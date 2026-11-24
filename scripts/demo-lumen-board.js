// The live demo's second board: Lumen Notes (the small notes app,
// scripts/demo-lumen.js) beside Brackwell in the same project, so the demo
// shows that one project holds several boards. scripts/demo-brackwell.js calls
// this after its own export.
//
// Lumen's export is made as it is for the tests (its captures, versions,
// variants and compare data), into a work folder, then its board's data goes
// into the Brackwell export as data/boards/lumen(.json) (client/src/demo/world.js
// names the folder), with:
// - the captures as WebP, as Brackwell's;
// - a few instructions to the coding agent instead of the test fixture's
//   twenty-seven comments, in the Brackwell board's style and in several
//   states (resolved with a pull request, done, working, a fix on a branch,
//   queued), pinned where the fixture's comments were;
// - three of its journeys, and no broken links (the board opens clean).
// With --publish <siteRoot> Lumen's script also writes its copies there
// (production as /lumen, staging as /lumen-staging, scripts/demo-publish.js),
// so the board's "Open live" and page links open a real page.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { toWebp } from './demo-webp.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LUMEN_FOLDER = 'lumen'
const JOURNEYS = ['sign-up', 'upgrade', 'first-note']

// The board's comments: [fixture comment id, what changes]. Ids, pins,
// anchors, drawings and times stay the fixture's.
const COMMENTS = [
  [
    1,
    {
      author: 'Robin',
      body: '@agent Plus is the plan we want people to pick, but its button looks like the other two. Make it the primary button.',
      replies: ['Switched the Plus card to the primary button and recaptured Pricing. @robin over to you.'],
    },
  ],
  [
    10,
    {
      author: 'Sam',
      body: '@agent Sort the notes table by last edited, newest first, and put an arrow on that column so the order is obvious.',
      replies: ['Sorted by Updated, newest first, with an arrow on the column header. Recaptured the dashboard.'],
    },
  ],
  [
    16,
    {
      author: 'Robin',
      body: '@agent The hero button wraps to two lines on phones. Shorten it to "Start free" below 480 px and keep the long label on desktop.',
      replies: ['On it: "Start free" below 480 px wide, same button style.'],
    },
  ],
  [
    21,
    {
      author: 'Mei',
      body: '@agent On a phone Delete account sits right above Save changes, too easy to hit. Move it to the end of the page and ask to confirm.',
      branch: true,
    },
  ],
  [
    22,
    {
      author: 'Jo',
      body: '@agent Add a search box to the 404 page, above Go home. People usually know what they were looking for.',
      queued: true,
    },
  ],
]

// out: the Brackwell export. Returns { pages, files, converted }.
export async function addLumenBoard(out, { publishRoot = null } = {}) {
  // One scratch folder per Brackwell export, as in demo-lumen.js.
  const work = path.join(
    ROOT,
    'test',
    '.output',
    'demo-export-lumen-board',
    createHash('sha256').update(path.resolve(out)).digest('hex').slice(0, 12),
  )
  fs.rmSync(work, { recursive: true, force: true })
  await promisify(execFile)(
    process.execPath,
    // The child runs in the repository root: a relative site root (deploy.sh passes `dist` from website/) is
    // resolved here, against the caller's folder, or Lumen's copies land in the repository's own dist/.
    [path.join(ROOT, 'scripts', 'demo-lumen.js'), work, ...(publishRoot ? ['--publish', path.resolve(publishRoot)] : [])],
    { cwd: ROOT, env: process.env, maxBuffer: 64 * 1024 * 1024 },
  )
  const from = path.join(work, 'data', 'boards')
  const comments = JSON.parse(fs.readFileSync(path.join(from, 'demo', 'comments.json'), 'utf8')).comments
  const converted = await toWebp(work)

  // The board's view: three journeys, no broken links, counts for the new comments.
  const view = JSON.parse(fs.readFileSync(path.join(from, 'demo.json'), 'utf8'))
  view.journeys = (view.journeys || []).filter((journey) => JOURNEYS.includes(journey.id))
  if (view.journeys.length !== JOURNEYS.length) throw new Error('demo lumen board: a journey is missing from the Lumen export')
  view.brokenLinks = []
  const list = COMMENTS.map(([id, change], index) => comment(comments, id, change, index + 1))
  view.commentCounts = {}
  for (const item of list) {
    const counts = (view.commentCounts[item.pageId] ||= { open: 0, resolved: 0 })
    counts[item.status] += 1
  }
  const journeysFile = path.join(from, 'demo', 'journeys.json')
  if (fs.existsSync(journeysFile)) {
    const stored = JSON.parse(fs.readFileSync(journeysFile, 'utf8'))
    const keep = (items) => (Array.isArray(items) ? items.filter((journey) => JOURNEYS.includes(journey.id)) : items)
    fs.writeFileSync(journeysFile, JSON.stringify(Array.isArray(stored) ? keep(stored) : { ...stored, journeys: keep(stored.journeys) }))
  }
  fs.writeFileSync(path.join(from, 'demo', 'comments.json'), JSON.stringify({ comments: list }))
  // Only the attachments the kept comments show.
  const images = new Set(list.flatMap((item) => (item.images || []).map((image) => image.file)))
  const filesDir = path.join(from, 'demo', 'comment-files')
  if (fs.existsSync(filesDir))
    for (const name of fs.readdirSync(filesDir)) if (!images.has(name)) fs.rmSync(path.join(filesDir, name), { recursive: true })

  const target = path.join(out, 'data', 'boards')
  fs.rmSync(path.join(target, LUMEN_FOLDER), { recursive: true, force: true })
  fs.cpSync(path.join(from, 'demo'), path.join(target, LUMEN_FOLDER), { recursive: true })
  fs.writeFileSync(path.join(target, `${LUMEN_FOLDER}.json`), JSON.stringify(view))
  const files = countFiles(path.join(target, LUMEN_FOLDER)) + 1
  fs.rmSync(work, { recursive: true, force: true })
  return { pages: view.board.pages.length, files, converted }
}

// One of the fixture's comments as an instruction to the agent, numbered n.
function comment(comments, id, change, n) {
  const found = comments.find((item) => item.id === id)
  if (!found) throw new Error(`demo lumen board: the Lumen export has no comment ${id}`)
  const item = structuredClone(found)
  item.id = n
  item.author = change.author
  item.body = change.body
  item.mentions = ['agent', ...(change.replies || []).flatMap((text) => (text.includes('@robin') ? ['robin'] : []))]
  item.reactions = []
  if (change.replies) item.replies = item.replies.slice(0, 1).map((reply, index) => ({ ...reply, body: change.replies[index] }))
  if (change.branch) {
    const branch = `shapewall/comment-${n}-delete-account`
    item.agentBranch = branch
    item.replies = item.replies.map((reply) => ({ ...reply, body: reply.body.replace(/shapewall\/comment-\d+-[a-z-]+/, branch) }))
  }
  if (change.queued) {
    item.agentStatus = 'queued'
    item.agentStatusAt = new Date(Date.parse(item.createdAt) + 2 * 60_000).toISOString()
    item.replies = []
  }
  return item
}

function countFiles(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .reduce((sum, entry) => sum + (entry.isDirectory() ? countFiles(path.join(folder, entry.name)) : 1), 0)
}
