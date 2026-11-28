// `shapewall push`, server side. A push uploads one board: its definition
// (pages, groups, journeys; never auth settings, actions or paths), then each
// file, then a commit with the manifest and variants.
//
// Uploads are untrusted, even from our own CLI:
// - file names must match the names the local tool writes, for pages and
//   viewports on the pushed board;
// - live HTML goes through the same sanitizer as a local capture
//   (sanitizeDocument, then the CSP meta tag) and the same 5 MB cap;
// - element maps (<page>.<viewport>.elements.json) are parsed and rebuilt
//   field by field (cleanElementMap), capped at 3 MB;
// - PNGs are decoded and re-encoded (pngjs), which drops every chunk but the
//   pixels, after a header check on their size;
// - the manifest and variants are rebuilt field by field.
// Files land in a staging folder; the commit swaps it in whole, so a board
// never shows half a push.
//
// Environments: a team server keeps one (`default`); on the solo engine a
// push keeps the board's environments, and the other environments'
// captures come as area `env:<id>` (envs/<id>/captures/ in the board
// folder, as on a local board) with their manifests in the commit.

import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { ID_RE, frameSize, normalizeConfig } from '../config.js'
import { FILE_MAX as HTML_MAX, withCspMeta } from '../capture/live.js'
import { CssTooLargeError, sanitizeDocument } from '../capture/sanitize.js'
import { ELEMENT_MAP_LIMITS, ElementMapError, parseElementMap } from '../capture/element-map.js'
import { CAPTURE_FILE_RE, VERSION_FILE_RE, VERSION_RE, entryVersion, versionTime } from '../store.js'
import { referencedVersions } from './retention.js'
import { ID_PATTERNS, newId } from './crypto.js'
import { transaction } from './db.js'
import { commentFileBytes } from './comment-files.js'
import { findApiToken, openPushIds, pushStatus, staleOpenPushes, tenant } from './tenancy.js'
import { mergeCheckEnvironments, validateCheckEnvironments } from '../checks/environments.js'
import { projectDir } from './projects.js'
import { readSoloBinding } from './solo/binding.js'
import { boardJobBusyMessage, readBoardJob } from '../board-job.js'
import { acquireLock, releaseLock } from '../lock.js'
import { CHECKS_BUNDLE_MAX, validateChecksBundle } from '../checks/transport.js'
import { listReports } from '../checks/store.js'
import { REPORT_ID_RE, REPORTS_MAX, validateReport } from '../checks/schema.js'
import { cleanNetworkSummary } from '../capture/network-summary.js'

export const PUSH_LIMITS = {
  checks: CHECKS_BUNDLE_MAX,
  png: 10 * 1024 * 1024,
  html: HTML_MAX,
  elements: ELEMENT_MAP_LIMITS.bytes,
  files: 5000,
  bytes: 1024 * 1024 * 1024,
  pages: 500,
  variants: 200,
  boardsPerProject: 10,
  openMs: 60 * 60_000,
  // All stylesheet text of one live HTML file (style elements and attributes).
  css: 4 * 1024 * 1024,
  // Decoded size of one PNG: 16 megapixels is 64 MB of RGBA.
  pixels: 16_000_000,
  // Everything a workspace stores (committed boards plus open pushes).
  workspaceBytes: 5 * 1024 * 1024 * 1024,
}
// How far ahead of the server's clock a page push's capture time may be.
const FUTURE_SKEW_MS = 10 * 60_000
const PNG_MAX_WIDTH = 3840
const PNG_MAX_HEIGHT = 8000

export class PushError extends Error {
  constructor(status, code, message) {
    super(message)
    this.statusCode = status
    this.code = code
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined)
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

// Only the fields the board shows. normalizeConfig then validates them the
// same way it validates a local config.
//
// Environments: a team server keeps one, `default` (the pushed board's
// first environment, renamed), whatever the push sends. The solo engine
// (`environments: true`, src/hosted/solo/config.js and a push to its bound
// project) keeps the board's own list, as a local board has it: ids,
// titles, base and public URLs (scrubbed of credentials by the CLI), so
// compare works there (src/hosted/board-compare.js).
export function cleanDefinition(raw, { environments = false } = {}) {
  if (!isObject(raw) || !isObject(raw.board)) throw new PushError(400, 'invalid_board', 'Send { title, viewports, board }.')
  const board = raw.board
  if (!Array.isArray(board.pages) || board.pages.length > PUSH_LIMITS.pages) {
    throw new PushError(400, 'invalid_board', `A pushed board has 1 to ${PUSH_LIMITS.pages} pages.`)
  }
  // Only the fields an environment has; the first one is the board's base URL.
  const ownEnvironments =
    environments && Array.isArray(board.environments) && board.environments.length
      ? board.environments.map((env) =>
          isObject(env) ? { id: env.id, title: env.title, baseUrl: env.baseUrl, publicUrl: env.publicUrl ?? undefined } : env,
        )
      : null
  const picked = {
    title: raw.title,
    viewports: raw.viewports,
    // The wire field is `versions` (every CLI sends it); `keepVersions` is
    // taken too. Either way it reaches normalizeConfig as `keepVersions`, so a
    // push never logs the deprecation meant for a local config file.
    keepVersions: [raw.keepVersions, raw.versions].find((value) => Number.isInteger(value)),
    boards: [
      {
        id: board.id,
        title: board.title,
        ...(ownEnvironments ? { environments: ownEnvironments } : { baseUrl: board.baseUrl, publicUrl: board.publicUrl ?? undefined }),
        groups: board.groups,
        pages: board.pages.map((page) =>
          isObject(page)
            ? {
                id: page.id,
                path: page.path,
                title: page.title,
                group: page.group,
                note: page.note || undefined,
                viewports: page.viewports,
                frameHeight: page.frameHeight ?? undefined,
              }
            : page,
        ),
        journeys: board.journeys,
      },
    ],
  }
  let config
  try {
    config = normalizeConfig(JSON.parse(JSON.stringify(picked)), { dir: '/nonexistent' })
  } catch (error) {
    throw new PushError(400, 'invalid_board', error.problems ? `Invalid board: ${error.problems.slice(0, 5).join('; ')}` : 'Invalid board.')
  }
  // Capture-only settings never travel: auth, block lists, setup, seeds.
  // eslint-disable-next-line no-unused-vars
  const { auth, block, reducedMotion, localStorage, setup, viewports, ...normalized } = config.boards[0]
  return {
    title: config.title,
    viewports: config.viewports,
    versions: config.versions,
    board: {
      ...normalized,
      // A team server: one environment, `default`. The solo engine: the board's own.
      environments: ownEnvironments ? normalized.environments : [{ ...normalized.environments[0], id: 'default', title: 'Default' }],
      pages: normalized.pages.map((page) => ({ ...page, waitFor: null, actions: [] })),
    },
  }
}

function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

export function cleanPng(buffer) {
  if (buffer.length > PUSH_LIMITS.png) throw new PushError(413, 'too_large', `Images are limited to ${PUSH_LIMITS.png / 1048576} MB.`)
  const size = pngSize(buffer)
  if (!size) throw new PushError(400, 'invalid_png', 'Not a PNG.')
  if (
    !size.width ||
    !size.height ||
    size.width > PNG_MAX_WIDTH ||
    size.height > PNG_MAX_HEIGHT ||
    size.width * size.height > PUSH_LIMITS.pixels
  ) {
    throw new PushError(
      400,
      'invalid_png',
      `Images are at most ${PNG_MAX_WIDTH}x${PNG_MAX_HEIGHT} pixels and ${PUSH_LIMITS.pixels / 1e6} megapixels.`,
    )
  }
  let image
  try {
    image = PNG.sync.read(buffer)
  } catch {
    throw new PushError(400, 'invalid_png', 'The PNG could not be decoded.')
  }
  return PNG.sync.write(image, { colorType: 6 })
}

// The same pass a local capture's live HTML gets after the snapshot.
export function cleanHtml(buffer, board) {
  if (buffer.length > PUSH_LIMITS.html) throw new PushError(413, 'too_large', `Live HTML is limited to ${PUSH_LIMITS.html / 1048576} MB.`)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new PushError(400, 'invalid_html', 'Live HTML must be UTF-8.')
  }
  let html
  try {
    html = withCspMeta(sanitizeDocument(text, { base: board.publicUrl || board.baseUrl, maxCss: PUSH_LIMITS.css }))
  } catch (error) {
    if (error instanceof CssTooLargeError)
      throw new PushError(413, 'too_large', `The CSS of one live HTML file is limited to ${PUSH_LIMITS.css / 1048576} MB.`)
    throw error
  }
  if (Buffer.byteLength(html) > PUSH_LIMITS.html) throw new PushError(413, 'too_large', 'Live HTML is over the cap after cleaning.')
  return Buffer.from(html)
}

