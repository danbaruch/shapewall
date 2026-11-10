import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { normalizeConfig } from '../../src/config.js'
import { runChecks } from '../../src/checks/runner.js'
import { readSnapshot } from '../../src/checks/seo-snapshot.js'
import { checksBundle } from '../../src/checks/store.js'
import { tempDir } from '../helpers.js'

let browser
before(async () => {
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
})

async function fixture(t) {
  const received = []
  const png = PNG.sync.write(new PNG({ width: 12, height: 8 }))
  let robots = 'User-agent: *\nDisallow: /\nUser-agent: Googlebot\nAllow: /'
  let robotsStatus = 200
  let image = '/image'
  let robotsRedirect = false
  let extra = ''
  const other = http.createServer((req, res) => {
    received.push({ kind: 'off-origin', headers: req.headers })
    res.end(png)
  })
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
  const server = http.createServer((req, res) => {
    received.push({ kind: req.url, headers: req.headers })
    if (req.url === '/robots.txt') {
      if (robotsRedirect) {
        res.writeHead(302, { location: '/robots-target' })
        res.end()
        return
      }
      res.writeHead(robotsStatus, { 'content-type': 'text/plain' })
      res.end(robots)
      return
    }
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end(
        "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));",
      )
      return
    }
    if (req.url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(png)
      return
    }
    if (req.url === '/invalid') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end('private body not an image')
      return
    }
    if (req.url === '/corrupt') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(png.subarray(0, 24))
      return
    }
    if (req.url === '/missing') {
      res.writeHead(404)
      res.end('private')
      return
    }
    if (req.url === '/oversize') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': 6 * 1024 * 1024 })
      res.end(png)
      return
    }
    if (req.url === '/large-pixels') {
      const big = Buffer.from(png)
      big.writeUInt32BE(20000, 16)
      res.end(big)
      return
    }
    if (req.url === '/stream-large') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.alloc(5 * 1024 * 1024 + 1))
      return
    }
    if (req.url === '/image-redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${other.address().port}/image` })
      res.end()
      return
    }
    if (req.url === '/image-local-redirect') {
      res.writeHead(302, { location: '/image' })
      res.end()
      return
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.write(png.subarray(0, 10))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html', 'x-robots-tag': 'noindex', 'set-cookie': 'fixture=private; Path=/' })
    res.end(
      `<html lang="en"><title>Fixture private text</title><meta name="viewport" content="width=device-width"><meta name="description" content="Private description"><link rel="canonical" href="${base}/"><meta property="og:title" content="Private title"><meta property="og:description" content="Private description"><meta property="og:image" content="${image.startsWith('http') ? image : base + image}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><main><h1>Fixture</h1><div id="error">Private error</div><div hidden id="hidden-error">Hidden error</div>${extra}</main></html>`,
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(() => {
    server.closeAllConnections()
    server.close()
    other.closeAllConnections()
    other.close()
  })
  const config = normalizeConfig(
    {
      baseUrl: base,
      pages: [{ id: 'home', path: '/', viewports: ['desktop'] }],
      viewports: { desktop: { width: 1200, height: 800 } },
      timeouts: { page: 5000, settle: 50 },
    },
    { dir: tempDir('checks-seo') },
  )
  const run = async () => (await runChecks({ browser, config, seo: true, limit: 1 }))[0]
  return {
    config,
    run,
    received,
    base,
    other,
    set: (s) => {
      if ('robots' in s) robots = s.robots
      if ('robotsStatus' in s) robotsStatus = s.robotsStatus
      if ('image' in s) image = s.image
      if ('robotsRedirect' in s) robotsRedirect = s.robotsRedirect
      if ('extra' in s) extra = s.extra
    },
  }
}

test('real SEO probes decode original image, observe rule precedence and never store private text or send cookies', async (t) => {
  const f = await fixture(t)
  const r = await f.run()
  assert.equal(r.state, 'complete')
  assert.equal(r.metrics.robotsAllowed, 1)
  assert.equal(r.metrics.socialImageDecodedWidth, 12)
  assert.equal(r.metrics.socialImageDecodedHeight, 8)
  assert.ok(r.metrics.socialImageBytes > 0)
  assert.equal(r.metrics.socialImageWidth, 1200)
  assert.ok(r.findings.some((x) => x.id === 'social-image-dimensions'))
  assert.ok(r.findings.some((x) => x.id === 'search-noindex' && x.severity === 'advisory'))
  assert.doesNotMatch(JSON.stringify(r), /127\.0\.0\.1|Private description|Private title|Fixture private text|robots\.txt|#error|\/image/)
  assert.equal(r.metrics.titleLength, 'Fixture private text'.length)
  assert.ok(r.findings.some((x) => x.id === 'seo-description-short'))
  assert.ok(!r.findings.some((x) => x.id === 'canonical-elsewhere'))
  // The local search preview keeps the page's own metadata and a browser
  // JPEG re-encode of the social image, beside (never inside) the report.
  const preview = readSnapshot(f.config, r.boardId, r.id)
  assert.equal(preview.title, 'Fixture private text')
  assert.equal(preview.description, 'Private description')
  assert.equal(preview.canonical, `${f.base}/`)
  assert.equal(preview.social.title, 'Private title')
  assert.match(preview.image.dataUrl, /^data:image\/jpeg;base64,/)
  assert.deepEqual([preview.image.width, preview.image.height], [12, 8])
  assert.equal(checksBundle(f.config, r.boardId, { includeChecks: true }).reports.length >= 1, true)
  assert.doesNotMatch(JSON.stringify(checksBundle(f.config, r.boardId, { includeChecks: true })), /Fixture private text|data:image/)
  for (const request of f.received.filter((r) => ['/robots.txt', '/image'].includes(r.kind))) {
    assert.equal(request.headers.cookie, undefined)
    assert.equal(request.headers.referer, undefined)
    assert.equal(request.headers.authorization, undefined)
  }
  f.set({ robots: 'User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /' })
  assert.equal((await f.run()).metrics.robotsAllowed, 0)
  f.set({ robotsStatus: 404 })
  assert.equal((await f.run()).metrics.robotsAllowed, 1)
  for (const status of [429, 503]) {
    f.set({ robotsStatus: status })
    const r = await f.run()
    assert.equal(r.metrics.robotsAllowed, null)
    assert.ok(r.findings.some((x) => x.id === 'robots-unavailable'))
  }
  f.set({ robotsStatus: 200, robotsRedirect: true })
  const redirected = await f.run()
  assert.equal(redirected.metrics.robotsAllowed, null)
  assert.ok(!f.received.some((r) => r.kind === '/robots-target'))
})

test('image HTTP, invalid, corrupt, oversized, redirect and foreign targets have honest bounded results', async (t) => {
  const f = await fixture(t)
  for (const image of ['/missing', '/invalid', '/corrupt']) {
    f.set({ image })
    const r = await f.run()
    assert.equal(r.metrics.socialImageDecodedWidth, null)
    assert.ok(
      r.findings.some((x) => x.id === 'social-image-failed'),
      image,
    )
    assert.equal(r.metrics.httpErrorResponses, 0, 'probe HTTP errors must not pollute page load measurements')
  }
  for (const image of [
    '/oversize',
    '/large-pixels',
    '/stream-large',
    '/image-redirect',
    '/image-local-redirect',
    `http://127.0.0.1:${f.other.address().port}/image`,
    f.base.replace('http://', 'http://fixture:secret@') + '/image',
  ]) {
    f.set({ image })
    const r = await f.run()
    assert.equal(r.metrics.socialImageDecodedWidth, null)
    assert.ok(
      r.findings.some((x) => x.id === 'social-image-unavailable'),
      image,
    )
  }
  assert.ok(!f.received.some((r) => r.kind === 'off-origin'))
  assert.ok(!f.received.some((r) => r.kind === '/image'), 'local redirect is not followed either')
})

test('private applicability skips SEO requests and explicit error selectors check visible elements only', async (t) => {
  const f = await fixture(t),
    p = f.config.boards[0].pages[0]
  p.seo = { indexable: false }
  p.errorSelectors = ['#error', '#hidden-error', '[']
  const r = await f.run()
  assert.equal(r.state, 'complete')
  assert.equal(r.findings.filter((x) => x.category === 'seo').length, 1)
  assert.ok(r.findings.some((x) => x.id === 'seo-private-expected'))
  assert.ok(r.findings.some((x) => x.id === 'configured-error-visible' && x.observation.startsWith('1 ')))
  assert.ok(r.findings.some((x) => x.id === 'error-selectors-incomplete'))
  assert.ok(!f.received.some((r) => ['/robots.txt', '/image'].includes(r.kind)))
  p.errorSelectors = ['#hidden-error', '#absent']
  assert.ok(!(await f.run()).findings.some((x) => x.id === 'configured-error-visible'))
})

test('stalled social response stops within the per-probe deadline', async (t) => {
  const f = await fixture(t)
  f.set({ image: '/slow' })
  const start = Date.now(),
    r = await f.run()
  assert.ok(Date.now() - start < 10000)
  assert.ok(r.findings.some((x) => x.id === 'social-image-unavailable'))
})

test('controlling service workers make SEO fetches explicitly unsupported', async (t) => {
  const f = await fixture(t)
  f.set({
    extra: `<script>(async()=>{
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
    const ready=document.createElement('p');ready.id='sw-ready';ready.textContent='Ready';document.body.append(ready);
  })()</script>`,
  })
  f.config.boards[0].pages[0].waitFor = '#sw-ready'
  const r = await f.run()
  assert.equal(r.state, 'complete')
  assert.equal(r.completeness.serviceWorker, true)
  assert.equal(r.metrics.robotsAllowed, null)
  assert.ok(r.findings.some((x) => x.id === 'social-image-unavailable'))
  assert.ok(!f.received.some((r) => ['/robots.txt', '/image'].includes(r.kind)))
})
