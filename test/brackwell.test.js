// Brackwell, the live demo's big fictional app (examples/brackwell): every
// screen builds, ids and paths are unique, and no copy the demo captures has a
// broken link (the board would open on a warning).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GROUPS, PAGES, STAGING_ONLY, brokenLinks, buildSite } from '../examples/brackwell/build.js'
import { DEMO_APPS, publicUrl, publishDemoSite } from '../scripts/demo-publish.js'

test('a big app: unique screens, every one in a group', () => {
  assert.ok(PAGES.length >= 100 && PAGES.length <= 150, `${PAGES.length} screens`)
  assert.equal(new Set(PAGES.map((page) => page.id)).size, PAGES.length)
  assert.equal(new Set(PAGES.map((page) => page.path)).size, PAGES.length)
  assert.ok(GROUPS.length >= 10)
  for (const page of PAGES) {
    assert.ok(page.title && page.group, page.id)
    assert.match(page.path, /^\/(.*\/)?$/, page.id)
  }
})

test('staging rounds and production build without broken links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-brackwell-'))
  try {
    for (const state of [{ round: 1 }, { round: 2 }, { round: 3 }, { env: 'production' }]) {
      const count = buildSite(dir, state)
      const expected = state.env === 'production' ? PAGES.length - STAGING_ONLY.size : PAGES.length
      assert.equal(count, expected, JSON.stringify(state))
      assert.deepEqual(brokenLinks(dir), [], JSON.stringify(state))
      const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
      assert.doesNotMatch(html, /—/, 'no em dashes')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('published under /brackwell with the demo banner and guarded forms', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-brackwell-src-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-brackwell-pub-'))
  try {
    buildSite(source, { round: 3 })
    const files = publishDemoSite(source, root, 'staging', 'brackwell')
    assert.equal(publicUrl('staging', 'brackwell'), 'https://shapewall.com/brackwell-staging')
    assert.ok(files.includes('brackwell-staging.html'))
    const signin = fs.readFileSync(path.join(root, 'brackwell-staging', 'signin.html'), 'utf8')
    assert.ok(signin.includes(DEMO_APPS.brackwell.banner))
    assert.match(signin, /data-brackwell-demo-next="\/brackwell-staging\/app"/)
    assert.doesNotMatch(signin, /\saction="/)
    assert.match(signin, /noindex/)
  } finally {
    fs.rmSync(source, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})
