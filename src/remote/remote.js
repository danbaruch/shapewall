import { readOutputFile } from '../output-path.js'
// The client side of the hosted token API, for `shapewall push`,
// `comments --remote`, `watch --remote` and `mcp --remote`.
//
// The token comes from $SHAPEWALL_TOKEN or a file (--token-file), never from
// a command-line flag (other users of the machine can read argv). Tokens are
// only sent over https, or plain http to this machine.

import { portablePagePath } from '../portable-path.js'
import fs from 'node:fs'
import path from 'node:path'
import { soloHost, soloLoopbackPinned } from './loopback-pin.js'
import { isLoopback } from '../net.js'
import { boardViewports } from '../config.js'
import { boardDir, capturesDir } from '../store.js'
import { readCredential } from './credentials.js'
import { ENGINE_TARGET, ENGINE_TOKEN, guardEngineFetch } from '../engine-target.js'
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
  // Plain http: only to this machine. That is a loopback address or name, or the solo engine's own host name
  // (<project>-<random>.shapewall.localhost), whose connections are pinned to 127.0.0.1 (src/remote/loopback-pin.js).
  const solo = url.protocol === 'http:' && soloHost(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLoopback(url.hostname) || solo))) {
    throw new Error('--remote must be https (plain http only to this machine), so the token is never sent in the clear')
  }
  if (solo && !soloLoopbackPinned())
    throw new Error(`--remote ${url.origin}: could not make sure the connection stays on this machine, so no token is sent.`)
  return url.origin
}

