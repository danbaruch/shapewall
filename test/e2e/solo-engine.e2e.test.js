// End to end, the solo engine (experimental): the real `shapewall serve
// --engine hosted` on this machine, as a person runs it in their project.
// The one-time sign-in page signs a real browser in on the project's own
// http://<project>.shapewall.localhost origin and the board opens; that
// cookie is not sent to 127.0.0.1 or localhost on the same port (PR #53
// review, F5). `shapewall login --remote` is approved on /device by the
// terminal-signed-in owner; `shapewall push` uploads the captures; a
// comment, a reply and a resolve on the board; a reply from the command
// line (`comments reply --remote`); and `agent connect --remote` with the
// ACP stub standing in for Claude Code's adapter, which answers on the
// board's chat.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { SAMPLE, tempDir } from '../helpers.js'
import { writeLocalCaptures } from '../hosted-helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { loadConfig } from '../../src/config.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')
const ACP_STUB = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')

let projectDir
let config
let engine // the serve child
let origin
let boardUrl
let browser
let context
let page
const errors = []
const children = []

const HOME = tempDir('solo-e2e-home')
const ENV = {
  PATH: process.env.PATH,
  HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  SHAPEWALL_NO_BROWSER: '1',
  SHAPEWALL_USER_NAME: 'Robin Tester',
}

const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `solo-${name}.png`), animations: 'disabled' })
const realErrors = () => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function run(args, { env = {}, cwd = projectDir } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const state = { out: '', err: '' }
  child.stdout.on('data', (chunk) => (state.out += chunk))
  child.stderr.on('data', (chunk) => (state.err += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const entry = { child, state, exited, close: () => stopChild(child, exited) }
  children.push(entry)
  return entry
}
const finished = async (entry, label) => {
  const { code } = await entry.exited
  assert.equal(code, 0, `${label}\n${entry.state.out}\n${entry.state.err}`)
  return entry.state.out + entry.state.err
}

// The owner approves a terminal's code on /device in the signed-in browser.
async function approve(code, { agent = false } = {}) {
  await page.goto(`${origin}/device`)
  await page.fill('[data-sw-device-code]', code)
  await page.click('[data-sw-device-lookup]')
  await page.waitForSelector(agent ? '[data-sw-device-agent]' : '[data-sw-device-approve]')
  await shot(agent ? 'device-agent' : 'device-login')
  await page.click('[data-sw-device-approve]')
  await page.waitForSelector('[data-sw-device-done="approved"]')
}
const CODE_RE = /[A-Z]{4}-[A-Z]{4}/

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the solo engine e2e test')
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'console', 'console.html')), 'run "npm run build" before the solo engine e2e test')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  projectDir = tempDir('solo-e2e-project')
  fs.writeFileSync(
    path.join(projectDir, 'shapewall.config.json'),
    JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes' }, null, 2),
  )
  config = loadConfig(path.join(projectDir, 'shapewall.config.json'))
  writeLocalCaptures(config, 'sample')
  engine = run(['serve', '--engine', 'hosted', '--port', '0', '--print-owner-link'])
  await until(() => /Sign in: open file:/.test(engine.state.out), `the engine to start\n${engine.state.out}\n${engine.state.err}`)
  boardUrl = /serving 1 board at (\S+)/.exec(engine.state.out)[1]
  origin = new URL(boardUrl).origin
  assert.match(origin, /^http:\/\/lumen-notes-[a-z2-7]{14}\.shapewall\.localhost:\d+$/)
  browser = await chromium.launch()
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', (error) => errors.push(error.message))
})

after(async () => {
  for (const entry of children.reverse()) await entry.close()
  await browser?.close()
})

test('the one-time sign-in page signs the browser in on the project origin, once; the cookie stays on that origin', async () => {
  const link = /Sign in: open (file:\S+)/.exec(engine.state.out)[1]
  const file = fileURLToPath(link)
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  assert.doesNotMatch(
    engine.state.out + engine.state.err,
    new RegExp(`swp_|sw_session|${nonce}`),
    'no token, cookie or nonce in the output',
  )
  // A copy, to try the used page again below (the engine removes its own once used).
  const copy = path.join(tempDir('solo-e2e-copy'), 'again.html')
  fs.copyFileSync(file, copy)
  await page.goto(link)
  await page.waitForURL((url) => url.href.startsWith(boardUrl))
  await page.waitForSelector('[data-sw-board], [data-sw-node], [data-sw-empty-board]')
  await shot('board-signed-in')

  // F5: a host-only cookie on the project's name; nothing for the bare loopback names on the same port.
  const port = new URL(origin).port
  const cookies = await context.cookies(origin)
  const session = cookies.find((cookie) => cookie.name === 'sw_session')
  assert.ok(session, 'signed in')
  assert.equal(session.domain, new URL(origin).hostname)
  assert.equal(session.httpOnly, true)
  assert.ok(session.expires > 0 && session.expires * 1000 < Date.now() + 25 * 3_600_000, 'a short-lived cookie')
  assert.deepEqual(await context.cookies(`http://127.0.0.1:${port}`), [])
  assert.deepEqual(await context.cookies(`http://localhost:${port}`), [])
  const bare = await context.newPage()
  const me = await bare.goto(`http://127.0.0.1:${port}/auth/me`)
  assert.equal((await me.json()).user, null, 'not signed in on 127.0.0.1')
  await bare.close()

  assert.equal(session.sameSite, 'Strict')
  assert.equal(fs.existsSync(file), false, 'the page is removed once used')

  // rev54 F1: a link on another site to the engine's name never carries the cookie (SameSite=Strict).
  const lure = http.createServer((req, res) => res.end(`<a id="go" href="${origin}/auth/me">go</a>`))
  await new Promise((resolve) => lure.listen(0, '127.0.0.1', resolve))
  try {
    const other = await context.newPage()
    await other.goto(`http://127.0.0.1:${lure.address().port}/`)
    const [landed] = await Promise.all([other.waitForNavigation(), other.click('#go')])
    assert.equal((await landed.json()).user, null, 'a cross-site link arrives signed out')
    await other.close()
  } finally {
    lure.close()
  }

  // Used up: the same page again signs nobody in.
  const second = await browser.newContext()
  const againPage = await second.newPage()
  const gone = againPage.waitForResponse((response) => response.url().endsWith('/open'))
  await againPage.goto(pathToFileURL(copy).href)
  assert.equal((await gone).status(), 410)
  assert.deepEqual(await second.cookies(origin), [])
  await second.close()
})

