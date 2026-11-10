import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  VERSION_RE,
  archiveVersion,
  capturesDir,
  createComment,
  entryVersion,
  listVersions,
  pruneVersions,
  resolveFile,
  updateComment,
  versionId,
} from '../src/store.js'
import { sampleConfig } from './helpers.js'

function writeShot(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.png`), `png ${text}`)
  fs.writeFileSync(path.join(dir, `${name}.thumb.png`), `thumb ${text}`)
  fs.writeFileSync(path.join(dir, `${name}.html`), `<p>${text}</p>`)
}

test('version ids sort by time and match the served-name grammar', () => {
  const a = versionId(new Date('2026-11-04T09:08:07.006Z'), 'abcd')
  assert.equal(a, '20261104T090807006Z-abcd')
  assert.match(a, VERSION_RE)
  assert.ok(versionId(new Date('2026-11-04T09:08:07.007Z'), '0000') > a)
  // Manifests from before versions existed fall back to the run's time.
  assert.equal(entryVersion({ status: 'ok' }, { capturedAt: '2026-01-02T03:04:05.000Z' }), '20260102T030405000Z')
  assert.equal(entryVersion({ status: 'ok', version: a }, {}), a)
  assert.equal(entryVersion({ status: 'failed', version: a }, {}), null)
  assert.equal(entryVersion({ status: 'ok', version: '../x' }, {}), null)
})

test('archived versions are listed newest first and pruned to the newest N', () => {
  const config = sampleConfig('versions-prune', { versions: 2 })
  const captures = capturesDir(config, 'sample')
  const ids = ['20260101T000000000Z', '20260102T000000000Z-aaaa', '20260103T000000000Z', '20260104T000000000Z']
  for (const id of ids) {
    writeShot(captures, 'home.desktop', id)
    assert.equal(archiveVersion(config, 'sample', { fromDir: captures, pageId: 'home', viewport: 'desktop', version: id }).length, 3)
  }
  writeShot(captures, 'pricing.phone', 'p')
  archiveVersion(config, 'sample', { fromDir: captures, pageId: 'pricing', viewport: 'phone', version: ids[0] })
  // Invalid ids and missing shots are refused quietly.
  assert.deepEqual(archiveVersion(config, 'sample', { fromDir: captures, pageId: 'home', viewport: 'desktop', version: 'nope' }), [])
  assert.deepEqual(archiveVersion(config, 'sample', { fromDir: captures, pageId: 'app', viewport: 'desktop', version: ids[0] }), [])

  const listed = listVersions(config, 'sample')
  assert.deepEqual(
    listed.home.desktop.map((item) => item.version),
    [...ids].reverse(),
  )
  assert.deepEqual(listed.home.desktop[0], {
    version: ids[3],
    file: `home.desktop.${ids[3]}.png`,
    thumb: `home.desktop.${ids[3]}.thumb.png`,
    live: `home.desktop.${ids[3]}.html`,
  })
  assert.equal(pruneVersions(config, 'sample'), 2)
  const kept = listVersions(config, 'sample')
  assert.deepEqual(
    kept.home.desktop.map((item) => item.version),
    [ids[3], ids[2]],
  )
  assert.equal(kept.pricing.phone.length, 1)
  // The archived content is the shot as it was.
  assert.equal(fs.readFileSync(resolveFile(config, 'sample', 'versions', `home.desktop.${ids[2]}.png`), 'utf8'), `png ${ids[2]}`)
  assert.equal(resolveFile(config, 'sample', 'versions', `home.desktop.${ids[0]}.png`), null)
  assert.equal(resolveFile(config, 'sample', 'versions', '../comments.json'), null)
  assert.equal(pruneVersions(config, 'sample', 0), 3)
})

test('a comment records the capture version it was made on; fixRef is validated', async () => {
  const config = sampleConfig('versions-comment')
  const board = config.boards[0]
  const captures = capturesDir(config, 'sample')
  fs.mkdirSync(captures, { recursive: true })
  const version = '20261104T101010101Z-beef'
  fs.writeFileSync(
    path.join(captures, 'manifest.json'),
    JSON.stringify({ capturedAt: '2026-11-04T10:10:11Z', pages: { home: { desktop: { status: 'ok', version } } } }),
  )
  const base = { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Fix the logo' }
  const comment = await createComment(config, board, base)
  assert.equal(comment.captureVersion, version)
  assert.equal((await createComment(config, board, { ...base, viewport: 'phone' })).captureVersion, null)

  const resolved = await updateComment(config, 'sample', comment.id, { status: 'resolved', fixRef: '  https://github.com/o/r/pull/7 ' })
  assert.equal(resolved.fixRef, 'https://github.com/o/r/pull/7')
  assert.equal((await updateComment(config, 'sample', comment.id, { fixRef: 'a1b2c3d' })).fixRef, 'a1b2c3d')
  assert.equal('fixRef' in (await updateComment(config, 'sample', comment.id, { fixRef: null })), false)
  for (const bad of [42, 'line\nbreak', 'x'.repeat(301)]) {
    await assert.rejects(updateComment(config, 'sample', comment.id, { fixRef: bad }), (error) => error.code === 'invalid_fix_ref')
  }
})
