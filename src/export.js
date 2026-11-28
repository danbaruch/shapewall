import { portablePagePath } from './portable-path.js'
import { portableLinks, portableManifest } from './portable-capture.js'
import { joinUrl } from './config.js'
import { scrubUrl } from './error-scrub.js'
import { COMMENT_FILE_RE } from './comment-fields.js'
// Static, read-only export of every board: the built client plus JSON and
// capture files, for any static host (or a folder you zip and send). The
// client sees <meta name="shapewall-static"> and reads data/ instead of /api.
// Live HTML keeps its own CSP meta tag, since a static host sends no headers.
// Compare data (each pair of environments, with its diff masks) is computed
// here, so compare mode works without a server too.

import { regularOutputFile } from './output-path.js'
import fs from 'node:fs'
import { checksBundle, checksView } from './checks/store.js'
import path from 'node:path'
import { CLIENT_DIR, boardSummary, boardView } from './server/app.js'
import { compareEnvironments } from './diff.js'
import { boardDir, captureFailures, captureFiles, capturesDir, diffsDir, listComments, readManifest } from './store.js'

function copyMatching(root, fromDir, toDir, test) {
  if (!fs.existsSync(fromDir)) return 0
  let count = 0
  for (const name of fs.readdirSync(fromDir)) {
    if (!test(name)) continue
    const file = regularOutputFile(root, path.join(fromDir, name))
    if (!file) continue
    fs.mkdirSync(toDir, { recursive: true })
    fs.copyFileSync(file, path.join(toDir, name))
    count += 1
  }
  return count
}

// Opened from disk (file://), the board's module scripts are refused (CORS),
// which leaves a blank page. This classic script still runs there, and says
// how to look at the export instead.
const FILE_WARNING_SCRIPT = `// Written by shapewall export: a page opened from disk cannot load the board.
if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', function () {
    var box = document.createElement('div')
    box.setAttribute('role', 'alert')
    box.style.cssText = 'max-width:36rem;margin:15vh auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif'
    var title = document.createElement('h1')
    title.textContent = 'Serve this folder to open the board'
    title.style.fontSize = '1.25rem'
    var text = document.createElement('p')
    text.textContent = 'A Shapewall export does not open from disk (file://). In this folder, run: npx serve . and open the address it prints. Any static web server works.'
    box.appendChild(title)
    box.appendChild(text)
    document.body.insertBefore(box, document.body.firstChild)
  })
}
`

// Options: includeComments (default true); browserComments lets visitors add,
// resolve and reply to comments that stay in their own browser
// (IndexedDB), for a public demo; noindex asks search engines to skip it.
// The read-aloud voice files (tts-*) are for the agent chat, which an export
// does not have; they are left out unless visitors may comment.
export async function exportStatic(
  config,
  {
    out,
    clientDir = CLIENT_DIR,
    includeComments = true,
    includeChecks = false,
    browserComments = false,
    noindex = false,
    // Where the comments come from when they are not the 1.x files (the solo engine, R5c):
    // { list(boardId) -> comments, file(boardId, name) -> bytes }.
    commentSource = null,
  } = {},
) {
  if (!fs.existsSync(path.join(clientDir, 'index.html'))) throw new Error('The client is not built. Run "npm run build" first.')
  const target = path.resolve(out)
  if (fs.existsSync(target) && fs.readdirSync(target).length && !fs.existsSync(path.join(target, 'data', 'boards.json'))) {
    throw new Error(`${target} is not empty and is not a previous Shapewall export; pick another folder.`)
  }
  fs.rmSync(target, { recursive: true, force: true })
  const voiceFile = (file) => /^tts-/.test(path.basename(file)) && path.basename(path.dirname(file)) === 'assets'
  fs.cpSync(clientDir, target, { recursive: true, filter: (file) => browserComments || !voiceFile(file) })
  fs.writeFileSync(path.join(target, 'static-boot.js'), FILE_WARNING_SCRIPT)
  const indexFile = path.join(target, 'index.html')
  const index = fs.readFileSync(indexFile, 'utf8')
  const metas = ['<meta name="shapewall-static" content="1">', '<script src="./static-boot.js"></script>']
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
  let comments = 0
  for (const board of config.boards) {
    const view = boardView(config, board)
    const sourced = includeComments && commentSource ? await commentSource.list(board.id) : null
    if (sourced) view.commentCounts = countsOf(sourced)
    view.board.siteUrl = board.publicUrl ? scrubUrl(board.publicUrl) : null
    for (const page of view.board.pages) {
      page.path = portablePagePath(page.path)
      page.url = view.board.siteUrl ? joinUrl(view.board.siteUrl, page.path) : null
    }
    view.brokenLinks = portableLinks(view.brokenLinks, board)
    if (view.manifest) view.manifest = { ...portableManifest(config, board, view.manifest), brokenLinks: view.brokenLinks }
    for (const variant of view.variants) delete variant.source
    view.capture = { running: false, state: 'idle' }
    if (!includeComments) {
      view.commentCounts = {}
      view.versions = {}
    }
    fs.writeFileSync(path.join(data, 'boards', `${board.id}.json`), JSON.stringify(view))
    const dir = path.join(data, 'boards', board.id)
    fs.mkdirSync(dir, { recursive: true })
    const boardComments = sourced || (includeComments ? listComments(config, board.id) : [])
    comments += boardComments.length
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify({ comments: boardComments }))
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
    files += copyMatching(config.outputDir, path.join(source, 'captures'), path.join(dir, 'captures'), media)
    const variantFiles = new Set()
    for (const variant of view.variants) {
      for (const viewport of Object.values(variant.files)) {
        for (const name of Object.values(viewport)) if (name) variantFiles.add(name)
      }
    }
    files += copyMatching(config.outputDir, path.join(source, 'variants'), path.join(dir, 'variants'), (name) => variantFiles.has(name))
    // Previous screenshots, for before/after on resolved comments (not their live HTML).
    if (includeComments)
      files += copyMatching(config.outputDir, path.join(source, 'versions'), path.join(dir, 'versions'), (name) => name.endsWith('.png'))
    // Images on the exported comments and their replies (not markup PNGs,
    // which are for agents, nor files of deleted comments).
    if (sourced) files += await writeSourcedImages(commentSource, board.id, sourced, path.join(dir, 'comment-files'))
    else if (includeComments) {
      const kept = new Set()
      for (const comment of listComments(config, board.id))
        for (const item of [comment, ...comment.replies]) for (const image of item.images || []) kept.add(image.file)
      files += copyMatching(config.outputDir, path.join(source, 'comment-files'), path.join(dir, 'comment-files'), (name) => kept.has(name))
    }
    files += await exportCompare(config, board, dir)
  }
  return { out: target, boards: config.boards.length, files, comments }
}

