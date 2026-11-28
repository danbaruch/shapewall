// Commands in a project folder whose solo engine runs (1.5.0; the default from 2.0;
// gap G15): `comments`, `watch` and `mcp` go to the engine over its token
// API, with the token it made for this command line at its start
// (src/engine-target.js), instead of the 1.x JSON files in .shapewall/. The
// board people see lives in the engine; the JSON files are not it.
//
// An explicit --remote (or $SHAPEWALL_REMOTE) wins: it names a server. With
// no engine running (2.0.0, R5c): once the engine holds the project (its
// database names it: `serve` started here, or `migrate` moved the 1.x data)
// `comments`, `watch` and `mcp` start it for themselves, headless, through
// the same start as `serve` (src/cli.js hands it in), and stop it when they
// end; the engine's serve.lock keeps a second one off the same data, and a
// command that finds one starting waits for it and uses it. Without a start
// (an agent's own process) they refuse and say to start `shapewall serve`.
// `github` (2.0.0, R5d) goes there the same way: it asks GitHub itself and
// records the issue and pull request links through the engine's token API.
// `SHAPEWALL_ENGINE=legacy` keeps the 1.x files. `export` reads the 1.x
// comment files: once the engine holds the project (running or not) it is
// refused unless --no-comments, and then exports the engine's captures.

import { getBoard, loadConfig } from '../config.js'
import { boardHome } from './board-home.js'
import { assertMigrationAllows } from '../engine-folder.js'
import { ENGINE_TARGET, ENGINE_TOKEN, EngineTargetError, NO_ENGINE_VAR, engineTarget, verifyEngine } from '../engine-target.js'

export const ENGINE_COMMANDS = ['comments', 'watch', 'mcp', 'export', 'github', 'open']
const REMOTE_COMMANDS = new Set(['comments', 'watch', 'mcp', 'open'])
const LONG_LIVED_COMMANDS = new Set(['mcp', 'watch'])

// -> { target, config } when the command goes to the engine (flags changed
// in place: remote, the token, a default board), else null. Throws when the
// command must not run on the JSON files.
// How long a command waits for an engine another command is starting or stopping.
const STARTING_WAIT_MS = 20000

const isBusyTargetError = (error) => error instanceof EngineTargetError && /starting or stopping/.test(error.message)

function tryEngineTarget(config, { which }) {
  try {
    return { target: engineTarget(config, { which }), busy: false, error: null }
  } catch (error) {
    if (isBusyTargetError(error)) return { target: null, busy: true, error }
    throw error
  }
}

// Never attach to an ephemeral headless command's engine (it exits moments later and would kill us).
// Long-lived sessions (mcp, watch) attach only to a full `serve` engine, not to another headless session.
function canAttach(target, command) {
  if (!target.headless) return true
  if (target.ephemeral) return false
  return !LONG_LIVED_COMMANDS.has(command)
}