// An element map: valid JSON in the map format, rebuilt, re-serialized,
// measured at its viewport's size (`size`, from the pushed definition).
export function cleanElements(buffer, size = null) {
  if (buffer.length > PUSH_LIMITS.elements)
    throw new PushError(413, 'too_large', `An element map is limited to ${PUSH_LIMITS.elements / 1048576} MB.`)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new PushError(400, 'invalid_elements', 'An element map must be UTF-8 JSON.')
  }
  try {
    const map = parseElementMap(text)
    // `size.heights`: the frame heights a map may have (see elementMapSize).
    if (size && (map.width !== size.width || !(size.heights || [size.height]).includes(map.height)))
      throw new ElementMapError(`measured at ${map.width}x${map.height}, not at its frame's ${size.width}x${size.height}`)
    return Buffer.from(JSON.stringify(map))
  } catch (error) {
    if (error instanceof ElementMapError) throw new PushError(400, 'invalid_elements', `Element map: ${error.message}.`)
    throw error
  }
}

const kindOf = (suffix) => (suffix === '.html' ? 'html' : suffix === '.elements.json' ? 'elements' : 'png')

// Which file a name is: { kind: png|html|elements, owner, viewport } or null.
// The size an element map was measured at: its frame. A page may set its own
// frame height; a variant takes its page's, and which page that is arrives
// later (variants.json), so a variant's map may have any of the board's
// frame heights for that viewport.
function elementMapSize(definition, parsed, area) {
  const size = definition.viewports?.[parsed.viewport]
  if (!size) return null
  const pages = definition.board.pages
  const owners = area === 'variants' ? pages : pages.filter((item) => item.id === parsed.owner)
  const heights = new Set(area === 'variants' ? [size.height] : [])
  for (const page of owners) heights.add(frameSize(size, page, parsed.viewport).height)
  return { width: size.width, height: [...heights][0], heights: [...heights] }
}

// Another environment's captures, as a push names them: `env:<id>` (the
// same kind store.js resolveFile reads). Only on a board that keeps its
// environments (the solo engine), and never its first one: the default
// environment's captures are `captures`, as on a local board.
const ENV_AREA_RE = /^env:([a-z0-9][a-z0-9-]{0,63})$/
export function envArea(area, board) {
  const match = ENV_AREA_RE.exec(String(area))
  if (!match || !board?.environments?.slice(1).some((env) => env.id === match[1])) return null
  return match[1]
}
// The staging (or board) folder of an upload area: envs/<id>/captures for another environment.
function areaDir(root, area, board) {
  const env = envArea(area, board)
  return env ? path.join(root, 'envs', env, 'captures') : path.join(root, area)
}

function parseName(area, name, board, variantIds = null) {
  const env = envArea(area, board)
  if (area === 'captures' || area === 'variants' || env) {
    const match = CAPTURE_FILE_RE.exec(name)
    if (!match) return null
    const owner = name.slice(0, name.indexOf('.'))
    const viewport = match[1]
    if (area !== 'variants') {
      const page = board.pages.find((item) => item.id === owner)
      if (!page || !page.viewports.includes(viewport)) return null
    } else if (!ID_RE.test(owner) || (variantIds && !variantIds.has(owner))) return null
    return { kind: kindOf(match[2]), owner, viewport }
  }
  if (area === 'versions') {
    const match = VERSION_FILE_RE.exec(name)
    if (!match) return null
    const page = board.pages.find((item) => item.id === match[1])
    if (!page || !page.viewports.includes(match[2])) return null
    return { kind: match[4] === '.html' ? 'html' : 'png', owner: match[1], viewport: match[2] }
  }
  return null
}

// `area`: where the files of these captures are in `files` (`captures`, or
// `env:<id>` for another environment's).
function cleanManifest(raw, board, viewports, files, area = 'captures') {
  const manifest = {
    board: board.id,
    capturedAt:
      typeof raw?.capturedAt === 'string' && Number.isFinite(Date.parse(raw.capturedAt)) ? new Date(raw.capturedAt).toISOString() : null,
    durationMs: num(raw?.durationMs) ?? null,
    viewports,
    pages: {},
  }
  const pageIds = new Set(board.pages.map((page) => page.id))
  for (const page of board.pages) {
    manifest.pages[page.id] = {}
    for (const viewport of page.viewports) {
      const entry = raw?.pages?.[page.id]?.[viewport]
      if (!isObject(entry)) continue
      const ok = entry.status === 'ok' && files.has(`${area}/${page.id}.${viewport}.png`)
      const clean = { status: ok ? 'ok' : 'failed' }
      const networkSummary = cleanNetworkSummary(entry.networkSummary)
      if (networkSummary) clean.networkSummary = networkSummary
      if (Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599) clean.httpStatus = entry.httpStatus
      if (entry.expectedStatus === true && clean.httpStatus !== undefined) clean.expectedStatus = true
      const url = str(entry.url, 2000)
      if (url && /^https?:\/\//.test(url)) clean.url = url
      if (!ok) clean.error = str(entry.error, 300) || (entry.status === 'ok' ? 'not pushed' : 'failed')
      if (num(entry.ms) !== undefined) clean.ms = num(entry.ms)
      if (num(entry.bytes) !== undefined) clean.bytes = num(entry.bytes)
      if (ok && typeof entry.version === 'string' && VERSION_RE.test(entry.version)) clean.version = entry.version
      if (isObject(entry.html)) {
        const html = { status: entry.html.status === 'ok' && files.has(`${area}/${page.id}.${viewport}.html`) ? 'ok' : 'failed' }
        for (const key of ['bytes', 'images', 'imagesDropped', 'fonts', 'fontsDropped'])
          if (num(entry.html[key]) !== undefined) html[key] = num(entry.html[key])
        if (typeof entry.html.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.html.sha256)) html.sha256 = entry.html.sha256
        if (html.status !== 'ok') html.error = str(entry.html.error, 200) || 'not pushed'
        clean.html = html
      }
      if (Array.isArray(entry.links)) {
        const links = [...new Set(entry.links.filter((id) => typeof id === 'string' && pageIds.has(id)))].slice(0, 500)
        if (links.length) clean.links = links
      }
      manifest.pages[page.id][viewport] = clean
    }
  }
  return manifest
}

