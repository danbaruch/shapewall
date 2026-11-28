// `shapewall github` and `shapewall doctor`.

import path from 'node:path'
import { getBoard, loadConfig } from '../config.js'
import { acpFlag } from './serve.js'
import { assertNotEngineBoard, boardHome } from './board-home.js'
import { ENGINE_TOKEN } from '../engine-target.js'

export async function github(positional, flags, out) {
  const config = loadConfig(flags.config)
  const { createIssue, engineGithubStore, linkPull, localGithubStore, syncGithub } = await import('../github.js')
  // Once the solo engine holds the project, the links are its comments' (2.0.0, R5d): main() points flags at the
  // engine (src/cli/engine-mode.js, started for this command when it does not run). This command still asks GitHub
  // itself, with this machine's token; the engine only keeps what it found. Its sync state is in the engine's folder.
  let store
  if (typeof flags[ENGINE_TOKEN] === 'string') {
    const { createRemote, remoteSettings } = await import('../remote/remote.js')
    const home = (await boardHome(config)).config
    store = engineGithubStore(createRemote(remoteSettings(flags)), config, { syncFile: path.join(home.outputDir, 'github-sync.json') })
  } else {
    // An engine board reached some other way (an explicit --remote): never the 1.x files, which are not the board.
    await assertNotEngineBoard(config, 'shapewall github', 'Run it without --remote: it goes to the solo engine of this folder.')
    store = localGithubStore(config)
  }
  const action = positional[0]
  const print = (value, line) => out(flags.json ? JSON.stringify(value, null, 2) : line)
  if (action === 'issue') {
    const id = positional[1]
    if (!id) throw new Error('usage: shapewall github issue COMMENT_ID')
    const board = getBoard(config, flags.board)
    const result = await createIssue(config, { boardId: board.id, commentId: id, store })
    print(
      result,
      `${result.created ? 'Opened' : 'Already has'} issue #${result.issue.number} for comment #${result.comment.id}: ${result.issue.url}`,
    )
    return
  }
  if (action === 'link') {
    const [, id, pr] = positional
    if (!id || !pr) throw new Error('usage: shapewall github link COMMENT_ID PR (12, #12 or the pull request URL)')
    const board = getBoard(config, flags.board)
    const result = await linkPull(config, { boardId: board.id, commentId: id, pr, store })
    const merged = result.merged ? '; it has merged, so the comment is resolved' : ''
    print(result, `Linked pull request #${result.pull.number} [${result.pull.state}] to comment #${result.comment.id}${merged}`)
    return
  }
  if (action === 'sync') {
    const result = await syncGithub(config, { log: out, store })
    const lines = [`Read ${result.scanned} pull request${result.scanned === 1 ? '' : 's'} of ${result.repo}`]
    for (const item of result.linked) lines.push(`  linked #${item.pull} [${item.state}] to comment ${item.board}/${item.comment}`)
    for (const item of result.merged) lines.push(`  resolved comment ${item.board}/${item.comment} (pull request #${item.pull} merged)`)
    for (const item of result.skipped) lines.push(`  skipped comment ${item.board}/${item.comment} named by #${item.pull}: ${item.reason}`)
    if (!result.linked.length && !result.skipped.length) lines.push('  nothing new')
    print(result, lines.join('\n'))
    return
  }
  throw new Error('usage: shapewall github issue|link|sync')
}

export async function doctor(flags, out) {
  const { chromiumInstalled, formatDoctor, installBrowser, installBrowserNote, runDoctor } = await import('../doctor.js')
  if (flags['install-browser']) {
    out(installBrowserNote(await chromiumInstalled()))
    const code = await installBrowser()
    if (code !== 0) throw new Error('the browser download failed (see above)')
  }
  // No --port: the port serve would use (the one this project last served on, else the default).
  const port = flags.port === undefined ? null : Number(flags.port)
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('--port must be a port number')
  // --install-browser works anywhere (the demo runs it in the Shapewall clone): no config is a skip there.
  const report = await runDoctor({
    configFile: flags.config,
    port,
    launch: !flags['no-launch'],
    acp: acpFlag(flags),
    configOptional: Boolean(flags['install-browser']),
  })
  out(flags.json ? JSON.stringify(report, null, 2) : formatDoctor(report))
  return report.ok ? 0 : 1
}
