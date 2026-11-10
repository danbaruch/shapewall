import { settingsTokenHeaders } from '../lib/api'

export async function buzzRequest(boardId, action, body = {}) {
  const response = await fetch(`api/buzz/boards/${encodeURIComponent(boardId)}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...settingsTokenHeaders() },
    body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new Error(data.error?.message || 'The private Buzz gateway is unavailable.')
    error.status = response.status
    error.code = data.error?.code
    throw error
  }
  return data
}