// The files to copy from the board being replaced (`target`) into the push
// (`staging`) so that every version its comments and reply drawings point at
// (`referenced`, retention.js referencedVersions) still resolves to the same
// pixels: the sender may keep less history than the server has. A version
// the push brings itself (in versions/, or as its new current capture) is
// left alone; otherwise it comes from the old board's versions/ or, when it
// was the old board's current capture, from its captures/.
// -> [{ from, to, bytes }]
function planCarry(referenced, target, staging, nextManifest) {
  const plan = []
  let oldManifest = null
  try {
    oldManifest = JSON.parse(fs.readFileSync(path.join(target, 'captures', 'manifest.json'), 'utf8'))
  } catch {
    oldManifest = null
  }
  const size = (file) => {
    try {
      const stat = fs.lstatSync(file)
      return stat.isFile() ? stat.size : null
    } catch {
      return null
    }
  }
  for (const key of referenced) {
    const [pageId, viewport, version] = key.split('\u0000')
    const base = `${pageId}.${viewport}.${version}`
    if (!VERSION_FILE_RE.test(`${base}.png`)) continue
    if (nextManifest.pages?.[pageId]?.[viewport]?.version === version) continue
    if (size(path.join(staging, 'versions', `${base}.png`)) !== null) continue
    const fromVersions = size(path.join(target, 'versions', `${base}.png`)) !== null
    const wasCurrent =
      !fromVersions &&
      oldManifest?.pages?.[pageId]?.[viewport]?.version === version &&
      size(path.join(target, 'captures', `${pageId}.${viewport}.png`)) !== null
    if (!fromVersions && !wasCurrent) continue
    for (const suffix of ['.png', '.thumb.png', '.html']) {
      const from = fromVersions
        ? path.join(target, 'versions', `${base}${suffix}`)
        : path.join(target, 'captures', `${pageId}.${viewport}${suffix}`)
      const to = path.join(staging, 'versions', `${base}${suffix}`)
      const bytes = size(from)
      if (bytes === null || size(to) !== null) continue
      plan.push({ from, to, bytes })
    }
  }
  return plan
}

function cleanVariants(raw, board) {
  const pages = new Set(board.pages.map((page) => page.id))
  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const out = []
  for (const item of Array.isArray(raw) ? raw.slice(0, PUSH_LIMITS.variants) : []) {
    if (!isObject(item) || !ID_RE.test(String(item.id || '')) || !pages.has(item.pageId)) continue
    if (out.some((existing) => existing.id === item.id)) continue
    out.push({
      id: item.id,
      pageId: item.pageId,
      title: text(item.title, 120) || item.id,
      note: text(item.note, 1000),
      source: text(item.source, 500),
      createdAt: typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : null,
    })
  }
  return out
}

// The pages and viewports of a page push, checked against the pushed board:
// { <page id>: [<viewport>, ...] } -> [[page, viewport], ...].
function pagePairs(raw, board) {
  if (!isObject(raw)) throw new PushError(400, 'invalid_pages', 'Send pages as { "<page id>": ["<viewport>", ...] }.')
  const entries = Object.entries(raw)
  if (!entries.length || entries.length > PUSH_LIMITS.pages)
    throw new PushError(400, 'invalid_pages', `A page push names 1 to ${PUSH_LIMITS.pages} pages.`)
  const pairs = []
  for (const [pageId, list] of entries) {
    const page = board.pages.find((item) => item.id === pageId)
    if (!page) throw new PushError(400, 'unknown_page', `No page "${String(pageId).slice(0, 64)}" on board "${board.id}".`)
    if (!Array.isArray(list) || !list.length) throw new PushError(400, 'invalid_pages', `Name the viewports of "${page.id}".`)
    for (const viewport of new Set(list)) {
      if (typeof viewport !== 'string' || !page.viewports.includes(viewport))
        throw new PushError(400, 'unknown_viewport', `Page "${page.id}" has no viewport "${String(viewport).slice(0, 40)}".`)
      pairs.push([page.id, viewport])
    }
  }
  return pairs
}

function regularFile(file) {
  try {
    return fs.lstatSync(file).isFile()
  } catch {
    return false
  }
}

