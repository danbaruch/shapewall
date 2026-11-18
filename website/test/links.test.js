// In-page links: which docs links the router takes (only its own pages; the live demo and files load as
// themselves).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { routerHref } from '../src/links.js'
import { DEMO_URL, ROUTES } from '../src/routes.js'

test('docs links: the router takes its own pages, never the live demo or a file', () => {
  for (const route of ROUTES) assert.equal(routerHref(route.path), route.path, route.path)
  assert.equal(routerHref('/docs/config#pages'), '/docs/config#pages')
  assert.equal(routerHref('/features/'), '/features/')
  assert.equal(routerHref('/features?x=1'), '/features?x=1')
  for (const href of [DEMO_URL, '/demo', '/demo/#board', '/lumen/', '/downloads/shapewall-agent-hardening.pdf', '/og/home.png'])
    assert.equal(routerHref(href), null, href)
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
