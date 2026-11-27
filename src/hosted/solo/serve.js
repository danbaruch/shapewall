// `shapewall serve --engine hosted` (1.5.0, experimental): the hosted engine
// for this project, one owner, on this machine (S5; plan R1). Reached from
// src/cli.js through ops-cli.js (the core never imports src/hosted).
//
// - Data: <outputDir>/.engine/ (src/engine-folder.js: refused when git tracks
//   it; 0700, a .gitignore of `*` in it). SQLite shapewall.db, secret.key,
//   files/<ws>/<project>/<board>/ (the local capture layout), solo-open.key.
// - Origin: http://<project>.shapewall.localhost:<port>, listening on
//   127.0.0.1 only; live HTML from http://uc.<project>.shapewall.localhost:<port>
//   (its own origin; S5 security 7).
// - The owner is made on the first start and signs in by a one-time link
//   (src/hosted/solo/signin.js). `--open` opens it; a second
//   `serve --engine hosted --open` while the engine runs asks it for a new one.
// - Boards come from shapewall.config.json, live (src/hosted/solo/config.js).
// - Events and notifications are the engine's (src/hosted/solo/events.js):
//   no second notifier here.
// - Exposure of any kind is refused until sharing lands (G12): --host, --lan,
//   --tailscale, TLS, extra Host names, paired devices, --trust-proxy.
// - Self-update (G10): SHAPEWALL_UPDATE_RESTART=1 makes a successful apply
//   that needs a restart stop the engine with exit 75 (what the service
//   manager restarts), as `serve` does; a stop waits for an apply in flight.
// - Refused while `shapewall migrate` runs or after one stopped midway.
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../../config.js'
import { DEFAULT_PORT } from '../../serve-state.js'
import { acquireLock, isLockLive, readLock, releaseLock } from '../../lock.js'
import { assertMigrationAllows, prepareEngineFolder } from '../../engine-folder.js'
import { localUserName } from '../../server/local-user.js'
import { openBrowser } from '../../cli/open.js'
import { UPDATE_RESTART_EXIT } from '../../cli/serve.js'
import { keyWarningLines } from '../../config-keys.js'
import { OPEN_KEY_FILE, soloHostLabel } from './signin.js'

export const ENGINES = ['hosted']

// Flags of the local `serve` that would put the board beyond this machine,
// or that belong to the local server only (G12, G20).
const REFUSED = {
  host: 'the solo engine listens on 127.0.0.1 only',
  lan: 'sharing on your network comes with team sign-in, later',
  tailscale: 'sharing on your tailnet comes with team sign-in, later (shapewall hosted --tailscale runs a team server)',
  'tls-cert': 'the solo engine listens on this machine only',
  'tls-key': 'the solo engine listens on this machine only',
  'allowed-host': 'the solo engine answers its own host name only',
  'no-identity': 'there are no paired devices on the solo engine',
  'no-remote-chat': 'there are no paired devices on the solo engine',
  'approve-on-host': 'there are no paired devices on the solo engine',
  accounts: 'the solo engine has one owner; shapewall migrate moves local passkey accounts (experimental)',
  'accounts-origin': 'the solo engine has one owner',
  'buzz-bridge': 'not on the solo engine yet',
  'agent-acp': 'agents connect to the solo engine with shapewall agent connect --remote <its address>',
  'allow-remote-agent': 'agents connect to the solo engine with shapewall agent connect',
  'trust-proxy': 'no proxy in front of the solo engine',
}

export function engineFlagProblem(flags) {
  if (!ENGINES.includes(flags.engine))
    return `--engine: "hosted" (experimental) is the only engine; leave --engine out for the local board server.`
  for (const [flag, why] of Object.entries(REFUSED)) if (flags[flag] !== undefined) return `--${flag} is not for --engine hosted: ${why}.`
  return null
}

const stateFile = (dir) => path.join(dir, 'serve.json')
const lockFile = (dir) => path.join(dir, 'serve.lock')

// A running engine for this folder: { url, origin, pid } or null.
function runningEngine(dir) {
  const lock = readLock(lockFile(dir))
  if (!lock || !isLockLive(lock)) return null
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'))
    return state && typeof state.port === 'number' ? state : null
  } catch {
    return null
  }
}

