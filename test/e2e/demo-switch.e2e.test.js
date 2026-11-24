// End to end: a project with two boards in the public demo's shape (the
// Brackwell world: one project, the boards "Brackwell" and "Lumen Notes"),
// driven in Chromium. Both boards here come from the Lumen export, so their
// comment ids and journey ids are the same, which is exactly when state
// carried from one board to the other would land on something unrelated:
// - picking the other board leaves nothing of the first board's view open
//   (journey, thread, chat) and nothing in the address;
// - a comment whose save is still out when the other board is picked is
//   saved on its own board and does not open anything on the new one;
// - Send cannot post a comment twice when another action ends first;
// - a Back that never lands does not freeze the board's address;
// - Reset brings back "Try this", even while the demo is busy.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots of each step.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import express from 'express'
import { chromium } from 'playwright'
import { ROOT_DIR, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const FIRST = 'brackwell'
const SECOND = 'lumen-notes'

let server
let browser
let base

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'demo-app', 'console.html')), 'run "npm run build:demo" before the demo e2e test')
  const work = path.join(ROOT_DIR, 'test', '.output', 'demo-switch-e2e')
  const out = path.join(work, 'demo')
  await promisify(execFile)(process.execPath, [path.join(ROOT_DIR, 'scripts', 'demo-export.js'), out, '--app', 'lumen'], {
    cwd: ROOT_DIR,
    maxBuffer: 16 * 1024 * 1024,
  })
  // The Brackwell world's two boards (client/src/demo/world.js): folders
  // "demo" and "lumen" in one project. The second is a copy of the first.
  const data = path.join(out, 'data')
  fs.cpSync(path.join(data, 'boards', 'demo'), path.join(data, 'boards', 'lumen'), { recursive: true })
  fs.copyFileSync(path.join(data, 'boards', 'demo.json'), path.join(data, 'boards', 'lumen.json'))
  const info = JSON.parse(fs.readFileSync(path.join(data, 'info.json'), 'utf8'))
  fs.writeFileSync(path.join(data, 'info.json'), JSON.stringify({ ...info, demoApp: 'brackwell' }))
  const app = express()
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
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `demo-switch-${name}.png`) })
}

async function openBoard(page, query = '') {
  await page.goto(`${base}${query}`)
  await page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
  await page.waitForSelector('[data-sw-demo-banner]')
}

const param = (page, key) => page.evaluate((name) => new URLSearchParams(window.location.search).get(name), key)

async function pickBoard(page, id) {
  await page.click('[data-sw-picker]')
  await page.click(`[role="listbox"] [data-sw-option="${id}"]`)
  await page.waitForSelector('[role="listbox"]', { state: 'detached' })
  await page.waitForFunction((want) => new URLSearchParams(window.location.search).get('board') === want, id)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForSelector(`[data-sw-picker][aria-label$="${id === FIRST ? 'Brackwell' : 'Lumen Notes'}"]`)
}

// Holds the demo's answers to matching requests for `ms` (the demo answers
// in the page, so this wraps its fetch).
async function holdRequests(page, { method, path: pattern, ms }) {
  await page.evaluate(
    ({ method, source, ms }) => {
      const real = window.fetch
      const match = new RegExp(source)
      window.fetch = async (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
        const verb = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
        if (verb === method && match.test(url.pathname)) await new Promise((resolve) => setTimeout(resolve, ms))
        return real(input, init)
      }
    },
    { method, source: pattern, ms },
  )
}

// Comment mode, then a click on the page that shows most on screen:
// the composer opens there. Returns once it does.
async function startComment(page) {
  const point = await page.evaluate(() => {
    const box = document.querySelector('[data-sw-canvas]').getBoundingClientRect()
    let best = null
    for (const node of document.querySelectorAll('[data-sw-frame] img')) {
      const rect = node.getBoundingClientRect()
      const left = Math.max(rect.left, box.left + 80)
      const right = Math.min(rect.right, box.right - 80)
      const top = Math.max(rect.top, box.top + 80)
      const bottom = Math.min(rect.bottom, box.bottom - 80)
      const area = Math.max(0, right - left) * Math.max(0, bottom - top)
      if (area > (best?.area || 0)) best = { area, x: (left + right) / 2, y: (top + bottom) / 2 }
    }
    return best
  })
  assert.ok(point, 'a page is on screen')
  await page.keyboard.press('c')
  await page.mouse.click(point.x, point.y)
  await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
}

const commentsWith = (page, board, body) =>
  page.evaluate(
    async ({ board, body }) => {
      const answer = await (await window.fetch(`api/boards/${board}/comments`)).json()
      return answer.comments.filter((item) => item.body === body).length
    },
    { board, body },
  )

