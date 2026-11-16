// `shapewall doctor`: checks what a capture and the board need, and says how
// to fix what is missing. `--install-browser` downloads the Chromium build
// that matches the bundled Playwright version.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { findConfigFile, loadConfig } from './config.js'
import { describeChannels } from './notify/index.js'
import { checkGithub } from './github.js'
import { agentSettings } from './agent/config.js'
import { formatCommand, loginHint } from './agent/acp/command.js'
import { acpHandshake } from './agent/backends/acp.js'
import { cliCommand, invocation } from './invocation.js'
import { listAgentBranches } from './agent/branch-mode.js'
import { nextFreePort, portInUse, probePort } from './ports.js'
import { DEFAULT_PORT, recordedServe } from './serve-state.js'
import { formatKeyWarning } from './config-keys.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)

export function playwrightCli() {
  return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js')
}

export function playwrightVersion() {
  return require('playwright/package.json').version
}

// The command that installs the matching browser, for messages: written the
// way this shapewall was started (npx github:..., a linked command, ...).
export const installHint = () => cliCommand('doctor --install-browser')
// System libraries for Chromium, from the Playwright version Shapewall uses.
const depsHint = () => `npx playwright@${playwrightVersion()} install-deps chromium`
// Playwright's install-deps needs apt-get; the docs list the packages for other distributions.
const LINUX_LIBS_URL = 'https://shapewall.com/docs/getting-started#linux-system-libraries'

// package.json's engines floor (">=22.19.0"), compared major, minor and patch.
export function checkNode(version = process.versions.node, engines = PACKAGE.engines?.node || '>=22') {
  const parts = (text) => (/(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text)) || []).slice(1, 4).map((part) => Number(part || 0))
  const wanted = parts(engines)
  const have = parts(version)
  const order = have[0] - wanted[0] || have[1] - wanted[1] || have[2] - wanted[2]
  const floor = wanted[1] || wanted[2] ? wanted.join('.') : String(wanted[0])
  return order >= 0
    ? { name: 'node', status: 'ok', message: `Node ${version}` }
    : { name: 'node', status: 'fail', message: `Node ${version}; Shapewall needs ${floor} or newer`, fix: 'Install a current Node LTS.' }
}

async function checkBrowser(config, { launch = true, chromium = null } = {}) {
  const channel = process.env.SHAPEWALL_BROWSER_CHANNEL || config?.browser.channel
  const executablePath = process.env.SHAPEWALL_BROWSER_PATH || config?.browser.executablePath
  let engine = chromium
  try {
    engine = engine || (await import('playwright')).chromium
  } catch (error) {
    return { name: 'browser', status: 'fail', message: `Playwright did not load (${error.message})`, fix: 'Reinstall Shapewall.' }
  }
  const label = executablePath ? `browser at ${executablePath}` : channel ? `installed browser channel "${channel}"` : 'Playwright Chromium'
  if (!executablePath && !channel && !fs.existsSync(engine.executablePath())) {
    return {
      name: 'browser',
      status: 'fail',
      message: `Playwright ${playwrightVersion()} has no Chromium yet`,
      fix: `Run "${installHint()}" (on Linux also "${depsHint()}" once, as root), or set browser.channel to "chrome".`,
    }
  }
  if (executablePath && !fs.existsSync(executablePath)) {
    return {
      name: 'browser',
      status: 'fail',
      message: `${label} does not exist`,
      fix: 'Fix browser.executablePath or SHAPEWALL_BROWSER_PATH.',
    }
  }
  if (!launch) return { name: 'browser', status: 'ok', message: `${label} found (not started)` }
  try {
    const options = { timeout: 30000 }
    if (executablePath) options.executablePath = executablePath
    else if (channel) options.channel = channel
    const browser = await engine.launch(options)
    const version = browser.version()
    await browser.close()
    return { name: 'browser', status: 'ok', message: `${label} starts (${version})` }
  } catch (error) {
    return {
      name: 'browser',
      status: 'fail',
      message: `${label} does not start: ${String(error.message).split('\n')[0].slice(0, 200)}`,
      fix:
        channel || executablePath
          ? 'Check the browser install.'
          : process.platform === 'linux'
            ? `Chromium is downloaded, so this is usually missing system libraries. On Debian or Ubuntu run "${depsHint()}" once as root (with sudo), then "${installHint()}" again. Fedora and other distributions: ${LINUX_LIBS_URL}`
            : `Run "${installHint()}" again, or set browser.channel to "chrome" to use an installed Chrome.`,
    }
  }
}

