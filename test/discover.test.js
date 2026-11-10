// "init --base-url" finds the site's real pages: its sitemap.xml first, else
// the links on its pages (two levels, same origin only, capped), else the
// home page alone with a clear next step.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { cutTitle, discoverPages, htmlLinks, htmlTitle, pageLink, pageTitle } from '../src/discover.js'
import { tempDir } from './helpers.js'

const page = (title, body = '') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`

// Starts a server for `routes` (path -> handler or HTML); returns { url, requests, close }.
async function serve(routes) {
  const requests = []
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x')
    requests.push({ path: pathname, method: req.method, cookie: req.headers.cookie || null })
    const route = routes[pathname]
    if (typeof route === 'function') return route(req, res)
    if (typeof route === 'string') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(route)
    }
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end(page('Not found'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

async function run(argv) {
  const lines = []
  const code = await main(argv, { out: (line) => lines.push(line) })
  return { code, text: lines.join('\n') }
}

// A small site: links to pages, a nested page, an external link, mailto,
// a PDF, a redirect off the site, a redirect on it, a 404 and a page slower
// than the per-request timeout (4 s in init).
async function smallSite() {
  const other = await serve({ '/': page('Elsewhere') })
  const site = await serve({
    '/': page(
      'Acme   Tools &amp; Co',
      `<a href="about">About</a> <a href="/about#team">Team</a> <a href="/blog/first">First</a>
       <a href='/blog/second?ref=home#top'>Second</a> <a href="${other.url}/">Elsewhere</a>
       <a href="mailto:hi@example.com">Mail</a> <a href="tel:+15550100">Call</a> <a href="javascript:void(0)">JS</a>
       <a href="/files/guide.pdf">Guide</a> <a href="/logo.png">Logo</a> <a href="/old">Old</a> <a href="/moved">Moved</a>
       <a href="/missing">Missing</a> <a href="/slow">Slow</a> <a href="/data">Data</a>
       <!-- <a href="/commented">no</a> --><script>var s = '<a href="/scripted">no</a>'</script>`,
    ),
    '/about': page('About | Acme Tools &amp; Co', '<a href="/team">Team</a> <a href="/">Home</a>'),
    '/team': page('Team - Acme Tools &amp; Co', '<a href="/deep">Too deep</a>'),
    '/blog/first': page('First post'),
    '/blog/second': page('Acme Tools &amp; Co'),
    '/contact': page('Contact us'),
    '/deep': page('Deep'),
    '/old': (req, res) => {
      res.writeHead(302, { location: `${other.url}/` })
      res.end()
    },
    '/moved': (req, res) => {
      res.writeHead(301, { location: '/contact' })
      res.end()
    },
    '/slow': (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page('Slow'))
      }, 4500).unref()
    },
    '/data': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    },
  })
  return {
    site,
    other,
    close: async () => {
      await site.close()
      await other.close()
    },
  }
}

test('htmlLinks, htmlTitle, pageLink and pageTitle', () => {
  const html = '<base href="/docs/"><a href="intro">x</a><a href=../top?a=1#b>y</a><!-- <a href="/c"> -->'
  assert.deepEqual(htmlLinks(html, 'http://localhost:3000/x/y').map(String), [
    'http://localhost:3000/docs/intro',
    'http://localhost:3000/top?a=1#b',
  ])
  assert.equal(htmlTitle('<title>\n  Hello &amp;  world </title>'), 'Hello & world')
  assert.equal(htmlTitle('<p>no title</p>'), null)
  const origin = 'http://localhost:3000'
  assert.equal(pageLink(new URL('http://localhost:3000/a?b=1#c'), { origin }), 'http://localhost:3000/a')
  assert.equal(pageLink(new URL('http://localhost:3001/a'), { origin }), null)
  assert.equal(pageLink(new URL('mailto:a@b.c'), { origin }), null)
  assert.equal(pageLink(new URL('http://localhost:3000/a.PDF'), { origin }), null)
  assert.equal(pageLink(new URL('http://localhost:3000/other'), { origin, basePath: '/app' }), null)
  assert.equal(pageLink(new URL('http://localhost:3000/app/x'), { origin, basePath: '/app' }), 'http://localhost:3000/app/x')
  assert.equal(pageTitle('Pricing | Acme', 'Acme'), 'Pricing')
  assert.equal(pageTitle('Acme: Pricing', 'Acme'), 'Pricing')
  assert.equal(pageTitle('Acme', 'Acme'), null)
  assert.equal(pageTitle('', 'Acme'), null)
  assert.equal(
    cutTitle('A very long site title that keeps going well past sixty characters'),
    'A very long site title that keeps going well past sixty...',
  )
})

test('discoverPages follows same-origin links two levels deep and skips the rest', async () => {
  const { site, other, close } = await smallSite()
  try {
    const result = await discoverPages(site.url, { requestMs: 300 })
    assert.deepEqual(
      result.pages.map((item) => new URL(item.url).pathname),
      ['/', '/about', '/blog/first', '/blog/second', '/contact', '/team'],
    )
    assert.equal(result.homeTitle, 'Acme Tools & Co')
    const reasons = Object.fromEntries(result.failed.map((item) => [new URL(item.url).pathname, item.reason]))
    assert.match(reasons['/old'], /another site/)
    assert.equal(reasons['/missing'], 'HTTP 404')
    assert.equal(reasons['/slow'], 'timed out')
    assert.match(reasons['/data'], /not a web page/)
    const asked = site.requests.map((item) => item.path)
    for (const never of ['/deep', '/files/guide.pdf', '/logo.png', '/commented', '/scripted'])
      assert.ok(!asked.includes(never), `${never} was fetched`)
    assert.equal(asked.filter((item) => item === '/about').length, 1, 'each page once')
    assert.ok(site.requests.every((item) => item.method === 'GET' && item.cookie === null))
    assert.equal(other.requests.length, 0, 'another origin is never asked, also after a redirect')
  } finally {
    await close()
  }
})

test('discoverPages stops at the page cap', async () => {
  const links = Array.from({ length: 40 }, (_, n) => `<a href="/p${n}">${n}</a>`).join('')
  const routes = { '/': page('Many', links) }
  for (let n = 0; n < 40; n += 1) routes[`/p${n}`] = page(`Page ${n}`)
  const site = await serve(routes)
  try {
    const result = await discoverPages(site.url)
    assert.equal(result.pages.length, 25)
    assert.equal(result.stopped, 'pages')
    assert.ok(site.requests.length <= 30, `asked ${site.requests.length} times`)
    const capped = await discoverPages(site.url, { maxPages: 3 })
    assert.equal(capped.pages.length, 3)
  } finally {
    await site.close()
  }
})

test('init --base-url without a sitemap writes the linked pages, titled and grouped', async () => {
  const { site, close } = await smallSite()
  const dir = tempDir('discover-links')
  const file = path.join(dir, 'shapewall.config.json')
  try {
    const { text } = await run(['init', '--config', file, '--base-url', site.url])
    const config = loadConfig(file)
    assert.equal(config.title, 'Acme Tools & Co')
    const pages = config.boards[0].pages.map(({ id, path: pagePath, title, group }) => ({ id, path: pagePath, title, group }))
    assert.deepEqual(pages, [
      { id: 'home', path: '/', title: 'Home', group: 'Pages' },
      { id: 'about', path: '/about', title: 'About', group: 'Pages' },
      { id: 'blog-first', path: '/blog/first', title: 'First post', group: 'Blog' },
      { id: 'blog-second', path: '/blog/second', title: 'Second', group: 'Blog' },
      { id: 'contact', path: '/contact', title: 'Contact us', group: 'Pages' },
      { id: 'team', path: '/team', title: 'Team', group: 'Pages' },
    ])
    assert.deepEqual(config.boards[0].groups, ['Pages', 'Blog'])
    assert.match(text, /No sitemap at .*\/sitemap\.xml \(HTTP 404\), so Shapewall followed the links/)
    assert.match(text, /Found 6 pages:/)
    assert.match(text, /left out 4 links that did not open: \/old \(redirected to another site/)
    assert.match(text, /Next: run ".*capture" and then ".*serve --open"\.\nApp screens behind Start/)
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /pricing|login/)
  } finally {
    await close()
  }
})

test('init --base-url uses <base URL>/sitemap.xml first and records it', async () => {
  let site
  const sitemap = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(
      `<urlset><url><loc>${site.url}/</loc></url><url><loc>${site.url}/pricing</loc></url><url><loc>${site.url}/docs/a</loc></url></urlset>`,
    )
  }
  site = await serve({ '/sitemap.xml': sitemap, '/': page('Sitemap Site', '<a href="/linked">L</a>'), '/linked': page('Linked') })
  const dir = tempDir('discover-sitemap')
  const file = path.join(dir, 'shapewall.config.json')
  try {
    const { text } = await run(['init', '--config', file, '--base-url', site.url])
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(raw.title, 'Sitemap Site')
    assert.equal(raw.sitemap, `${site.url}/sitemap.xml`)
    assert.deepEqual(
      raw.pages.map((item) => item.path),
      ['/', '/pricing', '/docs/a'],
    )
    assert.match(text, /Found 3 pages in .*sitemap\.xml/)
    assert.ok(!site.requests.some((item) => item.path === '/linked'), 'links are not followed when the sitemap has pages')
  } finally {
    await site.close()
  }
})

test('init --base-url on a site that is not running writes the home page and says what to do', async () => {
  const closed = await serve({})
  await closed.close()
  const dir = tempDir('discover-down')
  const file = path.join(dir, 'shapewall.config.json')
  const { text } = await run(['init', '--config', file, '--base-url', closed.url])
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(raw.pages, [{ id: 'home', path: '/', title: 'Home', group: 'Pages' }])
  assert.equal(raw.title, new URL(closed.url).host)
  assert.match(text, /Could not open .*: connection refused \(is the site running\?\)\./)
  assert.match(text, /Next: start your site, then run ".*init --base-url http:\/\/127\.0\.0\.1:\d+ --force" again/)
  assert.match(text, /or add pages by hand in shapewall\.config\.json/)
  loadConfig(file)
})

test('init --no-discover asks nothing; an existing config is kept without --force', async () => {
  const site = await serve({ '/': page('Quiet', '<a href="/a">A</a>'), '/a': page('A') })
  const dir = tempDir('discover-off')
  const file = path.join(dir, 'shapewall.config.json')
  try {
    const { text } = await run(['init', '--config', file, '--base-url', site.url, '--no-discover'])
    assert.equal(site.requests.length, 0)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(
      raw.pages.map((item) => item.path),
      ['/'],
    )
    assert.match(text, /Next: list your pages in shapewall\.config\.json/)
    const before = fs.readFileSync(file, 'utf8')
    await assert.rejects(run(['init', '--config', file, '--base-url', site.url]), /already exists \(use --force to overwrite\)/)
    assert.equal(site.requests.length, 0, 'nothing fetched before the existing-file check')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    await run(['init', '--config', file, '--base-url', site.url, '--force'])
    assert.deepEqual(
      loadConfig(file).boards[0].pages.map((item) => item.path),
      ['/', '/a'],
    )
  } finally {
    await site.close()
  }
})

test('init without --base-url keeps the examples and says to pass --base-url', async () => {
  const dir = tempDir('discover-none')
  const file = path.join(dir, 'shapewall.config.json')
  const { text } = await run(['init', '--config', file])
  assert.deepEqual(
    loadConfig(file).boards[0].pages.map((item) => item.path),
    ['/', '/pricing', '/login'],
  )
  assert.match(text, /Next: start your site and run ".*init --base-url <its URL> --force" so Shapewall finds its pages/)
})

test('discoverPages gives up at the total time budget', async () => {
  const site = await serve({
    '/': (req, res) => {
      setTimeout(() => res.end(page('Late')), 2000).unref()
    },
  })
  try {
    const started = Date.now()
    const result = await discoverPages(site.url, { totalMs: 200 })
    assert.ok(Date.now() - started < 1500)
    assert.deepEqual(result.pages, [])
    assert.equal(result.home.error, 'timed out')
    assert.equal(result.stopped, 'time')
  } finally {
    await site.close()
  }
})
