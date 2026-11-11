// Everything Shapewall keeps lives under the output directory (default
// .shapewall/), as plain files:
//
//   <out>/<board>/captures/<page>.<viewport>.png        full frame
//   <out>/<board>/captures/<page>.<viewport>.thumb.png  thumbnail for zoomed-out views
//   <out>/<board>/captures/<page>.<viewport>.html       sanitized live HTML
//   <out>/<board>/captures/manifest.json                what was captured, when, errors
//   <out>/<board>/variants/ + variants.json             alternative versions of pages
//   <out>/<board>/versions/<page>.<viewport>.<version>.*  previous captures (newest N)
//   <out>/<board>/envs/<env>/captures/                  captures of other environments
//   <out>/<board>/diffs/<a>_<b>/                        cached pixel diffs between environments
//   <out>/<board>/journeys.json                         journeys made on the board
//   <out>/<board>/comments.json                         comments (written atomically)
//   <out>/<board>/comment-files/                        images on comments, rendered drawings (src/comment-media.js)
//   <out>/<board>/capture.lock | status.json | capture.log
//   <out>/<board>/watch.lock | agent/                   `shapewall watch` (one per board)
//   <out>/events.jsonl (+ events.1.jsonl)              comment events from every process (src/event-log.js)
//   <out>/notifier.json                                which `shapewall serve` sends notifications
//
// JSON files are replaced atomically (write a temp file, fsync, rename), and
// read-modify-write runs under a short file lock, so the server and the CLI
// can both change comments safely.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { cleanNetworkSummary } from './capture/network-summary.js'
import { ID_RE, VIEWPORT_NAMES, boardViewports } from './config.js'
import { isLockLive, readLock, withFileLock } from './lock.js'
import { commentMentions } from './mentions.js'
import { publicReactions, toggleReaction } from './reactions.js'
import { createdEvents, emitCommentEvents, replyEvents, updateEvents } from './events.js'
import { appendEvents } from './event-log.js'
import {
  ANCHOR_SELECTOR_MAX,
  ANCHOR_SELECTOR_RE,
  AGENT_STATUSES,
  ANCHOR_TEXT_MAX,
  BRANCH_READY,
  COMMENT_BODY_MAX,
  CommentError,
  FIX_REF_MAX,
  STORED_AGENT_STATUSES,
  agentStatusOnResolve,
  cleanCommentBody,
  cleanFixRef,
  hasCommentMedia,
  readImages,
  validateAnchor,
} from './comment-fields.js'
import { DrawingError, readDrawing, validateDrawing } from './comment-drawing.js'
import { parseImageInputs, removeCommentMedia, removeImageFiles, saveCommentImages } from './comment-media.js'

// A comment's pure field rules live in comment-fields.js (the demo's
// in-browser backend uses them too); re-exported for everyone else.
export {
  AGENT_STATUSES,
  ANCHOR_SELECTOR_MAX,
  ANCHOR_SELECTOR_RE,
  ANCHOR_TEXT_MAX,
  BRANCH_READY,
  COMMENT_BODY_MAX,
  CommentError,
  FIX_REF_MAX,
  STORED_AGENT_STATUSES,
  cleanFixRef,
  validateAnchor,
}

export const AUTHOR_MAX = 60
const COMMENTS_MAX = 5000

// The only capture file names ever served. Ids share ID_RE, so a name can
// never contain a slash, a dot segment or a NUL. .elements.json is the live
// HTML's element map (src/capture/element-map.js).
// Viewport names follow VIEWPORT_NAME_RE (no dots), so the parts never run together.
export const CAPTURE_FILE_RE = /^[a-z0-9][a-z0-9-]{0,63}\.([a-z][a-z0-9-]{0,31})(\.thumb\.png|\.png|\.html|\.elements\.json)$/
// A capture version: when the shot was taken, plus a short random suffix.
export const VERSION_RE = /^\d{8}T\d{9}Z(?:-[a-f0-9]{4})?$/
// Previous captures: <page>.<viewport>.<version>.png|.thumb.png|.html
export const VERSION_FILE_RE =
  /^([a-z0-9][a-z0-9-]{0,63})\.([a-z][a-z0-9-]{0,31})\.(\d{8}T\d{9}Z(?:-[a-f0-9]{4})?)(\.thumb\.png|\.png|\.html)$/
// Pixel diffs between two environments: <page>.<viewport>.png
const DIFF_FILE_RE = /^[a-z0-9][a-z0-9-]{0,63}\.([a-z][a-z0-9-]{0,31})\.png$/
// An environment pair, "<a>_<b>" ('_' is never part of an id).
export const PAIR_RE = /^([a-z0-9][a-z0-9-]{0,63})_([a-z0-9][a-z0-9-]{0,63})$/

