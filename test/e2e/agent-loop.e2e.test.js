// Real browser + captures + scripted ACP edits. No installed agent/model calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { loadConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { Devices } from '../../src/server/devices.js'
import { createComment, getComment, listVersions, currentVersion } from '../../src/store.js'
import { tempDir, request } from '../helpers.js'
import { ROOT_DIR, listen } from './helpers.js'

const fixture = path.join(ROOT_DIR, 'test/fixtures/acp-fix.mjs')
const token = 'fixture-owner-token'

test('owner fixes fixture from desktop and phone; before/after, status and scoped tools survive real ACP + recapture', async () => {
  const dir = tempDir('loop-browser')
  const source = path.join(dir, 'index.html')
  fs.writeFileSync(source, '<!doctype html><html><body><h1>Original fixture heading</h1></body></html>')
  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(fs.readFileSync(source))
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const raw = {
    title: 'Fixture wall',
    id: 'fixture',
    baseUrl: `http://127.0.0.1:${site.address().port}`,
    viewports: { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } },
    pages: [
      { id: 'home', path: '/', title: 'Home' },
      { id: 'untouched', path: '/untouched', title: 'Untouched' },
    ],
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
    const untouchedVersion = currentVersion(config, board.id, 'untouched', 'desktop')
    const privateDir = path.join(dir, 'private')
    fs.mkdirSync(privateDir, { mode: 0o700 })
    const env = { ...process.env, XDG_CONFIG_HOME: privateDir, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(privateDir, 'agents.json') }
    const devices = new Devices(config.dir, { env })
    const paired = devices.request({ name: 'Fixture phone', ip: '192.0.2.5' })
    devices.decide(paired.code, true)
    app = createApp({
      config,
      env,
      remote: { devices },
      settingsToken: token,
      agentAcp: `${process.execPath} ${fixture}`,
      agentLimits: { burst: 100 },
    })
    server = await listen(app)
    const url = `http://127.0.0.1:${server.address().port}/`
    browser = await chromium.launch()
    for (const width of [1440, 390]) {
      fs.writeFileSync(source, `<!doctype html><html><body><h1>Original heading ${width}</h1></body></html>`)
      await runCapture({ config, only: ['home'], log: () => {} })
      const comment = await createComment(config, board, {
        pageId: 'home',
        viewport: width === 390 ? 'phone' : 'desktop',
        x: 25,
        y: 10,
        body: `Fix the fixture heading at ${width}`,
        author: 'Fixture owner',
      })
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        ...(width === 390 ? { isMobile: true, hasTouch: true, extraHTTPHeaders: { 'X-Forwarded-For': '192.0.2.5' } } : {}),
      })
      if (width === 390) await context.addCookies([{ name: devices.cookie, value: paired.token, url, httpOnly: true, sameSite: 'Strict' }])
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      try {
        await page.goto(`${url}?board=fixture${width === 390 ? '' : `#settings-token=${token}`}`)
        if (width === 390) {
          const info = await page.evaluate(() => fetch('/api/info').then((response) => response.json()))
          assert.equal(info.remote.kind, 'device')
          assert.equal(info.agent.settingsEditable, false)
          assert.equal(info.agent.settingsReadonly, true)
        }
        // Wait for resources before selecting the comment (deep-link race has a separate fix).
        await page.waitForSelector('[data-sw-node="home"]')
        if (width === 390) await page.locator('[data-sw-panel-toggle]').click()
        const row = page.locator(`[data-sw-comment="${comment.id}"]`).first()
        await row.waitFor()
        await row.click()
        await page.locator(`[data-sw-fix-agent="${comment.id}"]`).click()
        // The action opened the existing chat, which streams cards and permission controls.
        await page.waitForFunction(
          () => document.querySelector('[data-sw-chat-list]')?.textContent.includes('Changed the fixture heading'),
          null,
          { timeout: 30000 },
        )
        const events = []
        for (let attempt = 0; attempt < 100; attempt++) {
          const saved = getComment(config, board.id, comment.id)
          events.push(saved.agentStatus)
          if (saved.agentStatus === 'done') break
          await page.waitForTimeout(100)
        }
        const saved = getComment(config, board.id, comment.id)
        assert.equal(saved.agentStatus, 'done', JSON.stringify({ saved, events }))
        assert.equal(saved.status, 'open', 'owner still reviews and resolves')
        const states = fs
          .readFileSync(path.join(config.outputDir, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((event) => event.commentId === comment.id && event.type === 'comment.status_changed')
          .map((event) => event.comment.agentStatus)
        assert.deepEqual(states, ['queued', 'working', 'done'])
        assert.match(fs.readFileSync(source, 'utf8'), /Fixed fixture heading/)
        assert.ok(saved.replies.some((reply) => /owner tools/.test(reply.body)))
        assert.ok(saved.replies.some((reply) => /Before and after/.test(reply.body)))
        assert.notEqual(currentVersion(config, board.id, 'home', saved.viewport), saved.captureVersion)
        assert.ok(listVersions(config, board.id).home[saved.viewport].some((version) => version.version === saved.captureVersion))
        assert.equal(
          currentVersion(config, board.id, 'untouched', 'desktop'),
          untouchedVersion,
          'partial capture leaves unrelated page untouched',
        )
        // Reopen the actual comment thread after fix completion.
        await page.goto(`${url}?board=fixture${width === 390 ? '' : `#settings-token=${token}`}`)
        if (width === 390) {
          const info = await page.evaluate(() => fetch('/api/info').then((response) => response.json()))
          assert.equal(info.remote.kind, 'device')
          assert.equal(info.agent.settingsEditable, false)
          assert.equal(info.agent.settingsReadonly, true)
        }
        await page.waitForSelector('[data-sw-node="home"]')
        if (width === 390) await page.locator('[data-sw-panel-toggle]').click()
        await page.locator(`[data-sw-comment="${comment.id}"]`).first().click()
        await page.waitForSelector('[data-sw-before-after="ready"]')
        const images = page.locator('[data-sw-before-after="ready"] img')
        assert.ok((await images.count()) >= 1)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
        assert.deepEqual(errors, [])
        if (process.env.SHAPEWALL_SHOTS) {
          fs.mkdirSync(process.env.SHAPEWALL_SHOTS, { recursive: true })
          await page.screenshot({ path: path.join(process.env.SHAPEWALL_SHOTS, `agent-loop-${width}.png`) })
        }
      } finally {
        await context.close()
      }
    }
    const denied = await request(server.address().port, 'POST', '/api/agent/boards/fixture/threads/comment-1/messages', {
      body: { text: 'Fix it', fix: true },
    })
    assert.equal(denied.status, 403)
  } finally {
    await browser?.close()
    if (app) stopChildren(app)
    if (server) await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => site.close(resolve))
  }
})
