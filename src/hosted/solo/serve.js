// `shapewall serve --engine hosted` (1.5.0, experimental): the hosted engine
// for this project, one owner, on this machine (S5; plan R1). Reached from
// src/cli.js through ops-cli.js (the core never imports src/hosted).
//
// - Data: <outputDir>/.engine/ (src/engine-folder.js: refused when git tracks
//   it; 0700, a .gitignore of `*` in it). SQLite shapewall.db, secret.key,
//   files/<ws>/<project>/<board>/ (the local capture layout), solo-open.key.
// - Origin: http://<project>-<random>.shapewall.localhost:<port>, listening on
//   127.0.0.1 only; live HTML from http://uc.<project>-<random>.shapewall.localhost:<port>
//   (its own origin; S5 security 7).
// - The owner is made on the first start and signs in by a one-time page
//   (src/hosted/solo/signin.js, nonce never in argv). `--open` opens it; a second
//   `serve --engine hosted --open` while the engine runs asks it for a new one.
// - Boards come from shapewall.config.json, live (src/hosted/solo/config.js).
// - Events and notifications are the engine's (src/hosted/solo/events.js):
//   no second notifier here.
// - Exposure of any kind is refused: --host, --lan, --tailscale, TLS, extra
//   Host names, paired devices, --trust-proxy. The one way to let other
//   people in is team mode (R6, src/hosted/solo/team.js): `--team` puts the
//   engine on the tailnet through tailscale serve with tailnet sign-in, for
//   the people the owner invites; `--team off` takes it off again. It is
//   kept in the data folder (team.json), so a later `serve` starts the way it
//   was left. While the engine runs, `serve --team [off]` switches it there.
//   Each start prints who can reach the board.
// - Self-update (G10): SHAPEWALL_UPDATE_RESTART=1 makes a successful apply
//   that needs a restart stop the engine with exit 75 (what the service
//   manager restarts), as `serve` does; a stop waits for an apply in flight.
// - Refused while `shapewall migrate` runs or after one stopped midway.
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { loadConfig } from '../../config.js'
import { DEFAULT_PORT } from '../../serve-state.js'
import { acquireLock, isLockLive, processStartTime, readLock, releaseLock } from '../../lock.js'
import { assertMigrationAllows, prepareEngineFolder } from '../../engine-folder.js'
import { localUserName } from '../../server/local-user.js'
import { openBrowser } from '../../cli/open.js'
import { UPDATE_RESTART_EXIT } from '../../cli/serve.js'
import { keyWarningLines } from '../../config-keys.js'
import { pathToFileURL } from 'node:url'
import { verifyEngine } from '../../engine-target.js'
import { terminalSafe } from '../../remote/terminal.js'
import { OPEN_KEY_FILE, soloHostName, soloHostSuffix } from './signin.js'
import { teamPortProblem } from './team.js'
import { waitingOkLine } from '../imported-ok.js'

export const ENGINES = ['hosted']

// Flags of the local `serve` that would put the board beyond this machine,
// or that belong to the local server only (G12, G20).
const REFUSED = {
  host: 'the solo engine listens on 127.0.0.1 only',
  lan: 'shapewall serve --team shares it on your tailnet instead, with tailnet sign-in',
  tailscale: 'shapewall serve --team puts the solo engine on your tailnet, with tailnet sign-in for the people you invite',
  'tls-cert': 'the solo engine listens on this machine only',
  'tls-key': 'the solo engine listens on this machine only',
  'allowed-host': 'the solo engine answers its own host name only',
  'no-identity': 'there are no paired devices on the solo engine',
  'no-remote-chat': 'there are no paired devices on the solo engine',
  'approve-on-host': 'there are no paired devices on the solo engine',
  accounts: 'the solo engine has one owner; shapewall migrate moves local passkey accounts',
  'accounts-origin': 'the solo engine has one owner',
  'buzz-bridge': 'not on the solo engine yet',
  'agent-acp': 'agents connect to the solo engine with SHAPEWALL_REMOTE=<its address> shapewall agent connect',
  'allow-remote-agent': 'agents connect to the solo engine with shapewall agent connect',
  'trust-proxy': 'no proxy in front of the solo engine',
}

