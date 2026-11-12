// End to end, hosted: a real browser with a virtual passkey authenticator
// signs up through the setup link, saves recovery codes, makes a project and
// a token in the console, `shapewall push` uploads a real capture of the demo
// site, and the board (the same client as local) shows it: live HTML through
// the signed path, an element-anchored comment, then sign-out and passkey
// sign-in. Then `shapewall login` approved with a passkey check, one board
// removed in the console, and the admin loop: invite -> accept on a phone -> role change ->
// share link with a passcode -> a guest comments -> revoke. Desktop and phone
// widths, light and dark; no console errors.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../../src/config.js'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { remoteSource } from '../../src/agent/starter/source.js'
import { starterSettings } from '../../src/agent/starter/settings.js'
import { runStarter } from '../../src/agent/starter/supervisor.js'
import { startStarterStub } from '../fixtures/starter-model-stub.mjs'
import { hostedStarterRuntime } from '../fixtures/hosted-starter-runtime.mjs'
import { sampleConfig, tempDir } from '../helpers.js'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { runCapture } from '../../src/capture/capture.js'
import { main } from '../../src/cli.js'
import { startHostedServer, tokenCall, writeLocalCaptures } from '../hosted-helpers.js'
import { ROOT_DIR, demoSetup, liveElementBox } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
let setup
let hosted
let browser
// The owner's browser, kept across tests.
let owner
let workspaceId
let pushToken

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the hosted e2e test')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the hosted e2e test')
  setup = await demoSetup('hosted-e2e')
  await runCapture({ config: setup.config, log: () => {} })
  hosted = await startHostedServer('hosted-e2e', { clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await owner?.context.close()
  await browser?.close()
  await hosted?.close()
  await setup?.close()
})

const shot = async (page, name) =>
  SHOTS && page.screenshot({ path: path.join(SHOTS, `hosted-${name}.png`), fullPage: true, animations: 'disabled' })

async function open({ width = 1440, height = 900, dark = false, phone = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: dark ? 'dark' : 'light',
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  // Off: the authenticator waits (as a person would before picking a
  // passkey); on: it answers every request at once.
  const presence = (enabled) => cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled })
  return { context, page, errors, presence }
}

async function signUp(page, handle, name, { tap = false } = {}) {
  const press = (selector) => (tap ? page.tap(selector) : page.click(selector))
  await page.waitForSelector('[data-sw-signup-handle]')
  await page.fill('[data-sw-signup-handle]', handle)
  await page.fill('[data-sw-signup-name]', name)
  await press('[data-sw-signup-submit]')
  await page.waitForSelector('[data-sw-recovery-codes]')
  assert.equal(await page.locator('[data-sw-recovery-code-item]').count(), 10)
  // Continue stays off until the codes are marked saved.
  assert.equal(await page.isDisabled('[data-sw-codes-done]'), true)
  await press('#saved')
  await press('[data-sw-codes-done]')
}

