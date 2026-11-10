// Serves dist/ the way production should: clean URLs (/features -> features.html), long caching for hashed
// assets, 404.html with status 404. For local checks only: node scripts/serve.mjs [port] (default 4700).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REDIRECTS } from '../src/routes.js'

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
}

export function resolveFile(urlPath) {
  let clean
  try {
    clean = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null
  }
  const safe = path.normalize(clean).replace(/^(\.\.[/\\])+/, '')
  const candidates = safe.endsWith('/') ? [path.join(safe, 'index.html'), safe.replace(/\/+$/, '') + '.html'] : [safe, safe + '.html']
  for (const candidate of candidates) {
    const full = path.join(DIST, candidate)
    if (!full.startsWith(DIST)) continue
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
  }
  return null
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (Object.hasOwn(REDIRECTS, url.pathname)) {
      res.writeHead(301, { Location: REDIRECTS[url.pathname] + url.search, 'Cache-Control': 'no-cache' })
      res.end()
      return
    }
    const file = resolveFile(req.url || '/')
    const status = file ? 200 : 404
    const target = file || path.join(DIST, '404.html')
    const ext = path.extname(target)
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }
    headers['Cache-Control'] = target.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
    res.writeHead(status, headers)
    fs.createReadStream(target).pipe(res)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 4700)
  createServer().listen(port, '127.0.0.1', () => console.log(`Serving dist/ at http://127.0.0.1:${port}/`))
}
