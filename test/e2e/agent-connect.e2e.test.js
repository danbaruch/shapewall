// End to end: one-click agent connect in Chromium. A board opened from the
// `shapewall serve` link lists the agent CLIs found on PATH (a fake
// claude-agent-acp that runs the ACP stub in test/fixtures/acp-stub.mjs),
// Connect saves it, tests it and chats, with no file edit or restart; an
// agent that does not start leaves nothing saved; without the link the panel
// and the profile menu say how to unlock settings; the avatar has initials
// from the local name. Desktop 1440 and phone 390. Never a real agent.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { createApp, stopChildren } from '../../src/server/app.js'
import { absoluteProgram } from '../../src/which.js'
import { saveUserAgentEntry } from '../../src/agent/user-settings.js'
import { ROOT_DIR, demoSetup, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const STUB = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')
const TOKEN = 'e2e-connect-token-0123456789abcdef'
const POSIX = process.platform !== 'win32'
let setup
let home
let bins
let browser
const apps = []

// A folder with one program named claude-agent-acp: the ACP stub, or one that exits at once.
function binWith(kind) {
  const dir = path.join(bins, kind)
  fs.mkdirSync(dir, { recursive: true })
  const body = kind === 'stub' ? `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n` : '#!/bin/sh\nexit 3\n'
  fs.writeFileSync(path.join(dir, 'claude-agent-acp'), body, { mode: 0o755 })
  // Node and git live in different folders on CI. Keep agent discovery
  // hermetic while making the real git available for the profile-name check.
  const git = absoluteProgram('git')
  assert.ok(git, 'git must be installed for the local-profile integration test')
  const fixtureGit = path.join(dir, 'git')
  if (!fs.existsSync(fixtureGit)) fs.symlinkSync(git, fixtureGit)
  return dir
}

async function board(kind = 'stub', options = {}) {
  fs.rmSync(path.join(home, 'shapewall'), { recursive: true, force: true })
  const app = createApp({
    config: setup.config,
    // Only the fake agent's folder and node's: the result does not depend on what this machine has installed.
    env: {
      PATH: [binWith(kind), path.dirname(process.execPath)].join(path.delimiter),
      HOME: home,
      XDG_CONFIG_HOME: home,
      // The name comes from git: this home's .gitconfig (written in before()).
      GIT_CONFIG_NOSYSTEM: '1',
    },
    settingsToken: TOKEN,
    ...options,
  })
  const server = await listen(app)
  apps.push({ app, server })
  return `http://127.0.0.1:${server.address().port}/`
}
const withToken = (url) => `${url}#settings-token=${TOKEN}`

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the e2e tests')
  setup = await demoSetup('agent-connect-e2e')
  // Isolate git discovery from the checkout containing test/.output. A
  // repository-local user.name must not override this fixture's HOME.
  execFileSync(absoluteProgram('git'), ['init', '-q', setup.config.dir])
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-connect-e2e-'))
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Robin Tester\n')
  bins = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-connect-bins-'))
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  for (const { app, server } of apps) {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
  await setup?.close()
  for (const dir of [home, bins]) if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

async function openBoard(url, contextOptions) {
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url)
  await page.waitForSelector('[data-sw-node="home"]')
  return { context, page, errors }
}

async function shot(page, name) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))))
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

const settingsFile = () => path.join(home, 'shapewall', 'agents.json')

