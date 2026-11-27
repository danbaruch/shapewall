// End to end, checks on the solo engine (G6, experimental): the real
// `shapewall serve --engine hosted` in a project whose config points at the
// demo site. The owner signs in with the one-time page, captures, opens
// Checks on the board and starts a run with SEO: the engine checks in its
// own process, in a browser that reaches the app origin only, and the
// panel shows the result and the SEO tab's search previews from that run.
// A second origin the demo pages would load from is never reached.
// Screenshots at 1440x900 and 390x844 with SHAPEWALL_SHOTS=<dir>.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { pathWithoutAgents, tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')

const HOME = tempDir('solo-checks-e2e-home')
// No agent on PATH: the engine starts no agent of its own here.
const ENV = {
  PATH: pathWithoutAgents(),
  HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  SHAPEWALL_NO_BROWSER: '1',
  SHAPEWALL_USER_NAME: 'Robin Tester',
  // The engine's browsers: the Chromium this test's Playwright has (HOME is a temporary folder).
  SHAPEWALL_BROWSER_PATH: process.env.SHAPEWALL_BROWSER_PATH || chromium.executablePath(),
}

let site
let other // a second origin on this machine that no check may reach
const otherHits = []
let engine
let origin
let boardUrl
let browser
let context
let page
const errors = []

const shot = async (target, name) =>
  SHOTS && target.screenshot({ path: path.join(SHOTS, `solo-checks-${name}.png`), animations: 'disabled' })
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
  other = http.createServer((req, res) => {
    otherHits.push(req.url)
    res.end('no')
  })
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
  const projectDir = tempDir('solo-checks-e2e-project')
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  raw.title = 'Lumen Notes'
  raw.baseUrl = `http://localhost:${site.address().port}`
  delete raw.outputDir
  // The app pages are private; the rest get SEO. Home also asks the second origin for a script, from the page itself.
  for (const item of raw.pages) if (['login', 'dashboard'].includes(item.id)) item.seo = { indexable: false }
  const home = raw.pages.find((item) => item.id === 'home')
  home.actions = [
    ...(home.actions || []),
    { waitForFunction: `(fetch('http://127.0.0.1:PORT/beacon').catch(() => {}), true)`.replace('PORT', String(other.address().port)) },
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
  origin = new URL(boardUrl).origin
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
  await new Promise((resolve) => (other ? other.close(resolve) : resolve()))
})

async function openChecks(target, width) {
  if (width < 1024) await target.locator('[data-sw-menu]').click()
  await target.getByRole('button', { name: 'Checks', exact: true }).click()
  await target.locator('[data-sw-checks-panel]').waitFor()
}

test('the owner runs checks with SEO from the engine board; the SEO tab shows the run’s previews', async () => {
  // Captures first, so the board has frames (in-process capture, G3).
  const captured = await page.request.post(`${boardUrl}api/boards/demo/capture`, { data: {}, headers: { Origin: origin } })
  assert.equal(captured.status(), 202, await captured.text())
  await until(
    async () => {
      const view = await (await page.request.get(`${boardUrl}api/boards/demo`)).json()
      return view.capture?.state === 'done'
    },
    'the capture to finish',
    120_000,
  )
  await page.goto(boardUrl)
  const info = await (await page.request.get(`${boardUrl}api/info`)).json()
  assert.equal(info.soloFeatures.checksRun, true)
  await openChecks(page, 1440)
  const panel = page.locator('[data-sw-checks-panel]')
  await panel.getByRole('tab', { name: 'SEO' }).click()
  await panel.locator('[data-sw-checks-run-open]').click()
  assert.equal(await panel.locator('[data-sw-checks-run-seo]').getAttribute('aria-pressed'), 'true')
  const started = page.waitForResponse((r) => r.url().endsWith('/checks/run') && r.request().method() === 'POST')
  await panel.locator('[data-sw-checks-run-start]').click()
  assert.equal((await started).status(), 202)
  await panel.locator('[data-sw-checks-run-progress]').waitFor()
  await shot(page, 'progress-1440')
  await panel.locator('[data-sw-checks-run-result]').waitFor({ timeout: 240_000 })
  assert.match(await panel.locator('[data-sw-checks-run-result]').textContent(), /Checked \d+ page views/)
  const home = panel.locator('[data-sw-seo-page="home"]')
  await home.locator('[data-sw-seo-serp]').waitFor()
  assert.equal(await home.locator('[data-sw-seo-serp-title]').textContent(), 'Lumen Notes -- notes that think with you')
  assert.equal(await panel.locator('[data-sw-seo-page="login"]').getAttribute('data-sw-seo-status'), 'private')
  await shot(page, 'seo-1440')
  assert.deepEqual(otherHits, [], 'the check browser reached the app origin only')
  assert.doesNotMatch(engine.state.out + engine.state.err, /swp_|sw_session/)
  assert.deepEqual(realErrors(), [])
})

test('the SEO tab after the run on a phone at 390x844', async () => {
  const phone = await context.newPage()
  try {
    await phone.setViewportSize({ width: 390, height: 844 })
    await phone.goto(`${boardUrl}?checks=all&ct=seo`)
    const panel = phone.locator('[data-sw-checks-panel]')
    await panel.locator('[data-sw-seo-page="home"] [data-sw-seo-serp]').waitFor()
    await phone.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await shot(phone, 'seo-390')
  } finally {
    await phone.close()
  }
})