// The engine for this command when none attachable runs: waits for any starting/ephemeral engine to settle,
// then either attaches to a steady engine or starts its own headless engine.
async function engineForCommand(config, command, which, startEngine, err) {
  const until = Date.now() + STARTING_WAIT_MS
  const ephemeral = !LONG_LIVED_COMMANDS.has(command)
  let lastTarget = null
  while (Date.now() < until) {
    const probed = tryEngineTarget(config, { which })
    if (probed.target && canAttach(probed.target, command)) return { target: probed.target, stop: null }
    lastTarget = probed.target
    if (!probed.busy && !probed.target) {
      let handle = null
      try {
        handle = await startEngine(config, { ephemeral })
      } catch (error) {
        if (!/is starting the solo engine|already runs for this project|A headless solo engine is running/.test(error.message)) throw error
      }
      if (handle) {
        const target = engineTarget(config, { which })
        if (!target) {
          await handle.stop()
          throw new Error('The solo engine started for this command did not make its command-line tokens.')
        }
        err(`Solo engine: started for this command at ${target.url}; it stops when the command ends (shapewall serve keeps it running).`)
        let stopped = null
        return { target, stop: () => (stopped ||= handle.stop().catch(() => {})) }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (lastTarget?.headless)
    throw new Error(
      `Another headless Shapewall command holds the solo engine for this project (pid ${lastTarget.pid}). Start shapewall serve to share one engine across commands.`,
    )
  throw new Error('Another command is starting the solo engine for this project and it did not answer in time. Run this again.')
}

export async function engineMode(command, flags, { env = process.env, err = () => {}, verify = verifyEngine, startEngine = null } = {}) {
  if (!ENGINE_COMMANDS.includes(command)) return null
  if (flags.remote !== undefined || (REMOTE_COMMANDS.has(command) && env.SHAPEWALL_REMOTE)) return null
  let config
  try {
    config = loadConfig(flags.config)
  } catch {
    // No config here: the command says what is missing itself.
    return null
  }
  // export --no-comments reads the board capture folders only (commands.js): no engine token needed, even in an
  // agent's process or while `serve` runs.
  if (command === 'export' && flags['no-comments']) {
    const held = (await boardHome(config, { env })).engine
    if (!held) assertMigrationAllows(config, { local: true })
    return null
  }
  // watch --no-claim only looks (src/remote/remote-watch.js): the command line's read token, which sees every open
  // comment, not the claiming watch token, which sees only the comments its agent may take.
  const which = command === 'watch' && !flags['no-claim'] ? 'watch' : 'cli'
  const probed = tryEngineTarget(config, { which })
  let target = probed.target
  let stop = null
  const needsEngine = !target || !canAttach(target, command)
  // An agent's own process (watch --exec without --pass-token, connected agent): never gets engine tokens, and
  // never falls back to 1.x JSON files while an engine is active or starting.
  if (env[NO_ENGINE_VAR] === '1' && (target || probed.busy))
    throw new Error(
      "This command was started by an agent (shapewall watch without --pass-token, or a connected agent): it does not get the solo engine's tokens. Run it yourself, or give watch --pass-token.",
    )
  // Not running (or only an unattachable ephemeral/headless engine): wait and attach or start one for this command.
  if (needsEngine && startEngine && env[NO_ENGINE_VAR] !== '1' && (await boardHome(config, { env })).engine) {
    assertMigrationAllows(config)
    ;({ target, stop = null } = await engineForCommand(config, command, which, startEngine, err))
  } else if (probed.busy) {
    throw probed.error
  }
  if (target) {
    // Whoever listens on the engine's port proves it is this start's engine before any token goes there.
    try {
      await verify(target)
    } catch (error) {
      await stop?.()
      throw error
    }
    flags.remote = target.origin
    flags[ENGINE_TOKEN] = target.token
    flags[ENGINE_TARGET] = target
    // The board a command works on when it names none: the config's first, as on the JSON files (mcp lists them all).
    if (command !== 'mcp' && flags.board === undefined) flags.board = getBoard(config).id
    if (command === 'comments' && !flags.json && !flags['for-agent']) err(`Solo engine: ${target.url}`)
    return { target, config, stop }
  }
  // No engine runs. Once the engine holds the project, its board is in the engine's database, not the JSON files.
  const held = (await boardHome(config, { env })).engine
  if (command === 'export') {
    if (held)
      throw new Error(
        `The solo engine holds this project's comments (${config.outputDir}/.engine/); export reads the 1.x board files. Add --no-comments to export the captures only.`,
      )
    assertMigrationAllows(config, { local: true })
    return null
  }
  const boardIds = command === 'mcp' ? null : [getBoard(config, flags.board).id]
  assertMigrationAllows(config, { local: true, boardIds })
  if (held)
    throw new Error(
      `The solo engine holds this project's board, and it is not running. Start it with shapewall serve (in another terminal, or as a service), then run shapewall ${command} again; while it runs, ${command} here goes to it. SHAPEWALL_ENGINE=legacy reads the 1.x board files instead (deprecated).`,
    )
  return null
}
