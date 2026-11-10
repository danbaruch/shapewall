import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/config.js'
import { createLinkMatcher, linkTargets, pageLinks } from '../src/links.js'

const board = normalizeConfig({
  baseUrl: 'http://127.0.0.1:3000/app',
  pages: [
    { id: 'home', path: '/' },
    { id: 'pricing', path: '/pricing/' },
    { id: 'search', path: '/search?q=shoes&sort=new' },
    { id: 'docs', path: '/docs' },
  ],
}).boards[0]

test('links are matched to configured pages after normalizing', () => {
  const match = createLinkMatcher(board)
  const cases = [
    ['http://127.0.0.1:3000/app/', 'home'],
    ['http://127.0.0.1:3000/app', 'home'],
    ['http://127.0.0.1:3000/app/index.html', 'home'],
    ['http://127.0.0.1:3000/app/pricing', 'pricing'],
    ['http://127.0.0.1:3000/app/pricing/#plans', 'pricing'],
    ['http://127.0.0.1:3000/app//pricing//', 'pricing'],
    ['http://127.0.0.1:3000/app/pricing/?utm_source=nav', 'pricing'],
    ['http://127.0.0.1:3000/app/search?sort=new&q=shoes', 'search'],
    ['http://127.0.0.1:3000/app/d%6Fcs', 'docs'],
    ['/app/docs/', 'docs'],
  ]
  for (const [href, id] of cases) assert.equal(match(href), id, href)
})

test('links elsewhere never match', () => {
  const match = createLinkMatcher(board)
  for (const href of [
    'https://127.0.0.1:3000/app/pricing', // other scheme, other origin
    'http://localhost:3000/app/pricing',
    'http://127.0.0.1:3001/app/pricing',
    'http://127.0.0.1:3000/pricing', // outside the base path
    'http://user:secret@127.0.0.1:3000/app/pricing',
    'http://127.0.0.1:3000/app/search?q=boots', // a query page needs its query
    'http://127.0.0.1:3000/app/unknown',
    'javascript:alert(1)',
    'mailto:team@example.com',
    'not a url at all \u0000',
    `http://127.0.0.1:3000/app/${'x'.repeat(3000)}`,
    42,
    null,
  ]) {
    assert.equal(match(href), null, String(href).slice(0, 80))
  }
})

test('linkTargets keeps first-seen order, drops duplicates and the page itself', () => {
  const hrefs = [
    'http://127.0.0.1:3000/app/pricing/',
    'http://127.0.0.1:3000/app/',
    'http://127.0.0.1:3000/app/pricing',
    'http://127.0.0.1:3000/app/docs',
    'https://elsewhere.example/',
  ]
  assert.deepEqual(linkTargets(hrefs, board, { self: 'home' }), ['pricing', 'docs'])
  assert.deepEqual(linkTargets('not an array', board), [])
  // Another environment's base URL.
  assert.deepEqual(linkTargets(['https://staging.example/app/docs'], board, { baseUrl: 'https://staging.example/app' }), ['docs'])
})

test('pageLinks merges viewports and drops pages no longer on the board', () => {
  const manifest = {
    pages: {
      home: { desktop: { status: 'ok', links: ['pricing', 'gone'] }, phone: { status: 'ok', links: ['docs', 'pricing', 'home'] } },
      pricing: { desktop: { status: 'failed' } },
      docs: { desktop: { status: 'ok', links: 'pricing' } },
    },
  }
  assert.deepEqual(pageLinks(manifest, board), { home: ['pricing', 'docs'] })
  assert.deepEqual(pageLinks(null, board), {})
})
