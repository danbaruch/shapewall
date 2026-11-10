// A tiny static file server for the demo site (no dependencies). Directory
// paths serve their index.html, like most static hosts.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

// `root` serves another copy of the site (the live demo builds staging and
// production copies from this one).
export function startDemoSite({ port = 4601, host = '127.0.0.1', root = PUBLIC } = {}) {
  const server = http.createServer((req, res) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    let file = path.join(root, pathname)
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end()
      return
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4601
  startDemoSite({ port }).then(() => console.log(`Demo site at http://127.0.0.1:${port}/`))
}
