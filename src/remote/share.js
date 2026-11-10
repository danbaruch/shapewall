// Moving a local board uses the same pipeline from CLI and the host-only UI.
// Push only the public definition and capture allowlist, then validated,
// inert comments. Local paths contribute only to opaque import-key hashes.
import fs from 'node:fs'
import path from 'node:path'
import { withFileLock } from '../lock.js'
import { boardViewports, getBoard, loadConfig } from '../config.js'
import {
  CAPTURE_FILE_RE,
  VERSION_FILE_RE,
  VERSION_RE,
  listComments,
  readManifest,
  readMigration,
  readVariants,
  writeMigration,
} from '../store.js'
import { listJourneys } from '../journeys.js'
import { createRemote, pushDefinition, pushFiles, remoteOrigin, remoteSettings } from './remote.js'
import { login } from './login.js'
import { portableChecks } from '../checks/transport.js'
import { safeOut } from './terminal.js'
import { hash, mapFile, readMap, updateMap } from './share-state.js'

const fields = [
  'id',
  'pageId',
  'viewport',
  'x',
  'y',
  'body',
  'author',
  'anchor',
  'captureVersion',
  'status',
  'createdAt',
  'updatedAt',
  'resolvedAt',
  'resolution',
  'agentStatus',
  'agentStatusAt',
  'reopenCount',
  'reopenedAt',
  'fixRef',
  'editedAt',
]
export function portableComment(comment, projectPath, boardId) {
  const out = Object.fromEntries(fields.filter((key) => comment[key] !== undefined).map((key) => [key, comment[key]]))
  delete out.id
  out.authorKind = comment.authorAgent ? 'agent' : comment.authorGuest ? 'guest' : 'local'
  if (comment.anchor)
    out.anchor = Object.fromEntries(
      ['selector', 'text', 'dx', 'dy', 'w', 'h']
        .filter((key) => comment.anchor[key] !== undefined)
        .map((key) => [key, comment.anchor[key]]),
    )
  out.localId = comment.id
  out.importKey = hash(`${projectPath}\0${boardId}\0${comment.id}\0${comment.createdAt}`)
  out.reactions = (comment.reactions || []).map(({ emoji, count }) => ({ emoji, count }))
  out.replies = (comment.replies || []).map((reply) => ({
    author: reply.author,
    body: reply.body,
    createdAt: reply.createdAt,
    ...(reply.editedAt ? { editedAt: reply.editedAt } : {}),
    ...(reply.agent ? { agent: true } : {}),
    ...(reply.guest ? { guest: true } : {}),
    reactions: (reply.reactions || []).map(({ emoji, count }) => ({ emoji, count })),
  }))
  return out
}

export function shareFiles(config, board) {
  const pages = new Map(board.pages.map((page) => [page.id, new Set(page.viewports)]))
  const variants = new Set(readVariants(config, board.id).map((variant) => variant.id))
  return pushFiles(config, board).filter(([area, name]) => {
    if (area === 'versions') {
      const version = VERSION_FILE_RE.exec(name)
      return Boolean(version && pages.get(version[1])?.has(version[2]))
    }
    if (!CAPTURE_FILE_RE.test(name)) return false
    const [id, viewport] = name.split('.')
    return area === 'variants' ? variants.has(id) : Boolean(pages.get(id)?.has(viewport))
  })
}

