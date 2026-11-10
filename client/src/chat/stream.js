// The chat API from the board: JSON in, server-sent events out (fetch, since
// EventSource cannot POST). Paths are relative to the page, like lib/api.js.

import { api, responseError, settingsTokenHeaders } from '../lib/api.js'
import { DEMO, demoFiles } from '../lib/demo.js'

const enc = encodeURIComponent
export const threadPath = (boardId, threadId) => `api/agent/boards/${enc(boardId)}/threads/${enc(threadId)}`
// The demo keeps attached images in this browser (object URLs).
export const attachmentUrl = (boardId, file) =>
  DEMO ? demoFiles.get(file) || DEMO_MISSING : `api/agent/boards/${enc(boardId)}/files/${enc(file)}`
const DEMO_MISSING =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#8885"/></svg>')

// Posts a message and calls onEvent(name, data) for each event until the
// stream ends. Rejects with ApiError when the server refuses the message.
export async function sendMessage(boardId, threadId, body, { onEvent, signal } = {}) {
  const response = await fetch(`${threadPath(boardId, threadId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...settingsTokenHeaders() },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
  })
  if (!response.ok || !String(response.headers.get('content-type')).includes('text/event-stream')) {
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    throw responseError(response.status, data)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const name = /^event: (.*)$/m.exec(block)?.[1]
      const raw = /^data: (.*)$/m.exec(block)?.[1]
      if (!name || raw === undefined) continue
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        continue // a malformed event is skipped
      }
      onEvent?.(name, data)
    }
  }
}

// The person's answer to an agent's permission card: one of its options, or
// null to deny. Rejects with ApiError when the card is no longer waiting.
// The settings token goes with it (lib/api.js, every thread control route): a
// starter agent's command card is answered only by the person at the machine.
export const answerPermission = (boardId, threadId, permissionId, optionId) =>
  api.post(`${threadPath(boardId, threadId)}/permissions/${enc(permissionId)}`, { optionId })

// Rejects with ApiError when the server refuses; the panel then drops the stream.
export const stopThread = (boardId, threadId) => api.post(`${threadPath(boardId, threadId)}/stop`, {})

// Undo what one agent turn changed (its run summary). Owner only; the server
// checks every file (or the starter agent's branch) first. Resolves to
// { ok, message } with the answer marked undone; rejects with ApiError.
export const undoTurn = (boardId, threadId, messageId) => api.post(`${threadPath(boardId, threadId)}/messages/${enc(messageId)}/undo`, {})
