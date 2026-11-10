// The client side of the hosted token API, for `shapewall push`,
// `comments --remote`, `watch --remote` and `mcp --remote`.
//
// The token comes from $SHAPEWALL_TOKEN or a file (--token-file), never from
// a command-line flag (other users of the machine can read argv). Tokens are
// only sent over https, or plain http to this machine.

import fs from 'node:fs'
import path from 'node:path'
import { isLoopback } from '../net.js'
import { boardViewports } from '../config.js'
import { boardDir } from '../store.js'
import { readCredential } from './credentials.js'
import { terminalSafe } from './terminal.js'

export class RemoteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const TOKEN_RE = /^swp_[A-Za-z0-9_-]{43}$/

// The hosted origin from --remote (or $SHAPEWALL_REMOTE): https, or plain
// http only to this machine.
export function remoteOrigin(flags = {}, env = process.env) {
  const raw = typeof flags.remote === 'string' ? flags.remote : env.SHAPEWALL_REMOTE
  if (!raw) throw new Error('--remote URL (or $SHAPEWALL_REMOTE): the hosted Shapewall, e.g. https://app.shapewall.example')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`--remote: not a URL (${raw})`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('--remote must be https (plain http only to this machine), so the token is never sent in the clear')
  }
  return url.origin
}

// Where the token comes from, first match wins: $SHAPEWALL_TOKEN,
// --token-file FILE, then the login saved by `shapewall login` for this
// server.
export function remoteSettings(flags = {}, env = process.env) {
  const origin = remoteOrigin(flags, env)
  let token = env.SHAPEWALL_TOKEN || ''
  let source = token ? 'env' : null
  if (typeof flags['token-file'] === 'string') {
    token = fs.readFileSync(flags['token-file'], 'utf8').trim()
    source = 'file'
  }
  if (!token) {
    const saved = readCredential(origin, env)
    if (saved) {
      token = saved.token
      source = 'login'
    }
  }
  if (!TOKEN_RE.test(token)) {
    throw new Error(
      `No project token for ${origin}. Run "shapewall login --remote ${origin}", or set SHAPEWALL_TOKEN (or --token-file FILE) to a project token (swp_...) from the console.`,
    )
  }
  return { origin, token, source }
}

// What to tell someone whose token the server refused.
export function badTokenMessage(origin, source) {
  const again = source === 'login' ? ` Or run "shapewall login --remote ${origin}" again.` : ` Or run "shapewall login --remote ${origin}".`
  return `This token was revoked, has expired or its maker is no longer an admin there (or it is wrong). Create a new one in the console: ${origin}/${again}`
}

// The most a hosted server's answer may hold (a full-page PNG is at most
// 10 MB, a comment list a few MB). A server that sends more, or says it will,
// is cut off instead of filling this process's memory.
export const RESPONSE_MAX = 64 * 1024 * 1024

export async function readBounded(response, limit = RESPONSE_MAX) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('The server sent too large a response.')
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > limit) throw new Error('The server sent too large a response.')
    return bytes
  }
  const parts = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return Buffer.concat(parts, size)
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new Error('The server sent too large a response.')
    }
    parts.push(value)
  }
}