// With `optional` (doctor --install-browser, e.g. in the Shapewall clone for
// the demo) a missing config is a skip, not a FAIL.
function loadConfigCheck(explicit, { optional = false } = {}) {
  const file = findConfigFile(explicit)
  if (!fs.existsSync(file)) {
    const fix = `Run "${cliCommand('init')}" in the project you want to review.`
    const message = optional ? `No config at ${file} (not needed to install the browser)` : `No config at ${file}`
    return { check: { name: 'config', status: optional ? 'skip' : 'fail', message, fix }, config: null }
  }
  try {
    const config = loadConfig(explicit)
    const pages = config.boards.reduce((sum, board) => sum + board.pages.length, 0)
    return {
      check: {
        name: 'config',
        status: 'ok',
        message: `${path.relative(process.cwd(), file) || file}: ${config.boards.length} board${config.boards.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'}`,
      },
      config,
    }
  } catch (error) {
    return { check: { name: 'config', status: 'fail', message: error.message, fix: 'Fix the config (docs/config.md).' }, config: null }
  }
}

// The output folder, or the nearest folder above it that exists, must be
// writable. Nothing is created.
function checkStore(config) {
  if (!config) return { name: 'store', status: 'skip', message: 'No valid config, so no output folder to check' }
  let dir = config.outputDir
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir)
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    if (dir !== config.outputDir)
      return { name: 'store', status: 'ok', message: `${config.outputDir} will be created (${dir} is writable)` }
    const probe = path.join(dir, `.doctor-${process.pid}.tmp`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return { name: 'store', status: 'ok', message: `${config.outputDir} is writable` }
  } catch (error) {
    return {
      name: 'store',
      status: 'fail',
      message: `${dir} is not writable (${error.code || error.message})`,
      fix: 'Fix the folder permissions or set outputDir.',
    }
  }
}

// The port serve will listen on: free, in use (with a port that is free
// now), or this project's own running server. `running`: the URL of a live
// `shapewall serve` for this project (serve.json), when there is one.
export async function checkPort(port, host = '127.0.0.1', { running = null } = {}) {
  const state = await probePort(port, host)
  if (state === 'free') return { name: 'port', status: 'ok', message: `Port ${port} on ${host} is free` }
  if (state !== 'in-use') return { name: 'port', status: 'warn', message: `Port ${port} on ${host}: ${state}` }
  const mine = running && Number(new URL(running).port) === port ? running : null
  if (mine) return { name: 'port', status: 'ok', message: `Shapewall is already serving this project at ${mine}` }
  const free = await nextFreePort(port, host)
  const { message, fix } = portInUse({ port, host, free, command: (next) => cliCommand(`serve --port ${next}`) })
  return { name: 'port', status: 'warn', message: message.replace(/\.$/, ''), fix }
}

// Shapewall's own dependencies must be installed: a package.json for each,
// where Node looks for it from here. A package left out of node_modules (an
// interrupted install, a pruned folder) otherwise passes every check and
// `serve` dies with "Cannot find package".
// `lookIn(name)`: the node_modules folders Node would search, nearest first.
export function checkInstall({
  dependencies = PACKAGE.dependencies,
  lookIn = (name) => require.resolve.paths(name) || [path.join(ROOT, 'node_modules')],
  exists = fs.existsSync,
} = {}) {
  const missing = Object.keys(dependencies || {}).filter(
    (name) => !lookIn(name).some((dir) => exists(path.join(dir, name, 'package.json'))),
  )
  if (!missing.length)
    return { name: 'install', status: 'ok', message: `Dependencies installed (${Object.keys(dependencies || {}).length})` }
  const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? `, and ${missing.length - 5} more` : '')
  return {
    name: 'install',
    status: 'fail',
    message: `Shapewall's install is incomplete: ${missing.length === 1 ? 'a dependency is' : `${missing.length} dependencies are`} missing (${shown})`,
    fix: 'Reinstall it: "npm install" in this project (or "npm install -g shapewall" for a global install), then run doctor again.',
  }
}