export function boardDir(config, boardId) {
  if (!ID_RE.test(boardId)) throw new Error(`invalid board id ${boardId}`)
  return path.join(config.outputDir, boardId)
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = fs.openSync(temp, 'w', 0o644)
  try {
    try {
      fs.writeSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
  } catch (error) {
    // A full disk or a failed rename leaves no temporary file behind.
    fs.rmSync(temp, { force: true })
    throw error
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

// ---- Captures -----------------------------------------------------------------

// The names in a directory, read once (empty when it is missing), so a
// board's file sets cost one readdir instead of a stat per file.
function dirNames(dir) {
  try {
    return new Set(fs.readdirSync(dir))
  } catch {
    return new Set()
  }
}

function fileSet(names, name, viewports) {
  const files = {}
  for (const viewport of viewports) {
    const png = `${name}.${viewport}.png`
    if (!names.has(png)) continue
    const thumb = `${name}.${viewport}.thumb.png`
    const live = `${name}.${viewport}.html`
    files[viewport] = {
      file: png,
      thumb: names.has(thumb) ? thumb : null,
      live: names.has(live) ? live : null,
    }
    // Only beside its live HTML; captures made before maps have none.
    const elements = live.replace(/\.html$/, '.elements.json')
    if (files[viewport].live && names.has(elements)) files[viewport].elements = elements
  }
  return files
}

// The default environment's captures live in captures/ (as they always have);
// other environments in envs/<env>/captures/.
export function capturesDir(config, boardId, envId = null) {
  const dir = boardDir(config, boardId)
  if (!envId || isDefaultEnv(config, boardId, envId)) return path.join(dir, 'captures')
  if (!ID_RE.test(envId)) throw new Error(`invalid environment id ${envId}`)
  return path.join(dir, 'envs', envId, 'captures')
}

function isDefaultEnv(config, boardId, envId) {
  const board = config.boards.find((item) => item.id === boardId)
  return !board?.environments?.length || board.environments[0].id === envId
}

export function readManifest(config, boardId, envId = null) {
  const raw = readJson(path.join(capturesDir(config, boardId, envId), 'manifest.json'))
  if (!raw || typeof raw !== 'object') return null
  // Only bounded aggregate observations may leave the capture store.
  for (const viewports of Object.values(raw.pages || {})) {
    if (!viewports || typeof viewports !== 'object') continue
    for (const entry of Object.values(viewports)) {
      if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'networkSummary')) continue
      const summary = cleanNetworkSummary(entry.networkSummary)
      if (summary) entry.networkSummary = summary
      else delete entry.networkSummary
    }
  }
  return raw
}

// Page -> viewport -> error ("HTTP 404") for the shots of the last capture
// of an environment that failed. Empty when nothing failed.
export function captureFailures(config, board, envId = null) {
  const manifest = readManifest(config, board.id, envId)
  const out = {}
  for (const page of board.pages) {
    const entry = manifest?.pages?.[page.id]
    if (!entry || typeof entry !== 'object') continue
    for (const [viewport, shot] of Object.entries(entry)) {
      if (shot?.status !== 'failed') continue
      out[page.id] = { ...out[page.id], [viewport]: String(shot.error || 'failed').slice(0, 300) }
    }
  }
  return out
}

export function captureFiles(config, board, envId = null) {
  const dir = capturesDir(config, board.id, envId)
  if (!fs.existsSync(dir)) return {}
  const names = dirNames(dir)
  return Object.fromEntries(board.pages.map((page) => [page.id, fileSet(names, page.id, page.viewports)]))
}

// Absolute path of a file Shapewall wrote, or null when the name is not one
// it writes or the file does not exist. Kinds: captures, variants, versions,
// env:<id> (another environment's captures), diff:<a>_<b> (pixel diffs).
export function resolveFile(config, boardId, kind, name) {
  const value = String(name || '')
  const board = config.boards.find((item) => item.id === boardId)
  let dir
  if (kind === 'captures' || kind === 'variants') {
    if (!CAPTURE_FILE_RE.test(value)) return null
    dir = path.join(boardDir(config, boardId), kind)
  } else if (kind === 'versions') {
    if (!VERSION_FILE_RE.test(value)) return null
    dir = versionsDir(config, boardId)
  } else if (typeof kind === 'string' && kind.startsWith('env:')) {
    const envId = kind.slice(4)
    if (!CAPTURE_FILE_RE.test(value) || !board?.environments.some((env) => env.id === envId)) return null
    dir = capturesDir(config, boardId, envId)
  } else if (typeof kind === 'string' && kind.startsWith('diff:')) {
    const pair = PAIR_RE.exec(kind.slice(5))
    const envIds = new Set(board?.environments.map((env) => env.id))
    if (!DIFF_FILE_RE.test(value) || !pair || !envIds.has(pair[1]) || !envIds.has(pair[2])) return null
    dir = diffsDir(config, boardId, pair[1], pair[2])
  } else {
    return null
  }
  const file = path.join(dir, value)
  if (path.dirname(file) !== dir) return null
  return fs.existsSync(file) ? file : null
}

export function diffsDir(config, boardId, a, b) {
  if (!ID_RE.test(a) || !ID_RE.test(b)) throw new Error('invalid environment id')
  return path.join(boardDir(config, boardId), 'diffs', `${a}_${b}`)
}

// ---- Capture versions -------------------------------------------------------------
// When a page is captured again, the previous shot (PNG, thumbnail, live
// HTML) moves to versions/, named by its version id. The newest
// `config.versions` per page and viewport are kept.

export function versionsDir(config, boardId) {
  return path.join(boardDir(config, boardId), 'versions')
}

// A sortable id for a shot taken at `date`.
export function versionId(date = new Date(), suffix = randomBytes(2).toString('hex')) {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z')
  return suffix ? `${stamp}-${suffix}` : stamp
}

// The version of a manifest entry. Captures made before versions existed use
// the run's time.
export function entryVersion(entry, manifest) {
  if (entry?.status !== 'ok') return null
  if (typeof entry.version === 'string' && VERSION_RE.test(entry.version)) return entry.version
  const time = Date.parse(manifest?.capturedAt || '')
  return Number.isFinite(time) ? versionId(new Date(time), '') : null
}

// The version currently shown for a page and viewport (default environment).
export function currentVersion(config, boardId, pageId, viewport) {
  const manifest = readManifest(config, boardId)
  return entryVersion(manifest?.pages?.[pageId]?.[viewport], manifest)
}

const VERSION_SUFFIXES = ['png', 'thumb.png', 'html']

// Copies the shot <page>.<viewport>.* in `fromDir` into versions/ as
// `version`. Returns the files written (to undo a failed recapture).
export function archiveVersion(config, boardId, { fromDir, pageId, viewport, version }) {
  if (!VERSION_RE.test(String(version || '')) || !ID_RE.test(pageId)) return []
  const png = path.join(fromDir, `${pageId}.${viewport}.png`)
  if (!fs.existsSync(png)) return []
  const dir = versionsDir(config, boardId)
  fs.mkdirSync(dir, { recursive: true })
  const written = []
  for (const suffix of VERSION_SUFFIXES) {
    const source = path.join(fromDir, `${pageId}.${viewport}.${suffix}`)
    if (!fs.existsSync(source)) continue
    const target = path.join(dir, `${pageId}.${viewport}.${version}.${suffix}`)
    fs.copyFileSync(source, target)
    written.push(target)
  }
  return written
}

// Archived versions per page and viewport, newest first:
// { [pageId]: { [viewport]: [{ version, file, thumb, live }] } }
export function listVersions(config, boardId) {
  const dir = versionsDir(config, boardId)
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return {}
  }
  const found = {}
  for (const name of names) {
    const match = VERSION_FILE_RE.exec(name)
    if (!match) continue
    const [, pageId, viewport, version, suffix] = match
    found[pageId] ||= {}
    found[pageId][viewport] ||= {}
    const item = (found[pageId][viewport][version] ||= { version, file: null, thumb: null, live: null })
    if (suffix === '.png') item.file = name
    else if (suffix === '.thumb.png') item.thumb = name
    else item.live = name
  }
  const out = {}
  for (const [pageId, viewports] of Object.entries(found)) {
    out[pageId] = {}
    for (const [viewport, byVersion] of Object.entries(viewports)) {
      out[pageId][viewport] = Object.values(byVersion)
        .filter((item) => item.file)
        .sort((a, b) => (a.version < b.version ? 1 : -1))
    }
  }
  return out
}