// Layout checks for a console page at phone width.
async function phoneChecks(page, label) {
  // Right after a resize, wait for the phone layout (the desktop sidebar gone).
  await page.waitForFunction(() => !document.querySelector('[data-sw-app-rail]'))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no sideways scroll`)
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('main button, main a[href], main [role="tab"]')]
      .filter((el) => el.offsetParent !== null && !el.closest('p'))
      .filter((el) => el.getBoundingClientRect().height < 44)
      .map((el) => el.textContent.trim().slice(0, 30)),
  )
  assert.deepEqual(small, [], `${label}: touch targets under 44 px`)
  assert.doesNotMatch(await page.textContent('main'), /\bnull\b|\bundefined\b|NaN/)
}

test('sign up with a passkey, push, comment on the hosted board, sign in again', async () => {
  owner = await open()
  const { page, errors, presence } = owner
  const link = new URL(hosted.app.locals.setupLink())
  await page.goto(`${hosted.origin}${link.pathname}${link.hash}`)
  await signUp(page, 'robin', 'Robin Reviewer')
  await page.waitForSelector('[data-sw-new-project]')
  workspaceId = /\/w\/(ws_[a-f0-9]{24})/.exec(page.url())[1]
  await shot(page, '1-workspace')

  // A project, then a push token from the project page.
  await page.click('[data-sw-new-project]')
  await page.fill('[data-sw-project-name]', 'Demo site')
  await page.click('[data-sw-project-create]')
  await page.waitForSelector('[data-sw-project-shares]')
  await page.click('[data-sw-project-new-token]')
  await page.fill('[data-sw-token-name]', 'CI')
  await page.click('[data-sw-scope="push"]')
  await page.click('[data-sw-token-create]')
  await page.waitForSelector('[data-sw-copy-value="token"]')
  pushToken = (await page.textContent('[data-sw-copy-value="token"]')).trim()
  assert.match(pushToken, /^swp_[A-Za-z0-9_-]{43}$/)
  await shot(page, '2-token')
  await page.click('[data-sw-token-done]')

  // Rename the token: what a watcher using it is called on the board. The
  // token itself stays the same (the push below still uses it).
  await page.click('[data-sw-rename-token="CI"]')
  const renameInput = page.locator('[data-sw-rename-token-input]')
  await renameInput.waitFor()
  assert.equal(await renameInput.inputValue(), 'CI')
  assert.equal(await page.locator('[data-sw-rename-token-save]').isDisabled(), true, 'nothing to save until the name changes')
  await renameInput.fill('Harry the watcher')
  await shot(page, '2b-token-rename')
  await page.click('[data-sw-rename-token-save]')
  await page.waitForSelector('[data-sw-token="Harry the watcher"]')
  assert.equal(await page.locator('[data-sw-token="CI"]').count(), 0)
  assert.equal(
    hosted.db.prepare('SELECT name FROM api_tokens').get().name,
    'Harry the watcher',
    'saved on the server, the one token of this project',
  )

  // shapewall push, as a person would run it.
  const lines = []
  process.env.SHAPEWALL_TOKEN = pushToken
  try {
    assert.equal(
      await main(['push', '--remote', hosted.origin, '--config', setup.config.file], {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      }),
      0,
    )
  } finally {
    delete process.env.SHAPEWALL_TOKEN
  }
  const boardUrl = lines.join('\n').match(/Board: (\S+)/)[1]

  // The hosted board: the same client, with live HTML through /uc/.
  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-sw-frame] img')]
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
  })
  await shot(page, '3-board')
  const frame = '[data-sw-frame="pricing:desktop"]'
  await page.click(frame)
  await page.click('[data-sw-open-live="pricing|desktop"]')
  await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 15000 })
  // An opaque origin: the board cannot read the frame; pins come from the pushed element map.
  assert.equal(await page.getAttribute(`${frame} iframe`, 'sandbox'), '')
  assert.equal(await page.getAttribute(frame, 'data-sw-live-anchors'), 'map')
  assert.equal(await page.evaluate((selector) => document.querySelector(`${selector} iframe`).contentDocument, frame), null)
  const loaded = page.frames().find((item) => item.url().includes('/uc/'))
  assert.match(new URL(loaded.url()).pathname, /^\/uc\/ws_[a-f0-9]{24}\/pr_[a-f0-9]{24}\/demo\/captures\/pricing\.desktop\.html$/)

  // An element-anchored comment, signed with the account name.
  await page.click('[data-sw-comment-mode]')
  const point = await liveElementBox(page, frame, 'a[data-testid="plus-cta"]')
  await page.mouse.click(point.x, point.y)
  await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
  assert.equal(await page.locator('[data-sw-composer] >> text=As Robin Reviewer').count(), 1)
  assert.equal(await page.locator('[data-sw-comment-author]').count(), 0, 'no name field when signed in')
  await page.fill('[data-sw-comment-input]', 'Make the Plus button stand out @agent')
  await page.click('[data-sw-save-comment]')
  await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
  const report = await tokenCall(hosted, pushToken, 'GET', '/api/v1/boards/demo/comments')
  assert.equal(report.json.count, 1)
  const comment = report.json.comments[0]
  assert.equal(comment.author, 'Robin Reviewer')
  assert.match(comment.element.selector, /plus-cta/)
  assert.deepEqual(comment.mentions, ['agent'])
  await page.waitForSelector(`[data-sw-pin="${comment.id}"][data-sw-pin-anchor="element"]`)
  await shot(page, '4-comment')

  // Sign out, then back in with the passkey button (no username typed).
  // The autofill request waits in the background; the button replaces it.
  await page.goto(`${hosted.origin}/account`)
  await page.waitForSelector('[data-sw-sessions] [data-sw-session="current"]')
  await presence(false)
  const initialOptions = page.waitForResponse('**/auth/login/options')
  await page.click('[data-sw-signout]')
  await page.waitForURL(/\/signin/)
  await initialOptions
  let delayedAutofill = false
  await page.route('**/auth/login/options', async (route) => {
    if (!delayedAutofill) {
      delayedAutofill = true
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    await route.continue()
  })
  await page.goto(boardUrl)
  await page.waitForURL(/\/signin/)
  await page.waitForSelector('[data-sw-signin-autofill]')
  assert.equal(await page.getAttribute('[data-sw-signin-autofill]', 'autocomplete'), 'username webauthn')
  await presence(true)
  await page.click('[data-sw-passkey-signin]')
  await page.waitForSelector('[data-sw-node="home"]')
  assert.equal(new URL(page.url()).pathname, new URL(boardUrl).pathname)

  await page.unroute('**/auth/login/options')

  // Autofill: a passkey picked from the handle field signs in by itself
  // (the virtual authenticator picks at once).
  await page.goto(`${hosted.origin}/account`)
  await page.waitForSelector('[data-sw-signout]')
  await page.click('[data-sw-signout]')
  await page.waitForURL(/\/signin/)
  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  assert.equal(new URL(page.url()).pathname, new URL(boardUrl).pathname)
  assert.deepEqual(errors, [])
})

// A `shapewall login` waiting for approval, as the terminal starts one.
async function startDeviceLogin() {
  hosted.rateLimiter.reset()
  const response = await fetch(`${hosted.origin}/api/v1/device/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fixture laptop' }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

// The owner's sign-in as it is ten minutes on: sensitive actions ask for the passkey again.
const staleSignIn = () => hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date(Date.now() - 30 * 60_000).toISOString())