// The site the config captures must answer, or capture fails every shot.
// People run doctor before they start their dev server too, so a site
// that does not answer is a warning that says what to do, not a FAIL:
// serve works without it. Each board's default environment, a few at most.
const SITE_TIMEOUT_MS = 5000
const SITES_MAX = 4
export async function checkSites(config, { fetchImpl = globalThis.fetch, network = true, timeoutMs = SITE_TIMEOUT_MS } = {}) {
  if (!config) return []
  const urls = [...new Set(config.boards.map((board) => board.environments?.[0]?.baseUrl || board.baseUrl).filter(Boolean))]
  if (!network)
    return urls.length ? [{ name: 'site', status: 'skip', message: `Not checked whether ${urls[0]} answers (no network checks)` }] : []
  const checks = await Promise.all(urls.slice(0, SITES_MAX).map((url) => checkSite(url, { fetchImpl, timeoutMs })))
  if (urls.length > SITES_MAX)
    checks.push({ name: 'site', status: 'skip', message: `${urls.length - SITES_MAX} more base URLs not checked` })
  return checks
}

export async function checkSite(url, { fetchImpl = globalThis.fetch, timeoutMs = SITE_TIMEOUT_MS } = {}) {
  const start = `Start it (or fix baseUrl in the config) before "${cliCommand('capture')}"; serve works without it.`
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    response.body?.cancel?.().catch?.(() => {})
    const status = response.status
    if (status >= 500)
      return {
        name: 'site',
        status: 'warn',
        message: `${url} answers with HTTP ${status}`,
        fix: 'Captures of an error page fail. Check the site.',
      }
    if (status === 401 || status === 403)
      return {
        name: 'site',
        status: 'ok',
        message: `${url} answers (HTTP ${status}: it needs a sign-in; see Auth in docs/config.md to capture signed in)`,
      }
    return { name: 'site', status: 'ok', message: `${url} answers (HTTP ${status})` }
  } catch (error) {
    const code = error?.cause?.code || error?.code
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
      return { name: 'site', status: 'warn', message: `${url} did not answer within ${timeoutMs / 1000} s`, fix: start }
    if (code === 'ECONNREFUSED')
      return { name: 'site', status: 'warn', message: `Nothing answers at ${url} (connection refused): is the site running?`, fix: start }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
      return {
        name: 'site',
        status: 'warn',
        message: `The host of ${url} is not found`,
        fix: 'Check baseUrl in the config (a typo, or a host only another network knows).',
      }
    return {
      name: 'site',
      status: 'warn',
      message: `${url} could not be reached (${code || String(error?.message || error).slice(0, 120)})`,
      fix: start,
    }
  }
}

function checkClient() {
  const index = path.join(ROOT, 'dist', 'client', 'index.html')
  return fs.existsSync(index)
    ? { name: 'client', status: 'ok', message: 'Board client is built' }
    : { name: 'client', status: 'fail', message: 'The board client is not built', fix: 'Run "npm run build" in the Shapewall folder.' }
}

// Notification channels and what each still needs from the environment.
// Names of variables only: doctor output is pasted into issues.
export function checkNotifications(config, env = process.env) {
  if (!config) return { name: 'notifications', status: 'skip', message: 'No valid config, so no notifications to check' }
  const channels = describeChannels(config, env)
  if (!channels.length) return { name: 'notifications', status: 'skip', message: 'Notifications: none configured (docs/notifications.md)' }
  const list = channels.map((item) => `${item.id} (${item.type}${item.mode === 'outbox' ? ', outbox' : ''})`).join(', ')
  const missing = channels.filter((item) => !item.ready)
  const people = Object.keys(config.notifications.people).length
  const mapped = people ? `; ${people} ${people === 1 ? 'person' : 'people'} mapped for mentions` : ''
  if (!missing.length) return { name: 'notifications', status: 'ok', message: `Notifications: ${list}${mapped}` }
  return {
    name: 'notifications',
    status: 'warn',
    message: `Notifications: ${list}${mapped}; not ready: ${missing.map((item) => item.id).join(', ')}`,
    fix:
      missing.map((item) => `Set ${item.missing.join(' and ')} for ${item.id}.`).join(' ') +
      ` Then "${cliCommand('notify test CHANNEL')}".`,
  }
}