// Strip metadata before it crosses the wire, rather than relying on the
// destination server to discard local-only keys after receiving them.
export function portableManifest(config, board, raw) {
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const at =
    typeof raw?.capturedAt === 'string' && Number.isFinite(Date.parse(raw.capturedAt)) ? new Date(raw.capturedAt).toISOString() : null
  const out = {
    board: board.id,
    capturedAt: at,
    ...(number(raw?.durationMs) ? { durationMs: raw.durationMs } : {}),
    viewports: boardViewports(config, board),
    pages: {},
  }
  const ids = new Set(board.pages.map((page) => page.id))
  for (const page of board.pages) {
    out.pages[page.id] = {}
    for (const viewport of page.viewports) {
      const shot = raw?.pages?.[page.id]?.[viewport]
      if (!shot) continue
      const clean = { status: shot.status === 'ok' ? 'ok' : 'failed' }
      for (const key of ['ms', 'bytes']) if (number(shot[key])) clean[key] = shot[key]
      if (typeof shot.version === 'string' && VERSION_RE.test(shot.version)) clean.version = shot.version
      if (Array.isArray(shot.links)) clean.links = shot.links.filter((id) => typeof id === 'string' && ids.has(id)).slice(0, 500)
      if (shot.status !== 'ok') clean.error = 'Capture failed locally'
      if (shot.html) {
        clean.html = { status: shot.html.status === 'ok' ? 'ok' : 'failed' }
        for (const key of ['bytes', 'images', 'imagesDropped', 'fonts', 'fontsDropped'])
          if (number(shot.html[key])) clean.html[key] = shot.html[key]
        if (typeof shot.html.sha256 === 'string' && /^[a-f0-9]{64}$/.test(shot.html.sha256)) clean.html.sha256 = shot.html.sha256
        if (shot.html.status !== 'ok') clean.html.error = 'Live snapshot unavailable'
      }
      out.pages[page.id][viewport] = clean
    }
  }
  return out
}
export function portableVariants(variants) {
  return variants.map((variant) =>
    Object.fromEntries(
      ['id', 'pageId', 'title', 'note', 'createdAt'].filter((key) => typeof variant[key] === 'string').map((key) => [key, variant[key]]),
    ),
  )
}

function portableDefinition(config, board) {
  const definition = pushDefinition(config, board)
  for (const field of ['baseUrl', 'publicUrl']) {
    if (!definition.board[field]) continue
    const url = new URL(definition.board[field])
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    definition.board[field] = url.href
  }
  return definition
}

