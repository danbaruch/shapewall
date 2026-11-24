// A stuck "Agent working" on a local board (the state-machine review, F4):
// a claim whose process died is handed to a person when the server starts,
// and a status nobody's process holds can be cleared from the thread.
// Real browser; no agent runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright'
import { loadConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp, stopChildren } from '../../src/server/app.js'
import { commentsFile, createComment, getComment, setAgentStatus } from '../../src/store.js'
import { tempDir } from '../helpers.js'
import { ROOT_DIR, listen } from './helpers.js'

const fixture = path.join(ROOT_DIR, 'test/fixtures/acp-fix.mjs')
const token = 'fixture-owner-token'
const shots = process.env.SHAPEWALL_E2E_SHOTS || null

test('a dead agent hands its comment to a person at start; Clear takes back a stuck status on desktop and phone', async () => {
  const dir = tempDir('agent-clear')
  const site = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><html><body><h1>Clear fixture</h1></body></html>')
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      title: 'Clear wall',
      id: 'fixture',
      baseUrl: `http://127.0.0.1:${site.address().port}`,
      viewports: { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } },
      pages: [{ id: 'home', path: '/', title: 'Home' }],
    }),
  )
  const config = loadConfig(file)
  const board = config.boards[0]
  let browser
  let server
  let app
  try {
    await runCapture({ config, log: () => {} })
    const pin = { pageId: 'home', viewport: 'desktop', x: 20, y: 10, author: 'Fixture owner' }
    // A fix whose server was killed: its claim names a process that is gone.
    const dead = await createComment(config, board, { ...pin, body: 'Left working by a dead server' })
    await setAgentStatus(config, board.id, dead.id, 'working')
    const stored = JSON.parse(fs.readFileSync(commentsFile(config, board.id), 'utf8'))
    stored.comments.find((item) => item.id === dead.id).agentClaim = {
      id: 'gone',
      pid: 2 ** 22 + 54321,
      start: '1',
      at: new Date().toISOString(),
    }
    fs.writeFileSync(commentsFile(config, board.id), JSON.stringify(stored))
    const privateDir = path.join(dir, 'private')
    fs.mkdirSync(privateDir, { mode: 0o700 })
    const env = { ...process.env, XDG_CONFIG_HOME: privateDir, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(privateDir, 'agents.json') }
    app = createApp({ config, env, settingsToken: token, agentAcp: `${process.execPath} ${fixture}`, agentLimits: { burst: 100 } })
    server = await listen(app)
    for (let attempt = 0; attempt < 50 && getComment(config, board.id, dead.id).agentStatus !== 'needs-human'; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    const swept = getComment(config, board.id, dead.id)
    assert.equal(swept.agentStatus, 'needs-human')
    assert.match(swept.replies.at(-1).body, /stopped before it finished/)

    const url = `http://127.0.0.1:${server.address().port}/`
    browser = await chromium.launch()
    for (const width of [1440, 390]) {
      // Marked working by hand (the CLI): no process holds it, nothing sweeps it.
      const stuck = await createComment(config, board, { ...pin, viewport: width === 390 ? 'phone' : 'desktop', body: `Stuck at ${width}` })
      await setAgentStatus(config, board.id, stuck.id, 'working', { holder: null })
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        ...(width === 390 ? { isMobile: true, hasTouch: true } : {}),
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      try {
        await page.goto(`${url}?board=fixture#settings-token=${token}`)
        await page.waitForSelector('[data-sw-node="home"]')
        if (width === 390) await page.locator('[data-sw-panel-toggle]').click()
        const row = page.locator(`[data-sw-comment="${stuck.id}"]`).first()
        await row.waitFor()
        await row.click()
        const clear = page.locator(`[data-sw-fix-agent-clear="${stuck.id}"]`)
        await clear.waitFor()
        assert.match(await page.locator('[data-sw-fix-agent-state="working"]').first().textContent(), /Agent working/)
        // The phone's thread sheet slides in.
        if (shots) await page.waitForTimeout(500)
        if (shots) await page.screenshot({ path: path.join(shots, `agent-clear-${width}.png`) })
        await clear.click()
        // The status is gone at once in the thread, and Fix with agent is offered again.
        await page.locator(`[data-sw-fix-agent="${stuck.id}"]`).waitFor()
        assert.equal(getComment(config, board.id, stuck.id).agentStatus, null)
        if (shots) await page.screenshot({ path: path.join(shots, `agent-cleared-${width}.png`) })
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser?.close()
    if (app) stopChildren(app)
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
    await new Promise((resolve) => site.close(resolve))
  }
})