// Comment counts per page, as store.js commentCounts gives them for the 1.x files.
function countsOf(comments) {
  const counts = {}
  for (const comment of comments) {
    counts[comment.pageId] = counts[comment.pageId] || { open: 0, resolved: 0 }
    counts[comment.pageId][comment.status] = (counts[comment.pageId][comment.status] || 0) + 1
  }
  return counts
}

// The images the sourced comments and replies list, under the names they list (checked like a stored file name).
async function writeSourcedImages(commentSource, boardId, comments, folder) {
  const names = new Set()
  for (const comment of comments)
    for (const item of [comment, ...(comment.replies || [])])
      for (const image of item.images || []) if (COMMENT_FILE_RE.test(String(image?.file || ''))) names.add(image.file)
  if (!names.size) return 0
  fs.mkdirSync(folder, { recursive: true })
  let written = 0
  for (const name of names) {
    fs.writeFileSync(path.join(folder, name), await commentSource.file(boardId, name))
    written += 1
  }
  return written
}

// Every ordered pair of captured environments: their screenshots (and
// element maps, for comments on that side) under envs/<id>/, the diff masks under diffs/<a>_<b>/, and the answer the
// server's /compare would give in compare/<a>_<b>.json.
async function exportCompare(config, board, dir) {
  const captured = board.environments.filter((env) => readManifest(config, board.id, env.id))
  if (captured.length < 2) return 0
  const png = (name) => name.endsWith('.png')
  const shot = (name) => png(name) || name.endsWith('.elements.json')
  let files = 0
  for (const env of captured) {
    // The default environment's screenshots are already in captures/.
    if (env !== board.environments[0])
      files += copyMatching(config.outputDir, capturesDir(config, board.id, env.id), path.join(dir, 'envs', env.id), shot)
  }
  fs.mkdirSync(path.join(dir, 'compare'), { recursive: true })
  for (const a of captured) {
    for (const b of captured) {
      if (a === b) continue
      const result = await compareEnvironments(config, board, a.id, b.id)
      const pair = `${a.id}_${b.id}`
      files += copyMatching(config.outputDir, diffsDir(config, board.id, a.id, b.id), path.join(dir, 'diffs', pair), png)
      const current = { current: true }
      const filesByEnv = { [a.id]: captureFiles(config, board, a.id, current), [b.id]: captureFiles(config, board, b.id, current) }
      const failures = { [a.id]: captureFailures(config, board, a.id), [b.id]: captureFailures(config, board, b.id) }
      for (const byPage of Object.values(failures)) {
        for (const shots of Object.values(byPage)) {
          for (const [id, message] of Object.entries(shots)) if (!/^HTTP [1-5][0-9]{2}$/.test(message)) shots[id] = 'Capture failed locally'
        }
      }
      fs.writeFileSync(path.join(dir, 'compare', `${pair}.json`), JSON.stringify({ ...result, files: filesByEnv, failures }))
    }
  }
  return files
}
