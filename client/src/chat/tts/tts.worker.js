// The natural voice's worker: loads Kokoro into ONNX Runtime Web (on
// WebAssembly; docs/agents.md says why not WebGPU), turns text into phonemes
// (g2p.js) and phonemes into 24 kHz audio, one request at a time, off the
// main thread. Text never leaves this worker. The only network requests are
// the model, its tokenizer and the voice files from Hugging Face (kept in the
// browser's Cache API after the first time) and this build's own files.
//
// Messages in:  { type: 'load', voice }
//               { type: 'speak', id, text, voice, speed }
//               { type: 'cancel', ids }
// Messages out: { type: 'progress', loaded, total }
//               { type: 'ready', device, ms }
//               { type: 'audio', id, samples (transferred), phonemes, ms }
//               { type: 'error', id?, message, code? }  (code 'integrity': a file did not match its pin)

import assets from 'virtual:shapewall-tts-assets'
import { provideFile } from './node-shims.js'
import { createG2p } from './g2p.js'
import { CACHE_NAME, MODEL_BYTES, MODEL_FILE, STYLE_DIM, TOKENIZER_FILE, modelUrl, pinFor, voiceUrl } from './voices.js'
import { IntegrityError, verifyBytes } from './verify.js'

// Kokoro reads at most 510 phoneme tokens between its two "$" pads (id 0).
const MAX_TOKENS = 510

let ready = null
let session = null
let ort = null
let vocab = null
let g2p = null
const voices = new Map()
const cancelled = new Set()
let chain = Promise.resolve()

const post = (message, transfer = []) => self.postMessage(message, transfer)

