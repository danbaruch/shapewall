// The natural voice on the main thread: one worker (tts.worker.js), started
// only when someone turns natural voices on, and a small store the chat
// panel reads (download progress, ready, errors, pace). The model, the
// runtime and the lexicons are all in the worker's own files (assets/tts-*),
// so the board's main bundle carries only this glue.

import { CACHE_NAME, MODEL_FILE, SAMPLE_RATE, modelUrl } from './voices.js'
import { naturalSupport } from './support.js'
import { INTEGRITY_CODE } from './verify.js'

const MODEL_URL = modelUrl(MODEL_FILE)

// status: idle | downloading | ready | error | unsupported
let state = { status: 'idle', loaded: 0, total: 0, error: null, device: null, downloaded: null, loadMs: null, pace: null }
const listeners = new Set()
let worker = null
let readyWaiters = []
const pending = new Map()
let nextId = 1

function set(patch) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export const naturalStore = {
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  get: () => state,
}

// Is the model already in this browser's cache (no download needed)?
export async function checkDownloaded() {
  let downloaded = false
  try {
    const cache = await caches.open(CACHE_NAME)
    downloaded = Boolean(await cache.match(MODEL_URL))
  } catch {
    downloaded = false
  }
  set({ downloaded })
  return downloaded
}

function failAll(message) {
  const error = new Error(message)
  for (const { reject } of pending.values()) reject(error)
  pending.clear()
  readyWaiters.forEach(({ reject }) => reject(error))
  readyWaiters = []
}

function onMessage(event) {
  const message = event.data || {}
  if (message.type === 'progress') {
    set({ loaded: message.loaded, total: message.total })
  } else if (message.type === 'ready') {
    set({ status: 'ready', device: message.device, loadMs: message.ms, downloaded: true, error: null })
    readyWaiters.forEach(({ resolve }) => resolve())
    readyWaiters = []
  } else if (message.type === 'audio') {
    const job = pending.get(message.id)
    pending.delete(message.id)
    job?.resolve(message.samples)
    // How long a second of speech takes to make here (above 1: pauses).
    const seconds = message.samples.length / SAMPLE_RATE
    if (seconds >= 1) set({ pace: Math.round(((message.ms || 0) / 1000 / seconds) * 100) / 100 })
  } else if (message.type === 'error') {
    if (message.id != null) {
      const job = pending.get(message.id)
      pending.delete(message.id)
      job?.reject(new Error(message.message))
    } else {
      stopWorker()
      console.warn('Shapewall natural voice:', message.message)
      set({ status: 'error', error: friendlyError(message.message, message.code) })
      failAll(message.message)
      // A failed load can leave other files cached (Remove the download).
      checkDownloaded()
    }
  }
}

export const INTEGRITY_MESSAGE =
  'The natural voice download did not match the published files, so it was deleted. Try again later; the system voice reads meanwhile.'

function friendlyError(message, code) {
  if (code === INTEGRITY_CODE) return INTEGRITY_MESSAGE
  if (/fetch|network|load|40\d|50\d/i.test(message || '')) {
    return 'The natural voice could not be downloaded. Check the connection and try again; the system voice reads meanwhile.'
  }
  return 'The natural voice could not start in this browser; the system voice reads instead.'
}

function stopWorker() {
  worker?.terminate()
  worker = null
}

// Start (or join) the download and load. Resolves when ready.
export function startNatural({ voice = null } = {}) {
  const support = naturalSupport()
  if (!support.ok) {
    set({ status: 'unsupported', error: support.reason })
    return Promise.reject(new Error(support.reason))
  }
  if (state.status === 'ready' && worker) return Promise.resolve()
  const waiting = new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }))
  if (!worker) {
    try {
      worker = new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module', name: 'shapewall-tts' })
    } catch (error) {
      worker = null
      set({ status: 'error', error: friendlyError(error?.message) })
      failAll(error?.message || 'worker')
      return waiting
    }
    worker.onmessage = onMessage
    worker.onerror = (event) => {
      event.preventDefault?.()
      console.warn('Shapewall natural voice worker:', event.message || 'failed to start')
      stopWorker()
      set({ status: 'error', error: friendlyError(event.message) })
      failAll(event.message || 'worker error')
    }
    set({ status: 'downloading', loaded: 0, total: 0, error: null })
    worker.postMessage({ type: 'load', voice })
  }
  return waiting
}

// Cancel a download in progress (or unload): the worker stops, and nothing
// half-downloaded is kept.
export function cancelNatural() {
  stopWorker()
  failAll('cancelled')
  set({ status: 'idle', loaded: 0, total: 0, error: null, device: null })
}

// Free the space: drop the model and voice files from this browser.
export async function removeNatural() {
  cancelNatural()
  try {
    await caches.delete(CACHE_NAME)
  } catch {
    /* no Cache API */
  }
  set({ downloaded: false })
}

export function synthesize(text, { voice, speed }) {
  if (!worker || state.status !== 'ready') return Promise.reject(new Error('The natural voice is not ready.'))
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ type: 'speak', id, text, voice, speed })
  })
}

// Drop queued sentences (Stop): the worker skips the ones it has not started.
export function cancelSpeech() {
  if (!pending.size) return
  worker?.postMessage({ type: 'cancel', ids: [...pending.keys()] })
  const error = new Error('cancelled')
  for (const { reject } of pending.values()) reject(error)
  pending.clear()
}
