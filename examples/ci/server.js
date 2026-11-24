// A tiny static site for trying `shapewall ci` (and for its tests). Two
// variants of the same site: "base" serves site/, "head" serves site-head/
// first and falls back to site/, so a pull request that changes one page is
// one file in site-head/. The home page shows a clock, which ci.ignore hides.
//
//   node server.js                 base variant on $PORT (default 5810)
//   node server.js --variant head  the changed variant
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export function startSite({ port = 5810, host = '127.0.0.1', variant = 'base' } = {}) {
  const roots = variant === 'head' ? [path.join(HERE, 'site-head'), path.join(HERE, 'site')] : [path.join(HERE, 'site')]
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const name = pathname === '/' ? 'index.html' : `${pathname.replace(/^\/+|\/+$/g, '')}.html`
    if (!/^[a-z0-9-]+\.html$/.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
      return
    }
    const file = roots.map((root) => path.join(root, name)).find((candidate) => fs.existsSync(candidate))
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Not found</title><h1>Not found</h1>')
      return
    }
    const clock = new Date().toISOString().slice(11, 19)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(file, 'utf8').replace('{{clock}}', clock))
  })
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const variant = process.argv.includes('--variant') ? process.argv[process.argv.indexOf('--variant') + 1] : 'base'
  const port = Number(process.env.PORT || 5810)
  startSite({ port, variant }).then(() => console.log(`examples/ci (${variant}) on http://127.0.0.1:${port}/`))
}