export const REFUSED_FLAGS = Object.keys(REFUSED)

export function engineFlagProblem(flags) {
  if (!ENGINES.includes(flags.engine))
    return `--engine: "hosted" (the solo engine, the default) or "legacy" (the 1.x board server, deprecated).`
  for (const [flag, why] of Object.entries(REFUSED))
    if (flags[flag] !== undefined)
      return `--${flag} is not for the solo engine: ${why}. The 1.x board server still takes it (shapewall serve --engine legacy, deprecated).`
  try {
    teamWanted(flags)
  } catch (error) {
    return error.message
  }
  return null
}

// --team (on), --team on|off, --team=false: true, false, or null (the way it was left). --team-port N: the
// HTTPS port on the tailnet, with --team only.
export function teamWanted(flags) {
  const value = flags.team
  let want = null
  if (value === true || value === 'on' || value === 'true') want = true
  else if (value === false || value === 'off' || value === 'false') want = false
  else if (value !== undefined) throw new Error('--team: on (the default) or off')
  if (flags['team-port'] !== undefined) {
    if (want !== true) throw new Error('--team-port goes with --team (the HTTPS port on your tailnet; 443 by default)')
    const problem = teamPortProblem(flags['team-port'])
    if (problem) throw new Error(problem)
  }
  return want
}

// Before solo-open.key goes to the port serve.json names: whoever answers there proves it holds this start's proof
// key (engine-target.js verifyEngine, rev57 R57-6; 2.0 final review A-7). A stale lock that passes for live, and
// another user on the port, get nothing.
async function proveRunning(running) {
  const proof = typeof running.proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(running.proof) ? running.proof : null
  if (!proof)
    throw new Error(
      `The solo engine for this project (pid ${running.pid}) left no way to check it is the one answering. Restart it with this version of Shapewall.`,
    )
  // The port proven is the port the key goes to: serve.json's origin and port must agree.
  let origin = null
  try {
    origin = new URL(String(running.origin))
  } catch {
    origin = null
  }
  if (!origin || Number(origin.port) !== running.port)
    throw new Error(`The solo engine for this project (pid ${running.pid}) left a serve.json that does not read. Restart it.`)
  await verifyEngine({ origin: origin.origin, proof, pid: running.pid })
}

