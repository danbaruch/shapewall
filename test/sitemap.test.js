// Sitemap import: parsing, sitemap indexes, grouping, dedupe, --limit and the
// config writes. Every "remote" sitemap is a fixture behind a fake fetch, so
// no test touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { main } from '../src/cli.js'
import { loadConfig, normalizeConfig } from '../src/config.js'
import { importSitemap, parseSitemap, readSitemap, sitemapPages } from '../src/sitemap.js'
import { SAMPLE, tempDir } from './helpers.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sitemap')
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name))

// https://www.example.com/<name> serves the fixture of that name (the blog
// sitemap gzipped); anything else is a 404. Records every URL asked for.
function fakeFetch() {
  const asked = []
  const fetch = async (url) => {
    asked.push(url)
    const { host, pathname } = new URL(url)
    const name = pathname.slice(1)
    let body = null
    if (host === 'www.example.com' && name === 'sitemap-blog.xml.gz') body = gzipSync(fixture('sitemap-blog.xml'))
    else if (host === 'www.example.com' && fs.existsSync(path.join(FIXTURES, name))) body = fixture(name)
    return body
      ? { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) }
      : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  return { fetch, asked }
}

const noFetch = async (url) => {
  throw new Error(`unexpected network call to ${url}`)
}

async function run(argv, options = {}) {
  const lines = []
  const code = await main(argv, { out: (line) => lines.push(line), fetch: noFetch, ...options })
  return { code, text: lines.join('\n') }
}

test('parseSitemap reads urlset and sitemapindex, CDATA, entities, prefixes, and ignores comments', () => {
  const urlset = parseSitemap(fixture('sitemap.xml'))
  assert.equal(urlset.kind, 'urlset')
  assert.ok(urlset.locs.includes('https://www.example.com/blog/'), 'whitespace around a loc is trimmed')
  assert.ok(urlset.locs.includes('https://www.example.com/blog/notes_on-paper.html'), 'CDATA')
  assert.ok(urlset.locs.includes('https://www.example.com/search?q=notes&page=2'), '&amp;')
  assert.ok(!urlset.locs.some((loc) => loc.includes('commented-out')))
  assert.equal(urlset.locs.length, 12)
  const index = parseSitemap(fixture('sitemap-index.xml'))
  assert.equal(index.kind, 'sitemapindex')
  assert.equal(index.locs.length, 4)
  assert.throws(() => parseSitemap('<html><body>Not found</body></html>'), /not a sitemap/)
})

test('a sitemap index is followed into its children, gzip included, each once; a broken child is reported', async () => {
  const { fetch, asked } = fakeFetch()
  const result = await readSitemap('https://www.example.com/sitemap-index.xml', { fetch })
  assert.deepEqual(result.sitemaps, [
    'https://www.example.com/sitemap-index.xml',
    'https://www.example.com/sitemap-pages.xml',
    'https://www.example.com/sitemap-blog.xml.gz',
  ])
  assert.equal(result.urls.length, 7)
  assert.ok(result.urls.includes('https://www.example.com/blog/first-post'))
  assert.deepEqual(result.skipped, [
    { source: 'https://www.example.com/missing.xml', reason: 'https://www.example.com/missing.xml: HTTP 404' },
  ])
  // The index lists itself: read once, no loop.
  assert.equal(asked.filter((url) => url.endsWith('sitemap-index.xml')).length, 1)
  // The sitemap asked for must work.
  await assert.rejects(readSitemap('https://www.example.com/nope.xml', { fetch }), /HTTP 404/)
})