// A new one-time link from the engine that already runs for this folder.
async function linkFromRunning(dir, running, { keep }) {
  const key = fs.readFileSync(path.join(dir, OPEN_KEY_FILE), 'utf8').trim()
  const response = await fetch(`http://127.0.0.1:${running.port}/solo/open-link`, {
    method: 'POST',
    headers: { 'X-Shapewall-Solo-Key': key, ...(keep ? { 'X-Shapewall-Keep': '1' } : {}) },
  })
  if (!response.ok) throw new Error(`The running engine did not give a sign-in link (HTTP ${response.status}).`)
  const body = await response.json()
  return `${running.origin}${body.link}`
}

function showLink(flags, env) {
  if (flags['print-owner-link'] || env.SHAPEWALL_PRINT_OWNER_LINK === '1') return true
  return Boolean(process.stdout.isTTY) && env.TERM !== 'dumb'
}

export async function serveEngine(flags, out, { env = process.env, start = null } = {}) {
  const problem = engineFlagProblem(flags)
  if (problem) throw new Error(problem)
  const config = loadConfig(flags.config)
  for (const line of keyWarningLines(config.warnings)) out(line)
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number')
  assertMigrationAllows(config)
  const dir = prepareEngineFolder(config)

  // Already running for this project: --open signs a browser in there, and nothing starts twice.
  const running = runningEngine(dir)
  if (running) {
    if (!flags.open && !flags['print-owner-link'])
      throw new Error(
        `The solo engine already runs for this project at ${running.url} (pid ${running.pid}). Add --open to sign a browser in.`,
      )
    const link = await linkFromRunning(dir, running, { keep: !flags.open })
    if (flags.open) openBrowser(link, out, { onCannotOpen: () => 'it works once, from this machine, for a minute' })
    else out(`Sign in (works once, for 5 minutes, from this machine): ${link}`)
    return null
  }
  if (!acquireLock(lockFile(dir), { kind: 'serve-engine', mode: 0o600 }))
    throw new Error('Another shapewall serve --engine hosted is starting for this project.')
  const release = () => {
    releaseLock(lockFile(dir))
    fs.rmSync(stateFile(dir), { force: true })
  }
  process.once('exit', release)

  const label = soloHostLabel(config.title || path.basename(config.dir))
  const holder = { stop: null }
  const solo = {
    signIn: 'local',
    config,
    configPath: config.file,
    ownerName: localUserName(config.dir, env),
    projectName: config.title || path.basename(config.dir),
    readOnly: Boolean(flags['read-only']),
    chat: !flags['no-chat'],
    allowCapture: !flags['read-only'] && !flags['no-capture'],
    env,
    // A managed installer opts in to a restart after its helper switched the release (exit 75), as `serve`.
    appUpdate: env.SHAPEWALL_UPDATE_RESTART === '1' ? { onRestart: () => holder.stop?.(UPDATE_RESTART_EXIT) } : {},
  }
  let handle
  try {
    const { startHosted } = await import('../server.js')
    handle = await (start || startHosted)({
      dataDir: dir,
      port,
      host: '127.0.0.1',
      origin: (actual) => `http://${label}.shapewall.localhost:${actual}`,
      usercontentOrigin: (actual) => `http://uc.${label}.shapewall.localhost:${actual}`,
      env,
      out,
      solo,
    })
  } catch (error) {
    release()
    process.off('exit', release)
    if (error?.code === 'EADDRINUSE') throw new Error(`Port ${port} is in use. Pick another with --port.`, { cause: error })
    throw error
  }
  holder.stop = handle.stop
  const { boardUrl } = handle.app.locals.solo
  fs.writeFileSync(
    stateFile(dir),
    `${JSON.stringify({ port: handle.server.address().port, origin: handle.origin, url: boardUrl, pid: process.pid })}\n`,
    {
      mode: 0o600,
    },
  )
  out(
    `Shapewall solo engine (experimental) is serving ${config.boards.length} board${config.boards.length === 1 ? '' : 's'} at ${boardUrl}`,
  )
  out(`Data: ${dir} (never commit it)`)
  out(`Agents: shapewall agent connect --remote ${handle.origin}`)
  if (flags.open) {
    const link = handle.app.locals.soloOpenLink()
    openBrowser(`${handle.origin}${link}`, out, {
      onCannotOpen: () => {
        handle.app.locals.soloKeepOpenLink(link)
        return 'it signs you in once, from this machine, within 5 minutes'
      },
    })
  } else if (showLink(flags, env)) {
    const link = handle.app.locals.soloOpenLink({ keep: true })
    out(`Sign in (works once, for 5 minutes, from this machine): ${handle.origin}${link}`)
  } else {
    out('Sign in: run shapewall serve --engine hosted --open (a one-time link; this output is not a terminal, so none is printed).')
  }
  return handle
}
