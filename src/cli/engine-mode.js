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
// `SHAPEWALL_ENGINE=legacy` keeps the 1.x files. `export` reads the 1.x
// comment files: once the engine holds the project (running or not) it is
// refused unless --no-comments, and then exports the engine's captures.

import { getBoard, loadConfig } from '../config.js'
import { boardHome } from './board-home.js'
import { assertMigrationAllows } from '../engine-folder.js'
import { ENGINE_TARGET, ENGINE_TOKEN, NO_ENGINE_VAR, engineTarget, verifyEngine } from '../engine-target.js'

export const ENGINE_COMMANDS = ['comments', 'watch', 'mcp', 'export']

// -> { target, config } when the command goes to the engine (flags changed
// in place: remote, the token, a default board), else null. Throws when the
// command must not run on the JSON files.
// How long a command waits for an engine another command is starting.
const STARTING_WAIT_MS = 20000

// The engine for this command when none runs: started here (-> { target, stop }), or the one another command is
// starting (-> { target }).
async function engineForCommand(config, which, startEngine, err) {
  let handle
  try {
    handle = await startEngine(config)
  } catch (error) {
    if (!/is starting the solo engine|already runs for this project/.test(error.message)) throw error
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
  const until = Date.now() + STARTING_WAIT_MS
  while (Date.now() < until) {
    const target = engineTarget(config, { which })
    if (target) return { target }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Another command is starting the solo engine for this project and it did not answer in time. Run this again.')
}

export async function engineMode(command, flags, { env = process.env, err = () => {}, verify = verifyEngine, startEngine = null } = {}) {
  if (!ENGINE_COMMANDS.includes(command)) return null
  if (flags.remote !== undefined || env.SHAPEWALL_REMOTE) return null
  let config
  try {
    config = loadConfig(flags.config)
  } catch {
    // No config here: the command says what is missing itself.
    return null
  }
  const which = command === 'watch' ? 'watch' : 'cli'
  let target = engineTarget(config, { which })
  let stop = null
  // Not running, and the engine holds the project: this command starts it (never for an agent's own process).
  const wanted = command !== 'export' || !flags['no-comments']
  if (!target && wanted && startEngine && env[NO_ENGINE_VAR] !== '1' && (await boardHome(config, { env })).engine) {
    assertMigrationAllows(config)
    ;({ target, stop = null } = await engineForCommand(config, which, startEngine, err))
  }
  if (target) {
    // Started by an agent (watch --exec without --pass-token, an agent's own process): no engine token for it, and no
    // JSON files either, which are not the board.
    if (env[NO_ENGINE_VAR] === '1')
      throw new Error(
        "This command was started by an agent (shapewall watch without --pass-token, or a connected agent): it does not get the solo engine's tokens. Run it yourself, or give watch --pass-token.",
      )
    // export --no-comments: the engine's folders only (commands.js), no token needed.
    if (command === 'export' && flags['no-comments']) return { target: null, config, stop }
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
    if (held && !flags['no-comments'])
      throw new Error(
        `The solo engine holds this project's comments (${config.outputDir}/.engine/); export reads the 1.x board files. Add --no-comments to export the captures only.`,
      )
    if (held) return null
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
