// A small pool of worker threads that clean pushed files (clean-worker.js).
// At most `size` files are cleaned at once and at most `maxQueue` wait; a
// file that takes longer than `timeoutMs` (a decompression bomb, say) has
// its worker terminated and replaced. Workers are unref'd, so an idle pool
// never keeps the process alive.

import { Worker } from 'node:worker_threads'
import { PushError } from './push.js'

const WORKER_URL = new URL('./clean-worker.js', import.meta.url)

export function createCleaner({ size = 2, maxQueue = 32, timeoutMs = 30_000, memoryMb = 512 } = {}) {
  const idle = []
  const busy = new Set()
  const queue = []
  let nextId = 1
  let closed = false

  function spawn() {
    const worker = new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: memoryMb } })
    worker.unref()
    worker.on('message', (message) => finish(worker, message))
    worker.on('error', () => crash(worker))
    worker.on('exit', () => crash(worker))
    return worker
  }

  function crash(worker) {
    const job = worker.job
    if (!job) {
      const index = idle.indexOf(worker)
      if (index !== -1) idle.splice(index, 1)
      return
    }
    worker.job = null
    busy.delete(worker)
    clearTimeout(job.timer)
    job.reject(new PushError(422, 'clean_failed', 'The file could not be cleaned.'))
    pump()
  }

  function finish(worker, message) {
    const job = worker.job
    if (!job || job.id !== message.id) return
    worker.job = null
    clearTimeout(job.timer)
    busy.delete(worker)
    idle.push(worker)
    // A comment image comes back with what was read from it: { buffer,
    // mediaType, width, height }. Everything else: the Buffer.
    const buffer = message.ok ? Buffer.from(message.body.buffer, message.body.byteOffset, message.body.byteLength) : null
    if (message.ok) job.resolve(message.meta ? { ...message.meta, buffer } : buffer)
    else job.reject(new PushError(message.status, message.code, message.message))
    pump()
  }

  function pump() {
    while (!closed && queue.length && busy.size < size) {
      const job = queue.shift()
      const worker = idle.pop() || spawn()
      worker.job = job
      busy.add(worker)
      job.timer = setTimeout(() => {
        job.reject(new PushError(422, 'clean_timeout', 'The file took too long to clean.'))
        worker.job = null
        busy.delete(worker)
        worker.terminate()
        pump()
      }, timeoutMs)
      job.timer.unref?.()
      worker.postMessage({ id: job.id, kind: job.kind, body: job.body, base: job.base })
    }
  }

  // Resolves with the cleaned Buffer, or rejects with a PushError.
  function clean(kind, body, base = null) {
    if (closed) return Promise.reject(new PushError(503, 'closing', 'The server is shutting down.'))
    if (queue.length >= maxQueue) return Promise.reject(new PushError(503, 'busy', 'The server is busy cleaning files; try again shortly.'))
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, kind, body, base, resolve, reject })
      pump()
    })
  }

  async function close() {
    closed = true
    for (const job of queue.splice(0)) job.reject(new PushError(503, 'closing', 'The server is shutting down.'))
    await Promise.all([...idle.splice(0), ...busy].map((worker) => worker.terminate()))
  }

  return { clean, close, stats: () => ({ busy: busy.size, idle: idle.length, queued: queue.length }) }
}