// `serve --team [off]` while the engine runs: it switches there (POST /solo/team-switch, this start's key).
async function switchRunning(dir, running, { on, httpsPort }) {
  await proveRunning(running)
  const key = fs.readFileSync(path.join(dir, OPEN_KEY_FILE), 'utf8').trim()
  const response = await fetch(`http://127.0.0.1:${running.port}/solo/team-switch`, {
    method: 'POST',
    headers: { 'X-Shapewall-Solo-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ on, ...(httpsPort ? { httpsPort } : {}) }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(terminalSafe(body?.error?.message) || `The running engine did not switch team mode (HTTP ${response.status}).`)
  return body
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

// A new sign-in page from the engine that already runs for this folder: the
// path of a 0600 file in the data folder that posts a one-time nonce.
async function pageFromRunning(dir, running, { keep }) {
  await proveRunning(running)
  const key = fs.readFileSync(path.join(dir, OPEN_KEY_FILE), 'utf8').trim()
  const response = await fetch(`http://127.0.0.1:${running.port}/solo/open-link`, {
    method: 'POST',
    headers: { 'X-Shapewall-Solo-Key': key, ...(keep ? { 'X-Shapewall-Keep': '1' } : {}) },
  })
  if (!response.ok) throw new Error(`The running engine did not make a sign-in page (HTTP ${response.status}).`)
  const body = await response.json()
  const file = path.resolve(String(body.file || ''))
  if (path.dirname(file) !== path.resolve(dir)) throw new Error('The running engine answered with a sign-in page outside its data folder.')
  return file
}

// The browser opens the page by its path: the nonce is in the file only,
// never on a command line (other users can read every process's argv) or in
// this output.
function signIn(file, out, { open, spawnImpl, keep = () => {} }) {
  const url = pathToFileURL(file).href
  if (open)
    openBrowser(url, out, {
      spawnImpl,
      onCannotOpen: () => {
        keep()
        return 'it signs you in once, from this machine, within 5 minutes'
      },
    })
  else out(`Sign in: open ${url} in a browser on this machine (works once, for 5 minutes).`)
}

function showLink(flags, env) {
  if (flags['print-owner-link'] || env.SHAPEWALL_PRINT_OWNER_LINK === '1') return true
  return Boolean(process.stdout.isTTY) && env.TERM !== 'dumb'
}

// The cheap checks `serve` makes before it moves any 1.x data into the engine (IC4 B7): the flags, the port number,
// and that the port can be listened on now, so a start that cannot listen stops before it migrates anything. Not
// while the engine already runs for this folder (a second `serve --open` only signs a browser in there).
export async function preflightEngine(flags) {
  const problem = engineFlagProblem({ ...flags, engine: 'hosted' })
  if (problem) throw new Error(problem)
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number')
  if (port === 0) return
  const { createServer } = await import('node:net')
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use. Pick another with --port. Nothing was changed.`, { cause: error })
          : new Error(`Cannot listen on 127.0.0.1:${port} (${error.code || error.message}). Nothing was changed.`, { cause: error }),
      ),
    )
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(resolve))
  })
}

export async function serveEngine(flags, out, options = {}) {
  const { env = process.env, start = null, spawnImpl = undefined, agentSpawn = null } = options
  const problem = engineFlagProblem(flags)
  if (problem) throw new Error(problem)
  const config = loadConfig(flags.config)
  for (const line of keyWarningLines(config.warnings)) out(line)
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number')
  assertMigrationAllows(config)
  const dir = prepareEngineFolder(config, { skipGitCheck: Boolean(flags['skip-git-check']) })

  // Already running for this project: --open signs a browser in there, and nothing starts twice.
  const running = runningEngine(dir)
  const team = teamWanted(flags)
  const teamPort = flags['team-port'] === undefined ? null : Number(flags['team-port'])
  if (running && team !== null) {
    const answer = await switchRunning(dir, running, { on: team, httpsPort: teamPort })
    for (const line of Array.isArray(answer?.lines) ? answer.lines : []) out(terminalSafe(line))
    if (!flags.open && !flags['print-owner-link']) return null
  }
  if (running) {
    if (!flags.open && !flags['print-owner-link'])
      throw new Error(
        `The solo engine already runs for this project at ${running.url} (pid ${running.pid}). Add --open to sign a browser in.`,
      )
    const file = await pageFromRunning(dir, running, { keep: !flags.open })
    signIn(file, out, { open: Boolean(flags.open), spawnImpl })
    return null
  }
  if (!acquireLock(lockFile(dir), { kind: 'serve-engine', mode: 0o600 }))
    throw new Error('Another shapewall serve is starting the solo engine for this project.')
  const release = () => {
    releaseLock(lockFile(dir))
    fs.rmSync(stateFile(dir), { force: true })
  }
  process.once('exit', release)

  // <project>-<random>.shapewall.localhost: the random part (host.key in the data folder) keeps the name, and so the
  // owner's cookie, away from every other server on this machine (src/hosted/solo/signin.js).
  let label
  try {
    label = soloHostName(config.title || path.basename(config.dir), soloHostSuffix(dir))
  } catch (error) {
    release()
    process.off('exit', release)
    throw error
  }
  const holder = { stop: null }
  // This start's proof key (engine-target.js verifyEngine): only in serve.json (0600) and the engine's memory.
  const proofKey = randomBytes(32).toString('base64url')
  // The board's own agent (R2): planned from this project's agent settings before the engine starts, so its token is
  // made with it; started once the engine answers. --no-chat runs without one.
  const { planLocalAgent, startLocalAgent } = await import('../../remote/local-agent.js')
  const agentPlan = flags['no-chat'] || flags['read-only'] ? null : planLocalAgent(config, env)
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
    proofKey,
    localAgent: agentPlan && !agentPlan.off ? { ...agentPlan.identity, machine: null } : null,
    // Team mode (R6): asked for now (true, false) or the way it was left (null); the tailnet HTTPS port.
    team: { ...(team === null ? {} : { want: team }), ...(teamPort ? { httpsPort: teamPort } : {}), ...(options.team || {}) },
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
      // Every stop, a signal's too (rev57 R57-1): serve.json first, then the engine's own agent.
      beforeStop: () => holder.beforeStop?.(),
    })
  } catch (error) {
    release()
    process.off('exit', release)
    if (error?.code === 'EADDRINUSE') throw new Error(`Port ${port} is in use. Pick another with --port.`, { cause: error })
    throw error
  }
  // Every stop (this process's, an update restart, SIGINT or SIGTERM through startHosted's beforeStop): serve.json
  // goes first, so a command in the folder says "stopping" rather than reaching for a token being retired, then the
  // engine's own agent; the lock goes once the engine is down. Once, whichever way the stop came.
  const stopEngine = handle.stop
  let localAgent = null
  let before = null
  holder.beforeStop = () =>
    (before ||= (async () => {
      fs.rmSync(stateFile(dir), { force: true })
      try {
        await localAgent?.stop()
      } catch {
        /* gone already */
      }
    })())
  handle.stop = async (code, stopOptions) => {
    try {
      await holder.beforeStop()
      return await stopEngine(code, stopOptions)
    } finally {
      release()
      process.off('exit', release)
    }
  }
  holder.stop = handle.stop
  try {
    const { boardUrl, tokenFiles = {}, waitingOk } = handle.app.locals.solo
    // serve.json (0600): where the engine answers and which 0600 file holds the command line's token, so
    // `comments`, `watch`, `mcp` and `export` in this folder read the engine and not the 1.x JSON files (G15,
    // src/engine-target.js). The token itself is never in it.
    fs.writeFileSync(
      stateFile(dir),
      `${JSON.stringify({
        port: handle.server.address().port,
        origin: handle.origin,
        url: boardUrl,
        pid: process.pid,
        start: processStartTime(process.pid),
        tokens: Object.fromEntries(Object.entries(tokenFiles).map(([which, file]) => [which, path.basename(file)])),
        proof: proofKey,
      })}\n`,
      { mode: 0o600 },
    )
    out(`Shapewall is serving ${config.boards.length} board${config.boards.length === 1 ? '' : 's'} at ${boardUrl} (the solo engine)`)
    out(`Data: ${dir} (never commit it)`)
    const waiting = waitingOkLine(waitingOk?.() || 0)
    if (waiting) out(waiting)
    // The address goes in the environment, not on the agent's command line: any local user can read a process's
    // arguments (ps), and the name's random part is one of the layers that keep the cookie in (rev54 N3).
    out(`Agents: SHAPEWALL_REMOTE=${handle.origin} shapewall agent connect`)
    if (agentPlan)
      localAgent = startLocalAgent({
        config,
        origin: handle.origin,
        tokenFile: tokenFiles.agent,
        plan: agentPlan,
        env,
        out,
        ...(agentSpawn ? { spawnImpl: agentSpawn } : {}),
      })
    handle.localAgent = localAgent
    if (flags.open) {
      const file = handle.app.locals.soloOpenFile()
      signIn(file, out, { open: true, spawnImpl, keep: () => handle.app.locals.soloKeepOpenFile(file) })
    } else if (showLink(flags, env)) {
      signIn(handle.app.locals.soloOpenFile({ keep: true }), out, { open: false })
    } else {
      out('Sign in: run shapewall serve --open (a one-time sign-in page; this output is not a terminal, so none is made).')
    }
    return handle
  } catch (error) {
    await handle.stop(0, { exit: false }).catch(() => {})
    throw error
  }
}
