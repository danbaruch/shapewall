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
import { addReply, createComment } from '../../src/store.js'
import { solidPng } from '../comment-media-fixtures.js'
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

// A board whose chats start empty: the tests above leave a chat on an agent
// that this board has not connected.
async function freshBoard() {
  for (const item of setup.config.boards) fs.rmSync(path.join(setup.config.outputDir, item.id, 'chat'), { recursive: true, force: true })
  return board('stub')
}

// The name and icon of an agent (src/agent/identity.js), end to end: named
// in the Connect confirmation, renamed later on the Agents page without a
// restart, a built-in icon and an uploaded picture, and the name and icon
// in the chat header, on the Fix button and on the agent's reply.
test('desktop 1440: name an agent at Connect, rename it later, pick an icon and upload a picture', { skip: !POSIX }, async () => {
  const url = await freshBoard()
  const comment = await createComment(setup.config, setup.config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 30,
    y: 12,
    body: 'Identity check: tighten this heading',
    author: 'Robin Tester',
  })
  const { context, page, errors } = await openBoard(withToken(url), { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const savedProfile = () => Object.values(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).projects)[0].profiles[0]
  const pid = async () => {
    const before = await page.locator('[data-sw-chat-message="assistant"]').count()
    await page.fill('[data-sw-chat-input]', 'pid')
    await page.click('[data-sw-chat-send]')
    await page.waitForFunction(
      (index) => document.querySelectorAll('[data-sw-chat-message="assistant"]')[index]?.dataset.status === 'done',
      before,
    )
    return /pid (\d+)/.exec(await page.locator('[data-sw-chat-message="assistant"] [data-sw-markdown]').last().textContent())[1]
  }
  try {
    // ---- Name at connect time ----
    await page.click('[data-sw-chat-toggle]')
    await page.click('[data-sw-chat-connect-agent="claude"]')
    await page.locator('[data-sw-settings-confirm-list]').waitFor()
    const name = page.locator('[data-sw-connect-identity] [data-sw-agent-name-input]')
    assert.equal(await name.inputValue(), 'Claude Code', 'prefilled with the built-in name')
    assert.equal(await name.getAttribute('maxlength'), '40')
    // The icon is optional and folded away; a known agent starts with its product mark.
    assert.equal(await page.locator('[data-sw-connect-icon]').getAttribute('open'), null)
    assert.equal(
      await page.locator('[data-sw-connect-icon] summary [data-sw-agent-avatar]').getAttribute('data-sw-agent-avatar'),
      'logo:claude',
    )
    await shot(page, 'identity-connect-confirm')
    await name.fill('Harry')
    await page.click('[data-sw-connect-icon] summary')
    const options = page.locator('[data-sw-connect-icon] [data-sw-agent-icon-option]')
    assert.equal(await options.count(), 13, 'the default and twelve built-in icons')
    assert.equal(await page.locator('[data-sw-connect-icon] [data-sw-agent-icon-options]').getAttribute('role'), 'radiogroup')
    await page.locator('[data-sw-connect-icon] [data-sw-agent-icon-option="owl"]').click()
    await shot(page, 'identity-connect-icons')
    await page.click('[data-sw-settings-confirm]')
    const note = page.locator('[data-sw-chat-connected-note]')
    await note.waitFor()
    assert.match(await note.textContent(), /Connected to Harry\./)
    assert.deepEqual(savedProfile(), { id: 'claude', label: 'Harry', acpCommand: 'claude-agent-acp', icon: 'owl' })
    // The chat header: the name and the icon.
    const chip = page.locator('[data-sw-chat-label]').first()
    await page.waitForFunction(() => document.querySelector('[data-sw-chat-label]')?.getAttribute('data-sw-chat-label') === 'Harry')
    assert.equal(await chip.locator('[data-sw-agent-avatar]').getAttribute('data-sw-agent-avatar'), 'owl')
    const firstPid = await pid()
    // Its answers carry the icon too.
    assert.equal(
      await page.locator('[data-sw-chat-message="assistant"] [data-sw-agent-avatar]').last().getAttribute('data-sw-agent-avatar'),
      'owl',
    )
    await shot(page, 'identity-chat-header')

    // ---- Rename later, on the Agents page ----
    const settings = await context.newPage()
    settings.on('pageerror', (error) => errors.push(error.message))
    await settings.goto(`${url}console#settings-token=${TOKEN}`)
    await settings.locator('[data-sw-nav="agents"]').first().click()
    const row = settings.locator('[data-sw-agent-row="claude"]')
    await row.waitFor()
    assert.match(await row.textContent(), /Harry/)
    assert.equal(await row.locator('[data-sw-agent-avatar]').getAttribute('data-sw-agent-avatar'), 'owl')
    // The default-agent list shows it too.
    assert.equal(
      await settings.locator('[data-sw-agents-default-option="claude"] [data-sw-agent-avatar]').getAttribute('data-sw-agent-avatar'),
      'owl',
    )
    const edit = row.locator('[data-sw-agent-edit="claude"]')
    assert.equal(await edit.getAttribute('aria-label'), 'Edit Harry: name and icon')
    await edit.click()
    const dialog = settings.locator('[role="dialog"]')
    await dialog.locator('[data-sw-agent-identity="claude"]').waitFor()
    const input = dialog.locator('[data-sw-agent-name-input]')
    assert.equal(await input.inputValue(), 'Harry')
    // Focus is in the dialog, on the name, and stays inside it.
    assert.equal(await settings.evaluate(() => document.activeElement?.hasAttribute('data-sw-agent-name-input')), true)
    for (let i = 0; i < 40; i += 1) await settings.keyboard.press('Tab')
    assert.equal(await settings.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true, 'focus is trapped')
    // The picker is a radio group with a name for every choice.
    const radios = dialog.locator('[data-sw-agent-icon-options] input[type="radio"]')
    assert.equal(await radios.count(), 13)
    assert.equal(await dialog.locator('[data-sw-agent-icon-options] input[type="radio"]:checked').getAttribute('aria-label'), 'Owl')
    for (const label of await radios.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))) assert.ok(label, 'named')
    assert.equal(await dialog.locator('[data-sw-agent-icon-option="default"] input').getAttribute('aria-label'), 'Default: the Claude mark')
    await shot(settings, 'identity-edit-dialog')
    // Too long is said and cannot be saved (the field itself stops at 40).
    await input.fill('x'.repeat(60))
    assert.equal((await input.inputValue()).length, 40)
    // A built-in icon and a colour.
    await input.fill('Fixer')
    await dialog.locator('[data-sw-agent-icon-option="ghost"]').click()
    await dialog.locator('[data-sw-agent-tint-option="pink"]').click()
    assert.equal(await dialog.locator('[data-sw-agent-identity-preview]').getAttribute('data-sw-agent-avatar'), 'ghost')
    await dialog.locator('[data-sw-agent-identity-save]').click()
    await dialog.waitFor({ state: 'detached' })
    await settings.waitForFunction(() => document.querySelector('[data-sw-agent-row="claude"]')?.textContent.includes('Fixer'))
    assert.deepEqual(savedProfile(), { id: 'claude', label: 'Fixer', acpCommand: 'claude-agent-acp', icon: 'ghost', tint: 'pink' })
    assert.equal(await row.locator('[data-sw-agent-avatar]').getAttribute('data-sw-agent-avatar'), 'ghost')
    // Focus returns to the Edit button it was opened from.
    await settings.waitForFunction(() => document.activeElement?.getAttribute('data-sw-agent-edit') === 'claude')
    assert.equal(await row.locator('[data-sw-settings-test-result]').count(), 0, 'no connection test ran')

    // Reset to the default: the product mark again.
    await edit.click()
    await dialog.locator('[data-sw-agent-icon-option="default"]').click()
    assert.equal(await dialog.locator('[data-sw-agent-identity-preview]').getAttribute('data-sw-agent-avatar'), 'logo:claude')
    await dialog.locator('[data-sw-agent-identity-save]').click()
    await dialog.waitFor({ state: 'detached' })
    await settings.waitForFunction(
      () =>
        document.querySelector('[data-sw-agent-row="claude"] [data-sw-agent-avatar]')?.getAttribute('data-sw-agent-avatar') ===
        'logo:claude',
    )
    assert.equal(savedProfile().icon, undefined)

    // ---- Upload a picture ----
    await edit.click()
    // Not an image: said, nothing chosen.
    await dialog.locator('[data-sw-agent-icon-upload]').setInputFiles({
      name: 'icon.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    })
    assert.match(await dialog.locator('[data-sw-agent-icon-problem]').textContent(), /PNG, JPEG or WebP/)
    await dialog.locator('[data-sw-agent-icon-upload]').setInputFiles({
      name: 'big.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
    })
    assert.match(await dialog.locator('[data-sw-agent-icon-problem]').textContent(), /smaller than 2 MB/)
    // A wide picture: cropped to a square by the board.
    await dialog.locator('[data-sw-agent-icon-upload]').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: solidPng(600, 300, [20, 140, 90, 255]),
    })
    await dialog.locator('[data-sw-agent-icon-option="upload"]').waitFor()
    assert.equal(await dialog.locator('[data-sw-agent-identity-preview]').getAttribute('data-sw-agent-avatar'), 'upload')
    await dialog.locator('[data-sw-agent-identity-save]').click()
    await dialog.waitFor({ state: 'detached' })
    const icon = savedProfile().icon
    assert.match(icon, /^upload:[0-9a-f]{32}$/)
    const stored = path.join(home, 'shapewall', 'agent-icons', `${icon.slice(7)}.png`)
    assert.equal(fs.readFileSync(stored).readUInt32BE(16), 256, 'stored as the 256 px square the server encoded')
    const picture = row.locator('[data-sw-agent-avatar="upload"] img')
    await picture.waitFor()
    await settings.waitForFunction(
      () => document.querySelector('[data-sw-agent-row="claude"] [data-sw-agent-avatar="upload"] img')?.naturalWidth === 256,
    )
    await shot(settings, 'identity-agents-page')

    // ---- The board follows, and the agent was never restarted ----
    await page.bringToFront()
    await page.waitForFunction(() => document.querySelector('[data-sw-chat-label]')?.getAttribute('data-sw-chat-label') === 'Fixer')
    await chip.locator('[data-sw-agent-avatar="upload"] img').waitFor()
    assert.equal(await pid(), firstPid, 'the same agent process answers after two renames and three icons')
    // The Fix button names it.
    await page.click('[data-sw-chat-close]')
    const item = page.locator(`[data-sw-comment="${comment.id}"]`).first()
    if (!(await item.count())) await page.click('[data-sw-panel-toggle]')
    await item.click()
    const fix = page.locator(`[data-sw-fix-agent="${comment.id}"]`)
    await fix.waitFor()
    assert.match(await fix.textContent(), /Fix with Fixer/)
    // The agent's reply on the thread (what the owner MCP server writes for it,
    // test/agent-identity.test.js): its name, marked as an agent, with its icon.
    await addReply(setup.config, setup.config.boards[0].id, comment.id, { body: 'Tightened the heading.', author: 'Fixer', agent: true })
    await addReply(setup.config, setup.config.boards[0].id, comment.id, { body: 'An older note.', author: 'agent' })
    await page.reload()
    await page.waitForSelector('[data-sw-node="home"]')
    const again = page.locator(`[data-sw-comment="${comment.id}"]`).first()
    if (!(await again.count())) await page.click('[data-sw-panel-toggle]')
    await again.click()
    const replies = page.locator(`[data-sw-thread="${comment.id}"] [data-sw-reply]`)
    await replies.nth(1).waitFor()
    assert.equal((await replies.nth(0).locator('[data-sw-author]').textContent()).trim(), 'Fixer')
    assert.equal(await replies.nth(0).locator('[data-sw-author]').getAttribute('data-sw-author'), 'agent')
    await replies.nth(0).locator('[data-sw-agent-avatar="upload"] img').waitFor()
    // A reply signed "agent" (an older one, or another tool's) keeps the robot.
    assert.equal(await replies.nth(1).locator('[data-sw-agent-avatar]').count(), 0)
    await shot(page, 'identity-thread-reply')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('phone 390: the Connect name field and the icon picker are touch sized and fit', { skip: !POSIX }, async () => {
  const url = await freshBoard()
  const { context, page, errors } = await openBoard(withToken(url), {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  try {
    await page.tap('[data-sw-toolbar="compact"] [data-sw-menu]')
    await page.tap('[role="dialog"] [data-sw-chat-toggle]')
    await page.locator('[role="dialog"] [data-sw-chat-connect-agent="claude"]').tap()
    const name = page.locator('[data-sw-connect-identity] [data-sw-agent-name-input]')
    await name.waitFor()
    assert.ok((await name.boundingBox()).height >= 44, 'the name field is a touch target')
    await page.locator('[data-sw-connect-icon] summary').tap()
    for (const box of await page
      .locator('[data-sw-connect-icon] [data-sw-agent-icon-option]')
      .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
      assert.ok(box.width >= 44 && box.height >= 44, `an icon choice is a touch target (${box.width}x${box.height})`)
      assert.ok(box.right <= 390, 'it fits the screen')
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.locator('[data-sw-connect-icon] [data-sw-agent-icon-option="bear"]').tap()
    await shot(page, 'identity-connect-phone-dark')
    await name.fill('Pocket')
    await page.tap('[data-sw-settings-confirm]')
    await page.locator('[data-sw-chat-connected-note]:has-text("Connected to Pocket.")').waitFor()
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