// Keeps the newest `keep` versions of each page and viewport; removes the rest.
export function pruneVersions(config, boardId, keep = config.versions) {
  const dir = versionsDir(config, boardId)
  let removed = 0
  for (const viewports of Object.values(listVersions(config, boardId))) {
    for (const list of Object.values(viewports)) {
      for (const item of list.slice(Math.max(0, keep))) {
        for (const name of [item.file, item.thumb, item.live]) if (name) fs.rmSync(path.join(dir, name), { force: true })
        removed += 1
      }
    }
  }
  return removed
}

// ---- Capture state ------------------------------------------------------------

export function readCaptureState(config, boardId) {
  const dir = boardDir(config, boardId)
  const running = isLockLive(readLock(path.join(dir, 'capture.lock')))
  const status = readJson(path.join(dir, 'status.json')) || {}
  let state = ['running', 'done', 'failed'].includes(status.state) ? status.state : 'idle'
  if (state === 'running' && !running) state = 'failed'
  return {
    running,
    state: running ? 'running' : state,
    startedAt: typeof status.startedAt === 'string' ? status.startedAt : null,
    finishedAt: typeof status.finishedAt === 'string' ? status.finishedAt : null,
    done: Number.isFinite(status.done) ? status.done : null,
    total: Number.isFinite(status.total) ? status.total : null,
    failed: Number.isFinite(status.failed) ? status.failed : null,
    error:
      typeof status.error === 'string'
        ? status.error.slice(0, 300)
        : state === 'failed' && status.state === 'running'
          ? 'The capture stopped before it finished.'
          : null,
  }
}

// ---- Variants -------------------------------------------------------------------

function cleanVariant(entry) {
  if (!entry || typeof entry !== 'object' || !ID_RE.test(String(entry.id || '')) || !ID_RE.test(String(entry.pageId || ''))) return null
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  return {
    id: entry.id,
    pageId: entry.pageId,
    title: text(entry.title, 120) || entry.id,
    note: text(entry.note, 1000),
    source: text(entry.source, 500),
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null,
  }
}

export function variantsFile(config, boardId) {
  return path.join(boardDir(config, boardId), 'variants.json')
}

export function readVariants(config, boardId) {
  const raw = readJsonStrict(variantsFile(config, boardId))
  return (Array.isArray(raw?.variants) ? raw.variants : []).map(cleanVariant).filter(Boolean)
}

export function variantsWithFiles(config, board) {
  const dir = path.join(boardDir(config, board.id), 'variants')
  const pages = new Map(board.pages.map((page) => [page.id, page]))
  const variants = readVariants(config, board.id).filter((variant) => pages.has(variant.pageId))
  const names = variants.length ? dirNames(dir) : new Set()
  const viewports = [...new Set([...VIEWPORT_NAMES, ...Object.keys(boardViewports(config, board))])]
  return variants.map((variant) => ({ ...variant, files: fileSet(names, variant.id, viewports) }))
}

