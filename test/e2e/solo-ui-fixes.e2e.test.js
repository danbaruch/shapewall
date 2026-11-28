// End to end regression tests for 2.0.0 client UI fixes (Wave 4 F20-F26):
//   F20: TeamCard shows suspended team sign-in notice and /solo/team load errors
//   F21: InvitesSection routes through TeamOnDialog when team mode is off, and hides invite creation when ownerOnlyInvites
//   F22: ImportedOk per-comment checkboxes, BiDi escaping, human page title, reload-error preservation + retry, partial-change notice
//   F23: Solo local copy in ReauthProvider typed confirmation modal and StepUpCard
//   F24: Single-owner filter in Members role dropdown + ownerOnlyInvites hiding dead-end Invite buttons
//   F25: Single TeamOnDialog on MembersSection, stale error cleared on reopen
//   F26: First-run tip deferred while ImportedOk is visible
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { loadConfig } from '../../src/config.js'
import { quietSqliteWarning } from '../../src/hosted/db.js'
import { startHosted } from '../../src/hosted/server.js'
import { createAgentPolicy } from '../../src/hosted/agent-policy.js'
import { tenant } from '../../src/hosted/tenancy.js'
import { soloOrigin } from '../../src/hosted/solo/signin.js'
import { SAMPLE, tempDir } from '../helpers.js'
import { writeLocalCaptures } from '../hosted-helpers.js'
import { ROOT_DIR } from './helpers.js'

quietSqliteWarning()

let engine
let browser
let context
let page
let origin
let wsId
let projId
let boardUrl
const errors = []

const realErrors = () => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

function stateOf(number) {
  const row = engine.db.prepare('SELECT * FROM comments WHERE number = ?').get(number)
  const t = tenant(engine.db, row.workspace_id)
  return createAgentPolicy(t).state(row.project_id, row.board_id, row)
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" first')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" first')
  const projectDir = tempDir('solo-ui-fixes-project')
  const configPath = path.join(projectDir, 'shapewall.config.json')
  fs.writeFileSync(configPath, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes' }, null, 2))
  const config = loadConfig(configPath)
  writeLocalCaptures(config, 'sample')
  const dataDir = tempDir('solo-ui-fixes-data')
  engine = await startHosted({
    dataDir,
    port: 0,
    out: () => {},
    exitOnStop: false,
    clientDir: path.join(ROOT_DIR, 'dist', 'client'),
    consoleDir: path.join(ROOT_DIR, 'dist', 'console'),
    origin: (port) => soloOrigin('lumen-notes-uifixes2026', port),
    solo: { signIn: 'local', config, configPath, ownerName: 'Robin Tester', team: { want: false } },
  })
  origin = engine.origin
  wsId = engine.app.locals.solo.owner.workspaceId
  projId = engine.app.locals.solo.owner.projectId
  boardUrl = `${origin}/w/${wsId}/p/${projId}/?board=sample`

  // Seed a second workspace member so MembersSection renders a role dropdown.
  engine.db
    .prepare(
      `INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at) VALUES ('u-alex', 'alex', 'Alex Teammate', 'webauthn-u-alex', '2026-11-28T00:00:00.000Z')`,
    )
    .run()
  engine.db
    .prepare(`INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, 'u-alex', 'member', '2026-11-28T00:00:00.000Z')`)
    .run(wsId)

  browser = await chromium.launch()
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', (error) => errors.push(error.message))

  // Sign in via the one-time local open page.
  const openFile = engine.app.locals.soloOpenFile()
  await page.goto(pathToFileURL(openFile).href)
  await page.waitForURL((url) => url.href.startsWith(`${origin}/w/${wsId}`))
})

after(async () => {
  await browser?.close()
  await engine?.stop()
})

