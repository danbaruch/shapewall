// End to end: the public demo. Builds the export the way the website deploy
// does (scripts/demo-export.js over the demo client in dist/demo-app), serves
// it under /demo/ with the website's CSP headers and drives it in Chromium:
// "View as" changes what each role may do, an invite shows up on the invites,
// access and audit pages, a share link opens the board as its guest, the
// scripted agent streams its replies with a live activity line, asks before it edits and stops, the appearance
// choice persists and is applied before the app loads, and the phone layout
// fits 390 pixels. Nothing logs an error.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { NOTES_PROJECT, WORKSPACE_ID } from '../../client/src/demo/fixtures.js'
import { observeChatReply, ROOT_DIR, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
// The website's headers for /demo/* (website/deploy/shapewall.Caddyfile).
const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
// assets/tts-*.js: the natural voice's worker (its own policy, see the Caddyfile).
const TTS_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.hf.co; base-uri 'none'; form-action 'none'"
const LIVE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

let server
let browser
let base

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" before the demo e2e test')
  const out = path.join(ROOT_DIR, 'test', '.output', 'demo-e2e', 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  const app = express()
  app.use('/demo', (req, res, next) => {
    const live = /^\/data\/.*\.html$/.test(req.path)
    const tts = /^\/assets\/tts-[^/]*\.m?js$/.test(req.path)
    res.set('Content-Security-Policy', live ? LIVE_CSP : tts ? TTS_CSP : SHELL_CSP)
    res.set('X-Frame-Options', live ? 'SAMEORIGIN' : 'DENY')
    next()
  })
  app.use('/demo', express.static(out))
  server = await listen(app)
  base = `http://127.0.0.1:${server.address().port}/demo/`
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
})

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return { context, page, errors }
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `demo-${name}.png`) })
}

const consoleUrl = (route) => `${base}console.html#/w/${WORKSPACE_ID}${route}`

// Reset asks first: Cancel keeps everything, Reset starts over as the owner.
// On a phone the console's Demo chip has no Reset: it is in the profile menu.
async function askReset(page) {
  const chip = page.locator('[data-sw-demo-reset]')
  if (await chip.isVisible()) return chip.click()
  await page.click('[data-sw-account-menu]')
  await page.click('[data-sw-demo-reset-item]')
}

async function resetDemo(page) {
  await askReset(page)
  await page.click('[data-sw-demo-reset-cancel]')
  await page.waitForSelector('[data-sw-demo-reset-confirm]', { state: 'detached' })
  await askReset(page)
  await page.click('[data-sw-demo-reset-confirm]')
  await page.waitForSelector('[data-sw-demo-banner="owner"]', { timeout: 20000 })
}

async function openBoard(page, url = base) {
  await page.goto(url)
  await page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
  await page.waitForSelector('[data-sw-demo-banner]')
}

async function viewAs(page, role) {
  await page.click('[data-sw-profile-menu]')
  // The choice reloads the page as that person.
  await Promise.all([page.waitForEvent('load'), page.click(`[data-sw-view-as="${role}"]`)])
  await page.waitForSelector(`[data-sw-demo-banner="${role}"]`, { timeout: 20000 })
}

// Opens the first thread in the list (at its pin) and returns its selector.
async function openFirstThread(page) {
  const row = page.locator('[data-sw-comment-list] [data-sw-comment]').first()
  const id = await row.getAttribute('data-sw-comment')
  await row.click()
  const thread = `[data-sw-thread-popover="${id}"]`
  await page.waitForSelector(thread)
  return thread
}

// The edit and delete items in a thread's more menu.
async function menuHooks(page, thread) {
  await page.click(`${thread} [data-sw-thread-menu]`)
  await page.waitForSelector('[role="menu"]')
  const hooks = await page.$$eval('[role="menu"] [role="menuitem"]', (items) =>
    items.flatMap((item) => ['data-sw-edit', 'data-sw-delete'].filter((name) => item.hasAttribute(name))),
  )
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role="menu"]', { state: 'detached' })
  return hooks
}

const navSections = (page) => page.$$eval('[data-sw-nav]', (els) => els.map((el) => el.getAttribute('data-sw-nav')))

