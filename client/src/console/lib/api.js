import { DEMO } from '../../lib/demo.js'
import { ApiError, settingsTokenHeaders } from '../../lib/api.js'

// JSON calls to the hosted server (absolute paths: the console is served at
// several routes). Errors carry the server's code and message, as the one
// ApiError the board uses too.

export { ApiError }

// The typed reply to a server challenge belongs to the request being retried.
// Other requests, including background polls during the retry, carry no reply.
const confirmedRequests = new Map()
export async function retryConfirmed(error, phrase, action) {
  const reply = { phrase }
  confirmedRequests.set(error.requestKey, reply)
  try {
    return await action()
  } finally {
    if (confirmedRequests.get(error.requestKey) === reply) confirmedRequests.delete(error.requestKey)
  }
}

async function request(method, url, body, accept, typed) {
  const requestKey = `${method} ${url}`
  const confirmed = confirmedRequests.get(requestKey)?.phrase || typed
  confirmedRequests.delete(requestKey)
  let response
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(accept ? { Accept: accept } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(typeof document !== 'undefined' && document.querySelector('meta[name="shapewall-local-accounts"]') && url.startsWith('/auth/')
          ? settingsTokenHeaders()
          : {}),
        ...(confirmed ? { 'X-Shapewall-Confirm': encodeURIComponent(confirmed) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach the server. Check your connection and try again.')
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const retry = Number(response.headers.get('Retry-After'))
    const message = data?.error?.message || `Request failed (${response.status})`
    const error = new ApiError(
      response.status,
      data?.error?.code || 'error',
      response.status === 429 && retry > 0 ? withRetry(message, retry) : message,
      {
        retryAfter: response.status === 429 && retry > 0 ? retry : null,
        stepUp: data?.error?.stepUp || null,
        // confirm_device: the device the server sees, to name in the question.
        // confirm_required: what to type (a workspace's name, or your handle), and which of the two.
        details:
          data?.error?.device || data?.error?.confirm
            ? {
                ...(data.error.device ? { device: String(data.error.device) } : {}),
                ...(data.error.confirm ? { confirm: String(data.error.confirm), confirms: data.error.confirms || null } : {}),
              }
            : null,
      },
    )
    if (error.code === 'confirm_required') error.requestKey = requestKey
    throw error
  }
  return response
}

export async function call(method, url, body, typed) {
  const response = await request(method, url, body, 'application/json', typed)
  return response.json().catch(() => null)
}

// "Try again in 15 minutes" instead of a count of seconds.
export function waitText(seconds) {
  if (seconds >= 90 * 60) return `${Math.ceil(seconds / 3600)} hours`
  if (seconds >= 90) return `${Math.ceil(seconds / 60)} minutes`
  if (seconds > 60) return '2 minutes'
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}
const withRetry = (message, seconds) =>
  `${message.replace(/\s*Wait (a while|a moment) and try again\.?\s*$/i, '')} Try again in ${waitText(seconds)}.`

export const api = {
  get: (url) => call('GET', url),
  post: (url, body = {}) => call('POST', url, body),
  patch: (url, body = {}) => call('PATCH', url, body),
  put: (url, body = {}) => call('PUT', url, body),
  delete: (url, body) => call('DELETE', url, body, body?.confirm),
}

// A file from the server (an export, a CSV) saved through the browser.
// Errors come back as ApiError like any other call.
export async function download(method, url, body, fallbackName) {
  const response = await request(method, url, body)
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || fallbackName
  const blob = await response.blob()
  saveBlob(blob, name)
  return { name, bytes: blob.size }
}

// Hands a blob to the browser as a download named `name`.
export function saveBlob(blob, name) {
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

// Workspace-scoped URL builder.
export const wsUrl = (ws, rest = '') => `/api/workspaces/${encodeURIComponent(ws)}${rest}`

// The server's address for CLI examples. The public demo has no server: a
// made-up one.
export const serverOrigin = () => (DEMO ? 'https://shapewall.example' : window.location.origin)