export function createRemote({ origin, token, source = null, fetchImpl = fetch, maxResponseBytes = RESPONSE_MAX }) {
  async function call(method, pathname, { json, body, contentType } = {}) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    let payload
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(json)
    } else if (body !== undefined) {
      headers['Content-Type'] = contentType || 'application/octet-stream'
      payload = body
    }
    const response = await fetchImpl(`${origin}${pathname}`, { method, headers, body: payload, redirect: 'error' })
    const type = response.headers.get('content-type') || ''
    if (!response.ok) {
      let data = null
      try {
        data = type.includes('json') ? JSON.parse((await readBounded(response, 65536)).toString('utf8')) : null
      } catch {
        data = null
      }
      if (response.status === 401) throw new RemoteError(401, data?.error?.code || 'bad_token', badTokenMessage(origin, source))
      throw new RemoteError(
        response.status,
        data?.error?.code || 'http_error',
        terminalSafe(data?.error?.message || `${method} ${pathname} failed (${response.status})`),
      )
    }
    const bytes = await readBounded(response, maxResponseBytes)
    return type.includes('json') ? JSON.parse(bytes.toString('utf8')) : bytes
  }
  const enc = encodeURIComponent
  const board = (id) => `/api/v1/boards/${enc(id)}`
  const one = (boardId, id, rest, guests) => `${board(boardId)}/comments/${enc(id)}${rest}${guests ? '?guests=1' : ''}`

  // A file URL from a comment (files.screenshot) as bytes. Only this origin's API.
  async function download(url) {
    const target = new URL(url)
    if (target.origin !== origin || !target.pathname.startsWith('/api/v1/boards/')) throw new Error('not a file of this Shapewall')
    return call('GET', target.pathname)
  }

  return {
    origin,
    project: () => call('GET', '/api/v1/project'),
    pages: (boardId) => call('GET', `${board(boardId)}/pages`),
    // Guest comments (share links) only with `guests: true`.
    comments: (boardId, { status = 'open', page = null, mention = null, guests = false } = {}) => {
      const query = new URLSearchParams({ status })
      if (page) query.set('page', page)
      if (mention) query.set('mention', mention)
      if (guests) query.set('guests', '1')
      return call('GET', `${board(boardId)}/comments?${query}`)
    },
    // Acting on one comment: a share link guest's needs `guests: true` too
    // (the server refuses it otherwise), the same opt-in as listing them.
    comment: (boardId, id, { guests = false } = {}) => call('GET', one(boardId, id, '', guests)),
    // Replies are signed with the token's name on the server (no author here).
    reply: (boardId, id, { body, guests = false }) => call('POST', one(boardId, id, '/replies', guests), { json: { body } }),
    setAgentStatus: (boardId, id, agentStatus, { onlyFrom = null, guests = false } = {}) =>
      call('POST', one(boardId, id, '/agent-status', guests), { json: { agentStatus, onlyFrom } }),
    resolve: (boardId, id, { note, fixRef, agentStatus, guests = false } = {}) =>
      call('POST', one(boardId, id, '/resolve', guests), { json: { note, fixRef, agentStatus } }),
    reopen: (boardId, id, { guests = false } = {}) => call('POST', one(boardId, id, '/reopen', guests), { json: {} }),
    startPush: (definition) => call('POST', '/api/v1/pushes', { json: definition }),
    pushFile: (pushId, area, name, bytes) =>
      call('PUT', `/api/v1/pushes/${enc(pushId)}/files/${enc(area)}/${enc(name)}`, {
        body: bytes,
        contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.json') ? 'application/json' : 'image/png',
      }),
    commitPush: (pushId, { manifest, variants, checks }) =>
      call('POST', `/api/v1/pushes/${enc(pushId)}/commit`, { json: { manifest, variants, ...(checks !== undefined ? { checks } : {}) } }),
    requestApproval: (boardId, id, { command, reason }) =>
      call('POST', one(boardId, id, '/approvals', false), { json: { command, reason } }),
    approval: (boardId, id) => call('GET', `${board(boardId)}/approvals/${enc(id)}`),
    waitForChange: async ({ signal, timeoutMs = 60000, connectTimeoutMs = 3000 } = {}) => {
      if (signal?.aborted) return false
      const controller = new AbortController()
      let reader
      let cancelStarted = false
      let cancellation = Promise.resolve()
      const cancelReader = () => {
        if (reader && !cancelStarted) {
          cancelStarted = true
          try {
            cancellation = Promise.resolve(reader.cancel()).catch(() => {})
          } catch {
            /* already released */
          }
        }
        return cancellation
      }
      const abort = () => {
        // Native fetch can lose signal propagation after GC while an SSE
        // read is pending. Cancel the reader we own as well as the request.
        // Initiate cleanup without awaiting it, then abort the transport.
        cancelReader()
        controller.abort()
      }
      signal?.addEventListener('abort', abort, { once: true })
      let timer = setTimeout(abort, connectTimeoutMs)
      try {
        const response = await fetchImpl(`${origin}/api/v1/events`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          redirect: 'error',
          signal: controller.signal,
        })
        reader = response.body?.getReader()
        if (controller.signal.aborted) return false
        if (response.status === 401) throw new RemoteError(401, 'bad_token', badTokenMessage(origin, source))
        if (!response.ok || !reader || !response.headers.get('content-type')?.includes('text/event-stream')) return false
        clearTimeout(timer)
        timer = setTimeout(abort, timeoutMs)
        let text = ''
        const decoder = new TextDecoder()
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read()
          if (done || controller.signal.aborted) return false
          text += decoder.decode(value, { stream: true })
          if (text.includes('event: change')) return true
          if (text.length > 65536) return false
        }
        return false
      } catch (error) {
        if (error instanceof RemoteError) throw error
        return false
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        abort()
        await cancellation
      }
    },
    importComments: (boardId, json) => call('POST', `${board(boardId)}/import`, { json }),
    download,
  }
}

// The board definition a push sends: what the board shows, nothing else.
// Never auth settings, storage states, login scripts, actions (fill values
// can be passwords), waitFor selectors, or local paths.
export function pushDefinition(config, board) {
  return {
    title: config.title,
    // The board's own viewports when it lists them (a pushed board is one board).
    viewports: boardViewports(config, board),
    versions: config.versions,
    board: {
      id: board.id,
      title: board.title,
      baseUrl: board.baseUrl,
      ...(board.publicUrl ? { publicUrl: board.publicUrl } : {}),
      groups: board.groups,
      pages: board.pages.map((page) => ({
        id: page.id,
        path: page.path,
        title: page.title,
        group: page.group,
        ...(page.note ? { note: page.note } : {}),
        viewports: page.viewports,
        ...(page.frameHeight ? { frameHeight: page.frameHeight } : {}),
      })),
      journeys: (board.journeys || []).map((journey) => ({
        id: journey.id,
        name: journey.name,
        ...(journey.description ? { description: journey.description } : {}),
        steps: journey.steps,
      })),
    },
  }
}

// The files of a board's latest capture (default environment), its
// variants and previous versions, as [area, name, absolute path].
export function pushFiles(config, board) {
  const dir = boardDir(config, board.id)
  const files = []
  for (const area of ['captures', 'variants', 'versions']) {
    let names = []
    try {
      names = fs.readdirSync(path.join(dir, area))
    } catch {
      continue
    }
    // Screenshots, live HTML and (captures and variants only) its element maps.
    const wanted = area === 'versions' ? /\.(png|html)$/ : /\.(png|html|elements\.json)$/
    for (const name of names.sort()) if (wanted.test(name)) files.push([area, name, path.join(dir, area, name)])
  }
  return files
}

// One capture file's bytes, for push and share. The file and every folder
// between it and the output directory must be real (no symlinks) and the file
// a regular one at most `cap` bytes: a project that plants
// captures/home.desktop.png -> ~/.ssh/id_ed25519 must not get that key uploaded.
export function readCaptureFile(config, file, cap = Infinity) {
  const relative = path.relative(config.outputDir, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Capture file is outside the output directory.')
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
