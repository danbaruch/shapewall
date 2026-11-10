import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { appDefines, buildMetadata } from './scripts/build-info.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// The hosted console (client/src/console): its own entry and output
// (dist/console), served by `shapewall hosted` under /_console/. It shares
// the board's kit and tokens but not its service worker or shell.
// `npm run dev:console` serves it with hot reload and proxies the hosted
// server on port 4700 (start one with --origin http://localhost:5174).
export default defineConfig({
  root: 'client',
  base: '/_console/',
  // The public demo's backend is built only by vite.demo.config.js.
  define: { __SHAPEWALL_DEMO__: 'false', ...appDefines },
  plugins: [react(), tailwindcss(), buildMetadata()],
  build: {
    outDir: '../dist/console',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: { input: { console: path.join(ROOT, 'client', 'console.html') } },
  },
  server: {
    port: 5174,
    proxy: Object.fromEntries(['/api', '/auth', '/w/', '/s/', '/uc/'].map((prefix) => [prefix, 'http://127.0.0.1:4700'])),
  },
})