// What the chat panel is connected to. No network call: a model request
// costs money, so the first chat message is the real test.
export function checkAgent(config, env = process.env) {
  if (!config) return { name: 'agent', status: 'skip', message: 'No valid config, so no chat agent to check' }
  const settings = agentSettings(config, env)
  if (settings.configured) {
    // A keyless setup (Ollama, LM Studio) is fine: no "set the key" nudge
    // unless the config names a key variable.
    const key = settings.hasKey
      ? `key from ${settings.keyVar} goes to ${settings.host}`
      : settings.keyVarNamed
        ? `no key (${settings.keyVar} is not set)`
        : 'no key'
    return { name: 'agent', status: 'ok', message: `Chat agent: ${settings.model} at ${settings.host} (OpenAI-compatible), ${key}` }
  }
  if (settings.problem) {
    return {
      name: 'agent',
      status: 'warn',
      message: 'Chat agent: not connected',
      fix: `Fix the agent config: ${settings.problem}. See docs/agents.md.`,
    }
  }
  return { name: 'agent', status: 'skip', message: 'Chat agent: none connected (docs/agents.md)' }
}

// An ACP agent: the command (it is the person's own, so printing it on this
// machine is fine) and whether it starts: initialize and session/new, no
// prompt. With launch false (--no-launch) it is not started.
export async function checkAcpAgent(config, env = process.env, { acp = null, launch = true, timeoutMs = 30000 } = {}) {
  const settings = agentSettings(config || { agent: null }, env, { acp })
  if (!settings.configured) {
    return { name: 'agent', status: 'warn', message: 'Chat agent (ACP): not connected', fix: `${settings.problem}. See docs/agents.md.` }
  }
  const command = formatCommand(settings.acp.argv)
  const refused = settings.acp.refusedEnv.length ? `; not passed: ${settings.acp.refusedEnv.join(', ')}` : ''
  if (!launch || !config) {
    return { name: 'agent', status: 'ok', message: `Chat agent: ${settings.label} over ACP: ${command} (not started)${refused}` }
  }
  const result = await acpHandshake(settings, { env, root: config.dir, timeoutMs })
  if (result.ok) {
    const info = result.agentInfo
    const name = info ? `${info.title || info.name}${info.version ? ` ${info.version}` : ''}` : settings.label
    return {
      name: 'agent',
      status: 'ok',
      // A handshake needs no login; only a prompt shows it (and costs).
      message: `Chat agent: ${name} over ACP: ${command} (handshake ok, login not checked${result.image ? ', takes images' : ''})${refused}`,
      fix: `If the first chat message says it is not logged in: ${loginHint(settings.acp.argv)}.`,
    }
  }
  return {
    name: 'agent',
    status: 'warn',
    message: `Chat agent: ${settings.label} over ACP did not start: ${command}`,
    fix: `${result.message} See docs/agents.md.`,
  }
}

// Agent branch mode (src/agent/branch-mode.js): branches and worktrees the
// agent left in .shapewall/agent-worktrees/. Shown only when there are some.
export async function checkAgentBranches(config) {
  if (!config) return null
  const items = await listAgentBranches(config).catch(() => [])
  if (!items.length) return null
  const waiting = items.filter((item) => item.state === 'ready')
  const folders = items.filter((item) => item.worktree).length
  const names = items
    .slice(0, 3)
    .map((item) => item.branch)
    .join(', ')
  return {
    name: 'agent-branches',
    status: 'warn',
    message: `Agent branches: ${items.length} left (${waiting.length} ready to apply, ${folders} worktree folder${folders === 1 ? '' : 's'}): ${names}${items.length > 3 ? ', ...' : ''}`,
    fix: 'Apply or discard each one from its answer in the chat. Folders of finished turns are swept when Shapewall starts; ones with unapplied commits are kept.',
  }
}

export async function runDoctor({
  configFile = null,
  // null: the port serve will use, the one this project's serve.json
  // records (a running server, or the last one), else the default.
  port = null,
  host = '127.0.0.1',
  launch = true,
  chromium = null,
  env = process.env,
  fetchImpl = undefined,
  network = true,
  acp = null,
  configOptional = false,
} = {}) {
  const { check: configCheck, config } = loadConfigCheck(configFile, { optional: configOptional })
  const useAcp = Boolean(acp || env.SHAPEWALL_AGENT_ACP || (config && agentSettings(config, env, { acp }).backend === 'acp'))
  const recorded = recordedServe(config)
  const checks = [
    checkNode(),
    checkInstall(),
    configCheck,
    ...configWarningChecks(config),
    await checkBrowser(config, { launch, chromium }),
    checkStore(config),
    await checkPort(port ?? recorded?.port ?? DEFAULT_PORT, host, { running: recorded?.alive ? recorded.url : null }),
    ...(await checkSites(config, { fetchImpl, network })),
    checkClient(),
    checkNotifications(config, env),
    useAcp ? await checkAcpAgent(config, env, { acp, launch }) : checkAgent(config, env),
    await checkGithub(config, { env, fetchImpl, network }),
  ]
  const branches = await checkAgentBranches(config)
  if (branches) checks.push(branches)
  return { ok: !checks.some((check) => check.status === 'fail'), checks }
}