// A board file into a page push's staging folder: a hard link (no bytes
// copied, so the commit holds the write lock only for the walk, and the data
// is already on disk), else a copy that is synced before the commit. Board
// files are never written in place (a push swaps whole folders in, retention
// unlinks), so sharing an inode with the board being replaced is safe.
function linkOrCopy(from, to) {
  try {
    fs.linkSync(from, to)
    return
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EACCES'].includes(error.code)) throw error
  }
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE)
  const fd = fs.openSync(to, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// Links (or copies) the regular files and folders of `from` into `to`
// (relative paths that `keep` accepts), never following a link. Files
// already in `to` stay.
function copyBoard(from, to, keep, relative = '') {
  for (const entry of fs.readdirSync(path.join(from, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    if (entry.isDirectory()) copyBoard(from, to, keep, name)
    else if (entry.isFile() && keep(name)) {
      const dest = path.join(to, name)
      if (fs.existsSync(dest)) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      linkOrCopy(path.join(from, name), dest)
    }
  }
}

// Bytes of the regular files under `dir`.
function folderBytes(dir) {
  let total = 0
  for (const entry of safeEntries(dir)) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) total += folderBytes(file)
    else if (entry.isFile()) total += fs.statSync(file).size
  }
  return total
}

function safeEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export function createPushStore(
  t,
  { db, dataDir, workspaceQuota = PUSH_LIMITS.workspaceBytes, boardsPerProject = PUSH_LIMITS.boardsPerProject },
) {
  const stagingDir = (pushId) => {
    if (!ID_PATTERNS.push.test(pushId)) throw new Error('invalid push id')
    return path.join(dataDir, 'staging', pushId)
  }

  const get = (pushId) =>
    ID_PATTERNS.push.test(String(pushId || ''))
      ? t.get('SELECT * FROM pushes WHERE workspace_id = :ws AND id = :id', { id: pushId }) || null
      : null

  // Whether `projectId` is the solo engine's project (its binding names it):
  // its boards keep their environments. A team server has no binding, so its
  // pushes always collapse to `default`.
  function soloProject(projectId) {
    try {
      return readSoloBinding(db)?.projectId === projectId
    } catch {
      return false
    }
  }

  function sweep(now) {
    const cutoff = new Date(now.getTime() - PUSH_LIMITS.openMs).toISOString()
    for (const row of t.all("SELECT id FROM pushes WHERE workspace_id = :ws AND status = 'open' AND created_at < :cutoff", { cutoff }))
      expire(row.id, now)
  }

  function start({ projectId, tokenId, raw, now = new Date() }) {
    if (isObject(raw) && raw.mode === 'pages') return startPages({ projectId, tokenId, raw, now })
    const solo = soloProject(projectId)
    const definition = cleanDefinition(raw, { environments: solo })
    // The solo engine, pushed by a CLI that did not send the environments
    // (an older one, or an explicit --remote): the board keeps the ones it
    // has (from the bound config file), its first at the pushed base URL.
    const sent = Array.isArray(raw?.board?.environments) && raw.board.environments.length > 0
    if (solo && !sent) {
      const row = t.get('SELECT definition FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
        project: projectId,
        board: definition.board.id,
      })
      const kept = row ? JSON.parse(row.definition).board?.environments : null
      if (Array.isArray(kept) && kept.length > 1)
        definition.board.environments = [
          { ...kept[0], baseUrl: definition.board.baseUrl, publicUrl: definition.board.publicUrl ?? null },
          ...kept.slice(1),
        ]
    }
    sweep(now)
    refuseBoardJob(projectId, definition.board.id)
    const boards = t.all('SELECT board_id FROM boards WHERE workspace_id = :ws AND project_id = :project', { project: projectId })
    if (!boards.some((row) => row.board_id === definition.board.id) && boards.length >= boardsPerProject) {
      throw new PushError(409, 'too_many_boards', `A project holds at most ${boardsPerProject} boards.`)
    }
    const id = newId('ps')
    t.run(
      `INSERT INTO pushes (workspace_id, id, project_id, board_id, token_id, definition, status, created_at)
       VALUES (:ws, :id, :project, :board, :token, :definition, 'open', :at)`,
      {
        id,
        project: projectId,
        board: definition.board.id,
        token: tokenId || null,
        definition: JSON.stringify(definition),
        at: now.toISOString(),
      },
    )
    fs.mkdirSync(stagingDir(id), { recursive: true })
    return {
      id,
      board: definition.board.id,
      // The other environments whose captures this push takes (area
      // env:<id>, manifests in the commit's `environments`): the solo engine
      // only. A team server never lists any, so a CLI sends only the default.
      ...(solo && definition.board.environments.length > 1
        ? { environments: definition.board.environments.slice(1).map((env) => env.id) }
        : {}),
      limits: {
        checks: PUSH_LIMITS.checks,
        png: PUSH_LIMITS.png,
        html: PUSH_LIMITS.html,
        elements: PUSH_LIMITS.elements,
        files: PUSH_LIMITS.files,
        bytes: PUSH_LIMITS.bytes,
      },
    }
  }

  function expire(pushId, now) {
    fs.rmSync(stagingDir(pushId), { recursive: true, force: true })
    t.run("UPDATE pushes SET status = 'failed', finished_at = :at WHERE workspace_id = :ws AND id = :id AND status = 'open'", {
      id: pushId,
      at: now.toISOString(),
    })
  }

  function openPush(pushId, projectId, now) {
    const push = get(pushId)
    if (!push || push.project_id !== projectId) throw new PushError(404, 'unknown_push', 'No such push.')
    if (push.status !== 'open') throw new PushError(409, 'push_closed', 'This push is already finished.')
    if (Date.parse(push.created_at) + PUSH_LIMITS.openMs <= now.getTime()) {
      expire(push.id, now)
      throw new PushError(409, 'push_expired', 'This push is more than an hour old; start a new one.')
    }
    // With a preexisting restore or lost staging directory, receiving another
    // file must not recreate a partial upload that can replace the board.
    if (!fs.existsSync(stagingDir(push.id)))
      throw new PushError(409, 'push_incomplete', 'The files of this push are not on the server any more; start a new push.')
    return { ...push, definition: JSON.parse(push.definition) }
  }

  // Bytes the workspace holds apart from `boardId` of `projectId` (which a
  // push replaces): committed boards, every open push and the images on
  // comments (src/hosted/comment-files.js; a push never replaces those).
  function workspaceBytesBesides(projectId, boardId) {
    const boards = t.get(
      'SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = :ws AND NOT (project_id = :project AND board_id = :board)',
      { project: projectId, board: boardId },
    ).n
    const open = t.get("SELECT COALESCE(SUM(bytes), 0) AS n FROM pushes WHERE workspace_id = :ws AND status = 'open'").n
    return boards + open + commentFileBytes(t)
  }

  // Cleans the file off the event loop (cleaner), then writes it to the
  // push's staging folder. The push is checked again after cleaning: it may
  // have been committed or expired meanwhile.
  async function receive({ pushId, projectId, area, name, body, cleaner, now = () => new Date() }) {
    const first = openPush(pushId, projectId, now())
    const board = first.definition.board
    const parsed = parseName(String(area), String(name), board)
    if (!parsed) throw new PushError(400, 'invalid_file', 'That file name is not one Shapewall writes for this board.')
    // A page push takes only the captures of its own pages and viewports.
    if (
      first.definition.mode === 'pages' &&
      (area !== 'captures' || !first.definition.pairs.some(([page, viewport]) => page === parsed.owner && viewport === parsed.viewport))
    )
      throw new PushError(400, 'invalid_file', 'This page push takes only the captures of the pages and viewports it named.')
    if (!Buffer.isBuffer(body) || !body.length) throw new PushError(400, 'empty_file', 'Send the file as the request body.')
    if (first.files >= PUSH_LIMITS.files) throw new PushError(413, 'too_many_files', `A push holds at most ${PUSH_LIMITS.files} files.`)
    const limit = PUSH_LIMITS[parsed.kind]
    if (body.length > limit) throw new PushError(413, 'too_large', `This file is over the ${limit / 1048576} MB cap.`)
    const base = board.publicUrl || board.baseUrl
    // Maps are small JSON: cleaned here. HTML and PNGs go to the worker pool.
    const clean =
      parsed.kind === 'elements'
        ? cleanElements(body, elementMapSize(first.definition, parsed, area))
        : cleaner
          ? await cleaner.clean(parsed.kind, body, base)
          : parsed.kind === 'html'
            ? cleanHtml(body, board)
            : cleanPng(body)
    const push = openPush(pushId, projectId, now())
    const dir = areaDir(stagingDir(push.id), area, board)
    const file = path.join(dir, name)
    if (path.dirname(file) !== dir) throw new PushError(400, 'invalid_file', 'Bad file name.')
    const previous = fs.existsSync(file) ? fs.statSync(file).size : null
    // Checked again on the fresh row: uploads cleaned in parallel all passed
    // the first check before any of them was counted.
    if (previous === null && push.files >= PUSH_LIMITS.files)
      throw new PushError(413, 'too_many_files', `A push holds at most ${PUSH_LIMITS.files} files.`)
    const grow = clean.length - (previous ?? 0)
    if (push.bytes + grow > PUSH_LIMITS.bytes) throw new PushError(413, 'too_large', 'This push is over the size cap.')
    // A page push keeps the board it adds to, so its bytes count here too.
    const kept =
      push.definition.mode === 'pages'
        ? t.get(
            'SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board',
            {
              project: projectId,
              board: board.id,
            },
          ).n
        : 0
    if (workspaceBytesBesides(projectId, board.id) + kept + grow > workspaceQuota) {
      throw new PushError(413, 'quota_exceeded', 'This workspace is over its storage quota.')
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, clean)
    t.run('UPDATE pushes SET files = files + :files, bytes = bytes + :bytes WHERE workspace_id = :ws AND id = :id', {
      id: push.id,
      files: previous === null ? 1 : 0,
      bytes: grow,
    })
    return { name, bytes: clean.length }
  }

  const boardFolder = (projectId, boardId) => path.join(projectDir(dataDir, t.workspaceId, projectId), boardId)

  // A live board-job lock (<board>/capture.lock, src/board-job.js) in the
  // board's folder: only the solo engine's in-process capture writes one on
  // a server (src/hosted/solo/capture.js), so a team server never refuses here.
  function refuseBoardJob(projectId, boardId) {
    const job = readBoardJob({ outputDir: projectDir(dataDir, t.workspaceId, projectId) }, boardId)
    if (!job) return
    if (job.kind === 'capture')
      throw new PushError(409, 'capture_running', 'A capture of this board is running on the engine. Push again when it finishes.')
    throw new PushError(409, 'board_busy', boardJobBusyMessage(job.kind))
  }

  // The workspace quota with `bytes` as the new size of this board.
  function checkQuota(projectId, boardId, bytes) {
    const others = t.get(
      'SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = :ws AND NOT (project_id = :project AND board_id = :board)',
      { project: projectId, board: boardId },
    ).n
    if (others + commentFileBytes(t) + bytes > workspaceQuota)
      throw new PushError(413, 'quota_exceeded', 'This workspace is over its storage quota.')
  }

  // Swaps the push's staging folder in as the board's folder, inside one
  // write transaction that also marks the push committed. `prepare(at)` runs
  // first in that transaction (after the token is checked again): it finishes
  // the staging folder and writes the board's row. `carried` are files it
  // added to the staging folder that a failed commit takes out again.
  function installBoard({ push, projectId, boardId, credential, carried, prepare, now }) {
    const target = boardFolder(projectId, boardId)
    const staging = stagingDir(push.id)
    const old = `${target}.old-${push.id}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // Written down before the first rename, so a crash anywhere in the swap
    // can be put right from the database's word (recoverSwaps).
    const swap = { push: push.id, workspace: t.workspaceId, project: projectId, board: boardId, hadTarget: fs.existsSync(target) }
    writeSwap(dataDir, swap)
    let settled = false
    // B-8: the board's job lock, held from the check through the swap.
    let held = false
    try {
      transaction(db, () => {
        try {
          commitInLock()
        } catch (error) {
          // Still inside the write lock and nothing committed: the folders
          // go back before anyone else can write (a failed COMMIT itself is
          // settled after the rollback, below.)
          try {
            if (settleSwap(dataDir, swap, false) !== 'kept') removeSwap(dataDir, push.id)
            for (const file of carried) fs.rmSync(file, { force: true })
            settled = true
          } catch {
            /* settled below, or by the sweep */
          }
          throw error
        }
      })
    } catch (error) {
      if (!settled) {
        // COMMIT itself failed (or settling above did): the folders go back
        // to how they were, by what the database says. If that cannot be
        // done now, the journal stays and the next sweep does it.
        try {
          if (settleSwap(dataDir, swap, pushStatus(db, push.id) === 'committed') !== 'kept') removeSwap(dataDir, push.id)
          // The push is open again with only its own uploads (a retry carries again).
          for (const file of carried) fs.rmSync(file, { force: true })
        } catch {
          /* the sweep settles it */
        }
      }
      throw error
    } finally {
      // Moved with the folder it is in: in the old one after a swap (which
      // goes), back in place after a failed one. Only our own lock is removed.
      if (held) for (const dir of [target, old]) releaseLock(path.join(dir, 'capture.lock'))
    }
    function commitInLock() {
      const at = now.toISOString()
      if (credential) {
        const live = findApiToken(db, credential.hash, credential.now().toISOString())
        if (!live || live.id !== credential.id || live.project_id !== projectId || live.workspace_id !== t.workspaceId)
          throw new PushError(401, 'bad_token', 'This token is no longer valid for this project.')
        if (!JSON.parse(live.scopes).includes('push'))
          throw new PushError(403, 'missing_scope', 'This token does not have the "push" scope.')
      }
      // In the write lock: a job that holds the board folder (the solo
      // engine's capture) keeps it until it finishes, however the push's
      // route was spelled. Held, not only checked (B-8): a capture from the
      // terminal (another process, no database lock) cannot take the board
      // between this check and the swap.
      if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink()) {
        held = acquireLock(path.join(target, 'capture.lock'), { kind: 'push' })
        if (!held) {
          refuseBoardJob(projectId, boardId)
          throw new PushError(409, 'board_busy', boardJobBusyMessage('capture'))
        }
      } else refuseBoardJob(projectId, boardId)
      prepare(at)
      t.run("UPDATE pushes SET status = 'committed', finished_at = :at WHERE workspace_id = :ws AND id = :id", { id: push.id, at })
      // Inside the transaction: if the swap fails, the rows roll back too.
      if (fs.existsSync(target)) fs.renameSync(target, old)
      try {
        fs.renameSync(staging, target)
      } catch (error) {
        // Not there: put the old one back. There after all (the rename landed
        // and then reported a failure): settleSwap takes both back.
        if (fs.existsSync(old) && !fs.existsSync(target)) fs.renameSync(old, target)
        throw error
      }
      // The renames on disk before COMMIT: a power loss must not keep the
      // commit and lose the folders it names.
      syncDir(path.dirname(target))
      syncDir(path.dirname(staging))
    }
    try {
      settleSwap(dataDir, swap, true)
      removeSwap(dataDir, push.id)
    } catch {
      /* committed: the sweep removes the old folder */
    }
  }

  // ---- Page pushes ----
  //
  // `{ mode: "pages", board, pages: { <page>: [<viewport>, ...] } }` starts a
  // push that replaces only those pages' captures, for those viewports, on a
  // board already pushed: `shapewall push --page` and recapture_pages of
  // `mcp --remote`. Every other page, the variants, the versions, the
  // checks and the board definition stay as the server has them at commit
  // time (another machine may have pushed meanwhile). Only captures/ files
  // of the named pages and viewports are taken; the commit builds the rest of
  // the staging folder from the board as it is then, inside the write
  // transaction, and swaps it in like a whole push, so a page push is atomic
  // and recoverable the same way.
  //
  // Stale writes: a capture's version starts with the time it was taken
  // (VERSION_RE). The commit refuses the whole push (409 stale_capture) when
  // any page and viewport on the board holds a capture taken later than the
  // one sent, so an older capture never replaces a newer one, whichever
  // machine pushed it. The capture it replaces becomes a version (history and
  // comments made on it keep working); retention trims versions as usual.
  function startPages({ projectId, tokenId, raw, now }) {
    const boardId = String(raw.board || '')
    if (!ID_RE.test(boardId)) throw new PushError(400, 'invalid_board', 'Send { mode: "pages", board, pages }.')
    refuseBoardJob(projectId, boardId)
    const row = t.get('SELECT definition FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
      project: projectId,
      board: boardId,
    })
    if (!row) throw new PushError(404, 'unknown_board', `No board "${boardId}" here yet. Push the whole board first: shapewall push`)
    const definition = JSON.parse(row.definition)
    const pairs = pagePairs(raw.pages, definition.board)
    sweep(now)
    const id = newId('ps')
    t.run(
      `INSERT INTO pushes (workspace_id, id, project_id, board_id, token_id, definition, status, created_at)
       VALUES (:ws, :id, :project, :board, :token, :definition, 'open', :at)`,
      {
        id,
        project: projectId,
        board: boardId,
        token: tokenId || null,
        definition: JSON.stringify({ ...definition, mode: 'pages', pairs }),
        at: now.toISOString(),
      },
    )
    fs.mkdirSync(stagingDir(id), { recursive: true })
    return {
      id,
      board: boardId,
      mode: 'pages',
      pages: Object.fromEntries(pairs.map(([page]) => [page, pairs.filter((pair) => pair[0] === page).map((pair) => pair[1])])),
      limits: {
        png: PUSH_LIMITS.png,
        html: PUSH_LIMITS.html,
        elements: PUSH_LIMITS.elements,
        files: PUSH_LIMITS.files,
        bytes: PUSH_LIMITS.bytes,
      },
    }
  }

  function commitPages({ push, projectId, manifest, credential, now }) {
    const { board, viewports, pairs } = push.definition
    const staging = stagingDir(push.id)
    const target = boardFolder(projectId, board.id)
    const replaced = new Set(pairs.map(([page, viewport]) => `${page}.${viewport}`))
    // What this push brings: the files uploaded for its pages and viewports,
    // and a manifest entry for each, an ok capture with a version.
    const sent = {}
    for (const [page, viewport] of pairs) {
      if (!fs.existsSync(path.join(staging, 'captures', `${page}.${viewport}.png`)))
        throw new PushError(400, 'missing_file', `${page}.${viewport}.png was not uploaded; nothing was committed.`)
      const entry = manifest?.pages?.[page]?.[viewport]
      if (!isObject(entry) || entry.status !== 'ok' || typeof entry.version !== 'string' || !VERSION_RE.test(entry.version))
        throw new PushError(400, 'invalid_manifest', `The manifest needs an ok capture with a version for ${page} (${viewport}).`)
      // The version is the capture's time: one from the future would hold
      // this page against every later push (the stale guard), so a client
      // clock more than ten minutes ahead of the server's is refused.
      const taken = Date.parse(versionTime(entry.version) || '')
      if (!Number.isFinite(taken) || taken > now.getTime() + FUTURE_SKEW_MS)
        throw new PushError(
          400,
          'invalid_manifest',
          `The capture of ${page} (${viewport}) is dated in the future; check this machine's clock.`,
        )
      sent[`${page}.${viewport}`] = entry
    }
    // The staging folder down to this push's own uploads: before each commit
    // attempt (a retry starts again from them) and after a failed one, so a
    // refused commit leaves no copy of the board behind.
    const keepUploads = () => {
      for (const entry of safeList(staging)) {
        if (entry !== 'captures') fs.rmSync(path.join(staging, entry), { recursive: true, force: true })
      }
      for (const name of safeList(path.join(staging, 'captures'))) {
        if (!replaced.has(name.split('.').slice(0, 2).join('.')) || !CAPTURE_FILE_RE.test(name))
          fs.rmSync(path.join(staging, 'captures', name), { force: true })
      }
    }
    let pages = 0
    try {
      installBoard({
        push,
        projectId,
        boardId: board.id,
        credential,
        carried: [],
        now,
        prepare: (at) => {
          // The board as it is now, read in the write transaction.
          const row = t.get('SELECT definition FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
            project: projectId,
            board: board.id,
          })
          if (!row || !fs.existsSync(target))
            throw new PushError(409, 'board_gone', 'The board was removed meanwhile; nothing was committed.')
          const current = JSON.parse(row.definition)
          for (const [page, viewport] of pairs)
            if (!current.board.pages.some((item) => item.id === page && item.viewports.includes(viewport)))
              throw new PushError(409, 'board_changed', `The board no longer has ${page} (${viewport}); push the whole board.`)
          let currentManifest = null
          try {
            currentManifest = JSON.parse(fs.readFileSync(path.join(target, 'captures', 'manifest.json'), 'utf8'))
          } catch {
            currentManifest = null
          }
          const stale = []
          for (const [page, viewport] of pairs) {
            const held = entryVersion(currentManifest?.pages?.[page]?.[viewport], currentManifest)
            if (held && held.slice(0, 19) > sent[`${page}.${viewport}`].version.slice(0, 19)) stale.push(`${page} (${viewport})`)
          }
          if (stale.length)
            throw new PushError(
              409,
              'stale_capture',
              `The board has a newer capture of ${stale.join(', ')} than this push; nothing was committed. Capture again, then push.`,
            )
          keepUploads()
          // Everything else from the board as it is: other pages, variants,
          // versions, checks (hard links where the file system allows).
          // Never through a symlink.
          copyBoard(target, staging, (relative) => {
            // The board's job lock (the commit holds it, B-8) is not carried.
            if (/^capture\.lock(\.|$)/.test(relative)) return false
            if (relative === path.join('captures', 'manifest.json')) return false
            if (path.dirname(relative) === 'captures') return !replaced.has(path.basename(relative).split('.').slice(0, 2).join('.'))
            return true
          })
          // The capture each of these replaces becomes a version, as on a
          // local recapture, unless the board already keeps it.
          for (const [page, viewport] of pairs) {
            const version = entryVersion(currentManifest?.pages?.[page]?.[viewport], currentManifest)
            if (!version || version === sent[`${page}.${viewport}`].version) continue
            for (const suffix of ['.png', '.thumb.png', '.html']) {
              const from = path.join(target, 'captures', `${page}.${viewport}${suffix}`)
              const to = path.join(staging, 'versions', `${page}.${viewport}.${version}${suffix}`)
              if (!regularFile(from) || fs.existsSync(to)) continue
              fs.mkdirSync(path.dirname(to), { recursive: true })
              linkOrCopy(from, to)
            }
          }
          const files = new Set()
          for (const area of ['captures', 'variants', 'versions'])
            for (const name of safeList(path.join(staging, area))) files.add(`${area}/${name}`)
          const merged = { ...(currentManifest || {}), pages: {} }
          // Pages this push leaves keep their version as it is now: an entry
          // from before versions existed takes its version from the run's time,
          // which would otherwise move with the merged capturedAt.
          for (const [page, entries] of Object.entries(currentManifest?.pages || {})) {
            merged.pages[page] = {}
            for (const [viewport, entry] of Object.entries(isObject(entries) ? entries : {})) {
              const version = isObject(entry) && !entry.version ? entryVersion(entry, currentManifest) : null
              merged.pages[page][viewport] = version ? { ...entry, version } : entry
            }
          }
          for (const [page, viewport] of pairs)
            merged.pages[page] = { ...(merged.pages[page] || {}), [viewport]: sent[`${page}.${viewport}`] }
          const times = [currentManifest?.capturedAt, manifest?.capturedAt].filter((value) => Number.isFinite(Date.parse(value || '')))
          merged.capturedAt = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null
          const nextManifest = cleanManifest(merged, current.board, current.viewports || viewports, files)
          fs.mkdirSync(path.join(staging, 'captures'), { recursive: true })
          fs.writeFileSync(path.join(staging, 'captures', 'manifest.json'), JSON.stringify(nextManifest))
          const bytes = folderBytes(staging)
          checkQuota(projectId, board.id, bytes)
          t.run(
            'UPDATE boards SET pushed_at = :at, push_count = push_count + 1, bytes = :bytes WHERE workspace_id = :ws AND project_id = :project AND board_id = :board',
            { at, bytes, project: projectId, board: board.id },
          )
          pages = new Set(pairs.map(([page]) => page)).size
        },
      })
    } catch (error) {
      try {
        if (fs.existsSync(staging)) keepUploads()
      } catch {
        /* the push expires within the hour, and its staging folder with it */
      }
      throw error
    }
    return { board: board.id, mode: 'pages', files: push.files, pages, viewports: pairs.length, checks: 0 }
  }

  // Writes the cleaned manifest and variants, swaps the staging folder in
  // and records the board definition.
  // `environments`: { <env id>: manifest } of the other environments' captures
  // this push sent (start() lists which it takes; ignored on a team server).
  function commit({ pushId, projectId, manifest, variants, checks, environments = null, now = new Date(), credential }) {
    const push = openPush(pushId, projectId, now)
    if (push.definition.mode === 'pages') return commitPages({ push, projectId, manifest, credential, now })
    const { board, viewports } = push.definition
    const staging = stagingDir(push.id)
    let cleanChecks = { schemaVersion: 1, reports: [] }
    if (checks !== undefined) {
      try {
        cleanChecks = validateChecksBundle(checks, board, viewports)
      } catch {
        throw new PushError(400, 'invalid_checks', 'Invalid or oversized checks bundle for this board.')
      }
    }
    const previousRow = t.get('SELECT definition FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
      project: projectId,
      board: board.id,
    })
    const previousDefinition = previousRow ? JSON.parse(previousRow.definition) : null
    const previousEnvironments = previousDefinition
      ? validateCheckEnvironments(previousDefinition.checksEnvironments || [{ id: 'default', captured: true }])
      : []
    let checksEnvironments
    try {
      checksEnvironments = mergeCheckEnvironments(
        previousEnvironments.length || checks !== undefined ? previousEnvironments : [{ id: 'default', captured: true }],
        checks === undefined ? null : cleanChecks.environments || [{ id: 'default', captured: true }],
      )
    } catch {
      throw new PushError(
        400,
        'invalid_checks_environments',
        'Diagnostic environments exceed their bound or conflict. Nothing was committed.',
      )
    }
    // Existing reports are read against their retained descriptors, never just
    // the new push's one capture environment. Ordinary pushes preserve history.
    const existingReports = previousDefinition
      ? listReports(
          {
            outputDir: projectDir(dataDir, t.workspaceId, projectId),
            boards: [board],
            viewports,
            checksEnvironments: previousEnvironments,
          },
          board.id,
        )
      : []
    push.definition.checksEnvironments = checksEnvironments
    const merged = new Map(existingReports.map((r) => [r.id, r]))
    for (const report of cleanChecks.reports) {
      const existing = merged.get(report.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(report)) {
        // Older clients remapped the source's first environment to default.
        // Recognize that exact legacy representation on replay, retaining the
        // immutable stored report rather than rewriting its environment.
        const legacy =
          report.environment !== 'default' &&
          existing.environment === 'default' &&
          existing.profile.sourceEnvironment === report.environment
            ? validateReport({ ...report, environment: 'default', profile: { ...report.profile, sourceEnvironment: report.environment } })
            : null
        if (!legacy || JSON.stringify(existing) !== JSON.stringify(legacy))
          throw new PushError(409, 'check_conflict', 'A check report id already has different immutable content.')
        continue
      }
      merged.set(report.id, report)
    }
    const keptReports = [...merged.values()].sort((a, b) => b.auditedAt.localeCompare(a.auditedAt)).slice(0, REPORTS_MAX)
    const keptIds = new Set(keptReports.map((report) => report.id))
    if (cleanChecks.reports.some((report) => !keptIds.has(report.id)))
      throw new PushError(
        409,
        'checks_retention',
        'An explicitly included check report falls outside the retained history limit. Nothing was committed.',
      )
    const checkBytes = keptReports.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0)
    if (push.bytes + checkBytes > PUSH_LIMITS.bytes) throw new PushError(413, 'too_large', 'This push exceeds its storage cap.')
    const cleanList = cleanVariants(variants, board)
    const variantIds = new Set(cleanList.map((item) => item.id))
    const files = new Set()
    for (const area of ['captures', 'variants', 'versions']) {
      const dir = path.join(staging, area)
      if (!fs.existsSync(dir)) continue
      for (const name of fs.readdirSync(dir)) {
        // Files of variants that are not in the final list go, and so does a
        // carried version a crash cut short (it never got its own name).
        if ((area === 'variants' && !parseName(area, name, board, variantIds)) || name.endsWith(CARRYING))
          fs.rmSync(path.join(dir, name), { force: true })
        else files.add(`${area}/${name}`)
      }
    }
    fs.rmSync(path.join(staging, 'checks'), { recursive: true, force: true })
    if (keptReports.length) {
      fs.mkdirSync(path.join(staging, 'checks'), { recursive: true })
      for (const r of keptReports) fs.writeFileSync(path.join(staging, 'checks', `${r.id}.json`), JSON.stringify(r))
    }
    fs.mkdirSync(path.join(staging, 'captures'), { recursive: true })
    const nextManifest = cleanManifest(manifest, board, viewports, files)
    fs.writeFileSync(path.join(staging, 'captures', 'manifest.json'), JSON.stringify(nextManifest))
    // The other environments' captures (the solo engine only: a team
    // board has one environment, so no env: area was ever taken), each with
    // its own manifest, in envs/<id>/captures as on a local board.
    for (const env of board.environments.slice(1)) {
      const area = `env:${env.id}`
      const dir = areaDir(staging, area, board)
      const names = fs.existsSync(dir) ? fs.readdirSync(dir) : []
      for (const name of names) files.add(`${area}/${name}`)
      const raw = isObject(environments) ? environments[env.id] : undefined
      if (!names.length && !isObject(raw)) continue
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(cleanManifest(raw, board, viewports, files, area)))
    }
    fs.writeFileSync(path.join(staging, 'variants.json'), JSON.stringify({ variants: cleanList }))
    const target = boardFolder(projectId, board.id)
    // History the board's comments point at, copied over from the board
    // being replaced (carryReferenced); taken out again if the commit fails.
    const carried = []
    installBoard({
      push,
      projectId,
      boardId: board.id,
      credential,
      carried,
      now,
      prepare: (at) => {
        const existing = t.get('SELECT board_id FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
          project: projectId,
          board: board.id,
        })
        // Rechecked here: other pushes may have committed since this one started.
        if (!existing) {
          const count = t.get('SELECT COUNT(*) AS n FROM boards WHERE workspace_id = :ws AND project_id = :project', {
            project: projectId,
          }).n
          if (count >= boardsPerProject) throw new PushError(409, 'too_many_boards', `A project holds at most ${boardsPerProject} boards.`)
        }
        // Read in the transaction: no comment can pin a version between this
        // and the swap. Their bytes count once, with the board's.
        const plan = existing ? planCarry(referencedVersions(t, projectId, board.id), target, staging, nextManifest) : []
        // Files the board keeps that no push sends (the solo engine's board
        // journeys, the kept reports' search previews), read now, in the
        // lock, and carried over whole.
        const local = boardLocalFiles(target, [...keptIds])
        const bytes =
          push.bytes + checkBytes + plan.reduce((n, item) => n + item.bytes, 0) + local.reduce((n, item) => n + item.data.length, 0)
        checkQuota(projectId, board.id, bytes)
        if (plan.length) fs.mkdirSync(path.join(staging, 'versions'), { recursive: true })
        // Each under a temporary name, renamed when whole: a crash mid-copy
        // never leaves a cut-short file under a name a retry would install.
        for (const item of plan) {
          const temp = `${item.to}${CARRYING}`
          fs.copyFileSync(item.from, temp)
          carried.push(temp)
          fs.renameSync(temp, item.to)
          carried.push(item.to)
        }
        for (const item of local) {
          const to = path.join(staging, item.name)
          fs.mkdirSync(path.dirname(to), { recursive: true })
          const temp = `${to}${CARRYING}`
          fs.writeFileSync(temp, item.data, { flag: 'wx', mode: 0o600 })
          carried.push(temp)
          fs.renameSync(temp, to)
          carried.push(to)
        }
        const definition = JSON.stringify(push.definition)
        if (existing) {
          t.run(
            'UPDATE boards SET definition = :definition, pushed_at = :at, push_count = push_count + 1, bytes = :bytes WHERE workspace_id = :ws AND project_id = :project AND board_id = :board',
            { definition, at, bytes, project: projectId, board: board.id },
          )
        } else {
          t.run(
            `INSERT INTO boards (workspace_id, project_id, board_id, definition, pushed_at, push_count, bytes, created_at)
             VALUES (:ws, :project, :board, :definition, :at, 1, :bytes, :at)`,
            { project: projectId, board: board.id, definition, at, bytes },
          )
        }
      },
    })
    return { board: board.id, files: files.size, pages: board.pages.length, checks: cleanChecks.reports.length }
  }

  return { start, receive, commit, get, expire }
}

