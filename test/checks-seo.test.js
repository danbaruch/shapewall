import { test } from 'node:test'
import assert from 'node:assert/strict'
import { robotsDecision, ROBOTS_MAX_BYTES } from '../src/checks/robots.js'
import { imageDimensions } from '../src/checks/seo-probe.js'
import { normalizeConfig } from '../src/config.js'

const decide = (rules, path) => robotsDecision(rules, path).state

test('robots selects specific Googlebot groups, merges duplicates, ignores wildcard fallback and unrelated directives', () => {
  const rules = `User-agent: *\nDisallow: /\nUser-agent: googlebot-news\nDisallow: /fish\nUser-agent: Googlebot/2.1\nDisallow: /fish\nUser-agent: Googlebot*\nAllow: /fish/public\nUser-agent: Otherbot\nDisallow: /safe`
  assert.equal(decide(rules, '/safe'), 'allowed')
  assert.equal(decide(rules, '/fish'), 'blocked')
  assert.equal(decide(rules, '/fish/public'), 'allowed')
  assert.equal(decide('User-agent: Otherbot\nSitemap: anything\nUser-agent: Googlebot\nDisallow: /', '/'), 'blocked')
  assert.equal(decide('User-agent: *\nDisallow: /\nUser-agent: Googlebot\nDisallow:', '/'), 'allowed')
})

test('robots rule matching uses specificity, allow ties, wildcard, end anchor, query and encoded octets', () => {
  const rules =
    'User-agent: *\nDisallow: /*.php$\nDisallow: /fish\nAllow: /fish\nDisallow: /%7Eprivate\nDisallow: /ツ\nDisallow: /reserved%2Fslash\nDisallow: /*?private=*'
  for (const [path, expected] of [
    ['/page.php', 'blocked'],
    ['/page.php?q=1', 'allowed'],
    ['/Fish', 'allowed'],
    ['/fish', 'allowed'],
    ['/~private', 'blocked'],
    ['/%7eprivate', 'blocked'],
    ['/%E3%83%84', 'blocked'],
    ['/ツ', 'blocked'],
    ['/reserved/slash', 'allowed'],
    ['/reserved%2fslash', 'blocked'],
    ['/page?private=yes', 'blocked'],
  ])
    assert.equal(decide(rules, path), expected, path)
  assert.equal(decide('User-agent: *\nAllow: /page\nDisallow: /*.htm', '/page.htm'), 'blocked')
  assert.equal(decide('User-agent: *\nAllow: /page\nDisallow: /*.ph', '/page.php5'), 'allowed')
  assert.equal(decide('\uFEFFUser-agent: *\rDisallow: / # note\rAllow: /$', '/'), 'allowed')
})

test('robots resource limits produce unknown instead of partial allow decisions', () => {
  assert.equal(decide('a'.repeat(ROBOTS_MAX_BYTES + 1), '/'), 'unsupported')
  assert.equal(decide('\n'.repeat(10001), '/'), 'unsupported')
  assert.equal(decide('', '/'.repeat(4097)), 'unsupported')
  assert.equal(decide('', '/'), 'allowed')
  const costly = 'User-agent: *\n' + ('Disallow: /*' + 'a'.repeat(1000) + 'b\n').repeat(400)
  assert.equal(decide(costly, '/' + 'a'.repeat(4090)), 'unsupported')
})

test('raster preflight rejects arbitrary bytes and reads bounded format dimensions', () => {
  assert.equal(imageDimensions(Buffer.from('not an image')), null)
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.write('IHDR', 12)
  png.writeUInt32BE(1200, 16)
  png.writeUInt32BE(630, 20)
  assert.deepEqual(imageDimensions(png), { width: 1200, height: 630, type: 'image/png' })
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 2, 118, 4, 176, 0])
  assert.deepEqual(imageDimensions(jpeg), { width: 1200, height: 630, type: 'image/jpeg' })
  const webp = Buffer.alloc(30)
  webp.write('RIFF')
  webp.write('WEBP', 8)
  webp.write('VP8X', 12)
  webp.writeUIntLE(1199, 24, 3)
  webp.writeUIntLE(629, 27, 3)
  assert.deepEqual(imageDimensions(webp), { width: 1200, height: 630, type: 'image/webp' })
})

test('configured error selectors and SEO applicability are explicit and bounded', () => {
  const parse = (page) => normalizeConfig({ baseUrl: 'http://localhost:3000', pages: [{ id: 'home', path: '/', ...page }] })
  const p = parse({ errorSelectors: [' #error ', '#error'], seo: { indexable: false } }).boards[0].pages[0]
  assert.deepEqual(p.errorSelectors, ['#error'])
  assert.deepEqual(p.seo, { indexable: false })
  assert.equal(parse({}).boards[0].pages[0].errorSelectors, null)
  for (const errorSelectors of ['#error', [''], ['a'.repeat(501)], Array(11).fill('#error'), [42]])
    assert.throws(() => parse({ errorSelectors }))
  for (const seo of [false, {}, { indexable: 'false' }, { indexable: true, unknown: true }]) assert.throws(() => parse({ seo }))
})