// Where the token comes from, first match wins: $SHAPEWALL_TOKEN,
// --token-file FILE, then the login saved by `shapewall login` for this
// server.
export function remoteSettings(flags = {}, env = process.env) {
  const origin = remoteOrigin(flags, env)
  // The solo engine of this project folder (src/engine-target.js, set by main()): its own token for this command
  // line, whatever SHAPEWALL_TOKEN holds (that one is for another server).
  if (typeof flags[ENGINE_TOKEN] === 'string' && TOKEN_RE.test(flags[ENGINE_TOKEN]))
    return { origin, token: flags[ENGINE_TOKEN], source: 'engine', engine: flags[ENGINE_TARGET] || null }
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
  if (source === 'engine')
    return 'The solo engine refused the token it made for this command line (it restarted, or the token was revoked in its console). Run the command again; if it keeps failing, restart shapewall serve --engine hosted.'
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

// `engine`: the solo engine target this token is for (remoteSettings): its proof is asked again after a connection
// error or a 401, before the next request (engine-target.js guardEngineFetch).
export function createRemote({
  origin,
  token,
  source = null,
  fetchImpl: baseFetch = fetch,
  maxResponseBytes = RESPONSE_MAX,
  engine = null,
  verifyEngine = undefined,
}) {
  const fetchImpl = engine ? guardEngineFetch(baseFetch, engine, verifyEngine ? { verify: verifyEngine } : {}) : baseFetch
  async function call(method, pathname, { json, body, contentType, signal } = {}) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    let payload
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(json)
    } else if (body !== undefined) {
      headers['Content-Type'] = contentType || 'application/octet-stream'
      payload = body
    }
    const response = await fetchImpl(`${origin}${pathname}`, { method, headers, body: payload, redirect: 'error', signal })
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

  // A file URL from a comment (files.screenshot, a comment image) as bytes.
  // Only this origin's API; of the query only the guests opt-in (a share
  // link guest's image is served with it) and a capture version (the
  // current capture as the history listed it, else a 409) are kept.
  async function download(url, { signal } = {}) {
    const target = new URL(url)
    if (target.origin !== origin || !target.pathname.startsWith('/api/v1/boards/')) throw new Error('not a file of this Shapewall')
    const query = new URLSearchParams()
    if (target.searchParams.get('guests') === '1') query.set('guests', '1')
    const version = target.searchParams.get('version')
    if (version && /^[\w.-]{1,40}$/.test(version)) query.set('version', version)
    return call('GET', `${target.pathname}${query.size ? `?${query}` : ''}`, { signal })
  }

  return {
    origin,
    project: () => call('GET', '/api/v1/project'),
    pages: (boardId) => call('GET', `${board(boardId)}/pages`),
    // A page's capture history, newest first (current and kept versions).
    pageVersions: (boardId, pageId, { viewport = null, signal } = {}) =>
      call('GET', `${board(boardId)}/pages/${enc(pageId)}/versions${viewport ? `?viewport=${enc(viewport)}` : ''}`, { signal }),
    // The board's comments as a static export shows them, and one of their images (shapewall export, R5c).
    exportComments: (boardId, { guests = false, signal } = {}) =>
      call('GET', `${board(boardId)}/export/comments${guests ? '?guests=1' : ''}`, { signal }),
    commentFile: (boardId, name, { guests = false, signal } = {}) =>
      call('GET', `${board(boardId)}/comment-files/${enc(name)}${guests ? '?guests=1' : ''}`, { signal }),
    // Guest comments (share links) only with `guests: true`.
    comments: (boardId, { status = 'open', page = null, mention = null, guests = false, environment = null, signal } = {}) => {
      const query = new URLSearchParams({ status })
      if (page) query.set('page', page)
      if (environment) query.set('environment', environment)
      if (mention) query.set('mention', mention)
      if (guests) query.set('guests', '1')
      return call('GET', `${board(boardId)}/comments?${query}`, { signal })
    },
    // Acting on one comment: a share link guest's needs `guests: true` too
    // (the server refuses it otherwise), the same opt-in as listing them.
    comment: (boardId, id, { guests = false, signal } = {}) => call('GET', one(boardId, id, '', guests), { signal }),
    // Replies are signed with the token's name on the server. `author`: the label of an agent's reply on the solo
    // engine (the 1.x MCP and CLI `author`, still marked as an agent there); a team server ignores it.
    reply: (boardId, id, { body, author, guests = false, signal }) =>
      call('POST', one(boardId, id, '/replies', guests), { json: { body, ...(author ? { author } : {}) }, signal }),
    // A new comment ({ page, body, viewport?, x?, y?, anchor?, author? }), signed with the token's name on the server
    // (`author` as for reply: the solo engine only).
    addComment: (boardId, { page, body, viewport, x, y, anchor, author }) =>
      call('POST', `${board(boardId)}/comments`, { json: { page, body, viewport, x, y, anchor, ...(author ? { author } : {}) } }),
    setAgentStatus: (boardId, id, agentStatus, { onlyFrom = null, guests = false, signal } = {}) =>
      call('POST', one(boardId, id, '/agent-status', guests), { json: { agentStatus, onlyFrom }, signal }),
    resolve: (boardId, id, { note, fixRef, agentStatus, guests = false } = {}) =>
      call('POST', one(boardId, id, '/resolve', guests), { json: { note, fixRef, agentStatus } }),
    reopen: (boardId, id, { guests = false } = {}) => call('POST', one(boardId, id, '/reopen', guests), { json: {} }),
    // GitHub links on the solo engine (`shapewall github`, which asks GitHub itself): the issue made from a comment
    // ({ number, url, title, createdAt? }), and a pull request linked to it ({ number, url, title, state, mergedAt },
    // `via` manual, body or issue; a merge resolves the comment -> { comment, changed, merged }).
    githubIssue: (boardId, id, issue, { guests = false } = {}) =>
      call('POST', one(boardId, id, '/github/issue', guests), { json: { issue } }),
    githubPull: (boardId, id, pull, { via = 'manual', guests = false } = {}) =>
      call('POST', one(boardId, id, '/github/pulls', guests), { json: { pull, via } }),
    // B-20, the solo engine and this machine's command line only: the 1.x comments that wait for the owner's OK
    // ({ comments: [{ id, author, body, pageId, createdAt, dispatchHash }] }), and sending those the owner was shown
    // ([{ number, dispatchHash }] -> { sent, changed, skipped }).
    waitingOk: (boardId, { signal } = {}) => call('GET', `${board(boardId)}/waiting-ok`, { signal }),
    sendWaitingOk: (boardId, comments) => call('POST', `${board(boardId)}/waiting-ok/send`, { json: { comments } }),
    startPush: (definition) => call('POST', '/api/v1/pushes', { json: definition }),
    // A push of only these pages and viewports ({ <page>: [<viewport>] }) to a board already pushed.
    startPagePush: (boardId, pages) => call('POST', '/api/v1/pushes', { json: { mode: 'pages', board: boardId, pages } }),
    pushFile: (pushId, area, name, bytes) =>
      call('PUT', `/api/v1/pushes/${enc(pushId)}/files/${enc(area)}/${enc(name)}`, {
        body: bytes,
        contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.json') ? 'application/json' : 'image/png',
      }),
    commitPush: (pushId, { manifest, variants, checks, environments }) =>
      call('POST', `/api/v1/pushes/${enc(pushId)}/commit`, {
        json: { manifest, variants, ...(checks !== undefined ? { checks } : {}), ...(environments ? { environments } : {}) },
      }),
    requestApproval: (boardId, id, { command, reason, signal }) =>
      call('POST', one(boardId, id, '/approvals', false), { json: { command, reason }, signal }),
    approval: (boardId, id, { signal } = {}) => call('GET', `${board(boardId)}/approvals/${enc(id)}`, { signal }),
    cancelApproval: (boardId, id, { signal } = {}) => call('DELETE', `${board(boardId)}/approvals/${enc(id)}`, { signal }),
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
    // One image of an imported comment, before the batch that lists it.
    importImage: (boardId, json) => call('POST', `${board(boardId)}/import/images`, { json }),
    download,
  }
}