test('sign in a terminal: Approve with a sign-in that is not fresh asks for the passkey, says so when that is closed, and shows a refusal', async () => {
  const { page, errors } = owner
  // The 403s below are the point of this test; the browser logs each one.
  const expected = (text) => /status of 40[34]/.test(text)
  const login = await startDeviceLogin()
  staleSignIn()
  await page.goto(`${hosted.origin}/device`)
  await page.fill('[data-sw-device-code]', login.userCode)
  await page.click('[data-sw-device-lookup]')
  await page.waitForSelector('[data-sw-device-approve]')

  // Approve answers 403 reauth_required: the passkey dialog opens.
  const refused = page.waitForResponse((response) => response.url().endsWith('/api/device/approve') && response.status() === 403)
  await page.click('[data-sw-device-approve]')
  await refused
  await page.waitForSelector('[data-sw-reauth]')
  await shot(page, 'device-1-passkey')
  // Closed without confirming: the page says why nothing was approved.
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await page.waitForSelector('[data-sw-reauth]', { state: 'detached' })
  await page.waitForSelector('[data-sw-device-reauth-note]')
  assert.match(await page.textContent('[data-sw-device-reauth-note]'), /Not approved yet.*passkey/)
  assert.equal(await page.locator('[data-sw-device-done]').count(), 0)
  assert.equal(await page.isEnabled('[data-sw-device-approve]'), true)
  await shot(page, 'device-2-not-approved')

  // Again, with the passkey: approved, and the terminal gets its token.
  await page.click('[data-sw-device-approve]')
  await page.click('[data-sw-reauth]')
  await page.waitForSelector('[data-sw-device-done="approved"]')
  const polled = await fetch(`${hosted.origin}/api/v1/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceCode: login.deviceCode }),
  })
  assert.equal((await polled.json()).status, 'approved')

  // Any other refusal shows its message: here the code was used up
  // elsewhere between Continue and Approve.
  const second = await startDeviceLogin()
  await page.goto(`${hosted.origin}/device`)
  await page.fill('[data-sw-device-code]', second.userCode)
  await page.click('[data-sw-device-lookup]')
  await page.waitForSelector('[data-sw-device-approve]')
  assert.equal(hosted.app.locals.deviceLogins.deny(second.userCode.replace('-', '')), true)
  await page.click('[data-sw-device-approve]')
  await page.waitForSelector('[data-sw-device] [data-sw-error]')
  assert.match(await page.textContent('[data-sw-device] [data-sw-error]'), /code is not right, or it expired|already used/)
  assert.equal(await page.locator('[data-sw-device-reauth-note]').count(), 0)
  assert.deepEqual(
    errors.filter((text) => !expected(text)),
    [],
  )
  errors.length = 0
})

test('remove one board in the console: its captures and comments go, the other board and its comments stay', async () => {
  const { page, errors } = owner
  const projectId = hosted.db.prepare("SELECT id FROM projects WHERE name = 'Demo site'").get().id
  // A second board pushed by mistake, with a comment on it.
  const config = sampleConfig('hosted-e2e-extra', { id: 'mistake', title: 'Pushed by mistake' })
  writeLocalCaptures(config, 'mistake')
  const remote = createRemote({ origin: hosted.origin, token: pushToken })
  const started = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'mistake', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
  const boardApi = `${hosted.origin}/w/${workspaceId}/p/${projectId}/api`
  const posted = await page.request.post(`${boardApi}/boards/mistake/comments`, {
    data: { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body: 'On the board that goes' },
    headers: { Origin: hosted.origin },
  })
  assert.equal(posted.status(), 201)
  const kept = hosted.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE project_id = ? AND board_id = 'demo'").get(projectId).n
  assert.ok(kept > 0, 'the demo board has comments from the tests before')
  const folder = (board) => path.join(hosted.dataDir, 'files', workspaceId, projectId, board)
  assert.ok(fs.existsSync(folder('mistake')))

  // A board with no journeys has no Pages / Journeys tabs in the sidebar: still one search field, not two.
  await page.goto(`${hosted.origin}/w/${workspaceId}/p/${projectId}/?board=mistake`)
  await page.waitForSelector('[data-sw-node="home"]')
  const wasCollapsed = !(await page.locator('[data-sw-app-rail] [data-sw-pages-sidebar]').count())
  if (wasCollapsed) await page.click('[data-sw-sidebar-toggle]')
  await page.waitForSelector('[data-sw-app-rail] [data-sw-pages-sidebar]')
  assert.match(await page.textContent('[data-sw-app-rail] button[data-sw-palette-trigger]'), /Search the board/)
  assert.equal(await page.locator('[data-sw-app-rail] [data-sw-sidebar-tab]').count(), 0, 'no tabs on a board without journeys')
  assert.equal(await page.locator('[data-sw-app-rail] [data-sw-pages-filter]').count(), 0, 'no second search box')
  assert.equal(await page.locator('[data-sw-app-rail] input').count(), 0)
  await shot(page, 'sidebar-no-journeys')
  if (wasCollapsed) await page.click('[data-sw-sidebar-toggle]')

  await page.goto(`${hosted.origin}/w/${workspaceId}/projects/${projectId}`)
  await page.waitForSelector('[data-sw-project-board="mistake"]')
  assert.equal(await page.locator('[data-sw-project-board]').count(), 2)
  // The dialog names the board and says what goes.
  staleSignIn()
  await page.click('[data-sw-remove-board="mistake"]')
  await page.waitForSelector('[data-sw-remove-board-note]')
  assert.match(await page.textContent('[role="dialog"]'), /Remove the board mistake\?/)
  assert.match(
    await page.textContent('[data-sw-remove-board-note]'),
    /captures, the page history and every comment of mistake on this server/,
  )
  assert.match(await page.textContent('[data-sw-remove-board-note]'), /brings its captures back, but not the comments/)
  await shot(page, 'board-remove-1-confirm')
  // The sign-in is not fresh: the passkey first, then it is removed.
  await page.click('[data-sw-confirm]')
  await page.click('[data-sw-reauth]')
  await page.waitForSelector('[data-sw-project-board="mistake"]', { state: 'detached' })
  await page.waitForSelector('[data-sw-project-board="demo"]')
  assert.equal(await page.locator('[data-sw-project-board]').count(), 1)
  await shot(page, 'board-remove-2-done')

  assert.equal(fs.existsSync(folder('mistake')), false)
  assert.ok(fs.existsSync(path.join(folder('demo'), 'captures', 'manifest.json')))
  assert.equal(hosted.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE project_id = ? AND board_id = 'mistake'").get(projectId).n, 0)
  assert.equal(hosted.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE project_id = ? AND board_id = 'demo'").get(projectId).n, kept)
  // The removed board's address answers not found; the other board opens with its pins.
  assert.equal((await page.request.get(`${boardApi}/boards/mistake`)).status(), 404)
  assert.equal((await page.request.get(`${boardApi}/boards/demo`)).status(), 200)
  await page.goto(`${hosted.origin}/w/${workspaceId}/p/${projectId}/?board=demo`)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForSelector('[data-sw-pin]')
  // The audit page says it in words.
  await page.goto(`${hosted.origin}/w/${workspaceId}/audit`)
  await page.waitForSelector('text=removed the board mistake from Demo site')
  assert.deepEqual(
    errors.filter((text) => !/status of 40[34]/.test(text)),
    [],
  )
  errors.length = 0
})

test('hosted board: the Agent control opens a panel that lists the agents and says which are online', async () => {
  const { page, errors } = owner
  const projectId = hosted.db.prepare("SELECT id FROM projects WHERE name = 'Demo site'").get().id
  await page.goto(`${hosted.origin}/w/${workspaceId}/p/${projectId}/?board=demo`)
  await page.waitForSelector('[data-sw-node="home"]')
  // A sibling of Comments and Checks, for someone who can send comments to the agent.
  const agent = '[data-sw-toolbar="full"] [data-sw-panel-switch] [data-sw-chat-toggle]'
  await page.waitForSelector(agent)
  assert.equal(await page.getAttribute(agent, 'aria-pressed'), 'false')
  assert.match(await page.getAttribute(agent, 'aria-label'), /No agent is connected/)
  await page.click(agent)
  await page.waitForSelector('[data-sw-rail="agent"] [data-sw-hosted-agent]')
  assert.equal(await page.getAttribute(agent, 'aria-pressed'), 'true')
  assert.equal(new URL(page.url()).searchParams.get('ha'), '1')
  const listening = '[data-sw-hosted-agent-listening]'
  assert.equal(await page.getAttribute(listening, 'data-sw-hosted-agent-listening'), 'none')
  const said = await page.textContent(listening)
  assert.match(said, /No agent is connected to this project/)
  assert.ok(said.includes(`shapewall watch --remote ${hosted.origin}`), 'how to connect one')
  assert.equal(
    await page.getAttribute('[data-sw-hosted-agent-docs]', 'href'),
    'https://shapewall.com/docs/where-to-run#where-the-work-happens',
  )
  // No chat on a hosted board.
  assert.equal(await page.locator('[data-sw-chat], [data-sw-chat-input]').count(), 0)
  await shot(page, 'hosted-agent-1-none')

  // A machine starts listening: a token that may take work calls the token API.
  hosted.db.prepare('UPDATE sessions SET verified_at = ?').run(new Date().toISOString())
  const made = await page.request.post(`${hosted.origin}/api/workspaces/${workspaceId}/projects/${projectId}/tokens`, {
    data: { name: 'Build box', scopes: ['read', 'reply', 'status', 'claim'] },
    headers: { Origin: hosted.origin },
  })
  assert.equal(made.status(), 201)
  const called = await tokenCall(hosted, (await made.json()).token, 'GET', '/api/v1/project')
  assert.equal(called.status, 200)
  await page.reload()
  await page.waitForSelector('[data-sw-hosted-agent-listening="online"]')
  // Each agent by name, with its state (the full flows: hosted-agents.e2e.test.js).
  const row = '[data-sw-hosted-agent-row][data-sw-hosted-agent-name="Build box"]'
  assert.equal(await page.getAttribute(row, 'data-sw-agent-state'), 'online')
  assert.match(await page.textContent(row), /Build box\s*Online/)
  assert.match(await page.getAttribute(agent, 'aria-label'), /Build box online/)
  assert.doesNotMatch(await page.textContent('[data-sw-hosted-agent]'), /swp_|tk_/)
  await shot(page, 'hosted-agent-2-online')
  // The same button closes it; Comments takes its place again.
  await page.click(agent)
  await page.waitForSelector('[data-sw-rail="comments"]')
  assert.equal(new URL(page.url()).searchParams.get('ha'), null)
  assert.deepEqual(errors, [])
})

test('admin loop: invite, accept on a phone, change the role, share a link, guest comments, revoke', async () => {
  const { page, errors } = owner

  // Invite a member for 14 days; the link is copied and listed as pending.
  await page.goto(`${hosted.origin}/w/${workspaceId}/invites`)
  await page.click('[data-sw-new-invite]')
  await page.click('[data-sw-invite-role]')
  await page.click('[role="option"][data-sw-option="member"]')
  await page.click('[data-sw-invite-expiry]')
  await page.click('[role="option"][data-sw-option="14"]')
  await page.click('[data-sw-invite-create]')
  await page.waitForSelector('[data-sw-copy-value="invite"]')
  const inviteUrl = (await page.textContent('[data-sw-copy-value="invite"]')).trim()
  assert.match(inviteUrl, /\/invite#[A-Za-z0-9_-]{43}$/)
  await page.click('[data-sw-invite-done]')
  await page.waitForSelector('[data-sw-pending-invites] [data-sw-invite]')
  await shot(page, '5-invites')

  // Sam accepts on a phone in dark mode.
  const sam = await open({ width: 390, height: 844, dark: true, phone: true })
  try {
    await sam.page.goto(inviteUrl)
    await sam.page.waitForSelector('[data-sw-invite-title]')
    assert.match(await sam.page.textContent('[data-sw-invite-title]'), /Robin Reviewer's workspace/)
    await sam.page.tap('[data-sw-invite-signup]')
    await signUp(sam.page, 'sam', 'Sam', { tap: true })
    await sam.page.waitForSelector('[data-sw-project="Demo site"]')
    await phoneChecks(sam.page, 'member projects')
    // A member sees no admin sections.
    const nav = await sam.page.$$eval('[data-sw-nav]', (els) => els.map((el) => el.getAttribute('data-sw-nav')))
    assert.ok(!nav.includes('tokens') && !nav.includes('audit') && !nav.includes('invites'), nav.join(','))
    await shot(sam.page, '6-phone-member')
    await sam.page.tap('[data-sw-open-board="Demo site"]')
    await sam.page.waitForSelector('[data-sw-node="home"]')
    await shot(sam.page, '7-phone-board')
    assert.deepEqual(sam.errors, [])
  } finally {
    await sam.context.close()
  }

  // The invite is used now.
  await page.reload()
  await page.click('[data-sw-tab="history"]')
  await page.waitForSelector('[data-sw-invite-history] [data-sw-invite-status="used"]:has-text("@sam")')

  // Make Sam an admin, behind a confirm dialog.
  await page.goto(`${hosted.origin}/w/${workspaceId}/members`)
  await page.click('[data-sw-role-select="sam"]')
  await page.click('[role="option"][data-sw-option="admin"]')
  await page.waitForSelector('[data-sw-confirm]')
  await shot(page, '8-role-confirm')
  await page.click('[data-sw-confirm]')
  // Making an admin needs a recent passkey check; confirm if the console asks.
  await page
    .locator('[data-sw-reauth]')
    .click({ timeout: 1500 })
    .catch(() => {})
  await page.waitForSelector('[data-sw-role-select="sam"]:has-text("Admin")')
  assert.equal(
    hosted.db.prepare("SELECT role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.handle = 'sam'").get().role,
    'admin',
  )

  // Share links are off until an admin turns them on.
  await page.goto(`${hosted.origin}/w/${workspaceId}`)
  await page.click('[data-sw-manage-project="Demo site"]')
  await page.waitForSelector('[data-sw-project-shares]')
  assert.equal(await page.locator('[data-sw-new-share]').count(), 0)
  await page.goto(`${hosted.origin}/w/${workspaceId}/settings`)
  await page.click('[data-sw-settings-shares] [data-sw-switch="off"]')
  await page.waitForSelector('[data-sw-settings-shares] [data-sw-switch="on"]')

  // A comment link with a passcode.
  await page.goto(`${hosted.origin}/w/${workspaceId}`)
  await page.click('[data-sw-manage-project="Demo site"]')
  await page.click('[data-sw-new-share]')
  await page.fill('[data-sw-share-label]', 'Agency')
  await page.click('[data-sw-option="comment"]')
  await page.fill('[data-sw-share-passcode-input]', 'blue-door')
  await page.click('[data-sw-share-create]')
  await page.waitForSelector('[data-sw-copy-value="share"]')
  const shareUrl = (await page.textContent('[data-sw-copy-value="share"]')).trim()
  assert.match(shareUrl, /\/share#[A-Za-z0-9_-]{43}$/)
  await page.click('[data-sw-share-done]')
  await page.waitForSelector('[data-sw-share="Agency"]')
  await shot(page, '9-project-shares')

  // The guest: no account, a passcode and a name, then the board.
  const guest = await open({ dark: true })
  try {
    await guest.page.goto(shareUrl)
    await guest.page.waitForSelector('[data-sw-share-passcode]')
    // Before the passcode, the landing page names no project or workspace.
    assert.doesNotMatch(await guest.page.textContent('main'), /Demo site|Robin/)
    await guest.page.fill('[data-sw-share-passcode]', 'wrong-one')
    await guest.page.fill('[data-sw-share-name]', 'Gia')
    await guest.page.click('[data-sw-share-open]')
    await guest.page.waitForSelector('[data-sw-error]')
    await guest.page.fill('[data-sw-share-passcode]', 'blue-door')
    await guest.page.click('[data-sw-share-open]')
    await guest.page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
    await shot(guest.page, '10-guest-board')
    const info = await guest.page.evaluate(async () => (await fetch('api/info')).json())
    assert.equal(info.user.name, 'Gia (guest)')
    assert.equal(info.guest, true)
    const made = await guest.page.evaluate(async () => {
      const response = await fetch('api/boards/demo/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: 'home', viewport: 'desktop', x: 40, y: 40, body: 'Bigger CTA please @agent' }),
      })
      return { status: response.status, json: await response.json() }
    })
    assert.equal(made.status, 201)
    assert.deepEqual(made.json.comment.mentions, [], 'guest mentions never wake an agent')
    const resolve = await guest.page.evaluate(
      async (id) =>
        (
          await fetch(`api/boards/demo/comments/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: '{"status":"resolved"}',
          })
        ).status,
      made.json.comment.id,
    )
    assert.equal(resolve, 403)
    // The board shows the guest the comment with Reply, never Resolve or Delete.
    const commentId = made.json.comment.id
    await guest.page.goto(`${new URL(guest.page.url()).origin}${new URL(guest.page.url()).pathname}?c=${commentId}`)
    await guest.page.waitForSelector(`[data-sw-selected-comment="${commentId}"]`)
    assert.equal(await guest.page.locator(`[data-sw-resolve="${commentId}"]`).count(), 0)
    assert.equal(await guest.page.locator(`[aria-label="Delete comment ${commentId}"]`).count(), 0)
    assert.equal(await guest.page.locator(`[data-sw-edit="${commentId}"]`).count(), 0)
    // Guests see reactions but cannot add one; the more menu has no edit or delete.
    assert.equal(await guest.page.locator(`[data-sw-selected-comment="${commentId}"] [data-sw-reaction-add]`).count(), 0)
    assert.equal(await guest.page.locator(`[data-sw-selected-comment="${commentId}"] [data-sw-reply-form]`).count(), 1)
    if (await guest.page.locator(`[data-sw-thread-menu="${commentId}"]`).count()) {
      await guest.page.click(`[data-sw-thread-menu="${commentId}"]`)
      await guest.page.waitForSelector('[role="menu"]')
      assert.equal(await guest.page.locator(`[role="menu"] [data-sw-edit], [role="menu"] [data-sw-delete]`).count(), 0)
      await guest.page.keyboard.press('Escape')
      await guest.page.waitForSelector('[role="menu"]', { state: 'detached' })
    }
    await shot(guest.page, '10b-guest-comment')
    // Agents do not get it unless they ask for guest comments.
    const plain = await tokenCall(hosted, pushToken, 'GET', '/api/v1/boards/demo/comments')
    assert.ok(!plain.json.comments.some((item) => item.id === commentId))
    const report = await tokenCall(hosted, pushToken, 'GET', '/api/v1/boards/demo/comments?guests=1')
    const fromGuest = report.json.comments.find((item) => item.id === commentId)
    assert.equal(fromGuest.author, 'Gia (guest)')
    assert.equal(fromGuest.authorGuest, true)

    // Access shows the link against the project.
    await page.goto(`${hosted.origin}/w/${workspaceId}/access`)
    await page.waitForSelector('[data-sw-access-matrix]')
    assert.match(await page.textContent('[data-sw-access-matrix]'), /Agency/)
    await shot(page, '11-access')

    // Reopening uses the path-scoped guest cookie and ends the old visit.
    const shareId = new URL(guest.page.url()).pathname.split('/')[2]
    const reopen = async () => {
      await guest.page.goto(shareUrl)
      await guest.page.waitForSelector('[data-sw-share-passcode]')
      await guest.page.fill('[data-sw-share-passcode]', 'blue-door')
      await guest.page.fill('[data-sw-share-name]', 'Gia')
      await guest.page.click('[data-sw-share-open]')
      await guest.page.waitForSelector('[data-sw-node="home"]')
    }
    await reopen()
    const visits = hosted.db.prepare('SELECT ended_at FROM guest_sessions WHERE share_id = ?').all(shareId)
    assert.equal(visits.length, 2)
    assert.equal(visits.filter((visit) => !visit.ended_at).length, 1, 'the browser sends its scoped cookie on reopen')

    // End one guest through the real admin dialog; the share link remains live.
    await page.goto(`${hosted.origin}/w/${workspaceId}`)
    await page.click('[data-sw-manage-project="Demo site"]')
    await page.click('[data-sw-share-guests="Agency"]')
    await page.waitForSelector('[data-sw-guest="Gia"][data-sw-guest-status="active"]')
    await shot(page, '11b-guests')
    await page.click('[data-sw-end-guest="Gia"]')
    await page.waitForSelector('[data-sw-guest="Gia"][data-sw-guest-status="ended"]')
    assert.equal(await guest.page.evaluate(async () => (await fetch('api/info')).status), 401)
    await page.keyboard.press('Escape')
    await reopen()

    // Revoke: the guest is out at once.
    await page.goto(`${hosted.origin}/w/${workspaceId}`)
    await page.click('[data-sw-manage-project="Demo site"]')
    await page.click('[data-sw-revoke-share="Agency"]')
    await page.click('[data-sw-confirm]')
    await page.waitForSelector('[data-sw-share="Agency"]:has-text("Revoked")')
    const status = await guest.page.evaluate(async () => (await fetch('api/info')).status)
    assert.equal(status, 401)
    await guest.page.reload()
    await guest.page.waitForURL(/\/share/)
    await guest.page.waitForSelector('text=Your visit ended')
    await shot(guest.page, '12-guest-ended')
    // The 403 (resolve) and 401s (after revoking) are the test's own probes.
    assert.deepEqual(
      guest.errors.filter((text) => !/40[13]/.test(text)),
      [],
    )
  } finally {
    await guest.context.close()
  }

  // The audit log has all of it; filter by the guest.
  await page.goto(`${hosted.origin}/w/${workspaceId}/audit`)
  await page.waitForSelector('[data-sw-audit-list]')
  for (const action of [
    'invite_created',
    'invite_accepted',
    'member_role_changed',
    'share_links_enabled',
    'share_created',
    'guest_commented',
    'share_opened',
    'share_revoked',
  ]) {
    assert.equal((await page.locator(`[data-sw-audit-entry="${action}"]`).count()) > 0, true, action)
  }
  await page.click('[data-sw-audit-actor]')
  await page.click('[role="option"]:has-text("Agency")')
  await page.waitForSelector('[data-sw-audit-entry="share_opened"]')
  assert.equal(await page.locator('[data-sw-audit-entry="member_role_changed"]').count(), 0)
  await shot(page, '13-audit')
  assert.deepEqual(errors, [])
})

