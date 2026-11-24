import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeHref, sanitizeCss, sanitizeDocument } from '../src/capture/sanitize.js'
import { buildLiveHtml, createLinkRewriter, imageIsComplete, withCspMeta } from '../src/capture/live.js'

const BASE = 'http://127.0.0.1:3000/page'
const clean = (html, options = {}) => sanitizeDocument(html, { base: BASE, ...options })

test('scripts and script-like elements are removed with their content', () => {
  const out =
    clean(`<html><head><script>alert(1)</script><noscript>x</noscript><base href="http://evil.test/"><link rel="stylesheet" href="/a.css"><meta http-equiv="refresh" content="0;url=http://evil.test"></head>
    <body><p>Hi</p><iframe src="http://evil.test"></iframe><object data="x"></object><embed src="x"><template><script>1</script></template>
    <svg><foreignObject><p>in svg</p></foreignObject><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="x"/></svg></body></html>`)
  assert.match(out, /<p>Hi<\/p>/)
  for (const bad of [
    '<script',
    'alert(1)',
    '<noscript',
    '<base',
    '<link',
    'http-equiv',
    'refresh',
    '<iframe',
    '<object',
    '<embed',
    '<template',
    'foreignobject',
    '<animate',
    '<set',
  ]) {
    assert.ok(!out.toLowerCase().includes(bad.toLowerCase()), `${bad} survived:\n${out}`)
  }
})

test('event handlers and dangerous attributes never survive', () => {
  const out =
    clean(`<body onload="x()"><img src="data:image/png;base64,iVBORw0KGgo=" onerror="x()" srcset="a.png 2x"><a href="#" onclick="x()" target="_blank" ping="http://t.test">a</a>
    <button formaction="http://evil.test" onmouseover="x()">b</button><div style="color:red" ONFOCUS="x()" tabindex="0">c</div><svg onload="x()"><a xlink:href="javascript:alert(1)">s</a></svg></body>`)
  assert.doesNotMatch(out, /\son[a-z]+=/i)
  assert.doesNotMatch(out, /srcset|target=|ping=|formaction|javascript:/i)
  assert.match(out, /style="color:red"/)
})

test('javascript: and other schemes are dropped from links, even when obfuscated', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' java\nscript:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'vbscript:msgbox',
    'data:text/html,<script>1</script>',
  ]) {
    assert.equal(isSafeHref(href, BASE), null, href)
  }
  assert.equal(isSafeHref('/pricing', BASE), 'http://127.0.0.1:3000/pricing')
  assert.equal(isSafeHref('#top', BASE), '#top')
  assert.equal(isSafeHref('mailto:hi@example.com', BASE), 'mailto:hi@example.com')
})

test('hidden inputs and password values are dropped', () => {
  const out =
    clean(`<form action="/login" method="post"><input type="hidden" name="csrf" value="tok-123"><input type="HIDDEN" name="x" value="tok-456">
    <input type="password" name="pw" value="hunter2"><input type="email" name="email" value="a@example.com"><textarea name="t">kept text</textarea></form>`)
  assert.doesNotMatch(out, /tok-123|tok-456|hunter2|csrf/)
  assert.doesNotMatch(out, /action=|method=/)
  assert.match(out, /type="password"/)
  assert.match(out, /value="a@example\.com"/)
  assert.match(out, /kept text/)
})

test('data attributes that could hold tokens are dropped, simple state is kept', () => {
  const out = clean('<div data-state="open" data-token="abc.def-123" data-user-id="42" data-testid="hero-cta" data-x="Some Words"></div>')
  assert.match(out, /data-state="open"/)
  assert.match(out, /data-testid="hero-cta"/)
  assert.doesNotMatch(out, /data-token|data-user-id|data-x/)
})

test('images keep only data: image sources; others become sized placeholders', () => {
  const out = clean(
    '<img src="http://cdn.test/a.png" data-sw-w="100" data-sw-h="50"><img src="data:text/html;base64,PHNjcmlwdD4="><img src="data:image/png;base64,iVBORw0KGgo=">',
  )
  const sources = [...out.matchAll(/src="([^"]+)"/g)].map((match) => match[1])
  assert.equal(sources.length, 3)
  assert.match(sources[0], /^data:image\/svg\+xml,.*width%3D%22100%22/)
  assert.match(sources[1], /^data:image\/svg\+xml,/)
  assert.equal(sources[2], 'data:image/png;base64,iVBORw0KGgo=')
  assert.doesNotMatch(out, /data-sw-/)
})