test('view as: each role sees what it may do, on the board and in the console', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page)
    assert.equal(await page.getAttribute('[data-sw-demo-banner]', 'data-sw-demo-banner'), 'owner')
    await page.click('[data-sw-profile-menu]')
    await page.waitForSelector('[data-sw-profile-content]')
    for (const role of ['owner', 'admin', 'member', 'viewer', 'guest']) await page.waitForSelector(`[data-sw-view-as="${role}"]`)
    await shot(page, '1-profile-menu')
    await page.keyboard.press('Escape')
    assert.equal((await page.locator('[data-sw-comment-mode]').count()) > 0, true, 'the owner comments')

    // A viewer reads but does not comment.
    await viewAs(page, 'viewer')
    assert.match(await page.textContent('[data-sw-demo-banner]'), /Viewer/)
    assert.equal(await page.locator('[data-sw-comment-mode]').count(), 0, 'a viewer cannot comment')
    await shot(page, '2-viewer')

    // A member comments; in the console it has no admin sections.
    await viewAs(page, 'member')
    assert.equal((await page.locator('[data-sw-comment-mode]').count()) > 0, true, 'a member comments')
    await page.goto(consoleUrl(''))
    await page.waitForSelector('[data-sw-nav="projects"]')
    let nav = await navSections(page)
    assert.ok(!nav.includes('invites') && !nav.includes('audit') && !nav.includes('tokens'), nav.join(','))

    // An admin has them; the deep link survives a reload.
    await page.click('[data-sw-account-menu]')
    await Promise.all([page.waitForEvent('load'), page.click('[data-sw-view-as="admin"]')])
    await page.waitForSelector('[data-sw-demo-banner="admin"]')
    await page.goto(consoleUrl('/members'))
    await page.waitForSelector('[data-sw-members]')
    await page.reload()
    await page.waitForSelector('[data-sw-members]')
    assert.match(page.url(), /#\/w\/ws_[a-f0-9]{24}\/members$/)
    nav = await navSections(page)
    assert.ok(nav.includes('invites') && nav.includes('audit'), nav.join(','))
    // Agents has its own page, right before Agent feedback and Settings.
    const order = [...new Set(nav)].filter((id) => ['audit', 'agents', 'feedback', 'settings'].includes(id))
    assert.deepEqual(order, ['audit', 'agents', 'feedback', 'settings'], nav.join(','))

    // The guest has no console.
    await page.click('[data-sw-account-menu]')
    await Promise.all([page.waitForEvent('load'), page.click('[data-sw-view-as="guest"]')])
    await page.waitForSelector('[data-sw-demo-guest]')

    // Reset (after a confirmation): back to the owner on the board.
    await resetDemo(page)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('view as: threads follow each role (resolve, react, reply, edit, delete)', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page)
    // The owner (Robin) resolves, reacts and replies, and may delete any thread.
    let thread = await openFirstThread(page)
    assert.equal(await page.locator(`${thread} [data-sw-resolve]`).count(), 1)
    assert.equal(await page.locator(`${thread} [data-sw-reply-form]`).count(), 1)
    assert.ok((await page.locator(`${thread} [data-sw-reaction-add]`).count()) >= 1)
    assert.ok((await menuHooks(page, thread)).includes('data-sw-delete'))
    // Reactions toggle, with a count, and are stored in the demo backend.
    await page.hover(`${thread} [data-sw-message="comment"]`)
    await page.click(`${thread} [data-sw-message="comment"] [data-sw-reaction-add]`)
    await page.click('[data-sw-reaction-picker] [data-sw-reaction-pick="🚀"]')
    await page.waitForSelector(`${thread} [data-sw-message="comment"] [data-sw-reaction="🚀"][aria-pressed="true"]`)
    await shot(page, '2b-owner-thread')
    await page.click(`${thread} [data-sw-message="comment"] [data-sw-reaction="🚀"]`)
    await page.waitForSelector(`${thread} [data-sw-message="comment"] [data-sw-reaction="🚀"]`, { state: 'detached' })
    // Seeded reactions show, with who reacted.
    assert.ok((await page.locator('[data-sw-comment-list] [aria-label$="👍"]').count()) >= 1, 'the list shows reactions')

    // A member resolves, reacts and replies, but only deletes their own threads.
    await viewAs(page, 'member')
    thread = await openFirstThread(page)
    assert.equal(await page.locator(`${thread} [data-sw-resolve]`).count(), 1)
    assert.equal(await page.locator(`${thread} [data-sw-reply-form]`).count(), 1)
    assert.ok((await page.locator(`${thread} [data-sw-reaction-add]`).count()) >= 1)
    // A member edits and deletes exactly their own threads, so both or neither show.
    const memberHooks = await menuHooks(page, thread)
    assert.equal(memberHooks.includes('data-sw-edit'), memberHooks.includes('data-sw-delete'), memberHooks.join(','))

    // A viewer reads threads and reactions, and changes nothing.
    await viewAs(page, 'viewer')
    thread = await openFirstThread(page)
    assert.equal(await page.locator(`${thread} [data-sw-resolve], ${thread} [data-sw-reopen]`).count(), 0)
    assert.equal(await page.locator(`${thread} [data-sw-reply-form]`).count(), 0)
    // Where the reply box would be, it says why there is none.
    assert.match(await page.textContent(`${thread} [data-sw-reply-denied]`), /can't reply|Replies are off/)
    assert.equal(await page.locator(`${thread} [data-sw-reaction-add]`).count(), 0)
    assert.equal(await page.locator(`${thread} button[data-sw-reaction]`).count(), 0)
    assert.deepEqual(await menuHooks(page, thread), [])
    await shot(page, '2c-viewer-thread')

    await resetDemo(page)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('an invite shows up on the invites, access and audit pages; a share link opens as its guest', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page)
    // The board's profile menu leads to the console.
    await page.click('[data-sw-profile-menu]')
    assert.equal((await page.locator('[data-sw-profile-item="console"]').textContent()).trim(), 'Workspace Console')
    await page.click('[data-sw-profile-item="console"]')
    await page.waitForSelector('[data-sw-nav="members"]')

    await page.goto(consoleUrl('/access'))
    await page.waitForSelector('[data-sw-access]')
    const pendingBefore = Number(/(\d+) pending/.exec((await page.locator('main').textContent()) || '')?.[1] || 0)

    await page.goto(consoleUrl('/members'))
    await page.click('[data-sw-invite-people]')
    await page.click('[data-sw-invite-role]')
    await page.click('[role="option"][data-sw-option="viewer"]')
    await page.click('[data-sw-invite-create]')
    await page.waitForSelector('[data-sw-copy-value="invite"]')
    assert.match((await page.textContent('[data-sw-copy-value="invite"]')).trim(), /^https:\/\/shapewall\.example\/invite#/)
    await shot(page, '3-invite')
    await page.click('[data-sw-invite-done]')

    await page.goto(consoleUrl('/invites'))
    await page.waitForSelector('[data-sw-pending-invites] [data-sw-invite]')
    await page.goto(consoleUrl('/access'))
    await page.waitForSelector('[data-sw-access]')
    await page.waitForFunction((n) => new RegExp(`${n} pending`).test(document.querySelector('main').textContent), pendingBefore + 1)
    await page.goto(consoleUrl('/audit'))
    await page.waitForSelector('[data-sw-audit-entry="invite_created"]')
    assert.match(await page.locator('[data-sw-audit-entry="invite_created"]').first().textContent(), /Robin/)

    // A comment link on Lumen Notes, then the board as that guest.
    await page.goto(consoleUrl(`/projects/${NOTES_PROJECT}`))
    await page.click('[data-sw-new-share]')
    await page.fill('[data-sw-share-label]', 'Agency')
    await page.click('[data-sw-option="comment"]')
    await page.click('[data-sw-share-create]')
    await page.waitForSelector('[data-sw-copy-value="share"]')
    const shareUrl = new URL((await page.textContent('[data-sw-copy-value="share"]')).trim(), page.url()).href
    assert.match(shareUrl, /index\.html\?share=sh_[a-f0-9]{24}$/)
    await page.click('[data-sw-share-done]')
    await page.waitForSelector('[data-sw-share="Agency"]')
    await page.goto(consoleUrl('/audit'))
    await page.waitForSelector('[data-sw-audit-entry="share_created"]')

    await openBoard(page, shareUrl)
    assert.equal(await page.getAttribute('[data-sw-demo-banner]', 'data-sw-demo-banner'), 'guest')
    assert.doesNotMatch(page.url(), /share=/, 'the link leaves the address bar')
    // The guest is this tab only, across reloads; another tab is still the owner.
    await page.reload()
    await page.waitForSelector('[data-sw-demo-banner="guest"]')
    const other = await context.newPage()
    await openBoard(other)
    assert.equal(await other.getAttribute('[data-sw-demo-banner]', 'data-sw-demo-banner'), 'owner')
    assert.equal(await other.title(), 'Lumen Notes board · Shapewall demo')
    // Links that do not open say why.
    for (const [id, status] of [
      ['sh_0123456789abcdef01234567', 'unknown'],
      ['sh_4c756d000000000000000003', 'revoked'],
      ['not-a-share', 'unknown'],
    ]) {
      await other.goto(`${base}index.html?share=${id}`)
      await other.waitForSelector(`[data-sw-share-problem="${status}"]`)
    }
    await shot(other, '4-share-revoked')
    await Promise.all([other.waitForEvent('load'), other.click('[data-sw-share-problem-leave]')])
    await other.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
    assert.equal(await other.getAttribute('[data-sw-demo-banner]', 'data-sw-demo-banner'), 'owner')
    await other.goto(consoleUrl('/members'))
    await other.waitForSelector('[data-sw-members]')
    await other.waitForFunction(() => document.title === 'Members · Lumen · Shapewall demo')
    await other.close()
    assert.equal((await page.locator('[data-sw-comment-mode]').count()) > 0, true, 'a comment link comments')
    await page.click('[data-sw-profile-menu]')
    assert.equal(await page.locator('[data-sw-profile-item="console"]').count(), 0, 'a guest has no console')
    await page.keyboard.press('Escape')
    // A guest replies in a thread but does not resolve, react, edit or delete.
    const thread = await openFirstThread(page)
    assert.equal(await page.locator(`${thread} [data-sw-reply-form]`).count(), 1)
    assert.equal(await page.locator(`${thread} [data-sw-resolve], ${thread} [data-sw-reopen]`).count(), 0)
    assert.equal(await page.locator(`${thread} [data-sw-reaction-add]`).count(), 0)
    assert.equal(await page.locator(`${thread} button[data-sw-reaction]`).count(), 0, 'reactions are counts only')
    assert.deepEqual(await menuHooks(page, thread), [])
    await shot(page, '4-guest')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('the scripted agent streams with its steps, asks before it edits, and stops', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page)
    await page.click('[data-sw-chat-toggle]')
    await page.waitForSelector('[data-sw-chat="board"]')
    await page.waitForSelector('[data-sw-chat-label="Demo agent"][data-sw-chat-agent-state="ready"]')
    // Starter prompts until something is sent in the thread.
    assert.equal(await page.locator('[data-sw-chat-suggestion]').count(), 3)

    await observeChatReply(page)
    await page.fill('[data-sw-chat-input]', "What's still open?")
    await page.click('[data-sw-chat-send]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="streaming"]')
    // The activity line names the step the scripted agent is on.
    await page.locator('[data-sw-chat-activity-label]').getByText('Reading the open comments', { exact: true }).waitFor()
    await page.waitForFunction(
      () => {
        const replies = document.querySelectorAll('[data-sw-chat-message="assistant"]')
        const last = replies[replies.length - 1]
        return last.dataset.status === 'done' && /open comments/.test(last.textContent)
      },
      null,
      { timeout: 20000 },
    )
    const renders = await page.evaluate(() => window.__chatRenders)
    assert.ok(renders.filter((item) => item.status === 'streaming').every((item) => !item.read))
    assert.ok(
      new Set(renders.filter((item) => item.status === 'streaming' && item.text).map((item) => item.text)).size > 3,
      'demo prose streams in word by word',
    )
    const summary = page.locator('[data-sw-chat-message="assistant"]').last().locator('[data-sw-chat-activity="done"]')
    assert.match(await summary.textContent(), /^Worked for \d+s, 2 steps$/)
    await summary.locator('[data-sw-chat-activity-toggle]').click()
    assert.equal(await summary.locator('[data-sw-chat-card="list_comments"]').getAttribute('data-state'), 'done')
    // Natural voices are offered in the demo too, and say they run in this browser (nothing is downloaded here).
    await page.click('[data-sw-chat-settings]')
    await page.click('[data-sw-tts-engine] [data-sw-option="natural"]')
    assert.match(await page.locator('[data-sw-tts-where]').textContent(), /^Natural voices run on this device, in your browser\./)
    await page.click('[data-sw-tts-engine] [data-sw-option="system"]')
    await page.keyboard.press('Escape')

    await page.fill('[data-sw-chat-input]', 'Fix the next @agent comment')
    await page.click('[data-sw-chat-send]')
    await page.waitForSelector('[data-sw-chat-permission] [data-sw-chat-permission-option="allow"]', { timeout: 20000 })
    // What it said so far stays visible while it waits for the answer.
    await page.waitForSelector('[data-status="streaming"] [data-sw-markdown]')
    assert.equal(await page.locator('[data-sw-chat-activity-label]').textContent(), 'Waiting for your answer')
    await shot(page, '5-chat-approval')
    await page.click('[data-sw-chat-permission-option="allow"]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"] :text("Done.")', { timeout: 20000 })

    await page.fill('[data-sw-chat-input]', "What's still open?")
    await page.click('[data-sw-chat-send]')
    await page.click('[data-sw-chat-stop]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="stopped"] [data-sw-chat-stopped]')
    await page.waitForSelector('[data-sw-chat-send]')

    // The thread is kept in this browser.
    await page.reload()
    await page.waitForSelector('[data-sw-node="home"]')
    await page.waitForSelector('[data-sw-chat="board"] [data-sw-chat-message="assistant"][data-status="stopped"]')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('Fix with agent: the open thread offers it, the agent works on the comment, and an allowed edit ends as Agent done', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `${base}?c=17`)
    await page.click('[data-sw-fix-agent="17"]')
    await page.waitForSelector('[data-sw-chat="comment-17"] [data-sw-chat-fix-request]')
    // While the agent waits for the person, the thread and the list say so.
    await page.waitForSelector('[data-sw-chat-permission] [data-sw-chat-permission-option="allow"]', { timeout: 20000 })
    await page.waitForSelector('[data-sw-chat-label="Demo agent"][data-sw-chat-agent-state="waiting"]')
    await page.click('[data-sw-chat-permission-option="allow"]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"] :text("Done.")', { timeout: 20000 })
    await page.click('[data-sw-chat-close]')
    await page.waitForSelector('[data-sw-comment="17"] [data-sw-agent-status="done"]')
    await page.click('[data-sw-comment="17"]')
    await page.waitForSelector('[data-sw-thread="17"] [data-sw-reply] [data-sw-author="agent"]')
    await page.waitForSelector('[data-sw-fix-agent="17"]:has-text("Fix again")')
    await shot(page, 'fix-with-agent-done')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('agent activity on the toolbar: working, then needs your OK, then back, with the comments closed and the board elsewhere', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `${base}?c=17`)
    const agent = '[data-sw-toolbar="full"] [data-sw-chat-toggle]'
    // The demo opens with agents already at work on other comments, and
    // some comments waiting on a person: the control counts the ones at work.
    await page.waitForSelector(`${agent}[data-sw-agent-activity="working"]`)
    const resting = await page.getAttribute(agent, 'aria-label')
    const atWork = Number(await page.getAttribute(agent, 'data-sw-agent-activity-count'))
    assert.ok(atWork >= 1)
    assert.match(resting, /^Agent\. (Agent working on #\d+|\d+ agents working: #\d+) /)
    assert.doesNotMatch(resting, /#17 /)

    await page.click('[data-sw-fix-agent="17"]')
    await page.waitForSelector('[data-sw-chat="comment-17"] [data-sw-chat-fix-request]')
    // The agent panel closed, the thread closed, the canvas somewhere else:
    // the toolbar still says an agent is at work, and on what.
    await page.click('[data-sw-chat-close]')
    await page.keyboard.press('Escape')
    const canvas = await page.locator('[data-sw-canvas]').boundingBox()
    await page.mouse.move(canvas.x + 300, canvas.y + 300)
    await page.mouse.wheel(900, 600)
    // One more now: the mark carries the count, the words name this one too.
    await page.waitForSelector(`${agent}[data-sw-agent-activity="working"][data-sw-agent-activity-count="${atWork + 1}"]`, {
      timeout: 20000,
    })
    assert.match(await page.getAttribute(agent, 'aria-label'), new RegExp(`${atWork + 1} agents working: `))
    assert.equal((await page.textContent(`${agent} [data-sw-agent-activity-mark="working"]`)).trim(), String(atWork + 1))
    await page.waitForSelector(`${agent} [data-sw-agent-activity-mark="working"] [data-sw-agent-activity-pulse]`)
    await shot(page, 'agent-activity-working')

    // It asks before it edits: the control turns to "needs you" and names the comment.
    await page.waitForSelector(`${agent}[data-sw-agent-activity="waiting"]`, { timeout: 20000 })
    assert.match(await page.getAttribute(agent, 'aria-label'), /Agent needs your OK on #17 Home/)
    await shot(page, 'agent-activity-needs-you')
    // One thing needs the person: the control opens the panel on it.
    await page.click(agent)
    await page.waitForSelector('[data-sw-chat="comment-17"] [data-sw-chat-permission-option="allow"]')
    await page.click('[data-sw-chat-permission-option="allow"]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"] :text("Done.")', { timeout: 20000 })
    // The run is over: the control is back to the agents still at work
    // (the "done" settle, when nothing is left, is in board-ux.e2e).
    await page.click('[data-sw-chat-close]')
    await page.waitForFunction(([sel, was]) => document.querySelector(sel)?.getAttribute('aria-label') === was, [agent, resting], {
      timeout: 20000,
    })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('Fix with ...: the caret runs the fix once with the second scripted agent and keeps the default', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `${base}?c=17`)
    const main = page.locator('[data-sw-fix-agent="17"]')
    assert.equal((await main.textContent()).trim(), 'Fix with Demo agent')
    await page.click('[data-sw-fix-agent-choose="17"]')
    await page.waitForSelector('[data-sw-agent-menu]')
    assert.equal(await page.locator('[data-sw-agent-menu] [data-sw-agent-option]').count(), 2)
    await page.click('[data-sw-agent-menu] [data-sw-agent-option="second"]')
    await page.waitForSelector('[data-sw-chat-label="Second agent"]', { timeout: 20000 })
    await page.waitForSelector('[data-sw-chat-permission] [data-sw-chat-permission-option="allow"]', { timeout: 20000 })
    await page.click('[data-sw-chat-permission-option="allow"]')
    await page.waitForSelector('[data-sw-chat-message="assistant"][data-status="done"] :text("Second agent, scripted for the demo")', {
      timeout: 20000,
    })
    // The default is still the first agent.
    const status = await page.evaluate(() => fetch('api/agent/status').then((response) => response.json()))
    assert.equal(status.label, 'Demo agent')
    assert.equal(status.profiles.find((item) => item.id === 'default').sameAs, 'demo')
    // The chat picker switches back, with a keyboard, and says so once.
    await page.locator('[data-sw-agent-profile]').first().focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-agent-menu]')
    await page.keyboard.press('d')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-sw-agent-option') === 'demo')
    await page.keyboard.press('Enter')
    await page.waitForSelector(':text("Switched to Demo agent. It starts fresh and can read this chat.")')
    await page.waitForSelector('[data-sw-chat-label="Demo agent"]')
    await shot(page, 'fix-with-second-agent')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('the demo console has the real Agents page: every agent and its state, the default switches, notes instead of commands', async () => {
  const { context, page, errors } = await open()
  try {
    await page.goto(consoleUrl('/agents'))
    const card = page.locator('[data-sw-local-console-agents] [data-sw-agents-card="demo"]')
    await card.waitFor({ timeout: 20000 })
    // One demo note at the top, not per row.
    assert.equal(await page.locator('[data-sw-agents-demo-note]').count(), 1)
    const state = async (id) => card.locator(`[data-sw-agent-row="${id}"]`).getAttribute('data-sw-agent-row-state')
    const rows = await card
      .locator('[data-sw-agent-row]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sw-agent-row')))
    assert.deepEqual(rows, ['demo', 'second', 'claude', 'codex', 'goose', 'gemini', 'endpoint'])
    assert.equal(await state('demo'), 'connected')
    assert.equal(await state('codex'), 'found')
    assert.equal(await state('claude'), 'needs-adapter')
    assert.equal(await state('gemini'), 'missing')
    assert.match(await card.locator('[data-sw-agent-row="claude"]').textContent(), /npm install -g @agentclientprotocol\/claude-agent-acp/)
    // The Chat connection card, with the fictional folder and endpoint.
    await page.waitForSelector('[data-sw-agent-project-root]:text("/home/robin/code/lumen-notes")')
    assert.equal(await page.inputValue('[data-sw-settings-field="baseUrl"]'), 'https://api.example.com/v1')

    // Test connection: a scripted success.
    await page.click('[data-sw-agent-test="demo"]')
    await page.waitForSelector('[data-sw-agent-row="demo"] [data-sw-settings-test-result="ok"]')
    // Connect on a real agent: a neutral note, not an error.
    await page.click('[data-sw-profile-connect="codex"]')
    await page.waitForSelector('[data-sw-agent-row="codex"] [data-sw-settings-test-result="note"]')
    assert.equal(await page.locator('[data-sw-settings-test-result="failed"]').count(), 0)
    // The default switches, and the chat connection follows.
    await page.click('[data-sw-agents-default-option="second"]')
    await page.waitForSelector('[data-sw-agent-row="second"] :text("Default")')
    await page.waitForSelector('[data-sw-settings-status] :text("Chat uses Second agent")')
    // Remove a scripted agent, then connect it again.
    await page.click('[data-sw-agent-remove="demo"]')
    await page.waitForSelector('[data-sw-agent-row="demo"][data-sw-agent-row-state="found"]')
    await page.click('[data-sw-profile-connect="demo"]')
    await page.waitForSelector('[data-sw-agent-row="demo"][data-sw-agent-row-state="connected"]')
    await page.click('[data-sw-agent-remove="demo"]')
    await page.waitForSelector('[data-sw-agent-row="demo"][data-sw-agent-row-state="found"]')
    // Reset puts the first agent back as the default.
    // (Reset reloads the console at its start page: wait for that before going on.)
    await Promise.all([page.waitForURL(/console\.html$/), resetDemo(page)])
    await page.goto(consoleUrl('/agents'))
    await page.waitForSelector('[data-sw-agent-row="demo"][data-sw-agent-row-state="connected"]', { timeout: 20000 })
    await page.waitForSelector('[data-sw-agent-row="demo"] :text("Default")')
    assert.equal((await page.locator('h1').first().textContent()).trim(), 'Agents')
    assert.match(await page.title(), /^Agents · /)
    assert.equal((await page.locator('[data-sw-nav="agents"][aria-current="page"]').count()) > 0, true)
    // Settings keeps the general workspace settings only.
    await page.locator('[data-sw-nav="settings"]').first().click()
    await page.waitForSelector('[data-sw-settings-name]')
    assert.equal(await page.locator('[data-sw-local-console-agents]').count(), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('the links overlay lists the broken link and a card shows its capture network warning', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page)
    await page.waitForSelector('[data-sw-broken-links-badge="1"]')
    // Links live in the toolbar's View menu.
    await page.click('[data-sw-view-menu]')
    await page.click('[data-sw-links-toggle]')
    await page.click('[data-sw-broken-links-toggle]')
    await page.waitForSelector('[data-sw-broken-link="/help/templates/"]')
    await page.keyboard.press('Escape')
    // Comment 25 is on the dashboard: its card's header carries the warning chip.
    await openBoard(page, `${base}?c=25`)
    await page.keyboard.press('Escape')
    await page.locator('[data-sw-capture-warning="dashboard"]').first().click()
    await page.waitForSelector('[data-sw-capture-warning-details] :text("1 other HTTP error")')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('appearance: the choice persists across the board and console and applies before the app loads', async () => {
  const { context, page, errors } = await open({ colorScheme: 'light' })
  try {
    await openBoard(page)
    await page.click('[data-sw-profile-menu]')
    await page.click('[data-sw-appearance-mode="dark"]')
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    await page.click('[data-sw-theme-option="ocean"]')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'ocean')
    await shot(page, '6-ocean-dark')
    await page.keyboard.press('Escape')

    // No flash: with the app's scripts held back, the page is already dark.
    await context.route(/\/assets\/.*\.js$/, (route) => route.abort())
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const early = await page.evaluate(() => ({
      mode: document.documentElement.dataset.mode,
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
      mounted: Boolean(document.querySelector('[data-sw-board]')),
    }))
    assert.deepEqual({ mode: early.mode, theme: early.theme, mounted: early.mounted }, { mode: 'dark', theme: 'ocean', mounted: false })
    const [r, g, b] = early.background.match(/\d+/g).map(Number)
    assert.ok(r + g + b < 120, `dark before the app loads: ${early.background}`)
    await context.unroute(/\/assets\/.*\.js$/)

    // The console uses the same choice; System follows the browser.
    await page.goto(consoleUrl(''))
    await page.waitForSelector('[data-sw-nav="projects"]')
    assert.deepEqual(await page.evaluate(() => ({ ...document.documentElement.dataset })), { mode: 'dark', theme: 'ocean' })
    await page.click('[data-sw-account-menu]')
    await page.click('[data-sw-appearance-mode="system"]')
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    // Errors from the aborted scripts are expected; nothing else.
    assert.deepEqual(
      errors.filter((text) => !/ERR_FAILED|Failed to load resource/.test(text)),
      [],
    )
  } finally {
    await context.close()
  }
})

test('phone 390: the board and console fit, the profile menu opens', async () => {
  const { context, page, errors } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  try {
    await openBoard(page)
    assert.ok(await fits(), 'the board fits')
    await page.tap('[data-sw-profile-menu]')
    await page.waitForSelector('[data-sw-profile-content]')
    const box = await page.locator('[data-sw-profile-content]').boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= 390, `menu inside the screen: ${JSON.stringify(box)}`)
    await shot(page, '7-phone-menu')
    await page.keyboard.press('Escape')

    await page.goto(consoleUrl('/members'))
    await page.waitForSelector('[data-sw-members]')
    assert.ok(await fits(), 'the members page fits')
    await page.goto(`${base}console.html#/signin`)
    await page.waitForSelector('[data-sw-demo-signin-button]')
    await page.tap('[data-sw-demo-signin-button]')
    await page.waitForSelector('[data-sw-nav="projects"], [data-sw-workspace-card]', { timeout: 20000 })
    await shot(page, '8-phone-console')

    // The console header on a phone: the Demo chip is only a label (no
    // Reset), so the workspace name has its room; Reset is in the menu.
    await page.goto(consoleUrl('/members'))
    await page.waitForSelector('[data-sw-members]')
    assert.equal(await page.locator('[data-sw-demo-banner] [data-sw-demo-reset]').isVisible(), false, 'no Reset on the phone chip')
    assert.ok(await page.locator('[data-sw-demo-view-as]').isVisible(), 'the Demo chip stays')
    const name = page.locator('[data-sw-workspace-switcher] span.truncate')
    assert.ok(await name.evaluate((el) => el.scrollWidth <= el.clientWidth), `the workspace name is not cut: ${await name.textContent()}`)
    await page.tap('[data-sw-account-menu]')
    await page.waitForSelector('[data-sw-demo-reset-item]')
    await shot(page, '9-phone-console-menu')
    await page.tap('[data-sw-demo-reset-item]')
    await page.waitForSelector('[data-sw-demo-reset-confirm]')
    await page.tap('[data-sw-demo-reset-cancel]')
    await page.waitForSelector('[data-sw-demo-reset-confirm]', { state: 'detached' })
    await page.waitForSelector('[data-sw-members]')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('profile photo: browser-local upload, persistence, removal and reset at desktop and phone widths', async () => {
  const png = new PNG({ width: 320, height: 280 })
  for (let at = 0; at < png.data.length; at += 4) png.data.set([72, 121, 200, 255], at)
  const file = { name: 'fictional-profile.png', mimeType: 'image/png', buffer: PNG.sync.write(png) }
  for (const width of [1440, 390]) {
    const { context, page, errors } = await open({ viewport: { width, height: 900 } })
    const sent = []
    page.on('request', (request) => {
      if (['PUT', 'DELETE'].includes(request.method())) sent.push(request.url())
    })
    try {
      await page.goto(`${base}console.html#/account`)
      await page.waitForSelector('[data-sw-profile-photo]')
      const upload = async () => {
        await page.setInputFiles('[data-sw-profile-photo-file]', file)
        await page.waitForSelector('[data-sw-profile-photo-remove]')
        await page.waitForFunction(() => document.querySelector('[data-sw-profile-photo] img')?.naturalWidth === 256)
      }
      await upload()
      assert.match(await page.getAttribute('[data-sw-profile-photo] img', 'src'), /^data:image\/png;base64,/)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'profile fits viewport')
      await page.reload()
      await page.waitForSelector('[data-sw-profile-photo-remove]')
      await page.waitForFunction(() => document.querySelector('[data-sw-profile-photo] img')?.naturalWidth === 256)
      await page.goto(base)
      await page.waitForSelector('[data-sw-profile-menu] [data-sw-avatar-image]')
      await page.goto(`${base}console.html#/account`)
      await page.waitForSelector('[data-sw-profile-photo-remove]')
      await page.click('[data-sw-profile-photo-remove]')
      await page.waitForSelector('[data-sw-profile-photo-remove]', { state: 'detached' })
      assert.equal(await page.locator('[data-sw-profile-photo] img').count(), 0)
      await page.reload()
      await page.waitForSelector('[data-sw-profile-photo]')
      assert.equal(await page.locator('[data-sw-profile-photo] img').count(), 0)
      await upload()
      await Promise.all([page.waitForEvent('load'), resetDemo(page)])
      await page.waitForSelector('[data-sw-demo-banner="owner"]')
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('shapewall.demo.state.v1'))?.avatars ?? {}), {})
      assert.equal(await page.locator('[data-sw-avatar-image]').count(), 0)
      assert.deepEqual(sent, [], 'avatar mutations never leave the browser')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
})
