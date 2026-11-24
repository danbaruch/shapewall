// Serves dist/ the way production should: clean URLs (/features -> features.html), long caching for hashed
// assets, 404.html with status 404. For local checks only: node scripts/serve.mjs [port] (default 4700).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// SHAPEWALL_DIST serves another build folder (scripts/shots.mjs uses it to compare a saved build with the current one).
const DIST = process.env.SHAPEWALL_DIST
  ? path.resolve(process.env.SHAPEWALL_DIST)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
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

// /media/<hashed name>: the videos and posters from website/media/ (git-ignored, scripts/media-encode.mjs), the way the
// production server serves its shared media folder: byte ranges (a video seeks with them) and a year of caching, since
// every name carries its content hash. Returns false for any other path.
const MEDIA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'media')
const MEDIA_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
}
export function serveMedia(req, res) {
  const match = /^\/media\/([a-z0-9][a-z0-9-]*\.[0-9a-f]{10}\.(mp4|webm|vtt|jpg|webp))(?:\?.*)?$/.exec(req.url || '')
  if (!match) return false
  const file = path.join(MEDIA, match[1])
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('not found')
    return true
  }
  const size = fs.statSync(file).size
  const headers = {
    'Content-Type': MEDIA_TYPES[path.extname(file)],
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return true
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    fs.createReadStream(file, { start, end }).pipe(res)
    return true
  }
  res.writeHead(200, { ...headers, 'Content-Length': size })
  fs.createReadStream(file).pipe(res)
  return true
}

export function createServer() {
  return http.createServer((req, res) => {
    if (serveMedia(req, res)) return
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
