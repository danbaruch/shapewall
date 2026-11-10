// `shapewall capture` and `shapewall links`.

import { getBoard, getEnvironment, loadConfig } from '../config.js'
import { runCapture } from '../capture/capture.js'
import { readManifest } from '../store.js'
import { cliCommand } from '../invocation.js'
import { formatBroken } from '../broken-links.js'
import { pageLinks } from '../links.js'

// `capture`: one line per shot and a summary; with --json the summary is one
// JSON document on stdout and the progress lines go to stderr. --yes is
// accepted for CI scripts: capture never prompts.
export async function capture(flags, out, err) {
  const config = loadConfig(flags.config)
  const json = Boolean(flags.json)
  const result = await runCapture({
    config,
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
          total: result.total,
          okShots: result.done - result.failed,
          failed: result.failed,
          expected: result.expected,
          durationMs: result.durationMs,
          dir: result.dir,
          failedShots: result.shots.filter((shot) => shot.status !== 'ok'),
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
  const config = loadConfig(flags.config)
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