test('F22 + F26: ImportedOk checkboxes, BiDi escaping, human page titles, reload-error preservation, partial-change notice, and single-row tip deferral', async () => {
  // Seed two waiting 1.x comments (one with BiDi override U+202E).
  const apiBase = `${origin}/w/${wsId}/p/${projId}/api/boards/sample/comments`
  const numbers = []
  for (const body of ['Tighten header padding', 'Safe text \u202e hidden prompt injection']) {
    const made = await page.request.post(apiBase, {
      headers: { Origin: origin },
      data: { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body },
    })
    assert.equal(made.status(), 201)
    numbers.push((await made.json()).comment.id)
  }
  engine.db
    .prepare(
      "UPDATE comments SET imported_at = '2026-11-28T00:00:00.000Z', dispatch_hash = NULL, dispatch_by = NULL, dispatch_at = NULL, run_approved = 0, author = ?",
    )
    .run('Ada\u202eSpoof')

  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-imported-ok="2"]')
  // F26: First-run tip is deferred while ImportedOk is visible so CanvasNotes stays single-row.
  assert.equal(await page.locator('[data-sw-tip]').count(), 0, 'tip hidden while ImportedOk is visible')

  await page.click('[data-sw-imported-review]')
  await page.waitForSelector('[data-sw-imported-list]')

  const listText = await page.locator('[data-sw-imported-list]').textContent()
  // F22: Human page title ("Home") instead of raw pageId, and BiDi U+202E escaped as \u202e.
  assert.match(listText, /#1 on Home/)
  assert.match(listText, /\\u202e/)
  assert.doesNotMatch(listText, /\u202e/)

  // F22: Per-comment checkboxes, checked by default; unchecking all disables Send.
  const sendBtn = page.locator('[data-sw-imported-send]')
  assert.match(await sendBtn.textContent(), /Send 2 to agents/)
  await page.uncheck(`[data-sw-imported-check="${numbers[0]}"]`)
  await page.uncheck(`[data-sw-imported-check="${numbers[1]}"]`)
  assert.match(await sendBtn.textContent(), /Send 0 to agents/)
  assert.equal(await sendBtn.isDisabled(), true)

  // Re-check only comment #1, fail the post-send reload once to verify modal + error stay visible.
  await page.check(`[data-sw-imported-check="${numbers[0]}"]`)
  assert.match(await sendBtn.textContent(), /Send 1 to agents/)
  let failReload = true
  await page.route('**/waiting-ok', async (route) => {
    if (failReload && route.request().method() === 'GET') {
      failReload = false
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Temporary outage' } }),
      })
      return
    }
    await route.continue()
  })
  await sendBtn.click()
  await page.waitForSelector('[data-sw-imported-notice="bad"]')
  assert.match(await page.locator('[data-sw-imported-notice="bad"]').textContent(), /Temporary outage/)
  assert.equal(stateOf(numbers[0]).dispatchable, true, 'checked comment #1 was sent')
  assert.equal(stateOf(numbers[1]).dispatchable, false, 'unchecked comment #2 stayed waiting')

  // Retry reload clears the error and leaves only comment #2.
  await page.click('[data-sw-imported-retry]')
  await page.waitForSelector('[data-sw-imported-notice]', { state: 'detached' })
  assert.equal(await page.locator('[data-sw-imported-item]').count(), 1)
  await page.unroute('**/waiting-ok')

  // Edit comment #2 in DB so dispatchHash changes before clicking Send: warn notice + stays open.
  engine.db.prepare("UPDATE comments SET body = 'Edited concurrently' WHERE number = ?").run(numbers[1])
  await page.check(`[data-sw-imported-check="${numbers[1]}"]`)
  await sendBtn.click()
  await page.waitForSelector('[data-sw-imported-notice="warn"]')
  assert.match(await page.locator('[data-sw-imported-notice="warn"]').textContent(), new RegExp(`#${numbers[1]}`))
  assert.match(await page.locator('[data-sw-imported-list]').textContent(), /Edited concurrently/)

  // Send #2 now with the refreshed hash -> modal closes, banner disappears, first-run tip can show.
  await sendBtn.click()
  await page.waitForSelector('[data-sw-imported-list]', { state: 'detached' })
  await page.waitForSelector('[data-sw-imported-ok]', { state: 'detached' })
  await page.waitForSelector('[data-sw-tip]')
  assert.deepEqual(realErrors(), [])
})

test('F23: solo engine Settings StepUpCard and ReauthProvider typed confirmation show local copy, not Tailscale', async () => {
  await page.goto(`${origin}/w/${wsId}/settings`)
  const card = page.locator('[data-sw-settings-step-up="local-only"]')
  await card.waitFor()
  const text = await card.textContent()
  assert.match(text, /signed in locally on this machine/i)
  assert.doesNotMatch(text, /Your Tailscale account/i)
  assert.doesNotMatch(text, /shapewall hosted admin passkeys on/i)

  // F21 + F23: On Invites page with team mode off, "New invite" opens TeamOnDialog first,
  // and confirming opens the local typed confirmation modal.
  await page.goto(`${origin}/w/${wsId}/invites`)
  await page.click('[data-sw-new-invite]')
  await page.waitForSelector('[data-sw-confirm]')
  assert.match(await page.locator('[role="dialog"]').textContent(), /Put it on my tailnet/)
  await page.click('[data-sw-confirm]')
  await page.waitForSelector('[data-sw-confirm-required="workspace"]')
  const confirmText = await page.locator('[data-sw-confirm-required="workspace"]').textContent()
  assert.match(confirmText, /signed in locally on this machine/i)
  assert.doesNotMatch(confirmText, /Your Tailscale account/i)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  assert.deepEqual(realErrors(), [])
})

