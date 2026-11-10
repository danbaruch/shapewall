// The live demo's fictional site, published under shapewall.com (scripts/demo-publish.js): every page and
// asset under its prefix, clearly marked as a demo, forms that send nothing, and the source left untouched
// (the board's captures come from it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BANNER_TEXT,
  BOARD_PATH,
  DEMO_SITES,
  FORM_NOTE,
  publicUrl,
  publishDemoSite,
  rewriteLink,
  targetPath,
} from '../scripts/demo-publish.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'examples', 'demo-site', 'public')

function walk(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}
const hashes = (dir) =>
  Object.fromEntries(
    walk(dir)
      .sort()
      .map((file) => [path.relative(dir, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]),
  )

// What shapewall.com's Caddy does with a clean URL: the file itself, else the same path plus .html
// (a trailing slash is redirected away first; a directory never matches without one).
function served(siteRoot, urlPath) {
  const clean = urlPath.split(/[?#]/)[0].replace(/(.)\/+$/, '$1')
  for (const candidate of [clean, `${clean}.html`]) {
    const file = path.join(siteRoot, candidate)
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  return null
}

function publish(env) {
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-demo-publish-'))
  const files = publishDemoSite(SOURCE, siteRoot, env)
  return { siteRoot, files }
}

test('public URLs and the file layout under the prefix', () => {
  assert.equal(publicUrl('production'), 'https://shapewall.com/lumen')
  assert.equal(publicUrl('staging'), 'https://shapewall.com/lumen-staging')
  assert.equal(targetPath('index.html', '/lumen'), 'lumen.html')
  assert.equal(targetPath(path.join('pricing', 'index.html'), '/lumen'), 'lumen/pricing.html')
  assert.equal(targetPath(path.join('app', 'note', 'share', 'index.html'), '/lumen'), 'lumen/app/note/share.html')
  assert.equal(targetPath('styles.css', '/lumen-staging'), 'lumen-staging/styles.css')
  assert.equal(rewriteLink('/', '/lumen'), '/lumen')
  assert.equal(rewriteLink('/pricing/', '/lumen'), '/lumen/pricing')
  assert.equal(rewriteLink('/pricing/?plan=plus#faq', '/lumen'), '/lumen/pricing?plan=plus#faq')
  assert.equal(rewriteLink('/img/logo.svg', '/lumen'), '/lumen/img/logo.svg')
  assert.equal(rewriteLink('https://example.com/', '/lumen'), 'https://example.com/')
  assert.equal(rewriteLink('//example.com/x', '/lumen'), '//example.com/x')
  assert.equal(rewriteLink('#top', '/lumen'), '#top')
})

test('every page, asset and link of the published copy works under its prefix', () => {
  for (const env of Object.keys(DEMO_SITES)) {
    const { prefix } = DEMO_SITES[env]
    const { siteRoot } = publish(env)
    try {
      // The board's page URLs (with or without the trailing slash) open the published page.
      for (const page of ['/', '/pricing/', '/app/', '/app/note/share/', '/404/', '/error/', '/signup/verify/expired/']) {
        const url = new URL(page === '/' ? '' : page.slice(1), `${publicUrl(env)}/`).pathname
        assert.ok(served(siteRoot, url), `${env}: ${url} is served`)
      }
      // A page the site does not have is a 404 inside the prefix, not some other page.
      assert.equal(served(siteRoot, `${prefix}/status/`), null)
      const texts = walk(siteRoot)
        .filter((file) => /\.(html|js|css)$/.test(file))
        .map((file) => [path.relative(siteRoot, file), fs.readFileSync(file, 'utf8')])
      assert.ok(texts.length > 25, `${env}: pages published`)
      for (const [file, text] of texts) {
        for (const [, value] of text.matchAll(/\b(?:href|src|action)="([^"]*)"/g)) {
          if (!value.startsWith('/')) continue
          if (value === BOARD_PATH) continue
          assert.ok(value === prefix || value.startsWith(`${prefix}/`), `${env} ${file}: ${value} is under ${prefix}`)
          assert.ok(served(siteRoot, value), `${env} ${file}: ${value} resolves to a file`)
        }
      }
    } finally {
      fs.rmSync(siteRoot, { recursive: true, force: true })
    }
  }
})

test('every published page is marked as a demo: banner back to the board, noindex, forms that send nothing', () => {
  const { siteRoot } = publish('staging')
  try {
    const pages = walk(siteRoot).filter((file) => file.endsWith('.html'))
    assert.equal(pages.length, walk(SOURCE).filter((file) => file.endsWith('.html')).length)
    let forms = 0
    for (const file of pages) {
      const html = fs.readFileSync(file, 'utf8')
      const name = path.relative(siteRoot, file)
      assert.match(html, /<meta name="robots" content="noindex,nofollow" \/>/, `${name}: noindex`)
      assert.ok(html.includes(`<a href="${BOARD_PATH}"`) && html.includes(BANNER_TEXT), `${name}: banner linking to the board`)
      assert.match(html, /data-lumen-demo-banner[^>]*position:fixed/, `${name}: the banner is fixed`)
      assert.ok(html.includes('(staging copy)'), `${name}: says it is the staging copy`)
      for (const [form] of html.matchAll(/<form\b[^>]*>/g)) {
        forms += 1
        assert.ok(!/\baction=|\bmethod=/.test(form), `${name}: ${form} has no action or method`)
        assert.ok(form.includes('onsubmit="return false"') && form.includes('data-lumen-demo-form'), `${name}: ${form} is guarded`)
        assert.ok(form.includes(' novalidate'), `${name}: ${form} submits with empty fields`)
      }
      assert.ok(!/<(?:input|select|textarea)\b[^>]*\srequired\b/.test(html), `${name}: no required fields`)
      if (name === path.join('lumen-staging', 'login.html')) {
        assert.ok(html.includes('data-lumen-demo-next="/lumen-staging/app"'), 'sign in goes on to the app')
      }
      if (name === path.join('lumen-staging', 'signup.html')) {
        assert.ok(html.includes('data-lumen-demo-next="/lumen-staging/welcome"'), 'sign up goes on to the welcome page')
      }
      if (/<form\b/.test(html)) {
        assert.ok(html.includes(FORM_NOTE), `${name}: says the form sends nothing`)
        assert.ok(html.includes('<script src="/lumen-staging/demo-guard.js" defer></script>'), `${name}: submit guard`)
      }
      assert.ok(!/onclick=|demo-password-must-not-be-captured|csrf_token/.test(html), `${name}: no alerts or prefilled secrets`)
    }
    assert.ok(forms >= 6, 'sign-in, sign-up, reset and verify forms are all guarded')
    assert.match(fs.readFileSync(path.join(siteRoot, 'lumen-staging', 'demo-guard.js'), 'utf8'), /preventDefault/)
    // Production has no "(staging copy)" label.
    const production = publish('production')
    try {
      const home = fs.readFileSync(path.join(production.siteRoot, 'lumen.html'), 'utf8')
      assert.ok(home.includes(BANNER_TEXT) && !home.includes('(staging copy)'))
    } finally {
      fs.rmSync(production.siteRoot, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(siteRoot, { recursive: true, force: true })
  }
})

test('publishing leaves the captured copy untouched and is deterministic', () => {
  const before = hashes(SOURCE)
  const one = publish('production')
  const two = publish('production')
  try {
    assert.deepEqual(hashes(SOURCE), before, 'the source (what the board captures) is unchanged')
    for (const file of walk(SOURCE).filter((item) => item.endsWith('.html'))) {
      assert.ok(!fs.readFileSync(file, 'utf8').includes(BANNER_TEXT), `${path.relative(SOURCE, file)}: no banner in the source`)
    }
    assert.deepEqual(hashes(one.siteRoot), hashes(two.siteRoot))
    // Publishing again over an earlier copy replaces it.
    publishDemoSite(SOURCE, one.siteRoot, 'production')
    assert.deepEqual(hashes(one.siteRoot), hashes(two.siteRoot))
  } finally {
    fs.rmSync(one.siteRoot, { recursive: true, force: true })
    fs.rmSync(two.siteRoot, { recursive: true, force: true })
  }
})