// Read only regular capture files inside their real output tree. A planted
// symlink must never turn a capture upload into arbitrary local-file access.
function readCapture(config, file, cap) {
  cap = Math.min(typeof cap === 'number' && Number.isFinite(cap) ? cap : 0, 11 * 1024 * 1024)
  const relative = path.relative(config.outputDir, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Capture file is outside the output directory.')
  let current = config.outputDir
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Refusing to upload a symlinked capture or capture directory.')
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > cap)
      throw new Error(`Capture ${path.basename(file)} exceeds the server limit or is not a regular file; nothing was silently skipped.`)
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// The route has a 2 MiB wire cap. Leave room for the envelope and keys;
// rich threads split by bytes as well as the 200-comment count limit.
export function importBatches(comments, maxBytes = 1800000) {
  const batches = []
  let batch = [],
    bytes = 2
  for (const comment of comments) {
    const size = Buffer.byteLength(JSON.stringify(comment), 'utf8') + 1
    if (size > maxBytes) throw new Error(`Comment #${comment.localId} is too large to import; reduce its reply history before moving.`)
    if (batch.length && (batch.length === 200 || bytes + size > maxBytes)) {
      batches.push(batch)
      batch = []
      bytes = 2
    }
    batch.push(comment)
    bytes += size
  }
  if (batch.length) batches.push(batch)
  return batches
}

async function runShare(
  flags,
  print,
  {
    config = loadConfig(flags.config),
    env = process.env,
    fetchImpl = fetch,
    loginImpl = login,
    signal = null,
    open,
    beforeFreeze = () => {},
  } = {},
) {
  const out = safeOut(print)
  const origin = remoteOrigin(flags, env)
  const boards = flags.board ? [getBoard(config, flags.board)] : config.boards
  const projectPath = fs.realpathSync(config.dir)
  const plans = boards.map((board) => ({
    board,
    checks: portableChecks(config, board, { includeChecks: !!flags['include-checks'] }),
    comments: flags['no-comments'] ? [] : listComments(config, board.id).map((item) => portableComment(item, projectPath, board.id)),
    files: shareFiles(config, board),
  }))
  if (flags['dry-run']) {
    for (const { board, comments, files, checks } of plans)
      out(
        `Would move ${board.id}: ${files.length} capture/history files, ${comments.length} comments, ${comments.reduce((n, c) => n + c.replies.length, 0)} replies${checks ? `, ${checks.reports.length} check reports` : ''} to ${origin}. Remote conflicts are unknown: dry-run sends nothing.`,
      )
    return { code: 0, dryRun: true }
  }
  let settings
  try {
    settings = remoteSettings(flags, env)
  } catch {
    settings = null
  }
  let remote = settings && createRemote({ ...settings, fetchImpl })
  let project = null
  if (remote) {
    try {
      project = await remote.project()
    } catch (error) {
      if (error.status === 401 && settings.source === 'login') remote = null
      else throw error
    }
  }
  const maps = readMap(config, origin)
  const needsImport = plans.some(({ board, comments }) =>
    comments.some(
      (item) =>
        maps.boards[board.id]?.projectId !== project?.project.id ||
        maps.boards[board.id]?.comments?.[item.localId]?.localHash !== hash(item),
    ),
  )
  if (!remote || (needsImport && !project.token.scopes.includes('import'))) {
    if (env.SHAPEWALL_TOKEN || flags['token-file'])
      throw new Error(
        'This token has no one-time import scope. Unset SHAPEWALL_TOKEN/--token-file, then run shapewall share to approve a moving-project login.',
      )
    out('Sign in to move a local project. Pick or create its destination and check the one-time Import box.')
    await loginImpl(flags, out, { env, fetchImpl, purpose: 'import', signal, ...(open ? { open } : {}) })
    settings = remoteSettings(flags, env)
    remote = createRemote({ ...settings, fetchImpl })
    project = await remote.project()
  }
  if (needsImport && !project.token.scopes.includes('import'))
    throw new Error('The Import checkbox was not approved. Run shapewall share again and approve the one-time import grant.')
  const urls = []
  const conflicts = []
  // Stable across a crash, distinct after commit. Keep pending session in the
  // private map before sending its first request, so retries stay idempotent.
  let sessionId
  updateMap(config, origin, (data) => {
    if (!data.pending || data.pending.projectId !== project.project.id)
      data.pending = { projectId: project.project.id, sessionId: hash(`${Date.now()}:${Math.random()}`) }
    sessionId = data.pending.sessionId
  })
  let committedBoard = null
  for (const plan of plans) {
    if (signal?.aborted) throw new Error('Share cancelled.')
    const { board, files, checks } = plan
    if (!readManifest(config, board.id)) throw new Error(`Board ${board.id} has no captures. Capture it before sharing.`)
    const existing = readMigration(config, board.id)
    const prior = existing?.pending
      ? existing.url
        ? { ...existing, pending: false, readOnly: existing.previousReadOnly === true }
        : null
      : existing
    let frozen = false
    try {
      if (!flags['no-comments']) {
        await writeMigration(
          config,
          board.id,
          { ...prior, pending: true, readOnly: true, previousReadOnly: prior?.readOnly === true },
          { beforeWrite: () => beforeFreeze(board.id) },
        )
        frozen = true
        // Read again after freezing under the comment lock: no edits made
        // between planning and approval are lost from this move.
        plan.comments = listComments(config, board.id).map((item) => portableComment(item, projectPath, board.id))
      }
      if (
        !project.token.scopes.includes('import') &&
        plan.comments.some((item) => maps.boards[board.id]?.comments?.[item.localId]?.localHash !== hash(item))
      )
        throw new Error('Local comments changed during sign-in. Run shapewall share again to approve their import.')
      const definition = portableDefinition(config, { ...board, journeys: listJourneys(config, board) })
      out(`Pushing ${board.id}: ${files.length} capture/history files`)
      const started = await remote.startPush(definition)
      if (checks && !started.limits.checks) throw new Error('This server does not support explicitly included check reports.')
      let pushed = 0
      for (const [area, name, file] of files) {
        if (signal?.aborted) throw new Error('Share cancelled.')
        if (name.endsWith('.elements.json') && !started.limits.elements) continue
        const cap = name.endsWith('.html')
          ? started.limits.html
          : name.endsWith('.elements.json')
            ? started.limits.elements
            : started.limits.png
        const bytes = readCapture(config, file, cap)
        if (bytes.length > cap) throw new Error(`Capture ${area}/${name} exceeds the server limit; nothing was silently skipped.`)
        await remote.pushFile(started.id, area, name, bytes)
        pushed += 1
        if (pushed % 25 === 0) out(`Pushed ${pushed}/${files.length} files`)
      }
      const pushedBoard = await remote.commitPush(started.id, {
        manifest: portableManifest(config, board, readManifest(config, board.id)),
        variants: portableVariants(readVariants(config, board.id)),
        checks,
      })
      if (checks && pushedBoard.checks !== checks.reports.length) throw new Error('The server did not confirm all included check reports.')
      // A server-supplied URL is never trusted for navigation or credentials.
      const url = `${origin}/w/${encodeURIComponent(project.workspace.id)}/p/${encodeURIComponent(project.project.id)}/?board=${encodeURIComponent(board.id)}`
      if (!pushedBoard.board || pushedBoard.board !== board.id) throw new Error('The server committed a different board.')
      urls.push(url)
      if (project.token.scopes.includes('import')) committedBoard = board.id
      if (!flags['no-comments'] && project.token.scopes.includes('import')) {
        let importedCount = 0
        for (const comments of importBatches(plan.comments)) {
          importedCount += comments.length
          const result = await remote.importComments(board.id, { sessionId, batchKey: hash({ board: board.id, comments }), comments })
          out(
            `Importing ${board.id}: ${importedCount}/${plan.comments.length} comments (${result.imported} new, ${result.updated} updated, ${result.skipped} unchanged)`,
          )
          conflicts.push(...result.conflicts.map((id) => `${board.id}:${id}`))
          updateMap(config, origin, (data) => {
            const stored = (data.boards[board.id] ||= { projectId: project.project.id, comments: {} })
            if (stored.projectId !== project.project.id) {
              stored.projectId = project.project.id
              stored.comments = {}
            }
            for (const item of result.mappings)
              stored.comments[item.localId] = { ...item, localHash: hash(comments.find((local) => local.localId === item.localId)) }
          })
        }
        committedBoard = board.id
      }
      if (!flags['no-comments'] && !conflicts.some((id) => id.startsWith(`${board.id}:`))) {
        await writeMigration(config, board.id, {
          url,
          remote: origin,
          projectId: project.project.id,
          migratedAt: new Date().toISOString(),
          readOnly: true,
        })
        frozen = false
      }
    } finally {
      if (frozen) await writeMigration(config, board.id, prior)
    }
  }
  if (committedBoard) {
    await remote.importComments(committedBoard, { sessionId, batchKey: hash(`commit:${sessionId}`), comments: [], commit: true })
  }
  updateMap(config, origin, (data) => {
    delete data.pending
  })
  for (const url of urls) out(`Board: ${url}`)
  out(`Reconnect your agent: shapewall watch --remote ${origin} --exec '<your-agent-command>'`)
  out(`MCP: shapewall mcp --remote ${origin}`)
  if (conflicts.length) out(`Conflicts (remote copies kept): ${conflicts.join(', ')}`)
  return { code: conflicts.length ? 2 : 0, conflicts, urls }
}

// Serialize moves of this local project, even across different destination
// origins and CLI/UI processes. The short file-lock helper checks live PIDs.
export async function share(flags, print, options = {}) {
  const config = options.config || loadConfig(flags.config)
  if (flags['dry-run']) return runShare(flags, print, { ...options, config })
  const origin = remoteOrigin(flags, options.env || process.env)
  const file = mapFile(config, origin)
  // Held for the whole share, which can take minutes: never judged stale by
  // age, only when its holder is gone.
  return withFileLock(path.join(path.dirname(path.dirname(file)), 'share'), () => runShare(flags, print, { ...options, config }), {
    staleMs: Infinity,
  })
}
