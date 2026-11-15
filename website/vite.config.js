import { execFileSync } from 'node:child_process'
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
// Error reports for this site (src/errors.js): only in a build made with SHAPEWALL_ERROR_DSN (deploy/deploy.sh sets ours).
const errorDsn = (process.env.SHAPEWALL_ERROR_DSN || '').trim()
if (errorDsn && !/^https:\/\/[^@/\s]+@[^/\s]+\/\d+$/.test(errorDsn))
  throw new Error('SHAPEWALL_ERROR_DSN must be a DSN: https://<key>@<host>/<project id>')
const errorEnvironment = (process.env.SHAPEWALL_ERROR_ENVIRONMENT || '').trim() || 'production'
let revision = ''
try {
  revision = errorDsn
    ? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    : ''
} catch {
  revision = ''
}

export default defineConfig({
  base: '/',
  plugins: [markdown(), react(), tailwindcss()],
  // The launch switch, read by src/launch.js.
  // __SHAPEWALL_STEALTH__ lets client-side navigation keep the robots tag the prerender wrote (src/components/layout.jsx).
  define: {
    __SHAPEWALL_LAUNCHED__: JSON.stringify(launched),
    __SHAPEWALL_STEALTH__: JSON.stringify((process.env.SHAPEWALL_STEALTH ?? '1').trim() === '0' ? '0' : '1'),
    __SHAPEWALL_ERROR_DSN__: JSON.stringify(errorDsn),
    __SHAPEWALL_ERROR_ENVIRONMENT__: JSON.stringify(errorEnvironment),
    __SHAPEWALL_ERROR_RELEASE__: JSON.stringify(revision),
  },
  server: { fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
})
