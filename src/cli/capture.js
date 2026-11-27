// `shapewall capture` and `shapewall links`.

import { getBoard, getEnvironment, loadConfig } from '../config.js'
import { runCapture } from '../capture/capture.js'
import { readManifest } from '../store.js'
import { cliCommand } from '../invocation.js'
import { formatBroken } from '../broken-links.js'
import { pageLinks } from '../links.js'
import { keyWarningLines } from '../config-keys.js'
import { addAgentDocsOnce } from '../agent-docs.js'
import { assertMigrationAllows } from '../engine-folder.js'
import { boardHome } from './board-home.js'

// `capture`: one line per shot and a summary; with --json the summary is one
// JSON document on stdout and the progress lines go to stderr. Capture never
// prompts (a leftover --yes is accepted with a warning, src/cli/args.js).
export async function capture(flags, out, err) {
  const config = loadConfig(flags.config)
  const json = Boolean(flags.json)
  // Keys the config has but Shapewall does not use (a typo, most often).
  for (const line of keyWarningLines(config.warnings)) (json ? err : out)(line)
  // The first capture in a project adds the Shapewall section to AGENTS.md, once (src/agent-docs.js).
  const agentDocsLine = addAgentDocsOnce(config)
  if (agentDocsLine) (json ? err : out)(agentDocsLine)
  // Not while `shapewall migrate` runs for the project, or after one stopped midway.
  assertMigrationAllows(config)
  // Into the solo engine's board folder once the engine holds the project (src/cli/board-home.js).
  const home = await boardHome(config, { envId: flags.env || null, boardId: flags.board })
  const result = await runCapture({
    config: home.config,
    boardId: flags.board,
    envId: flags.env || null,
    only: flags.only,
    log: json ? err : out,
    checkExternal: Boolean(flags['check-external']),
    exitOnSignal: true,
  })
  if (json) {
    out(
      JSON.stringify(
        {
          ok: result.ok,
          board: result.board,
          env: result.env,
          // shots: planned; ok, failed: finished each way; expected: the ok ones
          // that answered the status their page's "expectStatus" asks for.
          totals: { shots: result.total, ok: result.done - result.failed, failed: result.failed, expected: result.expected },
          durationMs: result.durationMs,
          dir: result.dir,
          failedShots: result.shots.filter((shot) => shot.status !== 'ok'),
          // Shots that landed on another page than the one asked for (a sign-in redirect, say).
          redirectedShots: result.shots.filter((shot) => shot.redirected),
          shots: result.shots,
          linksChecked: result.linksChecked,
          brokenLinks: result.brokenLinks,
        },
        null,
        2,
      ),
    )
  }
  return result.failed ? 2 : 0
}

// `links`: page-to-page links from the last capture, or (--broken) the links
// that led to an error.
export async function links(flags, out) {
  const config = (await boardHome(loadConfig(flags.config), { envId: flags.env || null, boardId: flags.board })).config
  const board = getBoard(config, flags.board)
  const env = getEnvironment(board, flags.env || null)
  const manifest = readManifest(config, board.id, env.id)
  if (!manifest)
    throw new Error(`Board "${board.id}" has no captures${flags.env ? ` of ${env.id}` : ''} yet. Run "${cliCommand('capture')}" first.`)
  const broken = Array.isArray(manifest.brokenLinks) ? manifest.brokenLinks : []
  if (flags.broken) {
    if (flags.json) out(JSON.stringify({ board: board.id, env: env.id, capturedAt: manifest.capturedAt, brokenLinks: broken }, null, 2))
    else if (!broken.length) out(`No broken links on "${board.id}" (capture of ${manifest.capturedAt}).`)
    else {
      out(`${broken.length} broken link${broken.length === 1 ? '' : 's'} on "${board.id}" (capture of ${manifest.capturedAt}):`)
      for (const line of formatBroken(broken, { max: Infinity })) out(line)
    }
    return broken.length ? 2 : 0
  }
  const graph = pageLinks(manifest, board)
  if (flags.json) {
    out(JSON.stringify({ board: board.id, env: env.id, capturedAt: manifest.capturedAt, links: graph, brokenLinks: broken }, null, 2))
    return 0
  }
  const lines = board.pages.filter((page) => graph[page.id]).map((page) => `${page.id} -> ${graph[page.id].join(', ')}`)
  out(lines.length ? lines.join('\n') : 'No links between the pages on the board.')
  if (broken.length) out(`${broken.length} broken link${broken.length === 1 ? '' : 's'}: "${cliCommand('links --broken')}" lists them.`)
  return 0
}
