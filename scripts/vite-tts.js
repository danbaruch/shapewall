// Build support for the natural voice (client/src/chat/tts), shared by the
// board and demo Vite configs:
// - @titan-design/speech-g2p imports Node's fs and crypto; in the browser they
//   resolve to client/src/chat/tts/node-shims.js (only for that package).
// - virtual:shapewall-tts-assets gives the worker the URLs of the lexicon
//   files and of ONNX Runtime's WebAssembly file, emitted as build assets.
// - Everything the worker needs is named assets/tts-*, so the server can give
//   the worker its own CSP and the service worker can leave it out of the
//   app shell (it is downloaded only when someone turns natural voices on).
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHIMS = path.join(ROOT, 'client', 'src', 'chat', 'tts', 'node-shims.js')
const VIRTUAL = 'virtual:shapewall-tts-assets'

// The packages are dev dependencies of this repo (built into the client).
const packageDir = (name) => path.join(ROOT, 'node_modules', ...name.split('/'))

export const TTS_PREFIX = 'assets/tts-'

export function ttsAssets() {
  return {
    name: 'shapewall-tts-assets',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === VIRTUAL) return `\0${VIRTUAL}`
      if (
        (source === 'fs' || source === 'crypto') &&
        importer &&
        importer.includes(`${path.sep}@titan-design${path.sep}speech-g2p${path.sep}`)
      ) {
        return SHIMS
      }
      return null
    },
    load(id) {
      if (id !== `\0${VIRTUAL}`) return null
      const g2pDir = packageDir('@titan-design/speech-g2p')
      const ortDir = path.join(packageDir('onnxruntime-web'), 'dist')
      const files = {
        gold: path.join(g2pDir, 'data', 'us_gold.json'),
        silver: path.join(g2pDir, 'data', 'us_silver.json'),
        tokenizer: path.join(g2pDir, 'data', 'spacy-en-tokenizer.json'),
        // The plain SIMD build (no WebGPU): onnxruntime-web/wasm bundles its loader.
        ortWasm: path.join(ortDir, 'ort-wasm-simd-threaded.wasm'),
      }
      const names = Object.keys(files)
      return [
        ...names.map((name) => `import ${name} from ${JSON.stringify(`${files[name]}?url`)}`),
        `export default { ${names.join(', ')} }`,
      ].join('\n')
    },
  }
}

// Vite's worker options: ES modules (the worker imports its pieces lazily)
// and the tts- prefix on every file it brings.
export const ttsWorker = () => ({
  format: 'es',
  plugins: () => [ttsAssets()],
  rollupOptions: {
    output: {
      entryFileNames: `${TTS_PREFIX}[name]-[hash].js`,
      chunkFileNames: `${TTS_PREFIX}[name]-[hash].js`,
      assetFileNames: `${TTS_PREFIX}[name]-[hash][extname]`,
    },
  },
})