test('public projects: owner switches, an anonymous phone board and the kill switch', async () => {
  const { page } = owner
  await page.goto(`${hosted.origin}/w/${workspaceId}/settings`)
  await page.click('[data-sw-settings-public] [data-sw-switch="off"]')
  await page.waitForSelector('[data-sw-settings-public] [data-sw-switch="on"]')
  await page.goto(`${hosted.origin}/w/${workspaceId}`)
  await page.click('[data-sw-manage-project="Demo site"]')
  await page.click('[data-sw-project-public] [data-sw-switch="off"]')
  await page.waitForSelector('[data-sw-copy-value="public"]')
  const url = (await page.textContent('[data-sw-copy-value="public"]')).trim()
  const visitor = await open({ width: 390, height: 844, phone: true, dark: true })
  try {
    await visitor.page.goto(url)
    await visitor.page.waitForSelector('[data-sw-node="home"]')
    assert.equal(await visitor.page.locator('[data-sw-comment-mode]').count(), 0)
    const info = await visitor.page.evaluate(async () => (await fetch('api/info')).json())
    assert.equal(info.public, true)
    assert.equal(info.readOnly, true)
    assert.deepEqual(await visitor.context.cookies(), [])
    assert.ok(await visitor.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    await shot(visitor.page, '15-public-phone')
    assert.deepEqual(visitor.errors, [])
    // Making it private asks first: the URL is gone for good.
    await page.click('[data-sw-project-public] [data-sw-switch="on"]')
    await page.click('[data-sw-confirm]')
    await page.waitForSelector('[data-sw-project-public] [data-sw-switch="off"]')
    assert.equal(await visitor.page.evaluate(async () => (await fetch('api/info')).status), 404)
  } finally {
    await visitor.context.close()
  }
})

test('phone 390 and dark: every admin page fits, with 44 px targets', async () => {
  const cookies = await owner.context.cookies()
  for (const options of [
    { width: 390, height: 844, phone: true },
    { width: 390, height: 844, phone: true, dark: true },
  ]) {
    const view = await open(options)
    try {
      await view.context.addCookies(cookies)
      for (const section of ['', '/members', '/invites', '/access', '/tokens', '/audit', '/settings']) {
        await view.page.goto(`${hosted.origin}/w/${workspaceId}${section}`)
        await view.page.waitForSelector('[data-sw-nav]')
        await view.page.waitForLoadState('networkidle')
        await phoneChecks(view.page, section || '/projects')
      }
      await view.page.goto(`${hosted.origin}/account`)
      await view.page.waitForSelector('[data-sw-sessions] [data-sw-session]')
      await phoneChecks(view.page, '/account')
      await shot(view.page, `14-account-${options.dark ? 'dark' : 'light'}`)
      assert.deepEqual(view.errors, [])
    } finally {
      await view.context.close()
    }
  }
})

test('hosted starter: shell approval on the board, a fixture edit and a mocked pull request', async () => {
  const { page } = owner
  const project = hosted.db.prepare('SELECT id FROM projects WHERE workspace_id = ? ORDER BY created_at LIMIT 1').get(workspaceId)
  await page.goto(`${hosted.origin}/w/${workspaceId}/projects/${project.id}`)
  await page.getByLabel('Runs per day (UTC)').fill('51')
  await page.getByLabel('Trusted handles (comma separated)').fill('fixture-one, fixture-two')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().endsWith(`/projects/${project.id}/agent`),
  )
  await page.getByRole('button', { name: 'Save agent policy' }).click()
  assert.equal((await saved).status(), 200)
  await page.getByLabel('Trusted handles (comma separated)').waitFor()
  await shot(page, 'agent-policy')
  await page.setViewportSize({ width: 390, height: 844 })
  await phoneChecks(page, 'agent policy')
  await shot(page, 'agent-policy-phone')
  await page.setViewportSize({ width: 1440, height: 900 })
  const api = `/w/${workspaceId}/p/${project.id}/api/boards/${setup.config.boards[0].id}`
  const headers = { Origin: hosted.origin }
  const tokenResponse = await page.request.post(`${hosted.origin}/api/workspaces/${workspaceId}/projects/${project.id}/tokens`, {
    headers,
    data: { name: 'Fixture runner', scopes: ['read', 'reply', 'status', 'claim'] },
  })
  assert.equal(tokenResponse.status(), 201)
  const { token } = await tokenResponse.json()
  const made = await page.request.post(`${hosted.origin}${api}/comments`, {
    headers,
    data: { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body: 'Create the approved fixture marker' },
  })
  assert.equal(made.status(), 201)
  const { comment } = await made.json()
  const stub = await startStarterStub({
    script: [
      { tools: [{ name: 'run_shell', args: { command: 'echo fixture > approved.txt', reason: 'Write a test marker' } }] },
      { text: 'Fixture done.' },
    ],
  })
  const dir = fs.realpathSync(tempDir('hosted-starter-e2e-repo'))
  const bare = fs.realpathSync(tempDir('hosted-starter-e2e-remote'))
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
      cwd,
      stdio: 'pipe',
    }).toString()
  git(dir, 'init', '-q', '-b', 'main')
  git(bare, 'init', '-q', '--bare')
  fs.writeFileSync(
    path.join(dir, 'shapewall.config.json'),
    JSON.stringify({
      id: 'sample',
      baseUrl: 'http://127.0.0.1:9',
      pages: [{ id: 'home', path: '/' }],
      agent: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, model: 'stub-model' },
      starterAgent: { trusted: [] },
    }),
  )
  git(dir, 'add', 'shapewall.config.json')
  git(dir, 'commit', '-qm', 'Fixture initial')
  git(dir, 'remote', 'add', 'origin', bare)
  const config = loadConfig(path.join(dir, 'shapewall.config.json'))
  const remote = createRemote({ origin: hosted.origin, token })
  const source = await remoteSource(remote, setup.config.boards[0].id)
  const prs = []
  const controller = new AbortController()
  const running = runStarter({
    signal: controller.signal,
    source,
    settings: starterSettings(config, { env: {} }),
    runtime: hostedStarterRuntime(),
    image: 'fixture',
    projectDir: dir,
    workDir: fs.realpathSync(tempDir('hosted-starter-e2e-work')),
    commentId: comment.id,
    env: {},
    log: () => {},
    pr: async (info) => {
      prs.push(info)
      return { number: 1, url: 'https://example.invalid/pull/1' }
    },
  })
  try {
    await page.goto(`${hosted.origin}/w/${workspaceId}/p/${project.id}/?board=${setup.config.boards[0].id}`)
    await page.getByRole('button', { name: 'Approve once with passkey' }).waitFor()
    await shot(page, 'agent-approval-desktop')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector('[data-sw-toolbar="compact"]')
    await shot(page, 'agent-approval-phone')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'approval board fits at390')
    await shot(page, 'agent-approval-phone')
    assert.ok(
      await page
        .getByRole('button', { name: 'Approve once with passkey' })
        .evaluate((button) => button.getBoundingClientRect().height >= 44),
      'approval touch target',
    )
    await page.getByRole('button', { name: 'Approve once with passkey' }).click()
    const result = await running
    assert.equal(result.failure, null)
    assert.deepEqual(result.files, ['approved.txt'])
    assert.equal(prs.length, 1, 'PR adapter called once, no real PR created')
    assert.match(git(bare, 'show', `${result.branch}:approved.txt`), /fixture/)
    assert.match(result.reply, /https:\/\/example.invalid\/pull\/1/)
    assert.equal((await remote.comment(setup.config.boards[0].id, comment.id)).comment.agentStatus, 'done')
    await page.setViewportSize({ width: 1440, height: 900 })
  } finally {
    controller.abort()
    await running.catch(() => {})
    await stub.close()
  }
})