test('desktop 1440: Claude Code found, Connect, chatting; no file edit, no restart', { skip: !POSIX }, async () => {
  const url = await board('stub')
  const { context, page, errors } = await openBoard(withToken(url), { viewport: { width: 1440, height: 900 } })
  try {
    // The avatar has initials from the local name, not "?".
    const avatar = page.locator('[data-sw-profile-menu]')
    assert.equal((await avatar.textContent()).trim(), 'RT')
    assert.equal(await avatar.getAttribute('aria-label'), 'Profile and appearance: Robin Tester')

    await page.click('[data-sw-chat-toggle]')
    const card = page.locator('[data-sw-chat-detected="claude"]')
    await card.waitFor()
    assert.match(await card.textContent(), /Claude Code found on this machine/)
    assert.match(await card.textContent(), /claude-agent-acp/)
    assert.match(await page.locator('[data-sw-chat-connect-note]').textContent(), /does not sandbox/)
    // The endpoint and the docs are folded away.
    assert.equal(await page.locator('[data-sw-chat-other-options]').getAttribute('open'), null)
    assert.equal(await page.locator('[data-sw-chat-acp-example]').count(), 0, 'no JSON or terminal commands up front')
    await shot(page, 'connect-desktop-detected')

    await page.click('[data-sw-chat-connect-agent="claude"]')
    // The same confirmation as any new command, with exactly the command it runs.
    const dialog = page.locator('[data-sw-settings-confirm-list]')
    await dialog.waitFor()
    assert.equal(await dialog.locator('[data-sw-settings-confirm-item="command"] > code').textContent(), 'claude-agent-acp')
    assert.equal(fs.existsSync(settingsFile()), false, 'nothing saved before Allow')
    await shot(page, 'connect-desktop-confirm')
    await page.click('[data-sw-settings-confirm]')
    const note = page.locator('[data-sw-chat-connected-note]')
    await note.waitFor()
    assert.match(await note.textContent(), /Connected to Claude Code\. Handshake ok, login not checked/)
    assert.match(await note.textContent(), /\/login/)
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-empty="thread"]')
    await shot(page, 'connect-desktop-connected')
    // Saved to the person's own file, not the project.
    assert.equal(Object.values(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).projects)[0].acpCommand, 'claude-agent-acp')

    await page.fill('[data-sw-chat-input]', 'stream')
    await page.click('[data-sw-chat-send]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"]')
    assert.equal(
      (await page.locator('[data-sw-chat-message="assistant"]').last().locator('[data-sw-markdown]').textContent()).trim(),
      'Hello from the stream.',
    )
    await shot(page, 'connect-desktop-chatting')

    // The console's Agents page is in the profile menu too (Workspace Console).
    await avatar.click()
    await page.click('[data-sw-profile-item="console"]')
    await page.locator('[data-sw-nav="agents"]').click()
    await page.waitForSelector('[data-sw-local-console-agent-details] [data-sw-settings="agent"]')
    assert.equal(await page.getAttribute('[data-sw-settings-status]', 'data-sw-settings-status'), 'connected')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('desktop 1440: an agent that does not start says so and leaves nothing saved', { skip: !POSIX }, async () => {
  const url = await board('crash')
  const { context, page, errors } = await openBoard(withToken(url), { viewport: { width: 1440, height: 900 } })
  try {
    await page.click('[data-sw-chat-toggle]')
    await page.click('[data-sw-chat-connect-agent="claude"]')
    await page.click('[data-sw-settings-confirm]')
    const failed = page.locator('[data-sw-chat-connect-result="failed"]')
    await failed.waitFor()
    assert.match(await failed.textContent(), /did not start/)
    assert.match(await failed.textContent(), /Nothing was changed/)
    assert.equal(await page.locator('[data-sw-chat-input]').count(), 0)
    assert.ok(!fs.existsSync(settingsFile()) || !Object.keys(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).projects).length)
    // The failed handshake answers 200 with connected false, so nothing logs an error.
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('without the link: the chat and the console Agents page explain how to unlock', { skip: !POSIX }, async () => {
  const url = await board('stub')
  const { context, page, errors } = await openBoard(url, { viewport: { width: 1440, height: 900 } })
  try {
    await page.click('[data-sw-chat-toggle]')
    const hint = page.locator('[data-sw-settings-hint="connect"]')
    await hint.waitFor()
    assert.match(await hint.textContent(), /owner link printed by shapewall serve/)
    assert.equal(await page.locator('[data-sw-chat-detected]').count(), 0, 'what is installed stays behind the token')
    assert.equal(await page.locator('[data-sw-chat-files-setup]').getAttribute('open'), null)
    await shot(page, 'connect-desktop-locked')

    await page.click('[data-sw-profile-menu]')
    const item = page.locator('[data-sw-profile-item="console"]')
    await item.waitFor()
    assert.equal(await item.getAttribute('data-disabled'), null)
    await item.click()
    await page.locator('[data-sw-nav="agents"]').click()
    await page.waitForSelector('[data-sw-local-console-agent-details]')
    assert.match(await page.locator('[data-sw-settings-agent-unavailable]').textContent(), /owner link printed by shapewall serve/)
    await shot(page, 'connect-desktop-profile-locked')
    assert.deepEqual(errors, [])
    // The server refuses Connect from this tab (after the error check: the 404 logs one).
    const status = await page.evaluate(
      async () =>
        (
          await fetch('/api/agent/settings/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: 'claude' }),
          })
        ).status,
    )
    assert.equal(status, 404)
    assert.equal(fs.existsSync(settingsFile()), false)
  } finally {
    await context.close()
  }
})

test('phone 390: detected agents and Connect fit the sheet and work', { skip: !POSIX }, async () => {
  const url = await board('stub')
  const { context, page, errors } = await openBoard(withToken(url), {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  try {
    // On a phone the agent is in the More menu, and the chat is a sheet.
    await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
    await page.tap('[role="dialog"] [data-sw-chat-toggle]')
    const connect = page.locator('[role="dialog"] [data-sw-chat-connect-agent="claude"]')
    await connect.waitFor()
    const box = await connect.boundingBox()
    assert.ok(box.height >= 44, `Connect is a touch target (${box.height}px)`)
    assert.ok(box.x + box.width <= 390, 'Connect fits the screen')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await shot(page, 'connect-phone-detected')
    await connect.tap()
    await page.tap('[data-sw-settings-confirm]')
    await page.locator('[data-sw-chat-connected-note]').waitFor()
    await page.waitForSelector('[data-sw-chat-input]')
    await shot(page, 'connect-phone-connected')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

for (const width of [1440, 390])
  test(`native profile selector persists and chats at ${width}px`, { skip: !POSIX }, async () => {
    const url = await board('stub')
    // All three labels deliberately use the software ACP stub, never a real provider.
    saveUserAgentEntry(
      setup.config.dir,
      {
        backend: 'acp',
        acpCommand: 'claude-agent-acp',
        profiles: [
          { id: 'claude', label: 'Claude Code', acpCommand: 'claude-agent-acp' },
          { id: 'codex', label: 'Codex', acpCommand: 'claude-agent-acp' },
          { id: 'goose', label: 'goose', acpCommand: 'claude-agent-acp' },
        ],
      },
      { HOME: home, XDG_CONFIG_HOME: home },
    )
    const { context, page, errors } = await openBoard(withToken(url), { viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    try {
      if (width < 1024) {
        await page.locator('[data-sw-toolbar="compact"] [data-sw-menu]').click()
        await page.locator('[role="dialog"] [data-sw-chat-toggle]').click()
      } else await page.locator('[data-sw-chat-toggle]').click()
      const select = page.locator('[data-sw-agent-profile]')
      await select.click()
      await page.locator('[data-sw-agent-menu] [data-sw-agent-option="codex"]').click()
      // Said once, quietly: the new agent starts fresh and can read this chat.
      await page.locator('[data-sw-chat-notice]:has-text("Switched to Codex. It starts fresh and can read this chat.")').waitFor()
      await page.waitForFunction(() => document.querySelector('[data-sw-agent-profile]')?.textContent.trim() === 'Codex')
      const priorReplies = await page.locator('[data-sw-chat-message="assistant"]').count()
      await page.locator('[data-sw-chat-input]').fill('stream')
      await page.locator('[data-sw-chat-send]').click()
      await page.waitForFunction(
        (index) => document.querySelectorAll('[data-sw-chat-message="assistant"]')[index]?.dataset.status === 'done',
        priorReplies,
      )
      assert.equal(
        (await page.locator('[data-sw-chat-message="assistant"] [data-sw-markdown]').last().textContent()).trim(),
        'Hello from the stream.',
      )
      const selected = await page.evaluate(
        async (id) => (await fetch(`/api/agent/boards/${id}/threads/board`)).json(),
        setup.config.boards[0].id,
      )
      assert.equal(selected.profileId, 'codex')
      // The menu: arrow keys and type-ahead reach goose, Enter picks it.
      await select.focus()
      await page.keyboard.press('Enter')
      await page.locator('[data-sw-agent-menu]').waitFor()
      await page.keyboard.press('g')
      await page.waitForFunction(() => document.activeElement?.dataset.swAgentOption === 'goose')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('[data-sw-agent-profile]')?.textContent.trim() === 'goose')
      assert.equal(await page.locator('[data-sw-chat-message="assistant"]').count(), priorReplies + 1, 'switching keeps transcript')
      assert.equal(await page.locator('select').count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await shot(page, `native-profiles-${width}`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