export async function saveVariant(config, boardId, variant) {
  const file = variantsFile(config, boardId)
  return withFileLock(file, () => {
    const list = readVariants(config, boardId).filter((item) => item.id !== variant.id)
    const clean = cleanVariant(variant)
    if (!clean) throw new Error('invalid variant')
    list.push(clean)
    writeJsonAtomic(file, { variants: list })
    return clean
  })
}

export async function removeVariant(config, boardId, variantId) {
  const file = variantsFile(config, boardId)
  return withFileLock(file, () => {
    const list = readVariants(config, boardId)
    const kept = list.filter((item) => item.id !== variantId)
    if (kept.length === list.length) return false
    writeJsonAtomic(file, { variants: kept })
    const dir = path.join(boardDir(config, boardId), 'variants')
    const board = config.boards?.find((item) => item.id === boardId)
    for (const viewport of new Set([...VIEWPORT_NAMES, ...Object.keys(boardViewports(config, board) || {})])) {
      for (const suffix of ['png', 'thumb.png', 'html']) fs.rmSync(path.join(dir, `${variantId}.${viewport}.${suffix}`), { force: true })
    }
    return true
  })
}

// ---- Comments -------------------------------------------------------------------

// The bridge freezes comments under their existing write lock. Captures and
// journeys stay writable. A host may explicitly keep the local copy independent.
export function readMigration(config, boardId) {
  const marker = readJson(path.join(boardDir(config, boardId), 'migrated.json'))
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  let url = null
  try {
    const parsed = new URL(marker.url)
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href
  } catch {
    /* A pending import has no destination yet. */
  }
  if (!url && marker.pending !== true) return null
  return {
    url,
    readOnly: marker.readOnly === true,
    pending: marker.pending === true,
    previousReadOnly: marker.previousReadOnly === true,
    ...(typeof marker.migratedAt === 'string' ? { migratedAt: marker.migratedAt } : {}),
  }
}
export async function writeMigration(config, boardId, marker, { beforeWrite = () => {} } = {}) {
  await withFileLock(commentsFile(config, boardId), async () => {
    beforeWrite()
    writeJsonAtomic(path.join(boardDir(config, boardId), 'migrated.json'), marker)
  })
}
function assertLocalComments(config, boardId) {
  if (readMigration(config, boardId)?.readOnly)
    throw new CommentError(
      403,
      'comments_moved',
      'Comments for this board moved to the shared board. Choose Keep commenting here on the host to edit this independent local copy.',
    )
}

export function commentsFile(config, boardId) {
  return path.join(boardDir(config, boardId), 'comments.json')
}

// Like readJson, but a file that exists and does not parse is an error, so a
// hand-edited comments.json with a typo is never overwritten with an empty list.
function readJsonStrict(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CommentError(
      500,
      'corrupt_file',
      `${path.basename(file)} is not valid JSON (${error.message}); fix or move it, nothing was written.`,
      { cause: error },
    )
  }
}

function readCommentStore(config, boardId) {
  const raw = readJsonStrict(commentsFile(config, boardId))
  const comments = Array.isArray(raw?.comments) ? raw.comments.filter((item) => item && Number.isSafeInteger(item.id)) : []
  const nextId = Math.max(Number(raw?.nextId) || 1, ...comments.map((item) => item.id + 1))
  return { nextId, comments }
}

// Comments written before replies and agent status existed read as having
// none, so every reader sees the same shape.
// The same goes for the reopen count; mentions are read from the text.
// Reactions read as { emoji, count, by } on the comment and each reply.
function withAgentFields(comment) {
  const replies = (Array.isArray(comment.replies) ? comment.replies : []).map((reply) =>
    withMedia({
      ...reply,
      reactions: publicReactions(reply.reactions),
    }),
  )
  const { agentBranch, ...rest } = withMedia(comment)
  // The branch of a fix waiting on one (branch-ready), and only then.
  const branch = comment.agentStatus === BRANCH_READY ? cleanAgentBranch(agentBranch) : null
  return {
    ...rest,
    ...(branch ? { agentBranch: branch } : {}),
    replies,
    reactions: publicReactions(comment.reactions),
    editedAt: typeof comment.editedAt === 'string' ? comment.editedAt : null,
    agentStatus: STORED_AGENT_STATUSES.includes(comment.agentStatus) ? comment.agentStatus : null,
    agentStatusAt: typeof comment.agentStatusAt === 'string' ? comment.agentStatusAt : null,
    reopenCount: Number.isSafeInteger(comment.reopenCount) && comment.reopenCount > 0 ? comment.reopenCount : 0,
    reopenedAt: typeof comment.reopenedAt === 'string' ? comment.reopenedAt : null,
    mentions: commentMentions({ body: comment.body, replies }),
    github: cleanGithub(comment.github),
  }
}

// Images and a drawing are optional: read back through their validators,
// and left off entirely when there are none, so older files read unchanged.
export function withMedia(item) {
  const out = { ...item }
  const images = readImages(item.images)
  const drawing = readDrawing(item.drawing)
  delete out.images
  delete out.drawing
  if (images.length) out.images = images
  if (drawing) out.drawing = drawing
  return out
}

// The images and drawing of a new comment or reply, checked (nothing
// written yet). Throws CommentError.
export function validateCommentMedia(input) {
  const images = parseImageInputs(input?.images)
  let drawing = null
  try {
    drawing = validateDrawing(input?.drawing)
  } catch (error) {
    if (error instanceof DrawingError) throw new CommentError(400, error.code, error.message)
    throw error
  }
  return { images, drawing }
}

