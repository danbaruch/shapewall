// The line protocol between `shapewall agent` on the host and the agent in
// the container: one JSON object per line, on the container's stdin and
// stdout (stderr is a log).
//
//   host -> container   { t: 'task', ... }            once, first: what to do (no secret in it)
//                       { t: 'answer', id, result }    the answer to a call
//                       { t: 'head', id, status, contentType }   a model call's response starts
//                       { t: 'chunk', id, data }       ... a piece of its body (text)
//                       { t: 'end', id, error? }       ... and its end
//                       { t: 'stop', reason }         stop now (wall time, Ctrl+C)
//   container -> host   { t: 'event', type, ... }     progress: turn, tool, usage, text
//                       { t: 'call', id, method, params }   reply, approve, model
//                       { t: 'cancel', id }           stop a model call
//                       { t: 'result', ... }          the end: status, summary, usage
//
// The model is called through the host (method "model"): the host adds the
// API key, sends the request to the configured endpoint only, enforces the
// turn and token budget, and streams the answer back. The key never enters
// the container.
//
// Everything the container sends is treated as untrusted on the host (the
// model chose it): lines are size-limited and checked field by field there.

export const LINE_MAX = 16 * 1024 * 1024

// Calls onLine(object) for each JSON line; bad and oversized lines go to onBad.
export function readLines(stream, onLine, { max = LINE_MAX, onBad = () => {} } = {}) {
  let buffer = ''
  let skipping = false
  stream.setEncoding?.('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (skipping) {
        skipping = false
        continue
      }
      if (!line.trim()) continue
      let value
      try {
        value = JSON.parse(line)
      } catch {
        onBad(line.slice(0, 200))
        continue
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) onLine(value)
      else onBad(line.slice(0, 200))
    }
    if (buffer.length > max) {
      onBad('a line over the size limit')
      buffer = ''
      skipping = true
    }
  })
}

export const writeLine = (stream, value) => stream.write(`${JSON.stringify(value)}\n`)

// The container side of calls: call(method, params) -> Promise of the host's
// result; fetch() is a fetch for the model that goes through the host.
export function createCaller(output) {
  let next = 1
  const pending = new Map()
  const streams = new Map()
  return {
    call(method, params) {
      const id = next++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        writeLine(output, { t: 'call', id, method, params })
      })
    },
    // A fetch-shaped call of the model: the URL is ignored (the host knows
    // the endpoint), the JSON body goes along, the answer streams back.
    fetch(url, { body, signal } = {}) {
      const id = next++
      return new Promise((resolve, reject) => {
        let controller
        // The reader may cancel the body (after [DONE]) before the host's end
        // arrives: from then on, later chunks and the end are dropped.
        let open = true
        const settle = (step) => {
          if (!open) return
          try {
            step()
          } catch {
            /* closed */
          }
        }
        const stream = new ReadableStream({
          start(value) {
            controller = value
          },
          cancel() {
            open = false
            streams.delete(id)
            writeLine(output, { t: 'cancel', id })
          },
        })
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          reject(new Error('the model request is not JSON'))
          return
        }
        const onAbort = () => {
          writeLine(output, { t: 'cancel', id })
          streams.delete(id)
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
          settle(() => controller.error(error))
          open = false
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        let headed = false
        streams.set(id, {
          head: (message) => {
            headed = true
            const headers = new Headers({ 'content-type': String(message.contentType || 'application/json') })
            resolve(new Response(stream, { status: Number(message.status) || 502, headers }))
          },
          chunk: (message) => settle(() => controller.enqueue(new TextEncoder().encode(String(message.data ?? '')))),
          end: (message) => {
            signal?.removeEventListener('abort', onAbort)
            streams.delete(id)
            if (message.error || !headed) {
              const error = new Error(String(message.error || 'the model call ended without an answer'))
              // The host's own words, already a sentence part: not wrapped again (openai.js).
              error.relayed = true
              reject(error)
              settle(() => controller.error(error))
            } else settle(() => controller.close())
            open = false
          },
        })
        writeLine(output, { t: 'call', id, method: 'model', params: { body: parsed } })
      })
    },
    // Host messages for calls: answer, head, chunk, end.
    handle(message) {
      if (message.t === 'answer') {
        const resolve = pending.get(message.id)
        if (!resolve) return
        pending.delete(message.id)
        resolve(message.result)
        return
      }
      const stream = streams.get(message.id)
      if (stream && ['head', 'chunk', 'end'].includes(message.t)) stream[message.t](message)
    },
    // Stop: every open call ends as refused.
    cancel(reason) {
      for (const resolve of pending.values()) resolve({ ok: false, error: reason })
      pending.clear()
      for (const stream of streams.values()) stream.end({ error: reason })
      streams.clear()
    },
  }
}
