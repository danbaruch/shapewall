// End to end, journey editing on the solo engine (G5, experimental): the real
// `shapewall serve --engine hosted`. The owner signs in with the one-time
// page, maps a journey on the board (New journey, click two pages, Save),
// renames it with "Edit this journey", and it is in the board's
// journeys.json in the engine's data folder. Screenshots at 1440x900 and
// 390x844 with SHAPEWALL_SHOTS=<dir>.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { SAMPLE, tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')

const HOME = tempDir('solo-journeys-e2e-home')
const ENV = {
  PATH: process.env.PATH,
  HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  SHAPEWALL_NO_BROWSER: '1',
  SHAPEWALL_USER_NAME: 'Robin Tester',
}

let projectDir
let engine
let boardUrl
let browser
let context
let page
const errors = []

const shot = async (target, name) =>
  SHOTS && target.screenshot({ path: path.join(SHOTS, `solo-journeys-${name}.png`), animations: 'disabled' })
const realErrors = () => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// The board's journeys.json in the engine's data folder (.shapewall/.engine/files/<ws>/<project>/<board>/).
function storedJourneys() {
  const [, ws, project] = /\/w\/([^/]+)\/p\/([^/]+)\//.exec(new URL(boardUrl).pathname)
  const file = path.join(projectDir, '.shapewall', '.engine', 'files', ws, project, 'sample', 'journeys.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).journeys : []
}

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the solo engine e2e test')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  projectDir = tempDir('solo-journeys-e2e-project')
  fs.writeFileSync(
    path.join(projectDir, 'shapewall.config.json'),
    JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes' }, null, 2),
  )
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
  page = await context.newPage()
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(/Sign in: open (file:\S+)/.exec(state.out)[1])
  await page.waitForURL((url) => url.href.startsWith(boardUrl))
})

after(async () => {
  await browser?.close()
  if (engine) await stopChild(engine.child, engine.exited)
})

test('the owner maps a journey on the engine board and renames it; it is stored in the engine’s board folder', async () => {
  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.click('[data-sw-sidebar-toggle]')
  await page.locator('[data-sw-sidebar-tab="journeys"]').click()
  await page.locator('[data-sw-journeys-empty]').click()
  const builder = page.locator('[data-sw-journey-builder]')
  await builder.waitFor()
  await page.fill('[data-sw-journey-name]', 'Upgrade to Plus')
  await page.locator('[data-sw-node="home"]').click()
  await page.locator('[data-sw-node="pricing"]').click()
  await until(
    async () => (await page.locator('[data-sw-journey-draft]').getAttribute('data-sw-journey-draft')) === 'home,pricing',
    'two steps',
  )
  await shot(page, 'builder-1440')
  await page.click('[data-sw-journey-save]')
  await builder.waitFor({ state: 'detached' })
  await until(() => storedJourneys().length === 1, 'the journey in journeys.json')
  assert.deepEqual(
    storedJourneys().map((journey) => [journey.id, journey.name, journey.steps]),
    [['upgrade-to-plus', 'Upgrade to Plus', ['home', 'pricing']]],
  )

  // Open it and rename it.
  await page.waitForSelector('[data-sw-journey-bar]')
  await shot(page, 'journey-1440')
  await page.locator('[data-sw-journey-bar] [aria-label="Edit this journey"]').click()
  await builder.waitFor()
  await page.fill('[data-sw-journey-name]', 'Upgrade')
  await page.click('[data-sw-journey-save]')
  await builder.waitFor({ state: 'detached' })
  await until(() => storedJourneys()[0]?.name === 'Upgrade', 'the rename in journeys.json')

  const phone = await context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(`${boardUrl}?j=upgrade-to-plus`)
  await phone.waitForSelector('[data-sw-journey-bar]')
  await shot(phone, 'journey-390')
  await phone.close()
  assert.deepEqual(realErrors(), [])
})
