// Regression tests for issues found in review.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildLiveHtml } from '../src/capture/live.js'
import { commentsFile, createComment, validateAnchor } from '../src/store.js'
import { withFileLock } from '../src/lock.js'
import { isLoopback } from '../src/cli.js'
import { sampleConfig, tempDir } from './helpers.js'

test('a repeated non-base64 SVG image cannot break out of the shared style rule', async () => {
  const payload = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"></style><meta http-equiv=refresh content="0;url=https://evil.test/">${'x'.repeat(2100)}</svg>`
  const snapshot = {
    base: 'http://127.0.0.1:3000/',
    html: `<!DOCTYPE html><html><head></head><body><img src='${payload}'><img src='${payload}'></body></html>`,
    chunks: [],
    cssImages: {},
  }
  const { html } = await buildLiveHtml(snapshot, { getBody: async () => null })
  assert.doesNotMatch(html, /<meta http-equiv=refresh/i)
  assert.doesNotMatch(html, /evil\.test\/">/)
  assert.equal((html.match(/<\/style>/g) || []).length, (html.match(/<style>/g) || []).length)
})

test('a corrupt comments.json is never overwritten', async () => {
  const config = sampleConfig('review-corrupt')
  const file = commentsFile(config, 'sample')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"nextId": 3, "comments": [ {"id": 1}, ]}')
  await assert.rejects(
    createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'x' }),
    /not valid JSON/,
  )
  assert.equal(fs.readFileSync(file, 'utf8'), '{"nextId": 3, "comments": [ {"id": 1}, ]}')
})

test('anchors on non-ASCII ids are accepted', () => {
  assert.equal(validateAnchor({ selector: '#café > a:nth-of-type(1)', dx: 0.5, dy: 0.5 }).selector, '#café > a:nth-of-type(1)')
})

test('withFileLock never removes a lock that is not its own', async () => {
  const file = path.join(tempDir('review-lock'), 'data.json')
  await withFileLock(file, () => {
    // Someone wrongly took over and now holds the lock.
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, nonce: 'other' }))
  })
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).nonce, 'other')
})

test('loopback detection covers 127/8 and every spelling of ::1', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']) assert.equal(isLoopback(host), true, host)
  for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) assert.equal(isLoopback(host), false, host)
})