// `mention` keeps comments whose text or replies mention that handle.
export function listComments(config, boardId, { status = null, mention = null } = {}) {
  const { comments } = readCommentStore(config, boardId)
  const wanted = mention ? String(mention).replace(/^@/, '').toLowerCase() : null
  return comments
    .map(withAgentFields)
    .filter((comment) => !status || comment.status === status)
    .filter((comment) => !wanted || comment.mentions.includes(wanted))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id))
}

export function commentCounts(config, boardId) {
  const counts = {}
  for (const comment of readCommentStore(config, boardId).comments) {
    counts[comment.pageId] = counts[comment.pageId] || { open: 0, resolved: 0 }
    counts[comment.pageId][comment.status] = (counts[comment.pageId][comment.status] || 0) + 1
  }
  return counts
}

function cleanAuthor(value) {
  const author = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX) : ''
  return author || 'anonymous'
}

// Validates a new comment against the board: the target is a page on it or
// one of its variants (`variant:<id>`), the viewport is one the target has,
// coordinates are percentages, and the body is plain text of bounded length.
export function validateCommentInput(config, board, input) {
  const pageId = typeof input?.pageId === 'string' ? input.pageId.trim() : ''
  const variantMatch = /^variant:([a-z0-9][a-z0-9-]{0,63})$/.exec(pageId)
  const page = variantMatch ? null : board.pages.find((item) => item.id === pageId)
  const variant = variantMatch ? readVariants(config, board.id).find((item) => item.id === variantMatch[1]) : null
  if (!page && !variant) throw new CommentError(404, 'unknown_page', 'That page is not on this board.')
  const viewport = input?.viewport
  const allowed = page ? page.viewports : Object.keys(boardViewports(config, board))
  if (!allowed.includes(viewport)) throw new CommentError(400, 'invalid_viewport', `Viewport must be one of ${allowed.join(', ')}.`)
  const x = Number(input?.x)
  const y = Number(input?.y)
  if (
    typeof input?.x !== 'number' ||
    typeof input?.y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 100 ||
    y < 0 ||
    y > 100
  ) {
    throw new CommentError(400, 'invalid_position', 'The pin must sit on the page (0 to 100 percent).')
  }
  return {
    pageId,
    viewport,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    // No text is fine when an image or a drawing comes with it (checked by
    // validateCommentMedia, which refuses anything it does not keep).
    body: cleanCommentBody(input?.body, { media: hasCommentMedia(input) }),
    author: cleanAuthor(input?.author),
    anchor: validateAnchor(input?.anchor),
  }
}

// Events go into the shared event log while the comments lock is still held
// (so the log has a board's changes in order); this process's listeners hear
// them once the lock is released.
async function logEvents(config, events) {
  await appendEvents(config, events)
  return events
}

export async function createComment(config, board, input, { now = new Date() } = {}) {
  const clean = validateCommentInput(config, board, input)
  const media = validateCommentMedia(input)
  const file = commentsFile(config, board.id)
  let events = []
  // Written before the lock (new random names), removed again if the
  // comment is not saved.
  const images = saveCommentImages(boardDir(config, board.id), media.images)
  let stored = false
  const saved = await withFileLock(file, async () => {
    assertLocalComments(config, board.id)
    const store = readCommentStore(config, board.id)
    if (store.comments.length >= COMMENTS_MAX)
      throw new CommentError(409, 'too_many_comments', `A board holds at most ${COMMENTS_MAX} comments.`)
    const comment = {
      id: store.nextId,
      ...clean,
      // The capture the reviewer saw, for before/after once it is fixed.
      captureVersion: clean.pageId.startsWith('variant:') ? null : currentVersion(config, board.id, clean.pageId, clean.viewport),
      status: 'open',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      resolvedAt: null,
      resolution: null,
      replies: [],
      agentStatus: null,
      agentStatusAt: null,
    }
    if (!comment.anchor) delete comment.anchor
    if (images.length) comment.images = images
    // The drawing belongs to the capture it was drawn on.
    if (media.drawing) comment.drawing = { ...media.drawing, captureVersion: comment.captureVersion }
    store.comments.push(comment)
    writeJsonAtomic(file, { nextId: store.nextId + 1, comments: store.comments })
    stored = true
    const result = withAgentFields(comment)
    events = await logEvents(config, createdEvents(board.id, result, now))
    return result
  }).finally(() => {
    if (!stored) removeImageFiles(boardDir(config, board.id), images)
  })
  emitCommentEvents(events)
  return saved
}

