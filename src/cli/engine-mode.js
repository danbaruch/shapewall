// Commands in a project folder whose solo engine runs (1.5.0, experimental;
// gap G15): `comments`, `watch` and `mcp` go to the engine over its token
// API, with the token it made for this command line at its start
// (src/engine-target.js), instead of the 1.x JSON files in .shapewall/. The
// board people see lives in the engine; the JSON files are not it.
//
// An explicit --remote (or $SHAPEWALL_REMOTE) wins: it names a server. With
// no engine running, a board `shapewall migrate` moved is refused (its
// comments live in the engine), and a project whose engine kept comments
// before says on stderr that these are the 1.x board's, not the engine's.
// `export` reads the 1.x files: while the engine runs it is refused unless
// --no-comments, so it never ships a board's old comments as if current.

import { getBoard, loadConfig } from '../config.js'
import { assertMigrationAllows } from '../engine-folder.js'
import { ENGINE_TOKEN, engineAtRest, engineTarget } from '../engine-target.js'

export const ENGINE_COMMANDS = ['comments', 'watch', 'mcp', 'export']

// -> { target, config } when the command goes to the engine (flags changed
// in place: remote, the token, a default board), else null. Throws when the
// command must not run on the JSON files.
export function engineMode(command, flags, { env = process.env, err = () => {} } = {}) {
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
    if (command === 'export') {
      if (!flags['no-comments'])
        throw new Error(
          `The solo engine runs for this project (${target.url}) and holds its comments; export reads the 1.x board files in ${config.outputDir}. Add --no-comments to export the captures only.`,
        )
      return null
    }
    flags.remote = target.origin
    flags[ENGINE_TOKEN] = target.token
    // The board a command works on when it names none: the config's first, as on the JSON files (mcp lists them all).
    if (command !== 'mcp' && flags.board === undefined) flags.board = getBoard(config).id
    if (command === 'comments' && !flags.json && !flags['for-agent']) err(`Solo engine: ${target.url}`)
    return { target, config }
  }
  // No engine runs: the JSON files, unless a board was moved to the engine.
  const boardIds = command === 'mcp' || command === 'export' ? null : [getBoard(config, flags.board).id]
  assertMigrationAllows(config, { local: true, boardIds })
  if (engineAtRest(config).data)
    err(
      `Note: this project also has a solo engine (not running). These are the 1.x board's comments in ${config.outputDir}; start shapewall serve --engine hosted to work with the engine's.`,
    )
  return null
}