test('moving an account: the old origin reauthenticates and the new origin creates a passkey', async () => {
  const { page, errors } = owner
  const oldOrigin = hosted.origin
  const { port, dataDir } = hosted
  assert.deepEqual(errors, [], 'the owner board is clean before the fixture restarts')
  // Leave the live board before deliberately taking its server down. Its
  // presence reconnect and agent polling otherwise race the fixture restart.
  // Keep the context and authenticator so this is still the existing account.
  await page.goto('about:blank')
  await hosted.close()
  hosted = await startHostedServer('hosted-e2e-moved', {
    dataDir,
    port,
    origin: (p) => `http://new.localhost:${p}`,
    previousOrigin: () => oldOrigin,
    clientDir: path.join(ROOT_DIR, 'dist', 'client'),
  })
  await page.goto(oldOrigin)
  await page.waitForSelector('[data-sw-moving]')
  await shot(page, '16-moving')
  await page.click('[data-sw-move-signin]')
  await page.waitForSelector('[data-sw-rebind-create]')
  assert.equal(new URL(page.url()).origin, hosted.origin)
  assert.equal(new URL(page.url()).hash, '', 'the token leaves the address bar')
  await page.click('[data-sw-rebind-create]')
  await page.waitForSelector('[data-sw-rebind="done"]')
  await shot(page, '17-rebound')
  await page.click('[data-sw-rebind-continue]')
  await page.click(`[data-sw-workspace-card="${workspaceId}"]`)
  await page.waitForSelector('[data-sw-project="Demo site"]')
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM rebind_tokens WHERE used_at IS NOT NULL').get().n, 1)
  assert.equal(hosted.db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE rp_id = 'new.localhost'").get().n, 1)
  assert.deepEqual(errors, [])
})
