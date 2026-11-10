import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { markdown } from './scripts/markdown.mjs'

// The site is prerendered: `vite build` (client), `vite build --ssr src/entry-server.jsx` (renderer), then
// scripts/prerender.mjs writes one HTML file per route into dist/. Docs pages are markdown in src/docs/, turned
// into HTML at build time by the markdown plugin, so no markdown parser ships to the browser. Guides that also
// live in the repository's docs/ folder are read from there (see scripts/markdown.mjs).
const launched = (process.env.SHAPEWALL_LAUNCHED ?? '0').trim() || '0'
if (!['0', '1'].includes(launched)) throw new Error('SHAPEWALL_LAUNCHED must be 0 (early access, the default) or 1 (launched)')

export default defineConfig({
  base: '/',
  plugins: [markdown(), react(), tailwindcss()],
  // The launch switch, read by src/launch.js.
  // __SHAPEWALL_STEALTH__ lets client-side navigation keep the robots tag the prerender wrote (src/components/layout.jsx).
  define: {
    __SHAPEWALL_LAUNCHED__: JSON.stringify(launched),
    __SHAPEWALL_STEALTH__: JSON.stringify((process.env.SHAPEWALL_STEALTH ?? '1').trim() === '0' ? '0' : '1'),
  },
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
})