test('a remote sitemap index only follows children on its own site, also after redirects', async () => {
  const asked = []
  const xml = (text) => Buffer.from(text)
  const pages = xml('<urlset><url><loc>https://www.example.com/a</loc></url></urlset>')
  const files = {
    'https://www.example.com/index.xml': xml(
      `<sitemapindex>${[
        'https://www.example.com/pages.xml',
        'http://169.254.169.254/latest/meta-data/',
        'https://other.example/s.xml',
        'file:///etc/passwd',
        'https://www.example.com/hop.xml',
        'https://www.example.com/moved.xml',
        'https://www.example.com/loop.xml',
        'https://www.example.com/followed.xml',
      ]
        .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
        .join('')}</sitemapindex>`,
    ),
    'https://www.example.com/pages.xml': pages,
    'https://www.example.com/hop.xml': pages,
    'https://www.example.com/new/pages.xml': xml('<urlset><url><loc>https://www.example.com/b</loc></url></urlset>'),
    'https://www.example.com/followed.xml': pages,
  }
  // hop.xml redirects to another host, moved.xml to a page on the same site,
  // loop.xml to itself; followed.xml stands for a fetch that followed a
  // redirect by itself and ended on another host.
  const redirects = {
    'https://www.example.com/hop.xml': 'https://internal.example/s.xml',
    'https://www.example.com/moved.xml': '/new/pages.xml',
    'https://www.example.com/loop.xml': '/loop.xml',
  }
  const fetch = async (url, options) => {
    asked.push(url)
    if (redirects[url]) {
      assert.equal(options.redirect, 'manual')
      return {
        ok: false,
        status: 302,
        url,
        headers: new Headers({ location: redirects[url] }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }
    const body = files[url]
    const finalUrl = url.endsWith('/followed.xml') ? 'https://internal.example/s.xml' : url
    return body
      ? { ok: true, status: 200, url: finalUrl, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) }
      : { ok: false, status: 404, url, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  const result = await readSitemap('https://www.example.com/index.xml', { fetch })
  assert.deepEqual(result.sitemaps, [
    'https://www.example.com/index.xml',
    'https://www.example.com/pages.xml',
    'https://www.example.com/moved.xml',
  ])
  assert.deepEqual(result.urls, ['https://www.example.com/a', 'https://www.example.com/b'])
  // The other host is never asked: the redirect is refused before it is followed.
  assert.ok(!asked.some((url) => url.includes('internal.example')), asked.join(' '))
  assert.equal(asked.filter((url) => url.endsWith('/loop.xml')).length, 6)
  assert.deepEqual(
    result.skipped.map((item) => [item.source, item.reason.replace(/^\S+: /, '')]),
    [
      ['http://169.254.169.254/latest/meta-data/', 'on another site than the sitemap'],
      ['https://other.example/s.xml', 'on another site than the sitemap'],
      ['file:///etc/passwd', 'on another site than the sitemap'],
      ['https://www.example.com/hop.xml', 'redirected to another site than the sitemap'],
      ['https://www.example.com/loop.xml', 'more than 5 redirects'],
      ['https://www.example.com/followed.xml', 'redirected to another site than the sitemap'],
    ],
  )
})

test('a local sitemap index resolves its children next to it, with no fetch at all', async () => {
  const result = await readSitemap(path.join(FIXTURES, 'local-index.xml'), { fetch: noFetch })
  assert.equal(result.sitemaps.length, 3)
  assert.equal(result.urls.length, 7)
})

test('sitemapPages: one host, dedupe, exclude, ids, titles and groups by path prefix', () => {
  const { urls } = { urls: parseSitemap(fixture('sitemap.xml')).locs }
  const { pages, host, report } = sitemapPages(urls, {
    baseUrl: 'http://localhost:3000',
    existing: [{ id: 'home', path: '/', group: 'Marketing' }],
    exclude: ['/tag/'],
  })
  assert.equal(host, 'www.example.com', 'the most common host when baseUrl is not in the sitemap')
  assert.deepEqual(report, { otherHost: 1, invalid: 0, duplicate: 1, existing: 1, excluded: 1, overLimit: 0 })
  assert.deepEqual(
    pages.map((page) => [page.id, page.path, page.title, page.group]),
    [
      ['pricing', '/pricing', 'Pricing', 'Pages'],
      ['features', '/features', 'Features', 'Pages'],
      ['blog', '/blog/', 'Blog', 'Blog'],
      ['blog-sync-without-servers', '/blog/sync-without-servers', 'Sync without servers', 'Blog'],
      ['blog-notes-on-paper-html', '/blog/notes_on-paper.html', 'Notes on paper', 'Blog'],
      ['docs-getting-started', '/docs/getting-started', 'Getting started', 'Docs'],
      ['docs-api-auth', '/docs/api/auth', 'Auth', 'Docs'],
      ['search-q-notes-page-2', '/search?q=notes&page=2', 'Search (q=notes&page=2)', 'Pages'],
    ],
  )
  // Every page is valid in a config.
  const config = normalizeConfig({ ...structuredClone(SAMPLE), pages: [SAMPLE.pages[0], ...pages] })
  assert.equal(config.boards[0].pages.length, 1 + pages.length)
})

test('sitemapPages: --limit keeps the shallowest pages in sitemap order, ids stay unique, groups match the board', () => {
  const urls = [
    'https://site.test/blog/a',
    'https://site.test/blog/b',
    'https://site.test/blog/c',
    'https://site.test/',
    'https://site.test/pricing',
    'https://site.test/app/x',
    'https://site.test/app/y',
  ]
  const { pages, report } = sitemapPages(urls, {
    baseUrl: 'https://site.test',
    limit: 4,
    existing: [
      { id: 'pricing', path: '/old-pricing', group: 'Marketing' },
      { id: 'notes', path: '/notes', group: 'blog' },
    ],
  })
  assert.equal(report.overLimit, 3)
  assert.deepEqual(
    pages.map((page) => [page.id, page.path, page.group]),
    [
      ['blog-a', '/blog/a', 'blog'],
      ['blog-b', '/blog/b', 'blog'],
      ['home', '/', 'Pages'],
      ['pricing-2', '/pricing', 'Pages'],
    ],
  )
  // One group for all, on request.
  assert.deepEqual(
    new Set(sitemapPages(urls, { baseUrl: 'https://site.test', group: 'Imported' }).pages.map((page) => page.group)),
    new Set(['Imported']),
  )
})

test('sitemapPages: non-ASCII paths get readable ids (Café is cafe, not caf-c3-a9)', () => {
  const urls = ['/Caf%C3%A9', '/blog/Stra%C3%9Fe-%C3%BCber', '/%E6%97%A5%E6%9C%AC', '/caf%C3%A9-2', '/bad%zz'].map(
    (p) => `https://www.example.com${p}`,
  )
  const { pages } = sitemapPages(urls, { baseUrl: 'https://www.example.com' })
  assert.deepEqual(
    pages.map((page) => page.id),
    ['cafe', 'blog-strasse-uber', 'page', 'cafe-2', 'bad-zz'],
  )
  assert.equal(pages[0].title, 'Café')
  assert.equal(pages[0].path, '/Caf%C3%A9', 'the path stays as the site wrote it')
})

test('sitemapPages: the base URL host wins, and its base path is taken off', () => {
  const urls = [
    'https://prod.test/a',
    'https://prod.test/b',
    'http://localhost:3000/docs/',
    'http://localhost:3000/docs/intro',
    'http://localhost:3000/x',
  ]
  const { pages, host, report } = sitemapPages(urls, { baseUrl: 'http://localhost:3000/docs' })
  assert.equal(host, 'localhost:3000')
  assert.equal(report.otherHost, 2)
  assert.deepEqual(
    pages.map((page) => page.path),
    ['/', '/intro', '/x'],
  )
})

test('importSitemap uses the config "sitemap" setting and validates the result', async () => {
  const dir = tempDir('sitemap-import')
  const raw = {
    ...structuredClone(SAMPLE),
    sitemap: { source: path.join(FIXTURES, 'sitemap.xml'), limit: 3, exclude: ['/docs/'] },
  }
  const result = await importSitemap({ raw, dir, fetch: noFetch })
  assert.equal(result.pages.length, 3)
  assert.ok(!result.pages.some((page) => page.path.startsWith('/docs/')))
  assert.deepEqual(
    result.pages.map((page) => page.path),
    ['/features', '/blog/', '/search?q=notes&page=2'],
  )
  assert.deepEqual(result.raw.groups, ['Marketing', 'App', 'Pages'])
  assert.equal(raw.pages.length, SAMPLE.pages.length, 'the input is not changed')
  await assert.rejects(importSitemap({ raw: structuredClone(SAMPLE), dir, fetch: noFetch }), /Give a sitemap URL or file/)
  await assert.rejects(importSitemap({ raw: { ...structuredClone(SAMPLE), sitemap: { source: 'x', limit: 0 } }, dir }), /sitemap.limit/)
})

test('config: sitemap as a string or object, relative to the config; bad values are reported', () => {
  const dir = tempDir('sitemap-config')
  const config = normalizeConfig({ ...structuredClone(SAMPLE), sitemap: 'public/sitemap.xml' }, { dir })
  assert.deepEqual(config.boards[0].sitemap, { source: path.join(dir, 'public', 'sitemap.xml'), limit: null, group: null, exclude: [] })
  const remote = normalizeConfig({
    ...structuredClone(SAMPLE),
    sitemap: { source: 'https://www.example.com/sitemap.xml', limit: 50, group: 'Site' },
  })
  assert.equal(remote.boards[0].sitemap.source, 'https://www.example.com/sitemap.xml')
  assert.equal(remote.boards[0].sitemap.limit, 50)
  assert.equal(normalizeConfig(structuredClone(SAMPLE)).boards[0].sitemap, null)
  assert.throws(
    () => normalizeConfig({ ...structuredClone(SAMPLE), sitemap: { source: 'a.xml', limit: 5000, exclude: ['tag'] } }),
    (error) =>
      error.problems.some((item) => item.startsWith('sitemap.limit')) && error.problems.some((item) => item.startsWith('sitemap.exclude')),
  )
  assert.throws(
    () => normalizeConfig({ baseUrl: 'http://x.test', sitemap: 'a.xml', boards: [{ id: 'a', pages: [{ id: 'h', path: '/' }] }] }),
    /with boards, set sitemap inside each board/,
  )
})

test('CLI: shapewall sitemap adds pages (dry run first), skips what is there, respects --limit and --board', async () => {
  const dir = tempDir('sitemap-cli')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, `${JSON.stringify(SAMPLE, null, 2)}\n`)
  const { fetch, asked } = fakeFetch()

  const dry = await run(['sitemap', 'https://www.example.com/sitemap-index.xml', '--config', file, '--dry-run'], { fetch })
  assert.match(dry.text, /Read 7 URLs from 3 sitemaps \(www\.example\.com\)/)
  assert.match(dry.text, /could not read https:\/\/www\.example\.com\/missing\.xml/)
  assert.match(dry.text, /Dry run: would add 5 pages/)
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(SAMPLE, null, 2)}\n`, 'a dry run writes nothing')

  const added = await run(['sitemap', 'https://www.example.com/sitemap-index.xml', '--config', file, '--limit', '4'], { fetch })
  assert.match(added.text, /Added 4 pages/)
  assert.match(added.text, /skipped 2 already on the board/)
  assert.match(added.text, /skipped 1 over the limit/)
  const config = loadConfig(file)
  const paths = config.boards[0].pages.map((page) => page.path)
  assert.deepEqual(paths.slice(SAMPLE.pages.length), ['/app/settings', '/app/billing', '/blog/', '/blog/first-post'])
  assert.ok(config.boards[0].groups.includes('Blog'))
  assert.equal(config.boards[0].pages.find((page) => page.path === '/app/settings').group, 'App', 'joins the existing App group')

  // Again: only the page left over.
  const again = await run(['sitemap', 'https://www.example.com/sitemap-index.xml', '--config', file, '--json'], { fetch })
  const json = JSON.parse(again.text)
  assert.deepEqual(
    json.pages.map((page) => page.path),
    ['/blog/second-post'],
  )
  assert.equal(json.written, true)
  const none = await run(['sitemap', 'https://www.example.com/sitemap-index.xml', '--config', file], { fetch })
  assert.match(none.text, /No new pages to add/)
  assert.ok(asked.every((url) => url.startsWith('https://www.example.com/')))

  await assert.rejects(run(['sitemap', path.join(FIXTURES, 'sitemap.xml'), '--config', file, '--limit', '0']), /--limit/)
  await assert.rejects(run(['sitemap', path.join(FIXTURES, 'sitemap.xml'), '--config', file, '--board', 'nope']), /No board "nope"/)
})

test('CLI: init --sitemap starts a config from a sitemap file and records it', async () => {
  const dir = tempDir('sitemap-init')
  const file = path.join(dir, 'shapewall.config.json')
  const { text } = await run([
    'init',
    '--config',
    file,
    '--base-url',
    'http://localhost:4000',
    '--sitemap',
    path.join(FIXTURES, 'sitemap.xml'),
    '--exclude',
    '/tag/',
  ])
  assert.match(text, /Wrote/)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(raw.sitemap, { source: path.relative(dir, path.join(FIXTURES, 'sitemap.xml')), exclude: ['/tag/'] })
  const config = loadConfig(file)
  assert.equal(config.boards[0].pages[0].path, '/')
  assert.equal(config.boards[0].pages[0].id, 'home')
  assert.deepEqual(config.boards[0].groups, ['Pages', 'Blog', 'Docs'])
  assert.ok(!config.boards[0].pages.some((page) => page.path.startsWith('/tag/')))
  // Later runs read the recorded sitemap.
  const later = await run(['sitemap', '--config', file])
  assert.match(later.text, /No new pages to add/)
})

test('a fetched sitemap is read in pieces and given up at the cap', async () => {
  const chunk = new Uint8Array(1024 * 1024)
  let sent = 0
  let cancelled = false
  const endless = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          sent += 1
          controller.enqueue(chunk)
        },
        cancel() {
          cancelled = true
        },
      }),
      { status: 200 },
    )
  await assert.rejects(readSitemap('https://www.example.com/sitemap.xml', { fetch: endless }), /larger than 50 MB/)
  assert.ok(sent <= 60, 'stopped just past the cap')
  assert.equal(cancelled, true)
  // A declared length over the cap is refused before any of it is read.
  let read = false
  const declared = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(51 * 1024 * 1024) }),
    arrayBuffer: async () => {
      read = true
      return new ArrayBuffer(0)
    },
  })
  await assert.rejects(readSitemap('https://www.example.com/sitemap.xml', { fetch: declared }), /larger than 50 MB/)
  assert.equal(read, false)
  // A streamed body under the cap reads as before.
  const xml = '<urlset><url><loc>https://www.example.com/a</loc></url></urlset>'
  const small = await readSitemap('https://www.example.com/sitemap.xml', { fetch: async () => new Response(xml) })
  assert.deepEqual(small.urls, ['https://www.example.com/a'])
})