// The board definition a push sends: what the board shows, nothing else.
// Never auth settings, storage states, login scripts, actions (fill values
// can be passwords), waitFor selectors, or local paths.
// `environments`: also send the board's environments (ids, titles and their
// addresses, cleaned the same way). Only to the solo engine of this folder:
// a team server keeps one environment, so it never needs their addresses.
export function pushDefinition(config, board, { environments = false } = {}) {
  const address = (raw) => {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  }
  return {
    title: config.title,
    // The board's own viewports when it lists them (a pushed board is one board).
    viewports: boardViewports(config, board),
    versions: config.versions,
    board: {
      id: board.id,
      title: board.title,
      baseUrl: address(board.baseUrl),
      ...(board.publicUrl ? { publicUrl: address(board.publicUrl) } : {}),
      ...(environments
        ? {
            environments: board.environments.map((env) => ({
              id: env.id,
              title: env.title,
              baseUrl: address(env.baseUrl),
              ...(env.publicUrl ? { publicUrl: address(env.publicUrl) } : {}),
            })),
          }
        : {}),
      groups: board.groups,
      pages: board.pages.map((page) => ({
        id: page.id,
        path: portablePagePath(page.path),
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

// The files of another environment's latest capture (envs/<id>/captures/),
// as [area, name, absolute path] with area `env:<id>` (a push to the solo engine).
export function pushEnvironmentFiles(config, board, envId) {
  const dir = capturesDir(config, board.id, envId)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .sort()
    .filter((name) => /\.(png|html|elements\.json)$/.test(name))
    .map((name) => [`env:${envId}`, name, path.join(dir, name)])
}

// One capture file's bytes, for push and share. The file and every folder
// between it and the output directory must be real (no symlinks) and the file
// a regular one at most `cap` bytes: a project that plants
// captures/home.desktop.png -> ~/.ssh/id_ed25519 must not get that key uploaded.
export function readCaptureFile(config, file, cap = Infinity) {
  const relative = path.relative(config.outputDir, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Capture file is outside the output directory.')
  return readOutputFile(config.outputDir, file, cap)
}