test('F24 + F25: Members single-owner filter, single TeamOnDialog, stale error cleared on reopen', async () => {
  await page.goto(`${origin}/w/${wsId}/members`)
  await page.waitForSelector('[data-sw-role-select="alex"]')
  // F24: Owner is not assignable on the solo engine.
  await page.click('[data-sw-role-select="alex"]')
  const options = await page.locator('[role="option"]').allTextContents()
  assert.ok(options.includes('Admin') && options.includes('Member') && options.includes('Viewer'), `got ${options}`)
  assert.ok(!options.includes('Owner'), `Owner must be excluded from solo role dropdown: ${options}`)
  await page.keyboard.press('Escape')

  // F25: Single TeamOnDialog instance and stale error cleared on reopen.
  await page.route('**/solo/team', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'team_unavailable', message: 'Tailscale is not running' } }),
      })
      return
    }
    await route.continue()
  })
  await page.click('[data-sw-team-on]')
  assert.equal(await page.locator('[role="dialog"]').count(), 1, 'only one TeamOnDialog opens')
  await page.click('[data-sw-confirm]')
  await page.waitForSelector('[data-sw-error]')
  assert.match(await page.locator('[data-sw-error]').textContent(), /Tailscale is not running/)
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role="dialog"]', { state: 'detached' })

  // Reopen: prior error must be cleared.
  await page.click('[data-sw-team-on]')
  await page.waitForSelector('[role="dialog"]')
  assert.equal(await page.locator('[data-sw-error]').count(), 0, 'stale error cleared on reopen')
  await page.keyboard.press('Escape')
  await page.unroute('**/solo/team')
  assert.deepEqual(realErrors(), [])
})

test('F20 + F24: TeamCard suspended notice & load error when team is on, and ownerOnlyInvites hides dead-end Invite buttons', async () => {
  // F20: Team on with suspended problem notice.
  await page.route(`**/api/workspaces/${wsId}`, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.features.team = { available: true, on: true, origin: 'https://board.example.ts.net', problem: null }
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  let teamStatusFail = false
  await page.route('**/solo/team', async (route) => {
    if (teamStatusFail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Team status failed' } }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        on: true,
        origin: 'https://board.example.ts.net',
        problem: 'Tailscale HTTPS check failed',
        lines: ['https://board.example.ts.net', 'Only invited people can reach it'],
      }),
    })
  })
  await page.goto(`${origin}/w/${wsId}/members`)
  await page.waitForSelector('[data-sw-team="on"]')
  const problemNotice = page.locator('[data-sw-team-problem]')
  await problemNotice.waitFor()
  assert.match(await problemNotice.textContent(), /Team sign-in is suspended/)
  assert.match(await problemNotice.textContent(), /Tailscale HTTPS check failed/)

  // F20: /solo/team load error renders LoadError with Retry.
  teamStatusFail = true
  await page.reload()
  await page.waitForSelector('[data-sw-team="on"]')
  assert.match(await page.locator('[data-sw-team="on"]').textContent(), /This did not load/)
  assert.match(await page.locator('[data-sw-team="on"]').textContent(), /Team status failed/)

  await page.unroute('**/solo/team')
  await page.unroute(`**/api/workspaces/${wsId}`)

  // F24 + F21: Non-owner admin with ownerOnlyInvites sees no dead-end Invite buttons.
  await page.route(`**/api/workspaces/${wsId}`, async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.role = 'admin'
    delete body.features.team
    body.features.ownerOnlyInvites = true
    await route.fulfill({ response, body: JSON.stringify(body) })
  })
  await page.goto(`${origin}/w/${wsId}/members`)
  await page.waitForSelector('[data-sw-members]')
  assert.equal(await page.locator('[data-sw-invite-people]').count(), 0, 'Invite people hidden for non-owner admin')

  await page.goto(`${origin}/w/${wsId}/invites`)
  await page.waitForSelector('[data-sw-owner-only-invites]')
  assert.equal(await page.locator('[data-sw-new-invite]').count(), 0, 'New invite hidden for non-owner admin')
  await page.unroute(`**/api/workspaces/${wsId}`)
  assert.deepEqual(realErrors(), [])
})
