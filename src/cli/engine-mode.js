// Commands in a project folder whose solo engine runs (1.5.0, experimental;
// gap G15): `comments`, `watch` and `mcp` go to the engine over its token
// API, with the token it made for this command line at its start
// (src/engine-target.js), instead of the 1.x JSON files in .shapewall/. The
// board people see lives in the engine; the JSON files are not it.
//
// An explicit --remote (or $SHAPEWALL_REMOTE) wins: it names a server. With
// no engine running (2.0.0, R5b): once the engine holds the project (its
// database names it: `serve` started here, or `migrate` moved the 1.x data)
// the commands refuse and say to start `shapewall serve`, since the 1.x JSON
// files are not the board; a board `migrate` moved is refused the same way.
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
export async function engineMode(command, flags, { env = process.env, err = () => {}, verify = verifyEngine } = {}) {
  if (!ENGINE_COMMANDS.includes(command)) return null
  if (flags.remote !== undefined || env.SHAPEWALL_REMOTE) return null
  let config
  try {
    config = loadConfig(flags.config)
  } catch {
    // No config here: the command says what is missing itself.
    return null
  }
  const target = engineTarget(config, { which: command === 'watch' ? 'watch' : 'cli' })
  if (target) {
    // Started by an agent (watch --exec without --pass-token, an agent's own process): no engine token for it, and no
    // JSON files either, which are not the board.
    if (env[NO_ENGINE_VAR] === '1')
      throw new Error(
        "This command was started by an agent (shapewall watch without --pass-token, or a connected agent): it does not get the solo engine's tokens. Run it yourself, or give watch --pass-token.",
      )
    if (command === 'export') {
      if (!flags['no-comments'])
        throw new Error(
          `The solo engine runs for this project (${target.url}) and holds its comments; export reads the 1.x board files in ${config.outputDir}. Add --no-comments to export the captures only.`,
        )
      return null
    }
    // Whoever listens on the engine's port proves it is this start's engine before any token goes there.
    await verify(target)
    flags.remote = target.origin
    flags[ENGINE_TOKEN] = target.token
    flags[ENGINE_TARGET] = target
    // The board a command works on when it names none: the config's first, as on the JSON files (mcp lists them all).
    if (command !== 'mcp' && flags.board === undefined) flags.board = getBoard(config).id
    if (command === 'comments' && !flags.json && !flags['for-agent']) err(`Solo engine: ${target.url}`)
    return { target, config }
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