test('CSS: imports, expressions and remote urls are removed', () => {
  const css = sanitizeCss(`@import url(http://evil.test/a.css); @import 'b.css';
    .a { background: url(http://evil.test/x.png); width: expression(alert(1)); -moz-binding: url(x.xml#y); behavior: url(x.htc) }
    .b { background: url("data:image/png;base64,AAAA") } .c { background-image: image-set("http://evil.test/x.png" 1x) }
    .d { background: url(#grad) }`)
  assert.doesNotMatch(css, /@import|evil\.test|expression\(|-moz-binding|[^-]behavior:/)
  assert.match(css, /url\("data:image\/png;base64,AAAA"\)/)
  assert.match(css, /url\("#grad"\)/)
})

test('CSS escapes cannot smuggle url( or @import past the filter', () => {
  const css = sanitizeCss(
    String.raw`.a { background: \75rl(http://evil.test/x.png) } @\69mport "http://evil.test/b.css"; .lg\:flex { display: flex } .w-1\/2 { width: 50% }`,
  )
  assert.doesNotMatch(css, /evil\.test/)
  assert.match(css, /\.lg\\:flex/)
  assert.match(css, /\.w-1\\\/2/)
})

test('CSS cannot close the style element', () => {
  const out = clean('<style>.a{content:"</style><script>alert(1)</script>"}</style><p>x</p>')
  assert.doesNotMatch(out, /<script/)
})

test('a resolver inlines remote images it was given, as data URIs only', () => {
  const resolveUrl = (url) =>
    url.endsWith('ok.png') ? 'data:image/png;base64,iVBORw0KGgo=' : url.endsWith('bad.png') ? 'http://still-remote.test/x.png' : null
  const out = clean('<style>.a{background:url(/ok.png)}.b{background:url(/bad.png)}</style><img src="/ok.png">', { resolveUrl })
  assert.match(out, /url\("data:image\/png;base64,iVBORw0KGgo="\)/)
  assert.doesNotMatch(out, /still-remote/)
  assert.match(out, /<img src="data:image\/png;base64,iVBORw0KGgo=">/)
})

test('links to the capture base can be rewritten; other private hosts are dropped', () => {
  const rewrite = createLinkRewriter({ from: 'http://127.0.0.1:3000/app', to: 'https://www.example.com/' })
  assert.equal(rewrite('http://127.0.0.1:3000/app/pricing?x=1#a'), 'https://www.example.com/pricing?x=1#a')
  assert.equal(rewrite('http://192.168.1.20/admin'), null)
  assert.equal(rewrite('http://printer.local/'), null)
  assert.equal(rewrite('http://localhost./'), null)
  assert.equal(rewrite('http://[::ffff:a9fe:a9fe]/'), null)
  assert.equal(rewrite('http://[::ffff:10.0.0.5]/'), null)
  assert.equal(rewrite('https://docs.example.org/guide'), 'https://docs.example.org/guide')
  const keep = createLinkRewriter({ from: 'http://127.0.0.1:3000' })
  // Without a public URL, links to a private capture base go too; public ones stay.
  assert.equal(keep('http://127.0.0.1:3000/pricing'), null)
  assert.equal(
    createLinkRewriter({ from: 'https://staging.example.com' })('https://staging.example.com/a'),
    'https://staging.example.com/a',
  )
  const out = clean('<a href="http://10.0.0.5/secret">x</a><a href="/pricing">y</a>', { rewriteHref: rewrite })
  assert.doesNotMatch(out, /10\.0\.0\.5/)
})

test('the live document carries its own no-script CSP', () => {
  const out = withCspMeta('<!DOCTYPE html><html><head><title>t</title></head><body></body></html>')
  assert.match(out, /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;/)
})

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('image bodies are inlined only when complete', () => {
  assert.equal(imageIsComplete(PNG_1X1, 'image/png'), true)
  assert.equal(imageIsComplete(PNG_1X1.subarray(0, PNG_1X1.length - 10), 'image/png'), false)
  assert.equal(imageIsComplete(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'), true)
  assert.equal(imageIsComplete(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'), 'image/svg+xml'), false)
})

test('buildLiveHtml inlines CSS and complete images, and drops scripts', async () => {
  const snapshot = {
    base: 'http://127.0.0.1:3000/',
    html: '<!DOCTYPE html><html><head><title>t</title></head><body><img src="/a.png" data-sw-w="10" data-sw-h="10"><img src="/broken.png" data-sw-w="20" data-sw-h="20"><script>steal()</script><p onclick="x()">Hello</p></body></html>',
    chunks: [
      { href: null, base: 'http://127.0.0.1:3000/', text: 'p { color: red }\n.hero { background: url(/a.png) }', media: '' },
      { href: null, base: 'http://127.0.0.1:3000/', text: 'p { color: blue }', media: '(max-width: 640px)' },
    ],
    cssImages: {},
  }
  const bodies = {
    'http://127.0.0.1:3000/a.png': { buffer: PNG_1X1, mimeType: 'image/png', expectedLength: PNG_1X1.length },
    'http://127.0.0.1:3000/broken.png': { buffer: PNG_1X1.subarray(0, 30), mimeType: 'image/png', expectedLength: PNG_1X1.length },
  }
  const { html, stats } = await buildLiveHtml(snapshot, { getBody: async (url) => bodies[url] || null })
  assert.doesNotMatch(html, /<script|steal|onclick/)
  assert.match(html, /@media \(max-width: 640px\) \{\s*p \{ color: blue \}/)
  assert.match(html, /<img src="data:image\/png;base64,/)
  assert.match(html, /url\("data:image\/png;base64,/)
  assert.match(html, /data:image\/svg\+xml,.*width%3D%2220%22/)
  assert.equal(stats.imagesRejected, 1)
})

// Review regression: the url( and @font-face scans were quadratic (200 KB of
// "url( " held the event loop for 14 s). Every pathological shape must stay
// linear. Budget process CPU time so concurrent package workers or shared
// runner scheduling cannot turn a linear scan into a wall-clock false alarm.
test('CSS sanitizing is linear on pathological input', () => {
  const shapes = [
    'url(',
    'url( ',
    'URL(  ',
    'url("',
    "url('",
    'url("x";',
    'url(x;',
    '@font-face{',
    '@font-face{url(a)',
    'src(',
    'image-set(',
    '\\75rl(',
    'url("\\',
  ]
  for (const unit of shapes) {
    const css = unit.repeat(Math.ceil(3_000_000 / unit.length))
    const started = process.cpuUsage()
    sanitizeCss(css, { base: BASE })
    const elapsed = process.cpuUsage(started)
    const ms = (elapsed.user + elapsed.system) / 1000
    assert.ok(ms < 1500, `${JSON.stringify(unit)} x ${css.length} bytes took ${Math.round(ms)} ms CPU`)
  }
  const html = `<!DOCTYPE html><html><head><style>${'url( '.repeat(600_000)}</style></head><body><p style="${'url( '.repeat(1000)}">x</p></body></html>`
  const started = process.cpuUsage()
  sanitizeDocument(html, { base: BASE })
  const elapsed = process.cpuUsage(started)
  assert.ok((elapsed.user + elapsed.system) / 1000 < 3000)
})

test('the linear CSS scans keep what the old patterns kept', () => {
  const resolveUrl = (url, kind) =>
    url.endsWith('.png') ? 'data:image/png;base64,QQ' : kind === 'font' ? 'data:font/woff2;base64,QQ' : null
  const css = (text) => sanitizeCss(text, { base: BASE, resolveUrl })
  assert.equal(css('a{background:url( "/a.png" )}'), 'a{background:url("data:image/png;base64,QQ")}')
  assert.equal(css("a{background:url('/a.png')}"), 'a{background:url("data:image/png;base64,QQ")}')
  assert.equal(css('a{background:url(/a.png)}'), 'a{background:url("data:image/png;base64,QQ")}')
  assert.equal(css('@font-face{src:url(/f.woff2)}a{b:url(/f.woff2)}'), '@font-face{src:url("data:font/woff2;base64,QQ")}a{b:none}')
  assert.equal(css('a{b:url(#grad)}'), 'a{b:url("#grad")}')
  // Unterminated and odd forms go up to the end of their value.
  assert.equal(css('a{b:url(/x.png;c:d}'), 'a{b:none;c:d}')
  assert.equal(css('a{b:url("/x.png;c:d}'), 'a{b:none;c:d}')
  assert.equal(css('a{b:url(x y)}'), 'a{b:none}')
})

test('the document CSS cap counts style elements and attributes', () => {
  const html = `<html><head><style>${'a{color:red}'.repeat(100)}</style></head><body><p style="color:red">x</p></body></html>`
  assert.doesNotThrow(() => sanitizeDocument(html, { base: BASE, maxCss: 2000 }))
  assert.throws(() => sanitizeDocument(html, { base: BASE, maxCss: 1000 }), /CSS is over the cap/)
})

// Review regression: DOM clobbering. No name attributes (they name document
// properties), and no ids that shadow document or form methods the board calls.
test('names and clobbering ids are dropped; other ids stay', () => {
  const out = clean(
    `<html><body><form name="f"><input name="email" id="querySelector"><img name="body" src="x"></form>
    <a name="top" id="defaultView">a</a><div id="documentElement">d</div><div id="getElementById">g</div><div id="hero">h</div>
    <meta name="viewport" content="width=device-width"></body></html>`,
  )
  assert.doesNotMatch(out, / name="(f|email|body|top)"/)
  assert.doesNotMatch(out, /id="(querySelector|defaultView|documentElement|getElementById)"/)
  assert.match(out, /id="hero"/)
  assert.match(out, /<meta name="viewport"/)
})
