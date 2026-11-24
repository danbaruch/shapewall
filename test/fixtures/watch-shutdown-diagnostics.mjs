// Test-only preload. Never log URLs, headers, bodies, error messages or env.
const began = performance.now()
let sequence = 0
let emitted = 0
const log = (event, fields = {}) => {
  if (emitted++ >= 200) return
  process.stderr.write(`[watch-diag] ${JSON.stringify({ ms: Math.round(performance.now() - began), event, ...fields })}\n`)
}
const errorType = (error) => (['AbortError', 'TypeError', 'TimeoutError'].includes(error?.name) ? error.name : 'Other')
const counts = (names) => {
  const result = {}
  for (const name of names) {
    const safe = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Other'
    result[safe] = (result[safe] || 0) + 1
  }
  return result
}
const snapshot = (event) =>
  log(event, {
    resources: counts(process.getActiveResourcesInfo()),
    handles: counts(process._getActiveHandles().map((handle) => handle.constructor?.name || 'Other')),
    requests: counts(process._getActiveRequests().map((request) => request.constructor?.name || 'Other')),
    sigintListeners: process.listenerCount('SIGINT'),
    exitCode: typeof process.exitCode === 'number' ? process.exitCode : null,
  })
process.on('SIGINT', () => {
  snapshot('sigint')
  setTimeout(() => snapshot('sigint-plus-5s'), 5000).unref()
})
process.once('beforeExit', () => snapshot('before-exit'))
process.once('exit', (code) => log('exit', { code }))

const originalFetch = globalThis.fetch
globalThis.fetch = async (...args) => {
  const id = ++sequence
  const signal = args[1]?.signal
  log('fetch-start', { id, signal: Boolean(signal), aborted: Boolean(signal?.aborted) })
  signal?.addEventListener('abort', () => log('fetch-abort', { id }), { once: true })
  let response
  try {
    response = await originalFetch(...args)
  } catch (error) {
    log('fetch-error', { id, type: errorType(error) })
    throw error
  }
  log('fetch-headers', { id, status: response.status })
  for (const method of ['json', 'arrayBuffer', 'text']) {
    const original = response[method].bind(response)
    response[method] = async (...values) => {
      log(`body-${method}-start`, { id })
      try {
        const value = await original(...values)
        log(`body-${method}-end`, { id })
        return value
      } catch (error) {
        log(`body-${method}-error`, { id, type: errorType(error) })
        throw error
      }
    }
  }
  if (response.body) {
    const getReader = response.body.getReader.bind(response.body)
    response.body.getReader = (...values) => {
      const reader = getReader(...values)
      for (const method of ['read', 'cancel']) {
        const original = reader[method].bind(reader)
        reader[method] = async (...values) => {
          log(`reader-${method}-start`, { id })
          try {
            const value = await original(...values)
            log(`reader-${method}-end`, { id, ...(method === 'read' ? { done: value.done } : {}) })
            return value
          } catch (error) {
            log(`reader-${method}-error`, { id, type: errorType(error) })
            throw error
          }
        }
      }
      return reader
    }
  }
  return response
}
log('preload-ready')
