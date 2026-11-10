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

import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { ID_RE, frameSize, normalizeConfig } from '../config.js'
import { FILE_MAX as HTML_MAX, withCspMeta } from '../capture/live.js'
import { CssTooLargeError, sanitizeDocument } from '../capture/sanitize.js'
import { ELEMENT_MAP_LIMITS, ElementMapError, parseElementMap } from '../capture/element-map.js'
import { CAPTURE_FILE_RE, VERSION_FILE_RE, VERSION_RE } from '../store.js'
import { ID_PATTERNS, newId } from './crypto.js'
import { transaction } from './db.js'
import { commentFileBytes } from './comment-files.js'
import { openPushIds, staleOpenPushes, tenant } from './tenancy.js'
import { mergeCheckEnvironments, validateCheckEnvironments } from '../checks/environments.js'
import { projectDir } from './projects.js'
import { CHECKS_BUNDLE_MAX, validateChecksBundle } from '../checks/transport.js'
import { listReports } from '../checks/store.js'
import { REPORTS_MAX, validateReport } from '../checks/schema.js'
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
export function cleanDefinition(raw) {
  if (!isObject(raw) || !isObject(raw.board)) throw new PushError(400, 'invalid_board', 'Send { title, viewports, board }.')
  const board = raw.board
  if (!Array.isArray(board.pages) || board.pages.length > PUSH_LIMITS.pages) {
    throw new PushError(400, 'invalid_board', `A pushed board has 1 to ${PUSH_LIMITS.pages} pages.`)
  }
  const picked = {
    title: raw.title,
    viewports: raw.viewports,
    versions: Number.isInteger(raw.versions) ? raw.versions : undefined,
    boards: [
      {
        id: board.id,
        title: board.title,
        baseUrl: board.baseUrl,
        publicUrl: board.publicUrl ?? undefined,
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
      // One environment hosted (compare needs more than a push for now).
      environments: [{ ...normalized.environments[0], id: 'default', title: 'Default' }],
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

function parseName(area, name, board, variantIds = null) {
  if (area === 'captures' || area === 'variants') {
    const match = CAPTURE_FILE_RE.exec(name)
    if (!match) return null
    const owner = name.slice(0, name.indexOf('.'))
    const viewport = match[1]
    if (area === 'captures') {
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

function cleanManifest(raw, board, viewports, files) {
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
      const ok = entry.status === 'ok' && files.has(`captures/${page.id}.${viewport}.png`)
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
        const html = { status: entry.html.status === 'ok' && files.has(`captures/${page.id}.${viewport}.html`) ? 'ok' : 'failed' }
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

  function sweep(now) {
    const cutoff = new Date(now.getTime() - PUSH_LIMITS.openMs).toISOString()
    for (const row of t.all("SELECT id FROM pushes WHERE workspace_id = :ws AND status = 'open' AND created_at < :cutoff", { cutoff }))
      expire(row.id, now)
  }

  function start({ projectId, tokenId, raw, now = new Date() }) {
    const definition = cleanDefinition(raw)
    sweep(now)
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
    const dir = path.join(stagingDir(push.id), area)
    const file = path.join(dir, name)
    if (path.dirname(file) !== dir) throw new PushError(400, 'invalid_file', 'Bad file name.')
    const previous = fs.existsSync(file) ? fs.statSync(file).size : null
    // Checked again on the fresh row: uploads cleaned in parallel all passed
    // the first check before any of them was counted.
    if (previous === null && push.files >= PUSH_LIMITS.files)
      throw new PushError(413, 'too_many_files', `A push holds at most ${PUSH_LIMITS.files} files.`)
    const grow = clean.length - (previous ?? 0)
    if (push.bytes + grow > PUSH_LIMITS.bytes) throw new PushError(413, 'too_large', 'This push is over the size cap.')
    if (workspaceBytesBesides(projectId, board.id) + grow > workspaceQuota) {
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

  // Writes the cleaned manifest and variants, swaps the staging folder in
  // and records the board definition.
  function commit({ pushId, projectId, manifest, variants, checks, now = new Date() }) {
    const push = openPush(pushId, projectId, now)
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
        // Files of variants that are not in the final list go.
        if (area === 'variants' && !parseName(area, name, board, variantIds)) fs.rmSync(path.join(dir, name), { force: true })
        else files.add(`${area}/${name}`)
      }
    }
    fs.rmSync(path.join(staging, 'checks'), { recursive: true, force: true })
    if (keptReports.length) {
      fs.mkdirSync(path.join(staging, 'checks'), { recursive: true })
      for (const r of keptReports) fs.writeFileSync(path.join(staging, 'checks', `${r.id}.json`), JSON.stringify(r))
    }
    fs.mkdirSync(path.join(staging, 'captures'), { recursive: true })
    fs.writeFileSync(path.join(staging, 'captures', 'manifest.json'), JSON.stringify(cleanManifest(manifest, board, viewports, files)))
    fs.writeFileSync(path.join(staging, 'variants.json'), JSON.stringify({ variants: cleanList }))
    const target = path.join(projectDir(dataDir, t.workspaceId, projectId), board.id)
    const old = `${target}.old-${push.id}`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    transaction(db, () => {
      const at = now.toISOString()
      const existing = t.get('SELECT board_id FROM boards WHERE workspace_id = :ws AND project_id = :project AND board_id = :board', {
        project: projectId,
        board: board.id,
      })
      // Rechecked here: other pushes may have committed since this one started.
      if (!existing) {
        const count = t.get('SELECT COUNT(*) AS n FROM boards WHERE workspace_id = :ws AND project_id = :project', { project: projectId }).n
        if (count >= boardsPerProject) throw new PushError(409, 'too_many_boards', `A project holds at most ${boardsPerProject} boards.`)
      }
      const bytes = push.bytes + checkBytes
      const others = t.get(
        'SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = :ws AND NOT (project_id = :project AND board_id = :board)',
        { project: projectId, board: board.id },
      ).n
      if (others + commentFileBytes(t) + bytes > workspaceQuota)
        throw new PushError(413, 'quota_exceeded', 'This workspace is over its storage quota.')
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
      t.run("UPDATE pushes SET status = 'committed', finished_at = :at WHERE workspace_id = :ws AND id = :id", { id: push.id, at })
      // Inside the transaction: if the swap fails, the rows roll back too.
      if (fs.existsSync(target)) fs.renameSync(target, old)
      try {
        fs.renameSync(staging, target)
      } catch (error) {
        if (fs.existsSync(old)) fs.renameSync(old, target)
        throw error
      }
    })
    fs.rmSync(old, { recursive: true, force: true })
    return { board: board.id, files: files.size, pages: board.pages.length, checks: cleanChecks.reports.length }
  }

  return { start, receive, commit, get, expire }
}

// The whole data folder, at start and then every few minutes: open pushes
// past their hour fail and lose their staging folder, staging folders with
// no open push (a crash mid-push) go, and so do board folders a commit left
// behind (`<board>.old-<push>`).
export function sweepStaging({ db, dataDir, now = new Date() }) {
  const cutoff = new Date(now.getTime() - PUSH_LIMITS.openMs).toISOString()
  let removed = 0
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
  const files = path.join(dataDir, 'files')
  for (const ws of fs.existsSync(files) ? fs.readdirSync(files) : []) {
    for (const project of safeList(path.join(files, ws))) {
      for (const name of safeList(path.join(files, ws, project))) {
        if (!/\.old-ps_[a-f0-9]+$/.test(name)) continue
        fs.rmSync(path.join(files, ws, project, name), { recursive: true, force: true })
        removed += 1
      }
    }
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
