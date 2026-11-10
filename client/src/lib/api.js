// API access. A static export (shapewall export) has no server: the page
// carries <meta name="shapewall-static">, and reads map to JSON files under
// data/ instead.

import { browserCommentsRequest } from './browserComments.js'
import { DEMO, demoBoardFolders, demoFiles } from './demo.js'

const hasMeta = (name) => typeof document !== 'undefined' && Boolean(document.querySelector(`meta[name="${name}"]`))
// The public demo is a static export too, but its in-browser backend
// (client/src/demo) answers the API like a hosted server, so it is not STATIC.
export const STATIC = !DEMO && hasMeta('shapewall-static')
// A static export made with --browser-comments: comments live in this browser.
export const BROWSER_COMMENTS = STATIC && hasMeta('shapewall-browser-comments')

// The Settings > Agent capability: `shapewall serve` prints a link with
// #settings-token=...; the board keeps it for this tab (sessionStorage), drops
// it from the address bar, and sends it to local settings/info and agent
// message/control routes. Without it the settings screen stays hidden.
const TOKEN_KEY = 'shapewall-settings-token'
const TOKEN_HEADER = 'X-Shapewall-Settings-Token'

function readSettingsToken() {
  if (typeof window === 'undefined' || STATIC) return null
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const fresh = hash.get('settings-token')
    if (fresh) {
      window.sessionStorage.setItem(TOKEN_KEY, fresh)
      hash.delete('settings-token')
      const rest = hash.toString()
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`)
    }
    return window.sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
let settingsToken = readSettingsToken()

// A pasted owner link can be a same-document navigation. Consume its private
// fragment before reloading so info/settings are fetched with the new token.
if (typeof window !== 'undefined' && !STATIC) {
  window.addEventListener('hashchange', () => {
    if (!new URLSearchParams(window.location.hash.replace(/^#/, '')).get('settings-token')) return
    const next = readSettingsToken()
    // Storage/history can be disabled. Do not reload a token-bearing URL.
    if (!next || new URLSearchParams(window.location.hash.replace(/^#/, '')).has('settings-token')) return
    settingsToken = next
    window.location.reload()
  })
}

// Forgets the token (the server restarted with a new one).
export function forgetSettingsToken() {
  settingsToken = null
  try {
    window.sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage off: nothing kept
  }
}

// For the starter agent's approval cards (chat/stream.js answerPermission).
export const settingsTokenHeaders = () => (settingsToken ? { [TOKEN_HEADER]: settingsToken } : {})

const wantsToken = (url, method) =>
  url === '/api/info' ||
  url.startsWith('/api/app-update') ||
  url.startsWith('/api/agent/settings') ||
  url === '/api/agent/status' ||
  url.startsWith('/api/agent/feedback') ||
  url.startsWith('/api/agent/branches') ||
  (/^\/?api\/agent\/boards\//.test(url) && url.includes('/threads')) ||
  /^\/?api\/agent\/boards\/[a-z0-9-]+\/batch(\/|$)/.test(url) ||
  url.startsWith('/api/devices') ||
  url.startsWith('/api/share/') ||
  /^\/api\/boards\/[a-z0-9-]+\/checks\/run$/.test(url) ||
  (method !== 'GET' && url.startsWith('/api/agent/boards/') && url.includes('/threads/'))

function staticPath(url) {
  const [pathname, query = ''] = url.split('?')
  if (pathname === '/api/info') return 'data/info.json'
  if (pathname === '/api/boards') return 'data/boards.json'
  let match = /^\/api\/boards\/([a-z0-9-]+)$/.exec(pathname)
  if (match) return `data/boards/${match[1]}.json`
  match = /^\/api\/boards\/([a-z0-9-]+)\/checks$/.exec(pathname)
  if (match) {
    const env = new URLSearchParams(query).get('env')
    return env && /^[a-z0-9][a-z0-9-]{0,63}$/.test(env)
      ? `data/boards/${match[1]}/checks-${env}.json`
      : `data/boards/${match[1]}/checks.json`
  }
  match = /^\/api\/boards\/([a-z0-9-]+)\/comments$/.exec(pathname)
  if (match) return `data/boards/${match[1]}/comments.json`
  match = /^\/api\/boards\/([a-z0-9-]+)\/journeys$/.exec(pathname)
  if (match) return `data/boards/${match[1]}/journeys.json`
  match = /^\/api\/boards\/([a-z0-9-]+)\/compare$/.exec(pathname)
  if (match) {
    const params = new URLSearchParams(query)
    const [a, b] = [params.get('a') || '', params.get('b') || '']
    if (/^[a-z0-9-]+$/.test(a) && /^[a-z0-9-]+$/.test(b)) return `data/boards/${match[1]}/compare/${a}_${b}.json`
  }
  return null
}

// The one error class for the board and the console (console/lib/api.js
// re-exports it), so `instanceof ApiError` holds whichever made the call.
// `details`: the server's extra lines; `retryAfter`: seconds, on a 429.
export class ApiError extends Error {
  constructor(status, code, message, { details = null, retryAfter = null } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.retryAfter = retryAfter
  }
}

// The ApiError for a refused response, from its parsed JSON body (or null).
export const responseError = (status, data) =>
  new ApiError(status, data?.error?.code || 'http_error', data?.error?.message || `Request failed (${status})`, {
    details: data?.error?.details || null,
  })

async function fetchJson(target) {
  const response = await fetch(target, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new ApiError(response.status, 'http_error', `Request failed (${response.status})`)
  return response.json()
}

async function request(method, url, body) {
  if (BROWSER_COMMENTS) {
    const answer = await browserCommentsRequest(method, url, body, fetchJson)
    if (answer !== undefined) return answer
  }
  // Relative to the page, so the board also works under a proxy sub-path.
  const target = STATIC ? staticPath(url) : hasMeta('shapewall-local-console') ? url : url.replace(/^\//, '')
  if (!target || (STATIC && method !== 'GET')) throw new ApiError(404, 'static', 'Not available in a static export.')
  const headers = body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (settingsToken && wantsToken(url, method)) headers[TOKEN_HEADER] = settingsToken
  const response = await fetch(target, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok) {
    noticeLostAccess(response.status, data?.error?.code)
    throw responseError(response.status, data)
  }
  return data
}

// A hosted board that stops answering: the share link was revoked or ended,
// the session ended, or this account left the workspace. The board shows a
// banner (Board.jsx, ACCESS_LOST_EVENT) instead of failing request by request.
export const ACCESS_LOST_EVENT = 'shapewall:access-lost'
const LOST = {
  share_ended: 'share',
  signed_out: 'signed_out',
  unknown_workspace: 'removed',
  unknown_project: 'removed',
}
function noticeLostAccess(status, code) {
  if (DEMO || STATIC || typeof window === 'undefined') return
  if (status === 401 && code === 'pairing_required') window.dispatchEvent(new CustomEvent('shapewall:pairing-required'))
  const kind = (status === 401 || status === 404) && LOST[code]
  if (kind) window.dispatchEvent(new CustomEvent(ACCESS_LOST_EVENT, { detail: { kind } }))
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  delete: (url) => request('DELETE', url),
}

const enc = encodeURIComponent

// The demo's images and live HTML are the export's files.
const demoFile = (boardId, kind, file) => `data/boards/${enc(demoBoardFolders.get(boardId) || boardId)}/${kind}/${enc(file)}`

// URL of a capture or variant image.
export function fileUrl(boardId, kind, file, version) {
  if (DEMO) return demoFile(boardId, kind, file)
  if (STATIC) return `data/boards/${enc(boardId)}/${kind}/${enc(file)}`
  return `api/boards/${enc(boardId)}/${kind}/${enc(file)}?v=${enc(version || '0')}`
}

// URL of an image on a comment (src/comment-media.js). The demo keeps the
// images attached in this browser as data URLs (demoFiles); its seeded ones
// are the export's files.
export function commentFileUrl(boardId, file) {
  if (DEMO) return demoFiles.get(file) || demoFile(boardId, 'comment-files', file)
  if (STATIC) return `data/boards/${enc(boardId)}/comment-files/${enc(file)}`
  return `api/boards/${enc(boardId)}/comment-files/${enc(file)}`
}

// URL of a live page's element map (src/capture/element-map.js): JSON the
// board places pins from, so it never reads the live frame's DOM.
export function elementsUrl(boardId, kind, file, version) {
  if (DEMO) return demoFile(boardId, kind, file)
  if (STATIC) return `data/boards/${enc(boardId)}/${kind}/${enc(file)}`
  return `api/boards/${enc(boardId)}/${kind === 'variants' ? 'variant-elements' : 'elements'}/${enc(file)}?v=${enc(version || '0')}`
}

// URL of a live HTML document (served with a strict CSP).
export function liveUrl(boardId, kind, file, version) {
  if (DEMO) return demoFile(boardId, kind, file)
  if (STATIC) return `data/boards/${enc(boardId)}/${kind}/${enc(file)}`
  return `api/boards/${enc(boardId)}/${kind === 'variants' ? 'variant-live' : 'live'}/${enc(file)}?v=${enc(version || '0')}`
}