async function fetchOk(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load ${url.split('/').pop()} (${response.status}).`)
  return response
}

async function openCache() {
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

// A file from Hugging Face, from the cache when it is there. Every file is
// pinned (voices.js pinFor): a download is checked against its published
// size and SHA-256 before it is cached or used, and a mismatch deletes any
// cache entry for it and fails the load. Only a verified, complete download
// is cached, so a cancelled one (the worker is stopped) leaves nothing
// behind. onBytes(loaded) reports progress.
async function cachedBytes(url, onBytes = () => {}) {
  const pin = pinFor(url)
  const name = url.split('/').pop()
  const cache = await openCache()
  const hit = await cache?.match(url)
  if (hit) {
    const buffer = await hit.arrayBuffer()
    // Only verified files are cached; the size check catches a damaged entry.
    if (pin && buffer.byteLength === pin.bytes) {
      onBytes(buffer.byteLength)
      return buffer
    }
    await cache.delete(url).catch(() => {})
  }
  const discard = async (error) => {
    await cache?.delete(url).catch(() => {})
    throw error
  }
  if (!pin) return discard(new IntegrityError(name, 'no pinned hash'))
  const response = await fetchOk(url)
  const reader = response.body?.getReader()
  let buffer
  if (!reader) {
    buffer = await response.arrayBuffer()
    onBytes(buffer.byteLength)
  } else {
    const parts = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.byteLength
      // Larger than the published file: stop now rather than read it all.
      if (loaded > pin.bytes) {
        reader.cancel().catch(() => {})
        return discard(new IntegrityError(name, `more than ${pin.bytes} bytes`))
      }
      parts.push(value)
      onBytes(loaded)
    }
    const bytes = new Uint8Array(loaded)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    buffer = bytes.buffer
  }
  try {
    await verifyBytes(buffer, pin, name)
  } catch (error) {
    return discard(error)
  }
  await cache?.put(url, new Response(buffer.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {})
  return buffer
}

async function load(voice) {
  const started = performance.now()
  let last = 0
  const report = (loaded) => {
    const now = Date.now()
    if (now - last < 100 && loaded < MODEL_BYTES) return
    last = now
    post({ type: 'progress', loaded, total: Math.max(MODEL_BYTES, loaded) })
  }
  post({ type: 'progress', loaded: 0, total: MODEL_BYTES })
  const [runtime, model, tokenizer, gold, silver, tokenizerData] = await Promise.all([
    import('onnxruntime-web/wasm'),
    cachedBytes(modelUrl(MODEL_FILE), report),
    cachedBytes(modelUrl(TOKENIZER_FILE)),
    fetchOk(assets.gold).then((response) => response.text()),
    fetchOk(assets.silver).then((response) => response.text()),
    fetchOk(assets.tokenizer).then((response) => response.text()),
  ])
  vocab = JSON.parse(new TextDecoder().decode(tokenizer)).model.vocab
  provideFile('us_gold', gold)
  provideFile('us_silver', silver)
  provideFile('spacy-en-tokenizer', tokenizerData)
  const [{ misakiEnglish }, { EnglishG2P }] = await Promise.all([import('@titan-design/speech-g2p'), import('phonemize/en-g2p')])
  const english = new EnglishG2P()
  g2p = createG2p({ misakiEnglish, toIPA: (word) => english.predict(word) || '' })

  ort = runtime
  // The runtime's WebAssembly ships with this build (no third-party script).
  ort.env.wasm.wasmPaths = { wasm: assets.ortWasm }
  // Threads need a cross-origin isolated page; otherwise one.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 1) : 1
  session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  // One short run now: a session's first run is the slow one, and the voice
  // file comes with it, so the first Read aloud starts sooner.
  if (voice) await synthesizeText('Ready.', voice, 1).catch(() => {})
  return { device: 'wasm', ms: Math.round(performance.now() - started) }
}

async function voiceData(id) {
  if (!voices.has(id)) voices.set(id, new Float32Array(await cachedBytes(voiceUrl(id))))
  return voices.get(id)
}

// Kokoro's tokenizer is one id per phoneme symbol, padded with "$" (0).
function tokenize(phonemes) {
  const ids = [0]
  for (const symbol of phonemes) {
    const id = vocab[symbol]
    if (id !== undefined && ids.length <= MAX_TOKENS) ids.push(id)
  }
  ids.push(0)
  return ids
}

async function synthesizeText(text, voice, speed) {
  const phonemes = g2p.phonemize(text)
  if (!phonemes.replace(/[\s.,!?;:—…"“”()]/g, '')) return { samples: new Float32Array(0), phonemes }
  const ids = tokenize(phonemes)
  const tokens = Math.min(ids.length - 2, MAX_TOKENS - 1)
  const data = await voiceData(voice)
  const style = data.slice(tokens * STYLE_DIM, tokens * STYLE_DIM + STYLE_DIM)
  const feeds = {
    input_ids: new ort.Tensor(
      'int64',
      BigInt64Array.from(ids, (id) => BigInt(id)),
      [1, ids.length],
    ),
    style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([speed || 1]), [1]),
  }
  const output = await session.run(feeds)
  const waveform = output.waveform || output[session.outputNames[0]]
  return { samples: new Float32Array(waveform.data), phonemes }
}

async function speak({ id, text, voice, speed }) {
  const started = performance.now()
  const { samples, phonemes } = await synthesizeText(text, voice, speed)
  post({ type: 'audio', id, samples, phonemes, ms: Math.round(performance.now() - started) }, [samples.buffer])
}

self.onmessage = (event) => {
  const message = event.data || {}
  if (message.type === 'load') {
    ready ??= load(message.voice).then(
      (info) => post({ type: 'ready', ...info }),
      (error) => {
        ready = null
        post({ type: 'error', message: error?.message || String(error), code: error?.code })
      },
    )
    return
  }
  if (message.type === 'cancel') {
    for (const id of message.ids || []) cancelled.add(id)
    return
  }
  if (message.type === 'speak') {
    chain = chain.then(async () => {
      if (cancelled.delete(message.id)) return
      try {
        if (!session) throw new Error('The natural voice is not loaded.')
        await speak(message)
      } catch (error) {
        post({ type: 'error', id: message.id, message: error?.message || String(error) })
      }
    })
  }
}
