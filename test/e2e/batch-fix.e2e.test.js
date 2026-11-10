// Batch fixes in a real browser with the scripted ACP fixture (its "slow"
// mode: each fix pauses 1.5 s, and a cancel ends it with nothing edited). Off
// by default there is no Select control; turned on from the Agents page, three
// comments are fixed one after another with progress in the comments panel
// and the chat, each with its own before and after; a second batch is
// cancelled mid-item and the rest are skipped. No model calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { loadConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { createComment, getComment } from '../../src/store.js'
import { tempDir } from '../helpers.js'
import { ROOT_DIR, listen } from './helpers.js'

const fixture = path.join(ROOT_DIR, 'test/fixtures/acp-fix.mjs')
const token = 'batch-owner-token'

test('batch fixes: off by default, on from the Agents page, three fixed in order with progress and before/after, cancel mid-batch', async () => {
  const dir = tempDir('batch-browser')
  const source = path.join(dir, 'index.html')
  fs.writeFileSync(source, '<!doctype html><html><body><h1>Original batch heading</h1></body></html>')
  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(fs.readFileSync(source))
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const raw = {
    title: 'Batch wall',
    id: 'batchy',
    baseUrl: `http://127.0.0.1:${site.address().port}`,
    viewports: { desktop: { width: 1440, height: 900 } },
    pages: [{ id: 'home', path: '/', title: 'Home' }],
  }
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(raw))
  const config = loadConfig(file)
  const board = config.boards[0]
  let browser
  let server
  let app
  try {
    await runCapture({ config, log: () => {} })
    const privateDir = path.join(dir, 'private')
    fs.mkdirSync(privateDir, { mode: 0o700 })
    const env = { ...process.env, XDG_CONFIG_HOME: privateDir, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(privateDir, 'agents.json') }
    delete env.SHAPEWALL_AGENT_BRANCH_MODE
    app = createApp({ config, env, settingsToken: token, agentAcp: `${process.execPath} ${fixture} slow`, agentLimits: { burst: 100 } })
    server = await listen(app)
    const base = `http://127.0.0.1:${server.address().port}`
    const boardUrl = `${base}/?board=batchy#settings-token=${token}`
    const newComment = (body, x) => createComment(config, board, { pageId: 'home', viewport: 'desktop', x, y: 10, body, author: 'Owner' })
    const first = [await newComment('Batch one: bigger heading', 10), await newComment('Batch two: calmer colour', 30)]
    first.push(await newComment('Batch three: shorter text', 50))

    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const openBoard = async () => {
      await page.goto(boardUrl)
      await page.waitForSelector('[data-sw-node="home"]')
      await page.locator(`[data-sw-comment="${first[0].id}"]`).first().waitFor()
    }

    // Off by default: nothing changes in the comments panel.
    await openBoard()
    await page.waitForTimeout(500)
    assert.equal(await page.locator('[data-sw-batch-bar], [data-sw-batch-select-mode], [data-sw-batch-select]').count(), 0)

    // On from the Agents page, next to Work on a branch.
    await page.goto(`${base}/console?section=agents#settings-token=${token}`)
    await page.locator('[data-sw-agents-branch-mode]').waitFor()
    await page.locator('[data-sw-agents-batch-fixes="off"]').waitFor()
    await page.click('[data-sw-agents-batch-switch]')
    await page.locator('[data-sw-agents-batch-fixes="on"]').waitFor()
    const limit = page.locator('[data-sw-agents-batch-max]')
    assert.equal(await limit.inputValue(), '5')
    const saved = JSON.parse(fs.readFileSync(path.join(privateDir, 'agents.json'), 'utf8'))
    assert.match(JSON.stringify(saved), /"batchFixes":\{"enabled":true\}/)

    // Select three, confirm, run.
    await openBoard()
    await page.click('[data-sw-batch-select-mode]')
    for (const comment of first) await page.click(`[data-sw-batch-select="${comment.id}"]`)
    await page.locator('[data-sw-batch-count="3"]').waitFor()
    await page.click('[data-sw-batch-fix="3"]')
    await page.locator('[data-sw-batch-confirm="3"]').waitFor()
    assert.equal(await page.locator('[data-sw-batch-confirm-item]').count(), 3)
    await page.click('[data-sw-batch-start]')
    const strip = page.locator('[data-sw-batch-strip]')
    await strip.locator('[data-sw-batch-headline]').waitFor()
    await page.waitForFunction(() =>
      /Fixing \d of 3/.test(document.querySelector('[data-sw-batch-strip] [data-sw-batch-headline]')?.textContent || ''),
    )
    // The chat panel has the same card.
    await page.click('[data-sw-chat-toggle]')
    await page.locator('[data-sw-chat-batch] [data-sw-batch-headline]').waitFor()
    // A reload keeps it: the state comes from the server.
    await openBoard()
    await strip.waitFor()
    await page.locator('[data-sw-batch-strip] [data-sw-batch="done"]').waitFor({ timeout: 90000 })
    // The strip folds its list away; Show opens it.
    await page.click('[data-sw-batch-strip] [data-sw-batch-toggle]')
    const states = await page
      .locator('[data-sw-batch-strip] [data-sw-batch-item-state]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-sw-batch-item-state')))
    assert.deepEqual(states, ['fixed', 'fixed', 'fixed'])
    for (const comment of first) {
      const after = getComment(config, board.id, comment.id)
      assert.equal(after.agentStatus, 'done', `#${comment.id}`)
      assert.ok(
        after.replies.some((reply) => /owner tools/.test(reply.body)),
        `#${comment.id} has its own reply`,
      )
    }
    // In order: each started after the one before it finished.
    const order = first.map((comment) => getComment(config, board.id, comment.id).agentStatusAt)
    assert.deepEqual([...order].sort(), order)
    assert.match(fs.readFileSync(source, 'utf8'), /Fixed fixture heading/)
    // Each item's thread has its before and after.
    await page.click(`[data-sw-batch-strip] [data-sw-batch-open="${first[1].id}"]`)
    await page.waitForSelector('[data-sw-before-after="ready"]')
    assert.ok((await page.locator('[data-sw-before-after="ready"] img').count()) >= 1)
    if (process.env.SHAPEWALL_SHOTS) {
      fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
      await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, 'batch-fix-done.png') })
    }

    // A second batch, cancelled while its first item runs: the rest are skipped.
    const second = [await newComment('Cancel me one', 20), await newComment('Cancel me two', 40)]
    await openBoard()
    await page.click('[data-sw-batch-strip] [data-sw-batch-dismiss]')
    await strip.waitFor({ state: 'detached' })
    await page.click('[data-sw-batch-select-mode]')
    for (const comment of second) await page.click(`[data-sw-batch-select="${comment.id}"]`)
    await page.click('[data-sw-batch-fix="2"]')
    await page.click('[data-sw-batch-start]')
    await page.click('[data-sw-batch-strip] [data-sw-batch-toggle]')
    await page.locator(`[data-sw-batch-strip] [data-sw-batch-item="${second[0].id}"][data-sw-batch-item-state="running"]`).waitFor()
    await page.click('[data-sw-batch-strip] [data-sw-batch-cancel]')
    await page.locator('[data-sw-batch-strip] [data-sw-batch="cancelled"]').waitFor({ timeout: 30000 })
    const cancelled = await page
      .locator('[data-sw-batch-strip] [data-sw-batch-item-state]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-sw-batch-item-state')))
    assert.deepEqual(cancelled, ['skipped', 'skipped'])
    for (const comment of second) {
      const after = getComment(config, board.id, comment.id)
      assert.notEqual(after.agentStatus, 'done', `#${comment.id} was not fixed`)
      assert.notEqual(after.agentStatus, 'working', `#${comment.id} is not left working`)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    if (app) stopChildren(app)
    if (server) await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => site.close(resolve))
  }
})
