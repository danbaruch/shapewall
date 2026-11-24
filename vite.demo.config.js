import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { clientLicense } from './scripts/client-license.js'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { ttsWorker } from './scripts/vite-tts.js'
import { appDefines, buildInfo, buildMetadata } from './scripts/build-info.js'
import debugIds from './scripts/vite-debug-ids.mjs'
import sourcemapsStep from './scripts/vite-sourcemaps-step.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// The public demo (shapewall.com/demo/): the board and the hosted console in
// one static build, with __SHAPEWALL_DEMO__ on, so both load the in-browser
// backend (client/src/demo) that answers every API call with fictional
// fixtures. scripts/demo-export.js copies dist/demo-app into the export.
// Relative URLs throughout: it is served from a sub-path. No service worker.
export default defineConfig({
  root: 'client',
  base: './',
  define: { __SHAPEWALL_DEMO__: 'true', ...appDefines },
  plugins: [
    react(),
    tailwindcss(),
    buildMetadata(),
    clientLicense(),
    {
      // console.html is written for `shapewall hosted` (/_console/ and a
      // per-response CSP nonce); in the demo it sits next to index.html.
      name: 'shapewall-demo-console-html',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replaceAll('/_console/', './').replace(/\s*<meta name="sw-nonce"[^>]*>/, ''),
      },
    },
    // Demo only (not the package build): hidden source maps with debug ids for our GlitchTip, uploaded for the
    // release the demo reports (client/src/lib/error-tracking.js) when website/deploy/deploy.sh asks, always deleted.
    debugIds(),
    sourcemapsStep({ release: buildInfo.revision.slice(0, 7) }),
  ],
  worker: ttsWorker(),
  build: {
    outDir: '../dist/demo-app',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    sourcemap: 'hidden',
    rollupOptions: {
      input: { index: path.join(ROOT, 'client', 'index.html'), console: path.join(ROOT, 'client', 'console.html') },
    },
  },
})
