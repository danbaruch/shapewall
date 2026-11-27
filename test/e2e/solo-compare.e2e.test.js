// End to end, environments and compare on the solo engine (G4,
// experimental): the real `shapewall serve --engine hosted` in a project
// whose config has two environments (Staging, the default, and
// Production) on the demo site. The command line in the folder captures
// both and `shapewall push` sends them to the engine, which keeps both; the
// owner opens compare, the diff answers, and a comment placed on the
// Production side is stored on production with its pin there (as a local
// board, compare-comments.e2e). Then the engine captures Production itself
// (POST capture { env }). Screenshots at 1440x900 and 390x844 with
// SHAPEWALL_SHOTS=<dir>.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')

const HOME = tempDir('solo-compare-e2e-home')
const ENV = {
  PATH: process.env.PATH,
  HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  SHAPEWALL_NO_BROWSER: '1',
  SHAPEWALL_USER_NAME: 'Robin Tester',
  // The capture browser (the command line's and the engine's): this test's Playwright Chromium.
  SHAPEWALL_BROWSER_PATH: process.env.SHAPEWALL_BROWSER_PATH || chromium.executablePath(),
}

let site
let projectDir
let engine
let boardUrl
let browser
let context
let page
const errors = []

const shot = async (target, name) =>
  SHOTS && target.screenshot({ path: path.join(SHOTS, `solo-compare-${name}.png`), animations: 'disabled' })
const realErrors = () => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// The command line in the project folder (it targets the running engine).
function cli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: projectDir, env: ENV, encoding: 'utf8', timeout: 180_000 })
  assert.equal(result.status, 0, `shapewall ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

const api = (pathname, init) =>
  page.evaluate(
    async ([url, options]) => {
      const response = await fetch(url, options)
      return { status: response.status, json: await response.json().catch(() => null) }
    },
    [`${boardUrl}api/${pathname}`, init || {}],
  )

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the solo engine e2e test')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  site = await startDemoSite({ port: 0 })
  projectDir = tempDir('solo-compare-e2e-project')
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  raw.title = 'Lumen Notes'
  delete raw.baseUrl
  delete raw.outputDir
  // A smaller board: compare and capture stay quick.
  raw.pages = raw.pages.filter((item) => ['home', 'pricing', 'blog'].includes(item.id))
  raw.journeys = []
  raw.environments = [
    { id: 'staging', title: 'Staging', baseUrl: `http://localhost:${site.address().port}` },
    { id: 'production', title: 'Production', baseUrl: `http://127.0.0.1:${site.address().port}` },
  ]
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
  browser = await chromium.launch()
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    if (window === window.top) window.localStorage.setItem('shapewall.tip.board', '1')
  })
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

// The camera has stopped moving.
async function settle(target) {
  let last = null
  for (let tries = 0; tries < 40; tries += 1) {
    const now = await target.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform)
    if (now === last) return
    last = now
    await target.waitForTimeout(150)
  }
}

test('push from the folder keeps both environments; compare shows them, and a comment on Production stays there', async () => {
  cli(['capture'])
  cli(['capture', '--env', 'production'])
  const pushed = cli(['push'])
  assert.match(pushed, /Pushed \d+ files/)

  const view = await api('boards/demo')
  assert.equal(view.status, 200)
  assert.deepEqual(
    view.json.environments.map((env) => [env.id, Boolean(env.capturedAt)]),
    [
      ['staging', true],
      ['production', true],
    ],
  )
  const compare = await api('boards/demo/compare?a=staging&b=production')
  assert.equal(compare.status, 200, JSON.stringify(compare.json))
  assert.equal(compare.json.pages.home.desktop.status, 'ok')

  await page.goto(`${boardUrl}?cmp=staging_production`)
  await page.waitForSelector('[data-sw-compare-bar="staging_production"]')
  await page.waitForSelector('[data-sw-frame="home:desktop:production"]')
  await framesLoaded(page)
  await settle(page)
  await shot(page, 'compare-1440')

  // Comment mode, a click on the Production side of Home.
  await page.keyboard.press('c')
  await page.waitForSelector('[data-sw-comment-mode][aria-pressed="true"]')
  const box = await page.$eval('[data-sw-frame="home:desktop:production"]', (node) => node.getBoundingClientRect().toJSON())
  await page.mouse.click(box.left + box.width * 0.5, box.top + box.height * 0.3)
  await page.waitForSelector('[data-sw-composer-popover] [data-sw-comment-input]')
  assert.match(await page.textContent('[data-sw-composer-popover]'), /Production/)
  await page.keyboard.type('Production still shows the old hero')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-sw-composer]', { state: 'detached' })
  const comments = await api('boards/demo/comments')
  const made = comments.json.comments.find((item) => item.body === 'Production still shows the old hero')
  assert.ok(made, JSON.stringify(comments.json))
  assert.equal(made.environment, 'production')
  assert.equal(made.captureVersion, null, 'only the default environment keeps versions')
  await page.waitForSelector(`[data-sw-pin="${made.id}"]`)
  const frame = await page.$eval(`[data-sw-pin="${made.id}"]`, (node) => node.closest('[data-sw-frame]')?.getAttribute('data-sw-frame'))
  assert.equal(frame, 'home:desktop:production')
  await shot(page, 'compare-comment-1440')

  const phone = await context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(`${boardUrl}?cmp=staging_production`)
  await phone.waitForSelector('[data-sw-compare-bar="staging_production"]')
  await framesLoaded(phone)
  await settle(phone)
  await shot(phone, 'compare-390')
  await phone.close()
  assert.deepEqual(realErrors(), [])
})

test('the engine captures Production itself, into that environment', async () => {
  const before = (await api('boards/demo')).json.environments.find((env) => env.id === 'production').capturedAt
  const started = await api('boards/demo/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: 'production' }),
  })
  assert.equal(started.status, 202, JSON.stringify(started.json))
  await until(
    async () => {
      const view = (await api('boards/demo')).json
      return !view.capture.running && view.capture.state === 'done'
    },
    'the capture to finish',
    120_000,
  )
  const after = (await api('boards/demo')).json.environments.find((env) => env.id === 'production').capturedAt
  assert.ok(after && after > before, `${before} -> ${after}`)
  assert.deepEqual(realErrors(), [])
})
