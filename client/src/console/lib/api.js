import { DEMO } from '../../lib/demo.js'
import { ApiError, settingsTokenHeaders } from '../../lib/api.js'

// JSON calls to the hosted server (absolute paths: the console is served at
// several routes). Errors carry the server's code and message, as the one
// ApiError the board uses too.

export { ApiError }

// What the person typed to confirm one of the few things that always ask, on a server where Tailscale is
// the only sign-in (the server answers confirm_required with what to type). Sent with the requests of the
// action being retried, then cleared (state.jsx).
let confirmed = null
export const setConfirmed = (value) => {
  confirmed = value || null
}

export async function call(method, url, body) {
  let response
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' }),
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
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok) {
    const retry = Number(response.headers.get('Retry-After'))
    const message = data?.error?.message || `Request failed (${response.status})`
    throw new ApiError(
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
  }
  return data
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
  delete: (url, body) => call('DELETE', url, body),
}

// A file from the server (an export, a CSV) saved through the browser.
// Errors come back as ApiError like any other call.
export async function download(method, url, body, fallbackName) {
  let response
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'offline', 'Could not reach the server. Check your connection and try again.')
  }
  if (!response.ok) {
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    throw new ApiError(response.status, data?.error?.code || 'error', data?.error?.message || `Request failed (${response.status})`)
  }
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
