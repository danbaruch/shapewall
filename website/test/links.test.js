// In-page links: which docs links the router takes (only its own pages; the live demo and files load as
// themselves), and location hashes, including a malformed one, which must not break the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { renderMarkdown } from '../scripts/markdown.mjs'
import { hashId, routerHref } from '../src/links.js'
import { DEMO_URL, ROUTES } from '../src/routes.js'

test('docs links: the router takes its own pages, never the live demo or a file', () => {
  for (const route of ROUTES) assert.equal(routerHref(route.path), route.path, route.path)
  assert.equal(routerHref('/docs/config#pages'), '/docs/config#pages')
  assert.equal(routerHref('/features/'), '/features/')
  assert.equal(routerHref('/features?x=1'), '/features?x=1')
  for (const href of [DEMO_URL, '/demo', '/demo/#board', '/lumen/', '/og/home.png']) assert.equal(routerHref(href), null, href)
  for (const href of ['https://example.com/', '//example.com/x', '#section', 'mailto:a@example.com', '', null])
    assert.equal(routerHref(href), null, String(href))
})

test('every root-relative link in Getting Started is either a router page or loads as its own document', () => {
  const md = fs.readFileSync(new URL('../src/docs/getting-started.md', import.meta.url), 'utf8')
  const links = [...md.matchAll(/\]\((\/[^)\s]*)\)/g)].map((match) => match[1])
  const demo = links.filter((href) => href.startsWith('/demo'))
  assert.ok(demo.length >= 2, 'the guide links the live demo')
  for (const href of demo) assert.equal(routerHref(href), null, `${href} is a full page load`)
})

test('location hashes: an encoded anchor decodes, a missing one is null, a malformed escape does not throw', () => {
  assert.equal(hashId('#getting-started'), 'getting-started')
  assert.equal(hashId('#caf%C3%A9'), 'café')
  assert.equal(hashId(''), null)
  assert.equal(hashId('#'), null)
  assert.equal(hashId(undefined), null)
  assert.equal(hashId('#%E0%A4%A'), null)
  assert.equal(hashId('#100%'), null)
})

test('authored links and images preserve literal quotes and ampersands in HTML attributes', () => {
  const { html } = renderMarkdown(`[Guide](/docs?x=1&y=2 'A "quoted" guide')\n\n![Badge](/badge?x=1&y=2)`)
  assert.ok(html.includes('href="/docs?x=1&amp;y=2"'))
  assert.ok(html.includes('title="A &quot;quoted&quot; guide"'))
  assert.ok(html.includes('src="/badge?x=1&amp;y=2"'))
})
