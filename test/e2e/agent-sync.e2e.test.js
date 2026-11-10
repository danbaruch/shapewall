// End to end: agent settings stay in sync across open views without a
// reload. Two pages of one local install: the Workspace Console's Agents
// page and a board with its chat open. Changing the default on the Agents
// page moves the board's agent picker; an edit of the agents file from
// outside (as `shapewall settings` or a person would) reaches both; and
// unsaved typing on the Chat connection card is kept, with a quiet note to
// reload. Fake adapters on PATH run the ACP stub (test/fixtures/acp-stub.mjs):
// never a real agent. Nothing may log an error.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { saveUserAgentEntry } from '../../src/agent/user-settings.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const TOKEN = 'e2e-agent-sync-token-0123456789abcdef'
const STUB = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')
const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let setup
let env
let app
let server
let base
let browser

const entry = (defaultCommand) => ({
  backend: 'acp',
  acpCommand: defaultCommand,
  profiles: [
    { id: 'codex', label: 'Codex', acpCommand: 'codex-acp' },
    { id: 'claude', label: 'Claude Code', acpCommand: 'claude-agent-acp' },
  ],
})

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('agent-sync-e2e')
  const bin = path.join(setup.dir, 'bin')
  fs.mkdirSync(bin)
  for (const name of ['codex-acp', 'claude-agent-acp'])
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexec "' + process.execPath + '" "' + STUB + '" "$@"\n', { mode: 0o755 })
  env = { HOME: setup.dir, XDG_CONFIG_HOME: setup.dir, PATH: bin + path.delimiter + process.env.PATH }
  saveUserAgentEntry(setup.config.dir, entry('codex-acp'), env)
  app = createApp({ config: setup.config, env, settingsToken: TOKEN })
  server = await listen(app)
  base = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  if (app) stopChildren(app)
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await setup?.close()
})

// The picker's default agent on the board, read from its menu.
async function boardDefault(page) {
  await page.click('[data-sw-agent-profile]')
  const item = page.locator('[data-sw-agent-menu] [data-sw-agent-option]:has([data-sw-agent-default])')
  await item.first().waitFor()
  const id = await item.first().getAttribute('data-sw-agent-option')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-sw-agent-menu]', { state: 'detached' })
  return id
}
// The chat on the default shows the default agent's name on its picker.
async function waitBoardDefault(page, id, label) {
  await page.waitForFunction((text) => document.querySelector('[data-sw-agent-profile]')?.textContent.trim() === text, label)
  for (let i = 0; i < 40; i++) {
    if ((await boardDefault(page)) === id) return
    await page.waitForTimeout(150)
  }
  assert.fail('the board picker never showed ' + id + ' as the default')
}

test(
  'a default changed on the Agents page, or in the agents file, reaches the board picker and keeps unsaved typing',
  { timeout: 60000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const errors = []
    const watch = (page) => {
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      page.on('pageerror', (error) => errors.push(error.message))
    }
    try {
      const board = await context.newPage()
      watch(board)
      await board.goto(base + '/?board=' + setup.config.boards[0].id + '#settings-token=' + TOKEN)
      await board.waitForSelector('[data-sw-node="home"]')
      await board.click('[data-sw-chat-toggle]')
      await board.waitForSelector('[data-sw-agent-profile]')
      assert.equal(await boardDefault(board), 'codex')

      const agents = await context.newPage()
      watch(agents)
      await agents.goto(base + '/console?section=agents#settings-token=' + TOKEN)
      await agents.waitForSelector('[data-sw-agents-default-option="claude"]')
      // The Chat connection card's name field, typed into below.
      const label = agents.locator('[data-sw-settings-field="label"]')
      await label.waitFor()

      // 1. The Agents page makes Claude Code the default: the board follows, no reload.
      // A marker on the board's window: a reload would drop it.
      await board.evaluate(() => (window.swSyncMarker = 1))
      await agents.locator('[data-sw-agents-default-option="claude"] input').check()
      await agents.waitForFunction(() => document.querySelector('[data-sw-agents-default-option="claude"] input')?.checked === true)
      await waitBoardDefault(board, 'claude', 'Claude Code')
      // The Chat connection card on the same page took it (it had no edits).
      await agents.waitForFunction(() =>
        /Chat uses Claude Code/.test(document.querySelector('[data-sw-settings-status]')?.textContent || ''),
      )

      // 2. Typing, then an edit of the file from outside: the typing stays, the
      // read-only parts follow, and a quiet note offers a reload.
      await label.fill('My unsaved name')
      saveUserAgentEntry(setup.config.dir, entry('codex-acp'), env)
      await agents.waitForSelector('[data-sw-settings-stale]')
      assert.match(await agents.locator('[data-sw-settings-stale]').innerText(), /Agent settings changed elsewhere\. Reload to see them/)
      assert.equal(await label.inputValue(), 'My unsaved name', 'unsaved typing kept')
      await agents.waitForFunction(() => /Chat uses Codex/.test(document.querySelector('[data-sw-settings-status]')?.textContent || ''))
      await agents.waitForFunction(() => document.querySelector('[data-sw-agents-default-option="codex"] input')?.checked === true)
      await waitBoardDefault(board, 'codex', 'Codex')
      if (SHOTS) await agents.screenshot({ path: path.join(SHOTS, 'agent-sync-stale.png'), fullPage: true })
      // Reload takes the saved settings and drops the note.
      await agents.click('[data-sw-settings-stale-reload]')
      await agents.waitForSelector('[data-sw-settings-stale]', { state: 'detached' })
      assert.equal(await label.inputValue(), '')
      assert.equal(await board.evaluate(() => window.swSyncMarker), 1, 'the board never reloaded')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  },
)
