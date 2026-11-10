// End to end: error pages captured on purpose ("expectStatus"), unexpected
// statuses as failures, the broken-link report, and `capture --json`,
// against a tiny local site.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { main } from '../../src/cli.js'
import { runCapture } from '../../src/capture/capture.js'
import { loadConfig } from '../../src/config.js'
import { tempDir } from '../helpers.js'

const page = (title, links = []) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${links.map((href) => `<a href="${href}">${href}</a>`).join(' ')}</body></html>`

let server
let file
let base

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html' })
      res.end(body)
    }
    if (url.pathname === '/') return send(200, page('Home', ['/about', '/missing', '/oops', '/not-found', 'https://elsewhere.invalid/x']))
    if (url.pathname === '/about') return send(200, page('About', ['/', '/missing']))
    if (url.pathname === '/oops') return send(500, page('Oops'))
    if (url.pathname === '/broken') return send(503, page('Down'))
    return send(404, page('Not found', ['/']))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  const dir = tempDir('capture-status')
  file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      baseUrl: base,
      viewports: { desktop: { width: 800, height: 600 } },
      pages: [
        { id: 'home', path: '/' },
        { id: 'about', path: '/about' },
        { id: 'not-found', path: '/not-found', expectStatus: 404 },
        { id: 'broken', path: '/broken' },
      ],
    }),
  )
})

after(() => server?.close())

test('an expected error page is captured, an unexpected status fails, links that lead to errors are reported', async () => {
  const config = loadConfig(file)
  const result = await runCapture({ config, log: () => {} })
  assert.equal(result.failed, 1, 'only the 503 page fails')
  assert.equal(result.expected, 1)
  const notFound = result.shots.find((shot) => shot.page === 'not-found')
  assert.equal(notFound.status, 'ok')
  assert.equal(notFound.httpStatus, 404)
  assert.ok(fs.existsSync(path.join(result.dir, 'not-found.desktop.png')))
  const broken = result.shots.find((shot) => shot.page === 'broken')
  assert.equal(broken.error, 'HTTP 503')
  assert.deepEqual(
    result.brokenLinks.map((item) => [item.path, item.status, item.from]),
    [
      ['/missing', 404, ['about', 'home']],
      ['/not-found', 404, ['home']],
      ['/oops', 500, ['home']],
    ],
  )
  assert.ok(!result.brokenLinks.some((item) => item.kind === 'external'), 'other sites only with --check-external')
})

test('capture --json prints one summary with failed shots and broken links; links --broken lists them', async () => {
  const out = []
  const err = []
  const code = await main(['capture', '--json', '--yes', '--config', file], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  assert.equal(code, 2)
  assert.equal(out.length, 1, 'stdout is only the JSON')
  const summary = JSON.parse(out[0])
  assert.equal(summary.ok, false)
  assert.equal(summary.failed, 1)
  assert.deepEqual(
    summary.failedShots.map((shot) => [shot.page, shot.httpStatus]),
    [['broken', 503]],
  )
  assert.equal(summary.brokenLinks.length, 3)
  assert.ok(
    err.some((line) => /FAIL broken desktop HTTP 503/.test(line)),
    'progress goes to stderr',
  )
  const listed = []
  assert.equal(await main(['links', '--broken', '--config', file], { out: (line) => listed.push(line) }), 2)
  assert.match(listed.join('\n'), /3 broken links[\s\S]*404 {2}\/missing {2}\(from about, home\)/)
})

test('expectStatus: a page that answers something else fails, and says what was expected', async () => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.pages = [
    { id: 'home', path: '/', expectStatus: [404, 410] },
    { id: 'about', path: '/about' },
  ]
  const dir = tempDir('capture-status-2')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(raw))
  const result = await runCapture({ config: loadConfig(path.join(dir, 'shapewall.config.json')), log: () => {} })
  assert.equal(result.failed, 1)
  assert.equal(result.shots.find((shot) => shot.page === 'home').error, 'HTTP 200 (expected 404 or 410)')
})