// ---- The swap, recoverable ----
//
// A commit renames the board's folder aside (`<board>.old-<push>`) and the
// staging folder in, inside the transaction that marks the push committed.
// SQLite cannot roll back a rename: a crash between the renames and COMMIT
// would leave the old row without its files, or pointing at the new ones.
// So before the first rename a journal (<data>/swaps/<push>.json, synced)
// names the folders, and it goes once the outcome is settled. settleSwap
// then follows the database: committed, the new folder stays and the old
// one goes; not committed, the folders are put back as they were before the
// commit (the staging folder too, so the push can be committed again or
// expire). Nothing is deleted that the database does not show replaced.

const swapsDir = (dataDir) => path.join(dataDir, 'swaps')
// A carried version file while it is copied (push.js commit).
const CARRYING = '.carrying'

// Files in a board's folder that belong to the board, not to a push: no push
// uploads them (only captures/, variants/, versions/, checks/ and, on the
// solo engine, envs/<id>/captures/), so a whole
// push carries them over from the folder it replaces, or they would be lost.
// journeys.json: the journeys made on the board on the solo engine
// (src/hosted/solo/journeys.js, src/journeys.js). A team server never writes
// one, so there is nothing to carry there. A page push keeps them anyway
// (it copies everything outside captures/).
// checks/seo/<report>.json: a checks report's search preview, written only
// by a checks run on the server (src/checks/seo-snapshot.js; no checks
// bundle carries one). Carried for each report the push keeps, so a
// dropped report's preview goes with it, as saveSnapshot keeps no more
// previews than reports.
export const BOARD_LOCAL_FILES = Object.freeze(['journeys.json'])
export const SEO_PREVIEW_DIR = 'checks/seo'
const BOARD_LOCAL_MAX = 4 * 1024 * 1024

