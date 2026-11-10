// `shapewall doctor`: checks what a capture and the board need, and says how
// to fix what is missing. `--install-browser` downloads the Chromium build
// that matches the bundled Playwright version.

import fs from 'node:fs'
import net from 'node:net'
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

function checkNode(version = process.versions.node) {
  const wanted = Number(/\d+/.exec(PACKAGE.engines?.node || '22')[0])
  const major = Number(version.split('.')[0])
  return major >= wanted
    ? { name: 'node', status: 'ok', message: `Node ${version}` }
    : { name: 'node', status: 'fail', message: `Node ${version}; Shapewall needs ${wanted} or newer`, fix: 'Install a current Node LTS.' }
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
            ? `Chromium is downloaded, so this is usually missing system libraries: run "${depsHint()}" once as root (with sudo), then "${cliCommand('doctor')}" again.`
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

export function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) =>
      resolve(
        error.code === 'EADDRINUSE'
          ? {
              name: 'port',
              status: 'warn',
              message: `Port ${port} on ${host} is in use`,
              fix: `Use "${cliCommand(`serve --port ${port + 1}`)}" (or stop what is using it).`,
            }
          : { name: 'port', status: 'warn', message: `Port ${port} on ${host}: ${error.code || error.message}` },
      ),
    )
    server.listen(port, host, () => server.close(() => resolve({ name: 'port', status: 'ok', message: `Port ${port} on ${host} is free` })))
  })
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
  port = 4600,
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
  const checks = [
    checkNode(),
    configCheck,
    await checkBrowser(config, { launch, chromium }),
    checkStore(config),
    await checkPort(port, host),
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
  lines.push('', report.ok ? 'Ready.' : `Fix the FAIL lines above, then run "${how.command} doctor" again.`)
  if (how.note) lines.push(`(Commands above are written as "${how.command}": ${how.note}.)`)
  return lines.join('\n')
}

// Downloads Chromium for the bundled Playwright (its own CLI, so the browser
// build always matches). Resolves with the exit code.
export function installBrowser({ stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli(), 'install', 'chromium'], { stdio, shell: false })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}
