import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TTS_PREFIX, ttsWorker } from './scripts/vite-tts.js'
import { appDefines, buildMetadata } from './scripts/build-info.js'

// Icons, manifest and favicon from client/public that belong to the app shell.
const PUBLIC_SHELL = [
  'manifest.webmanifest',
  'favicon.svg',
  'theme-boot.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
]

// Emits sw.js from client/sw.js with this build's shell list and a build id,
// so each build gets its own cache and old ones are dropped.
function serviceWorker() {
  return {
    name: 'shapewall-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(options, bundle) {
      const assets = Object.keys(bundle)
        // The natural voice (assets/tts-*, tens of MB) loads only when someone turns it on.
        .filter((name) => name.startsWith('assets/') && !name.startsWith(TTS_PREFIX) && !name.endsWith('.map'))
        .sort()
      const shell = ['./', ...PUBLIC_SHELL, ...assets]
      const build = createHash('sha256').update(shell.join('\n')).digest('hex').slice(0, 12)
      const source = fs
        .readFileSync(new URL('./client/sw.js', import.meta.url), 'utf8')
        .replace('/* global __SHAPEWALL_SHELL__ */\n', '')
        .replace("const BUILD = '__SHAPEWALL_BUILD__'", `const BUILD = ${JSON.stringify(build)}`)
        .replace('const SHELL = __SHAPEWALL_SHELL__', `const SHELL = ${JSON.stringify(shell)}`)
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// The client lives in client/ and builds into dist/client, which the
// Shapewall server serves. `npm run dev` proxies the API to a running
// `shapewall serve` on port 4600.
export default defineConfig({
  root: 'client',
  base: './',
  // The public demo's backend is built only by vite.demo.config.js.
  define: { __SHAPEWALL_DEMO__: 'false', ...appDefines },
  plugins: [react(), tailwindcss(), buildMetadata(), serviceWorker()],
  worker: ttsWorker(),
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4600' },
  },
})