test('shapewall login --remote, approved on /device; push; a comment, a reply and a resolve on the board; a reply from the command line', async () => {
  const login = run(['login', '--remote', origin])
  await until(() => CODE_RE.test(login.state.out + login.state.err), `the login code\n${login.state.out}\n${login.state.err}`)
  await approve(CODE_RE.exec(login.state.out + login.state.err)[0])
  await finished(login, 'login')

  const pushed = await finished(run(['push', '--remote', origin, '--config', config.file]), 'push')
  assert.match(pushed, /Board: /)

  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('[data-sw-frame] img')]
    return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
  })
  const frame = page.locator('[data-sw-frame^="home:"]').first()
  await page.click('[data-sw-comment-mode]')
  const box = await frame.boundingBox()
  await page.mouse.click(box.x + box.width / 3, box.y + box.height / 3)
  await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
  assert.equal(await page.locator('[data-sw-comment-author]').count(), 0, 'signed in: no name field')
  await page.fill('[data-sw-comment-input]', 'Tighten the header spacing')
  await page.click('[data-sw-save-comment]')
  await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
  const pin = page.locator('[data-sw-pin]').first()
  await pin.waitFor()
  const id = await pin.getAttribute('data-sw-pin')
  await shot('comment')

  // The command line reads it with the saved login and replies.
  const listed = await finished(run(['comments', 'list', '--remote', origin, '--board', 'sample', '--json']), 'comments list')
  assert.match(listed, /Tighten the header spacing/)
  await finished(
    run(['comments', 'reply', id, '--remote', origin, '--board', 'sample', '--body', 'Done in the header component']),
    'comments reply --remote',
  )

  await page.reload()
  await page.waitForSelector(`[data-sw-pin="${id}"]`)
  await page.click(`[data-sw-pin="${id}"]`)
  const popover = `[data-sw-thread-popover="${id}"]`
  await page.waitForSelector(`${popover} [data-sw-reply-input]`)
  await page.waitForSelector(`${popover} >> text=Done in the header component`)
  await page.click(`${popover} [data-sw-reply-input]`)
  await page.keyboard.type('Looks right, thanks')
  await page.keyboard.press('Enter')
  await page.waitForSelector(`${popover} >> text=Looks right, thanks`)
  await page.click(`${popover} [data-sw-resolve="${id}"]`)
  await page
    .waitForSelector(`${popover} [data-sw-reopen="${id}"], [data-sw-pin="${id}"][data-sw-pin-resolved]`, { timeout: 10_000 })
    .catch(() => {})
  await shot('resolved')

  const after = JSON.parse(
    await finished(run(['comments', 'list', '--remote', origin, '--board', 'sample', '--json', '--all']), 'comments list --all'),
  )
  const stored = (after.comments || after).find((item) => String(item.id) === String(id))
  assert.equal(stored.status, 'resolved')
  assert.deepEqual(
    stored.replies.map((reply) => reply.body),
    ['Done in the header component', 'Looks right, thanks'],
  )
  assert.deepEqual(realErrors(), [])
})

test('agent connect --remote with the ACP stub: approved on /device, then it answers on the board chat', async () => {
  const bin = tempDir('solo-e2e-bin')
  fs.writeFileSync(path.join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec "${process.execPath}" "${ACP_STUB}" --ro-modes "$@"\n`, {
    mode: 0o755,
  })
  const agent = run(['agent', 'connect', '--remote', origin, '--agent', 'claude', '--name', 'Builder'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  })
  await until(() => CODE_RE.test(agent.state.out), `the agent code\n${agent.state.out}\n${agent.state.err}`)
  assert.doesNotMatch(agent.state.out + agent.state.err, /swp_/)
  await approve(CODE_RE.exec(agent.state.out)[0], { agent: true })
  await until(() => /Connected: Builder/.test(agent.state.err), `the link\n${agent.state.out}\n${agent.state.err}`)

  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-chat-toggle]')
  await page.click('[data-sw-chat-toggle]')
  const row = page.locator('[data-sw-hosted-agent-name="Builder"]')
  await row.waitFor()
  assert.equal(await row.getAttribute('data-sw-agent-state'), 'online')
  await row.locator('[data-sw-hosted-agent-chat]').click()
  await page.waitForSelector('[data-sw-chat-input]')
  await page.fill('[data-sw-chat-input]', 'What is on the home page?')
  const ask = page.locator('[data-sw-chat-ask]')
  await page.click((await ask.count()) ? '[data-sw-chat-ask]' : '[data-sw-chat-send]')
  await until(
    async () =>
      /Hello from the ACP stub/.test(
        (await page
          .locator('[data-sw-chat-message="assistant"]')
          .last()
          .textContent()
          .catch(() => '')) || '',
      ),
    'the stub to answer',
  )
  await shot('chat')
  assert.deepEqual(realErrors(), [])
})
