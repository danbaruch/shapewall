// Stand-ins for the two Node modules @titan-design/speech-g2p imports, used
// only in the browser build (scripts/vite-tts.js points its "fs" and "crypto"
// here). Its lexicon files are fetched by the worker first and handed over
// with provideFile; readFileSync then returns them by file name.

// Its version string also calls Buffer.from (this runs only in the worker).
globalThis.Buffer ??= { from: (value) => new TextEncoder().encode(String(value)) }

const files = new Map()
// Build output adds a hash to each name (tts-us_gold-1a2b3c4d.json).
const NAMES = ['us_gold', 'us_silver', 'spacy-en-tokenizer']
const stem = (value) => NAMES.find((name) => String(value).includes(name)) || String(value)

export function provideFile(name, text) {
  files.set(stem(name), text)
}

export function readFileSync(url, encoding) {
  const name = stem(url instanceof URL ? url.pathname : url)
  if (!files.has(name)) throw new Error(`${name} is not loaded`)
  const text = files.get(name)
  return encoding ? text : new TextEncoder().encode(text)
}

// Only the lexicon's version string uses a hash; it never leaves the worker.
export function createHash() {
  let hash = 0x811c9dc5
  const api = {
    update(data) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      for (let i = 0; i < bytes.length; i += 1) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0
      return api
    },
    digest: () => hash.toString(16).padStart(8, '0'),
  }
  return api
}

export default { readFileSync, createHash }