// Changes a comment: { body } edits it, { status: 'open'|'resolved' } (with an
// optional resolution note) resolves or reopens it, { agentStatus } sets or
// (null) clears the agent status, { fixRef } records what fixed it (null
// clears it). Reopening clears the agent status too, so a reopened comment is
// new work for `shapewall watch`, and counts the reopen (reopenCount, reopenedAt).
// `actor` names who made the change in its events (null: nobody said).
export async function updateComment(config, boardId, commentId, changes, { now = new Date(), actor = null } = {}) {
  const id = Number(commentId)
  if (!Number.isSafeInteger(id) || id <= 0) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
  if (!changes || typeof changes !== 'object') throw new CommentError(400, 'invalid_change', 'Nothing to change.')
  if (changes.status !== undefined && !['open', 'resolved'].includes(changes.status)) {
    throw new CommentError(400, 'invalid_status', 'Status must be open or resolved.')
  }
  if (changes.resolution !== undefined && changes.resolution !== null && typeof changes.resolution !== 'string') {
    throw new CommentError(400, 'invalid_resolution', 'The resolution note must be a string.')
  }
  const agentStatus = changes.agentStatus === undefined ? undefined : cleanAgentStatus(changes.agentStatus)
  const fixRef = changes.fixRef === undefined ? undefined : cleanFixRef(changes.fixRef)
  const file = commentsFile(config, boardId)
  let events = []
  const saved = await withFileLock(file, async () => {
    assertLocalComments(config, boardId)
    const store = readCommentStore(config, boardId)
    const comment = store.comments.find((item) => item.id === id)
    if (!comment) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
    const before = withAgentFields(structuredClone(comment))
    // The text may be emptied only on a comment that has an image or a drawing.
    const body = changes.body !== undefined ? cleanCommentBody(changes.body, { media: hasCommentMedia(before) }) : undefined
    if (body !== undefined && body !== comment.body) {
      comment.body = body
      // Shown as "edited" beside the time.
      comment.editedAt = now.toISOString()
    }
    if (fixRef !== undefined) {
      if (fixRef) comment.fixRef = fixRef
      else delete comment.fixRef
    }
    if (changes.status !== undefined && changes.status !== comment.status) {
      comment.status = changes.status
      comment.resolvedAt = changes.status === 'resolved' ? now.toISOString() : null
      if (changes.status === 'open') {
        comment.resolution = null
        // Reopened: kept, so the board can say so and people see it came back.
        comment.reopenCount = (Number.isSafeInteger(comment.reopenCount) ? comment.reopenCount : 0) + 1
        comment.reopenedAt = now.toISOString()
        if (agentStatus === undefined) setAgent(comment, null, now)
      } else if (agentStatus === undefined && comment.agentStatus !== BRANCH_READY) {
        // Resolved, however it happened (the board, the CLI, MCP): no agent
        // is left "working" on it.
        setAgent(comment, agentStatusOnResolve(before.agentStatus), now)
      }
    }
    if (agentStatus !== undefined) setAgent(comment, agentStatus, now)
    if (typeof changes.resolution === 'string' && comment.status === 'resolved') {
      comment.resolution = changes.resolution.trim().slice(0, COMMENT_BODY_MAX) || null
    }
    comment.updatedAt = now.toISOString()
    writeJsonAtomic(file, { nextId: store.nextId, comments: store.comments })
    const result = withAgentFields(comment)
    events = await logEvents(config, updateEvents(boardId, before, result, now, cleanActor(actor)))
    return result
  })
  emitCommentEvents(events)
  return saved
}

export async function deleteComment(config, boardId, commentId) {
  const id = Number(commentId)
  const file = commentsFile(config, boardId)
  return withFileLock(file, () => {
    assertLocalComments(config, boardId)
    const store = readCommentStore(config, boardId)
    const kept = store.comments.filter((item) => item.id !== id)
    if (kept.length === store.comments.length) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
    writeJsonAtomic(file, { nextId: store.nextId, comments: kept })
    // Its images, its replies' images and its rendered drawings go with it.
    for (const gone of store.comments.filter((item) => item.id === id)) removeCommentMedia(boardDir(config, boardId), gone)
    return true
  })
}

// ---- Replies and agent status ---------------------------------------------------
//
// A comment can carry a thread of replies ({ id, author, body, createdAt };
// an agent signs as "agent") and an agentStatus, the state of the work on
// it: queued (handed to an agent), working, done (the agent thinks it is
// fixed; a person still resolves) or needs-human (the agent stopped and
// asked). `shapewall watch` claims a comment by moving agentStatus from null
// to queued under the file lock, so two watchers never take the same one.
// Agent branch mode adds branch-ready (comment-fields.js), with the branch's
// name in agentBranch while the status lasts.

const REPLIES_MAX = 200
const AGENT_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/

function cleanAgentStatus(value) {
  if (value === null || STORED_AGENT_STATUSES.includes(value)) return value
  throw new CommentError(400, 'invalid_agent_status', `Agent status must be one of ${STORED_AGENT_STATUSES.join(', ')} (or null to clear).`)
}

const cleanAgentBranch = (value) => (typeof value === 'string' && value.length <= 120 && AGENT_BRANCH_RE.test(value) ? value : null)

function setAgent(comment, agentStatus, now, branch = null) {
  if (agentStatus === BRANCH_READY && cleanAgentBranch(branch)) comment.agentBranch = branch
  else delete comment.agentBranch
  if ((comment.agentStatus ?? null) === agentStatus) return
  comment.agentStatus = agentStatus
  comment.agentStatusAt = agentStatus ? now.toISOString() : null
}

function parseCommentId(value) {
  const id = typeof value === 'number' ? value : /^[1-9][0-9]{0,15}$/.test(String(value)) ? Number(value) : NaN
  if (!Number.isSafeInteger(id) || id <= 0) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
  return id
}

// Runs `change(comment)` on one comment under the file lock and saves it,
// unless `change` returns false (nothing to write). `eventsFor(comment,
// result)` lists the events of the change; they are logged under the lock and
// emitted after it.
async function changeComment(config, boardId, commentId, change, now, eventsFor = null) {
  const id = parseCommentId(commentId)
  const file = commentsFile(config, boardId)
  let events = []
  const outcome = await withFileLock(file, async () => {
    assertLocalComments(config, boardId)
    const store = readCommentStore(config, boardId)
    const comment = store.comments.find((item) => item.id === id)
    if (!comment) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
    const result = change(comment)
    if (result === false) return { comment: withAgentFields(comment), changed: false, result }
    comment.updatedAt = now.toISOString()
    writeJsonAtomic(file, { nextId: store.nextId, comments: store.comments })
    const saved = withAgentFields(comment)
    if (eventsFor) events = await logEvents(config, eventsFor(saved, result))
    return { comment: saved, changed: true, result }
  })
  emitCommentEvents(events)
  return outcome
}