test('picking the other board leaves nothing of the first board open: journey, thread, chat', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `?board=${FIRST}`)
    const comments = await page.evaluate(
      async (board) => (await (await window.fetch(`api/boards/${board}/comments`)).json()).comments,
      FIRST,
    )
    const target = comments.find((item) => item.status === 'open' && item.viewport === 'desktop')
    assert.ok(target, 'an open desktop comment')
    // The same ids exist on the second board: anything carried over would open there.
    // A journey, then a thread, then the chat about that thread.
    await openBoard(page, `?board=${FIRST}&j=sign-up`)
    await page.waitForSelector('[data-sw-journey-bar="sign-up"]')
    await pickBoard(page, SECOND)
    assert.equal(await param(page, 'j'), null)
    assert.equal(await page.locator('[data-sw-journey-bar]').count(), 0, 'no journey open on the second board')

    await openBoard(page, `?board=${FIRST}&c=${target.id}`)
    await page.waitForSelector(`[data-sw-thread-popover="${target.id}"]`)
    await openBoard(page, `?board=${FIRST}&chat=c${target.id}`)
    await page.waitForSelector(`[data-sw-chat="comment-${target.id}"]`, { timeout: 20000 })
    await shot(page, 'first-chat')
    await pickBoard(page, SECOND)
    for (const key of ['c', 'chat', 'j', 'step', 'hist']) assert.equal(await param(page, key), null, `${key} cleared`)
    await page.waitForTimeout(600)
    assert.equal(await page.locator('[data-sw-chat]').count(), 0, 'no chat open on the second board')
    assert.equal(await page.locator('[data-sw-thread-popover]').count(), 0, 'no thread open on the second board')
    // The second board's Agent toggle does not reopen the first board's chat.
    assert.equal(await page.evaluate((board) => window.sessionStorage.getItem(`shapewall.lastChat.${board}`), SECOND), null)

    await shot(page, 'second-clean')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('a comment still saving when the other board is picked is saved on its own board and opens nothing on the new one', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `?board=${FIRST}`)
    await holdRequests(page, { method: 'POST', path: '/comments$', ms: 1500 })
    await startComment(page)
    const body = `Saved late ${Date.now()}`
    await page.keyboard.type(body)
    await page.keyboard.press('Enter')
    // The save is out; the visitor moves on to the other board.
    await pickBoard(page, SECOND)
    await page.waitForTimeout(2500)
    assert.equal(await param(page, 'board'), SECOND)
    assert.equal(await param(page, 'c'), null, 'the late save wrote nothing into the second board')
    assert.equal(await page.locator('[data-sw-thread-popover]').count(), 0)
    assert.equal(await page.getByText(/was not found on this board/).count(), 0)
    assert.equal(await commentsWith(page, FIRST, body), 1, 'saved on the first board')
    assert.equal(await commentsWith(page, SECOND, body), 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('Send cannot post a comment twice when another action finishes while it is saving', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `?board=${FIRST}`)
    // Resolve a comment: its toast offers Undo.
    const row = page.locator('[data-sw-comment-list] [data-sw-comment]').first()
    const id = await row.getAttribute('data-sw-comment')
    await row.click()
    await page.click(`[data-sw-thread-popover="${id}"] [data-sw-resolve]`)
    await page.waitForSelector('[data-sw-toast-undo]')
    await holdRequests(page, { method: 'POST', path: '/comments$', ms: 2500 })
    await startComment(page)
    const body = `Only once ${Date.now()}`
    await page.keyboard.type(body)
    await page.keyboard.press('Enter')
    // Undo answers at once, while the comment is still saving.
    await page.click('[data-sw-toast-undo]')
    await page.waitForTimeout(400)
    // Send again (the button, or Enter in the box).
    assert.equal(await page.locator('[data-sw-composer] [data-sw-save-comment]').isDisabled(), true, 'Post stays disabled while it saves')
    await page.focus('[data-sw-composer] [data-sw-comment-input]')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached', timeout: 10000 })
    await page.waitForTimeout(500)
    assert.equal(await commentsWith(page, FIRST, body), 1, 'posted once')
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('a Back that never lands does not freeze the address: the next change still lands', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `?board=${FIRST}`)
    await page.click('[data-sw-profile-menu]')
    await page.waitForSelector('[role="menu"]')
    // The browser drops the overlay's Back.
    await page.evaluate(() => {
      window.history.go = () => {}
    })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="menu"]', { state: 'detached' })
    await page.click('[data-sw-option="phone"]')
    await page.waitForFunction(() => new URLSearchParams(window.location.search).get('vp') === 'phone', null, { timeout: 4000 })
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

test('Reset is atomic and back to the start: a save during it is dropped, "Try this" and the read state come back', async () => {
  const { context, page, errors } = await open()
  try {
    await openBoard(page, `?board=${FIRST}`)
    // Close "Try this" for good, and make a change.
    await page.click('[data-sw-try-this="folded"]', { timeout: 10000 })
    await page.click('[data-sw-try-close]')
    await page.waitForSelector('[data-sw-try-this]', { state: 'detached' })
    await startComment(page)
    const body = `Before reset ${Date.now()}`
    await page.keyboard.type(body)
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
    assert.equal(await commentsWith(page, FIRST, body), 1)
    assert.ok(
      await page.evaluate(() => Object.keys(window.localStorage).some((key) => key.startsWith('shapewall.seen:'))),
      'read state kept',
    )
    // Reset; while the page is still leaving, the demo saves again (a late
    // poll, a batch step): that save must not bring the old demo back.
    await page.click('[data-sw-profile-menu]')
    await page.click('[data-sw-demo-reset-item]')
    await page.evaluate(() => {
      // Requests keep coming while the old page leaves; each is a demo save.
      window.setInterval(() => window.fetch('api/boards').catch(() => {}), 2)
    })
    await Promise.all([page.waitForEvent('load'), page.click('[data-sw-demo-reset-confirm]')])
    await page.waitForSelector('[data-sw-node="home"]', { timeout: 20000 })
    assert.equal(await commentsWith(page, FIRST, body), 0, 'the reset stuck')
    await page.waitForSelector('[data-sw-try-this]', { timeout: 10000 })
    assert.equal(await page.evaluate(() => window.localStorage.getItem('shapewall.demo.try')), null)
    assert.equal(await page.evaluate(() => Object.keys(window.localStorage).some((key) => key.startsWith('shapewall.seen:'))), false)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})
