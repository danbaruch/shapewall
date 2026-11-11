// Static, read-only export of every board: the built client plus JSON and
// capture files, for any static host (or a folder you zip and send). The
// client sees <meta name="shapewall-static"> and reads data/ instead of /api.
// Live HTML keeps its own CSP meta tag, since a static host sends no headers.
// Compare data (each pair of environments, with its diff masks) is computed
// here, so compare mode works without a server too.

import fs from 'node:fs'
import { checksBundle, checksView } from './checks/store.js'
import path from 'node:path'
import { CLIENT_DIR, boardSummary, boardView } from './server/app.js'
import { compareEnvironments } from './diff.js'
import { boardDir, captureFailures, captureFiles, capturesDir, diffsDir, listComments, readManifest } from './store.js'

function copyMatching(fromDir, toDir, test) {
  if (!fs.existsSync(fromDir)) return 0
  let count = 0
  for (const name of fs.readdirSync(fromDir)) {
    if (!test(name)) continue
    fs.mkdirSync(toDir, { recursive: true })
    fs.copyFileSync(path.join(fromDir, name), path.join(toDir, name))
    count += 1
  }
  return count
}

// Options: includeComments (default true); browserComments lets visitors add,
// resolve and reply to comments that stay in their own browser
// (localStorage), for a public demo; noindex asks search engines to skip it.
export async function exportStatic(
  config,
  { out, clientDir = CLIENT_DIR, includeComments = true, includeChecks = false, browserComments = false, noindex = false } = {},
) {
  if (!fs.existsSync(path.join(clientDir, 'index.html'))) throw new Error('The client is not built. Run "npm run build" first.')
  const target = path.resolve(out)
  if (fs.existsSync(target) && fs.readdirSync(target).length && !fs.existsSync(path.join(target, 'data', 'boards.json'))) {
    throw new Error(`${target} is not empty and is not a previous Shapewall export; pick another folder.`)
  }
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(clientDir, target, { recursive: true })
  const indexFile = path.join(target, 'index.html')
  const index = fs.readFileSync(indexFile, 'utf8')
  const metas = ['<meta name="shapewall-static" content="1">']
  if (browserComments) metas.push('<meta name="shapewall-browser-comments" content="1">')
  if (noindex && !/<meta name="robots"/.test(index)) metas.push('<meta name="robots" content="noindex,nofollow">')
  fs.writeFileSync(indexFile, index.replace('<head>', `<head>\n    ${metas.join('\n    ')}`))
  const data = path.join(target, 'data')
  fs.mkdirSync(path.join(data, 'boards'), { recursive: true })
  fs.writeFileSync(
    path.join(data, 'info.json'),
    JSON.stringify({
      title: config.title,
      readOnly: !browserComments,
      allowCapture: false,
      static: true,
      browserComments,
      checksAvailable: includeChecks,
    }),
  )
  fs.writeFileSync(path.join(data, 'boards.json'), JSON.stringify({ boards: config.boards.map((board) => boardSummary(config, board)) }))
  let files = 0
  for (const board of config.boards) {
    const view = boardView(config, board)
    view.capture = { running: false, state: 'idle' }
    if (!includeComments) {
      view.commentCounts = {}
      view.versions = {}
    }
    fs.writeFileSync(path.join(data, 'boards', `${board.id}.json`), JSON.stringify(view))
    const dir = path.join(data, 'boards', board.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify({ comments: includeComments ? listComments(config, board.id) : [] }))
    if (includeChecks) {
      const defaultChecks = checksView(config, board.id)
      fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(defaultChecks))
      for (const env of defaultChecks.environments)
        fs.writeFileSync(path.join(dir, `checks-${env.id}.json`), JSON.stringify(checksView(config, board.id, env.id)))
      fs.writeFileSync(path.join(dir, 'checks-reports.json'), JSON.stringify(checksBundle(config, board.id, { includeChecks: true })))
    }
    // The same answer as GET /api/boards/:id/journeys: steps with their forks, pages and paths.
    fs.writeFileSync(path.join(dir, 'journeys.json'), JSON.stringify({ journeys: view.journeys }))
    const source = boardDir(config, board.id)
    // Screenshots, live HTML and its element maps (the board places pins from them).
    const media = (name) => /\.(png|html|elements\.json)$/.test(name)
    files += copyMatching(path.join(source, 'captures'), path.join(dir, 'captures'), media)
    files += copyMatching(path.join(source, 'variants'), path.join(dir, 'variants'), media)
    // Previous screenshots, for before/after on resolved comments (not their live HTML).
    if (includeComments) files += copyMatching(path.join(source, 'versions'), path.join(dir, 'versions'), (name) => name.endsWith('.png'))
    // Images on the exported comments and their replies (not markup PNGs,
    // which are for agents, nor files of deleted comments).
    if (includeComments) {
      const kept = new Set()
      for (const comment of listComments(config, board.id))
        for (const item of [comment, ...comment.replies]) for (const image of item.images || []) kept.add(image.file)
      files += copyMatching(path.join(source, 'comment-files'), path.join(dir, 'comment-files'), (name) => kept.has(name))
    }
    files += await exportCompare(config, board, dir)
  }
  return { out: target, boards: config.boards.length, files }
}

// Every ordered pair of captured environments: their screenshots under
// envs/<id>/, the diff masks under diffs/<a>_<b>/, and the answer the
// server's /compare would give in compare/<a>_<b>.json.
async function exportCompare(config, board, dir) {
  const captured = board.environments.filter((env) => readManifest(config, board.id, env.id))
  if (captured.length < 2) return 0
  const png = (name) => name.endsWith('.png')
  let files = 0
  for (const env of captured) {
    // The default environment's screenshots are already in captures/.
    if (env !== board.environments[0]) files += copyMatching(capturesDir(config, board.id, env.id), path.join(dir, 'envs', env.id), png)
  }
  fs.mkdirSync(path.join(dir, 'compare'), { recursive: true })
  for (const a of captured) {
    for (const b of captured) {
      if (a === b) continue
      const result = await compareEnvironments(config, board, a.id, b.id)
      const pair = `${a.id}_${b.id}`
      files += copyMatching(diffsDir(config, board.id, a.id, b.id), path.join(dir, 'diffs', pair), png)
      const filesByEnv = { [a.id]: captureFiles(config, board, a.id), [b.id]: captureFiles(config, board, b.id) }
      const failures = { [a.id]: captureFailures(config, board, a.id), [b.id]: captureFailures(config, board, b.id) }
      fs.writeFileSync(path.join(dir, 'compare', `${pair}.json`), JSON.stringify({ ...result, files: filesByEnv, failures }))
    }
  }
  return files
}