const cleanActor = (value) => (typeof value === 'string' && value.trim() ? cleanAuthor(value) : null)

export function getComment(config, boardId, commentId) {
  const id = parseCommentId(commentId)
  const comment = readCommentStore(config, boardId).comments.find((item) => item.id === id)
  if (!comment) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
  return withAgentFields(comment)
}

// Adds a reply. Returns { comment, reply }.
// `images` and `drawing` as on a new comment (validateCommentMedia).
export async function addReply(config, boardId, commentId, input, { now = new Date() } = {}) {
  const body = cleanCommentBody(input?.body, { media: hasCommentMedia(input) })
  const author = cleanAuthor(input?.author)
  const media = validateCommentMedia(input)
  const images = saveCommentImages(boardDir(config, boardId), media.images)
  let stored = false
  try {
    const { comment, result } = await changeComment(
      config,
      boardId,
      commentId,
      (target) => {
        const replies = Array.isArray(target.replies) ? target.replies : []
        if (replies.length >= REPLIES_MAX)
          throw new CommentError(409, 'too_many_replies', `A comment holds at most ${REPLIES_MAX} replies.`)
        const reply = {
          id: Math.max(0, ...replies.map((item) => Number(item.id) || 0)) + 1,
          author,
          body,
          createdAt: now.toISOString(),
        }
        if (images.length) reply.images = images
        if (media.drawing) {
          const version = String(target.pageId).startsWith('variant:')
            ? null
            : currentVersion(config, boardId, target.pageId, target.viewport)
          reply.drawing = { ...media.drawing, captureVersion: version }
        }
        target.replies = [...replies, reply]
        stored = true
        return reply
      },
      now,
      (saved, reply) => replyEvents(boardId, saved, reply, now),
    )
    return { comment, reply: withMedia(result) }
  } finally {
    if (!stored) removeImageFiles(boardDir(config, boardId), images)
  }
}

// Adds or takes away a person's emoji reaction on a comment (replyId null)
// or one of its replies. Returns { comment, added }. A reaction is not work
// on the comment: it keeps updatedAt and sends no events, so watchers,
// webhooks and notifications never see it.
export async function reactToComment(config, boardId, commentId, { emoji, replyId = null, author } = {}) {
  const id = parseCommentId(commentId)
  const file = commentsFile(config, boardId)
  return withFileLock(file, () => {
    assertLocalComments(config, boardId)
    const store = readCommentStore(config, boardId)
    const comment = store.comments.find((item) => item.id === id)
    if (!comment) throw new CommentError(404, 'unknown_comment', 'That comment does not exist.')
    let target = comment
    if (replyId !== null && replyId !== undefined) {
      const wanted = Number(replyId)
      target = (Array.isArray(comment.replies) ? comment.replies : []).find((reply) => Number(reply.id) === wanted)
      if (!target) throw new CommentError(404, 'unknown_reply', 'That reply does not exist.')
    }
    let result
    try {
      result = toggleReaction(target.reactions, emoji, { name: cleanAuthor(author) })
    } catch (error) {
      throw new CommentError(error.code === 'too_many_reactions' ? 409 : 400, error.code || 'invalid_reaction', error.message)
    }
    if (result.reactions.length) target.reactions = result.reactions
    else delete target.reactions
    writeJsonAtomic(file, { nextId: store.nextId, comments: store.comments })
    return { comment: withAgentFields(comment), added: result.added }
  })
}

// Sets the agent status. With `onlyFrom` (a list of current values, null
// meaning unset) the change is a compare-and-set: it happens only when the
// comment is open and its status is one of them. Returns { comment, changed }.
// `actor` names who made the change in its event.
// `branch`: with branch-ready, the name of the branch the fix waits on.
export async function setAgentStatus(
  config,
  boardId,
  commentId,
  agentStatus,
  { onlyFrom = null, now = new Date(), actor = null, branch = null } = {},
) {
  const next = cleanAgentStatus(agentStatus)
  let previous = null
  const { comment, changed } = await changeComment(
    config,
    boardId,
    commentId,
    (target) => {
      const current = STORED_AGENT_STATUSES.includes(target.agentStatus) ? target.agentStatus : null
      if (onlyFrom && (target.status !== 'open' || !onlyFrom.includes(current))) return false
      if (current === next) return false
      previous = current
      setAgent(target, next, now, branch)
    },
    now,
    (saved) => updateEvents(boardId, { ...saved, agentStatus: previous }, saved, now, cleanActor(actor)),
  )
  return { comment, changed }
}

// ---- GitHub links -----------------------------------------------------------------
//
// A comment can point at the GitHub issue made from it and at the pull
// requests that work on it: github: { issue: { number, url, title, createdAt },
// pulls: [{ number, url, title, state, mergedAt, via, linkedAt, notedAt }] }.
// `state` is open, closed or merged; `via` is how the link was made (manual,
// body: a "shapewall:<id>" marker in the PR, issue: the PR closes the issue);
// `notedAt` is when a merge resolved the comment, so that happens once.