export function formatDoctor(report) {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' }
  const lines = report.checks.flatMap((check) => [`${mark[check.status]} ${check.message}`, ...(check.fix ? [`     ${check.fix}`] : [])])
  const how = invocation()
  const warnings = report.checks.filter((check) => check.status === 'warn').length
  lines.push(
    '',
    !report.ok
      ? `Fix the FAIL lines above, then run "${how.command} doctor" again.`
      : warnings
        ? `Ready, with ${warnings} warning${warnings === 1 ? '' : 's'} above.`
        : 'Ready.',
  )
  if (how.note) lines.push(`(Commands above are written as "${how.command}": ${how.note}.)`)
  return lines.join('\n')
}

// A line of the box Playwright's installer draws around its npx warning.
export const isInstallerBox = (line) => /^\s*[\u2554\u2551\u255A]/.test(line)

// Playwright says this once per download (Chromium, its headless shell,
// ffmpeg) on a Linux it does not list, Fedora or Arch among them, in capitals.
const UNSUPPORTED_OS_RE = /^\s*BEWARE: your OS is not officially supported by Playwright/
export const UNSUPPORTED_OS_NOTE =
  'Note: Playwright does not list this Linux distribution, so it downloads its generic Linux build. That works on most distributions; if Chromium then does not start, doctor says which system libraries it needs.'

// What to print for one line of the installer's output: the line, our note
// instead of the first "BEWARE" (null for the others), or null for the box.
// `state` remembers whether the note was printed.
export function installerLine(line, state) {
  if (isInstallerBox(line)) return null
  if (UNSUPPORTED_OS_RE.test(line)) {
    if (state.noted) return null
    state.noted = true
    return UNSUPPORTED_OS_NOTE
  }
  return line
}

// Line by line through installerLine into `write`; returns { push, end }.
function installerFilter(write, state) {
  let rest = ''
  return {
    push(chunk) {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop()
      for (const line of lines) {
        const shown = installerLine(line, state)
        if (shown !== null) write(`${shown}\n`)
      }
    },
    end() {
      const shown = rest ? installerLine(rest, state) : null
      if (shown) write(shown)
      rest = ''
    },
  }
}

// Downloads Chromium for the bundled Playwright (its own CLI, so the browser
// build always matches). Resolves with the exit code.
export function installBrowser({ stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    // Run through `npx shapewall`, Playwright's installer prints a boxed warning
    // meant for `npx playwright install` in a project without Playwright
    // ("install your project's dependencies first"). It does not apply here
    // (this Playwright is Shapewall's own) and reads as a failure, so the box
    // is left out, and its "BEWARE: your OS is not officially supported" (on
    // stdout, once per download) becomes one calm note; every other line
    // passes through. Its progress bar is then the plain one it prints when
    // the output is not a terminal.
    const filter = stdio === 'inherit'
    const child = spawn(process.execPath, [playwrightCli(), 'install', 'chromium'], {
      stdio: filter ? ['inherit', 'pipe', 'pipe'] : stdio,
      shell: false,
    })
    if (filter) {
      const state = { noted: false }
      for (const [stream, target] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ]) {
        const lines = installerFilter((text) => target.write(text), state)
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => lines.push(chunk))
        stream.on('end', () => lines.end())
      }
    }
    child.once('error', reject)
    // 'close', not 'exit': the last of its output is written by then.
    child.once('close', (code) => resolve(code ?? 1))
  })
}

// A config key Shapewall does not use (a typo, most often): one warning
// each, with the key it probably meant (config-keys.js).
export function configWarningChecks(config) {
  const warnings = config?.warnings || []
  const checks = warnings.slice(0, 10).map((warning) => ({ name: 'config-key', status: 'warn', message: formatKeyWarning(warning) }))
  if (warnings.length > 10) checks.push({ name: 'config-key', status: 'warn', message: `and ${warnings.length - 10} more unknown keys` })
  return checks
}
