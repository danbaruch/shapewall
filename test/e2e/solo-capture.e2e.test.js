// End to end, capture on the solo engine (G3, experimental): the real
// `shapewall serve --engine hosted` in a project whose config points at the
// demo site. The owner signs in with the one-time page, presses "Capture
// now" on the board, and the frames appear: the engine captured in its own
// process, from the live config, through the capture browser's egress
// proxy, straight into its board folder (no push). Then an agent's
// recapture_pages over HTTP /mcp with a token the owner made recaptures one
// page. Screenshots at 1440x900 and 390x844 with SHAPEWALL_SHOTS=<dir>.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { request, tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')

const HOME = tempDir('solo-capture-e2e-home')
const ENV = {
  PATH: process.env.PATH,
  HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  SHAPEWALL_NO_BROWSER: '1',
  SHAPEWALL_USER_NAME: 'Robin Tester',
  // The engine's capture browser: the Chromium this test's Playwright has (HOME is a temporary folder).
  SHAPEWALL_BROWSER_PATH: process.env.SHAPEWALL_BROWSER_PATH || chromium.executablePath(),
}

let site
let engine
let origin
let boardUrl
let ids
let browser
let context
let page
const errors = []

const shot = async (target, name) =>
  SHOTS && target.screenshot({ path: path.join(SHOTS, `solo-capture-${name}.png`), animations: 'disabled' })
const realErrors = () => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the solo engine e2e test')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  site = await startDemoSite({ port: 0 })
  const projectDir = tempDir('solo-capture-e2e-project')
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  raw.title = 'Lumen Notes'
  raw.baseUrl = `http://localhost:${site.address().port}`
  delete raw.outputDir
  fs.writeFileSync(path.join(projectDir, 'shapewall.config.json'), JSON.stringify(raw, null, 2))
  const child = spawn(process.execPath, [CLI, 'serve', '--engine', 'hosted', '--port', '0', '--print-owner-link'], {
    cwd: projectDir,
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { out: '', err: '' }
  child.stdout.on('data', (chunk) => (state.out += chunk))
  child.stderr.on('data', (chunk) => (state.err += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  engine = { child, state, exited }
  await until(() => /Sign in: open file:/.test(state.out), `the engine to start\n${state.out}\n${state.err}`)
  boardUrl = /serving 1 board at (\S+)/.exec(state.out)[1]
  origin = new URL(boardUrl).origin
  const match = /\/w\/([^/]+)\/p\/([^/]+)\//.exec(new URL(boardUrl).pathname)
  ids = { workspace: match[1], project: match[2] }
  browser = await chromium.launch()
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(/Sign in: open (file:\S+)/.exec(state.out)[1])
  await page.waitForURL((url) => url.href.startsWith(boardUrl))
})

after(async () => {
  await browser?.close()
  if (engine) await stopChild(engine.child, engine.exited)
  await new Promise((resolve) => (site ? site.close(resolve) : resolve()))
})

const framesLoaded = (target) =>
  target.waitForFunction(
    () => {
      const images = [...document.querySelectorAll('[data-sw-frame] img')]
      return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
    },
    null,
    { timeout: 90_000 },
  )

test('Capture now on the engine board captures the app in place: no push, the frames appear', async () => {
  await page.goto(boardUrl)
  const capture = page.locator('[data-sw-toolbar-zone] [data-sw-capture]').first()
  await capture.waitFor()
  await shot(page, 'before-1440')
  await capture.click()
  await page.click('[data-sw-capture-confirm]')
  await framesLoaded(page)
  await until(async () => !(await capture.isDisabled()), 'the capture to finish', 90_000)
  await shot(page, 'captured-1440')
  const view = await page.evaluate(async (url) => (await fetch(url)).json(), `${boardUrl}api/boards/demo`)
  assert.equal(view.capture.state, 'done', JSON.stringify(view.capture))
  assert.ok(Object.keys(view.manifest.pages).length >= 7, 'every page of the config')

  const phone = await context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(boardUrl)
  await framesLoaded(phone)
  await shot(phone, 'captured-390')
  await phone.close()
  assert.doesNotMatch(engine.state.out + engine.state.err, /swp_|sw_session/)
  assert.deepEqual(realErrors(), [])
})

test('recapture_pages over HTTP /mcp with the owner’s token recaptures a page on the engine', async () => {
  const made = await page.request.post(`${origin}/api/workspaces/${ids.workspace}/projects/${ids.project}/tokens`, {
    data: { name: 'agent', scopes: ['read', 'reply', 'status', 'push'] },
    headers: { Origin: origin },
  })
  assert.equal(made.status(), 201, await made.text())
  const token = (await made.json()).token
  const port = Number(new URL(origin).port)
  const call = (method, params) =>
    request(port, 'POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method, params },
      headers: { Host: new URL(origin).host, Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' },
    })
  const listed = await call('tools/list', {})
  assert.ok(
    listed.json.result.tools.some((tool) => tool.name === 'recapture_pages'),
    listed.text,
  )
  const answer = await call('tools/call', { name: 'recapture_pages', arguments: { pageIds: ['home'] } })
  assert.equal(answer.status, 200, answer.text)
  const result = JSON.parse(answer.json.result.content[0].text)
  assert.equal(result.ok, true, answer.text)
  assert.ok(
    Object.values(result.pages.home).every((value) => value === 'ok'),
    answer.text,
  )
  assert.ok(result.compare.length > 0)
  assert.ok(result.compare.every((entry) => entry.link.startsWith(boardUrl)))
  assert.doesNotMatch(engine.state.out + engine.state.err, /swp_/)
})