export const PULL_STATES = ['open', 'closed', 'merged']
const PULL_VIA = ['manual', 'body', 'issue']
const PULLS_MAX = 20
const GITHUB_URL_RE = /^https?:\/\/[^\s"<>]{1,300}$/

function cleanGithubText(value, max) {
  return typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, max)
    : ''
}

function cleanIssue(issue) {
  if (!issue || typeof issue !== 'object' || !Number.isSafeInteger(issue.number) || issue.number <= 0) return null
  if (!GITHUB_URL_RE.test(String(issue.url || ''))) return null
  return {
    number: issue.number,
    url: issue.url,
    title: cleanGithubText(issue.title, 256),
    createdAt: typeof issue.createdAt === 'string' ? issue.createdAt : null,
  }
}

function cleanPull(pull) {
  if (!pull || typeof pull !== 'object' || !Number.isSafeInteger(pull.number) || pull.number <= 0) return null
  if (!GITHUB_URL_RE.test(String(pull.url || ''))) return null
  return {
    number: pull.number,
    url: pull.url,
    title: cleanGithubText(pull.title, 256),
    state: PULL_STATES.includes(pull.state) ? pull.state : 'open',
    mergedAt: typeof pull.mergedAt === 'string' ? pull.mergedAt : null,
    via: PULL_VIA.includes(pull.via) ? pull.via : 'manual',
    linkedAt: typeof pull.linkedAt === 'string' ? pull.linkedAt : null,
    notedAt: typeof pull.notedAt === 'string' ? pull.notedAt : null,
  }
}

export function cleanGithub(value) {
  const issue = cleanIssue(value?.issue)
  const pulls = (Array.isArray(value?.pulls) ? value.pulls : []).map(cleanPull).filter(Boolean).slice(0, PULLS_MAX)
  return { issue, pulls }
}

// Records the issue made from a comment. Returns the comment.
export async function setGithubIssue(config, boardId, commentId, issue, { now = new Date() } = {}) {
  const clean = cleanIssue({ createdAt: now.toISOString(), ...issue })
  if (!clean) throw new CommentError(400, 'invalid_issue', 'That is not a GitHub issue.')
  const { comment } = await changeComment(
    config,
    boardId,
    commentId,
    (target) => {
      target.github = { ...cleanGithub(target.github), issue: clean }
    },
    now,
  )
  return comment
}

// Links a pull request to a comment, or updates the link (title, state).
// When the pull request has merged and that was not noted yet, an open
// comment is resolved (the PR becomes its fix reference, so before/after
// shows it) and a reply from "github" says so. Returns { comment, changed,
// merged }; merged is true when this call noted the merge.
export async function recordGithubPull(config, boardId, commentId, pull, { via = 'manual', now = new Date() } = {}) {
  const incoming = cleanPull({ ...pull, via })
  if (!incoming) throw new CommentError(400, 'invalid_pull', 'That is not a GitHub pull request.')
  const { comment, changed, result } = await changeComment(
    config,
    boardId,
    commentId,
    (target) => {
      const github = cleanGithub(target.github)
      const index = github.pulls.findIndex((item) => item.number === incoming.number)
      const previous = index >= 0 ? github.pulls[index] : null
      if (!previous && github.pulls.length >= PULLS_MAX) {
        throw new CommentError(409, 'too_many_pulls', `A comment links at most ${PULLS_MAX} pull requests.`)
      }
      const next = {
        ...incoming,
        // A link keeps how it was first made.
        via: previous ? previous.via : incoming.via,
        linkedAt: previous?.linkedAt || now.toISOString(),
        notedAt: previous?.notedAt || null,
      }
      const merging = next.state === 'merged' && !next.notedAt
      if (merging) next.notedAt = now.toISOString()
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return false
      if (index >= 0) github.pulls[index] = next
      else github.pulls.push(next)
      target.github = github
      if (!merging) return { merged: false }
      const label = `pull request #${next.number}${next.title ? ` (${next.title})` : ''}`
      const before = withAgentFields({ ...target })
      let reply = null
      if (target.status === 'open') {
        target.status = 'resolved'
        target.resolvedAt = now.toISOString()
        if (target.agentStatus !== BRANCH_READY) setAgent(target, agentStatusOnResolve(before.agentStatus), now)
        target.resolution = `Merged in ${label}.`.slice(0, COMMENT_BODY_MAX)
        target.fixRef = next.url
      } else if (!target.fixRef) {
        target.fixRef = next.url
      }
      const replies = Array.isArray(target.replies) ? target.replies : []
      if (replies.length < REPLIES_MAX) {
        reply = {
          id: Math.max(0, ...replies.map((item) => Number(item.id) || 0)) + 1,
          author: 'github',
          body: `Merged ${label}: ${next.url}`.slice(0, COMMENT_BODY_MAX),
          createdAt: now.toISOString(),
        }
        target.replies = [...replies, reply]
      }
      return { merged: true, before, reply }
    },
    now,
    // A merge resolves and replies like a person would, so it tells listeners (notifications) the same way.
    (saved, outcome) =>
      outcome?.merged
        ? [
            ...updateEvents(boardId, outcome.before, saved, now, 'github'),
            ...(outcome.reply ? replyEvents(boardId, saved, outcome.reply, now) : []),
          ]
        : [],
  )
  const merged = Boolean(changed && result?.merged)
  return { comment, changed, merged }
}