// A folder under the board folder that is a real directory, not a link.
function realDir(dir, rel) {
  let at = dir
  for (const part of rel.split('/')) {
    at = path.join(at, part)
    try {
      if (!fs.lstatSync(at).isDirectory()) return false
    } catch {
      return false
    }
  }
  return true
}

// -> [{ name, data }] of the board-local files in `dir` (and the search
// previews of `reportIds`): regular files only, at most BOARD_LOCAL_MAX bytes
// each. lstat first, then open with O_NOFOLLOW and O_NONBLOCK, so nothing here
// ever blocks inside the write lock: a FIFO swapped in after the lstat opens
// at once and is refused by the fstat (rev58 RR1-L2).
// A BOARD_LOCAL_FILES file that cannot be carried (a link, a FIFO or other
// special file, or too large) refuses the commit: the swap would drop it, and
// the journeys with it (rev58 RR1-L3). A search preview that cannot be carried
// is left behind, as before: the next checks run writes it again.
function boardLocalFiles(dir, reportIds = []) {
  const found = []
  const seo = realDir(dir, SEO_PREVIEW_DIR)
    ? reportIds.filter((id) => REPORT_ID_RE.test(String(id))).map((id) => `${SEO_PREVIEW_DIR}/${id}.json`)
    : []
  const refuse = (name) => {
    throw new PushError(
      409,
      'board_local_unreadable',
      `The board's ${name} on this server is not a regular file of at most ${BOARD_LOCAL_MAX / 1024 / 1024} MB, so this push would lose it. Move it aside or fix it, then push again.`,
    )
  }
  for (const name of [...BOARD_LOCAL_FILES, ...seo]) {
    const file = path.join(dir, name)
    const unreadable = BOARD_LOCAL_FILES.includes(name) ? refuse : () => null
    let seen
    try {
      seen = fs.lstatSync(file)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue
      throw error
    }
    if (!seen.isFile() || seen.size > BOARD_LOCAL_MAX) {
      unreadable(name)
      continue
    }
    let fd
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    } catch (error) {
      // Gone since the lstat: nothing to carry.
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue
      if (['ELOOP', 'ENXIO', 'EMLINK'].includes(error.code)) {
        unreadable(name)
        continue
      }
      throw error
    }
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > BOARD_LOCAL_MAX) {
        unreadable(name)
        continue
      }
      const data = fs.readFileSync(fd)
      if (data.length > BOARD_LOCAL_MAX) {
        unreadable(name)
        continue
      }
      found.push({ name, data })
    } finally {
      fs.closeSync(fd)
    }
  }
  return found
}
const swapFile = (dataDir, pushId) => {
  if (!ID_PATTERNS.push.test(pushId)) throw new Error('invalid push id')
  return path.join(swapsDir(dataDir), `${pushId}.json`)
}
function syncDir(dir) {
  let fd = null
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* not every platform syncs a folder */
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
function writeSwap(dataDir, swap) {
  fs.mkdirSync(swapsDir(dataDir), { recursive: true, mode: 0o700 })
  const file = swapFile(dataDir, swap.push)
  const temp = `${file}.tmp`
  const fd = fs.openSync(temp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(swap))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
  syncDir(swapsDir(dataDir))
}
function removeSwap(dataDir, pushId) {
  fs.rmSync(swapFile(dataDir, pushId), { force: true })
}
// -> 'committed' | 'restored' | 'kept' (both folders there: left for the operator).
function settleSwap(dataDir, swap, committed) {
  const target = path.join(projectDir(dataDir, swap.workspace, swap.project), swap.board)
  const old = `${target}.old-${swap.push}`
  const staging = path.join(dataDir, 'staging', swap.push)
  if (committed) {
    fs.rmSync(old, { recursive: true, force: true })
    syncDir(path.dirname(target))
    return 'committed'
  }
  const has = (file) => fs.existsSync(file)
  // The new folder went in (its staging folder is gone, and the target is
  // either new or the old one was moved aside): take it back out.
  if (!has(staging) && has(target) && (has(old) || !swap.hadTarget)) {
    fs.mkdirSync(path.dirname(staging), { recursive: true })
    fs.renameSync(target, staging)
  }
  if (has(old)) {
    if (has(target)) return 'kept'
    fs.renameSync(old, target)
  }
  // On disk before the journal goes.
  syncDir(path.dirname(target))
  syncDir(path.dirname(staging))
  return 'restored'
}

// Swaps a crash left unsettled: the journals first, then `<board>.old-<push>`
// folders without one (from a build before the journal). -> { settled, kept }
export function recoverSwaps({ db, dataDir, log = () => {} }) {
  const result = { settled: 0, kept: [] }
  const journals = safeList(swapsDir(dataDir))
  for (const name of journals) {
    const file = path.join(swapsDir(dataDir), name)
    if (name.endsWith('.tmp')) {
      // Never got as far as a rename.
      fs.rmSync(file, { force: true })
      continue
    }
    let swap
    try {
      swap = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      result.kept.push(`swaps/${name}`)
      continue
    }
    if (
      !ID_PATTERNS.push.test(String(swap?.push)) ||
      name !== `${swap.push}.json` ||
      !ID_PATTERNS.workspace.test(String(swap.workspace)) ||
      !ID_PATTERNS.project.test(String(swap.project)) ||
      !ID_RE.test(String(swap.board))
    ) {
      result.kept.push(`swaps/${name}`)
      continue
    }
    const outcome = settleSwap(dataDir, swap, pushStatus(db, swap.push) === 'committed')
    if (outcome === 'kept') result.kept.push(`files/${swap.workspace}/${swap.project}/${swap.board}.old-${swap.push}`)
    else {
      removeSwap(dataDir, swap.push)
      result.settled += 1
    }
  }
  const files = path.join(dataDir, 'files')
  for (const ws of safeList(files)) {
    if (!ID_PATTERNS.workspace.test(ws)) continue
    for (const project of safeList(path.join(files, ws))) {
      if (!ID_PATTERNS.project.test(project)) continue
      for (const name of safeList(path.join(files, ws, project))) {
        const match = /^(.+)\.old-(ps_[a-f0-9]+)$/.exec(name)
        if (!match || !ID_RE.test(match[1]) || !ID_PATTERNS.push.test(match[2])) continue
        // An old folder exists only after the first rename: the board had one.
        const swap = { push: match[2], workspace: ws, project, board: match[1], hadTarget: true }
        const status = pushStatus(db, swap.push)
        // A push this database does not know: nothing proves the folder replaced.
        const outcome = status === null ? 'kept' : settleSwap(dataDir, swap, status === 'committed')
        if (outcome === 'kept') result.kept.push(`files/${ws}/${project}/${name}`)
        else result.settled += 1
      }
    }
  }
  result.kept = [...new Set(result.kept)]
  for (const item of result.kept) log(`staging sweep: left ${item} in place; check it by hand`)
  return result
}

// The whole data folder, at start and then every few minutes: unsettled
// swaps are settled first (recoverSwaps), then open pushes past their hour
// fail and lose their staging folder, and staging folders with no open push
// (a crash mid-push) go.
export function sweepStaging({ db, dataDir, now = new Date(), log = () => {} }) {
  const cutoff = new Date(now.getTime() - PUSH_LIMITS.openMs).toISOString()
  let removed = recoverSwaps({ db, dataDir, log }).settled
  for (const row of staleOpenPushes(db, cutoff)) {
    createPushStore(tenant(db, row.workspace_id), { db, dataDir }).expire(row.id, now)
    removed += 1
  }
  const staging = path.join(dataDir, 'staging')
  const open = openPushIds(db)
  for (const name of fs.existsSync(staging) ? fs.readdirSync(staging) : []) {
    if (open.has(name)) continue
    fs.rmSync(path.join(staging, name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
