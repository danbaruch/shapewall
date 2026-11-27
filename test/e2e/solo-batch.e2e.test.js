// End to end, batch fixes on the solo engine (G14a, experimental): the real
// `shapewall serve --engine hosted` in a git project with branch mode and
// batch fixes on in its config. The engine's own agent (`agent connect --as
// local`, the ACP stub on PATH as Claude Code's adapter) takes the fixes
// over the link. The owner signs in with the one-time page, picks two open
// comments in the comments panel's Select mode, confirms, answers each
// fix's edit card in the batch strip, and both comments end on a branch of
// their own; the checkout is untouched. Screenshots at 1440x900 and
// 390x844 with SHAPEWALL_SHOTS=<dir>.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { SAMPLE, pathWithoutAgents, tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { gitRepo } from '../hosted-chat-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')
const ACP_STUB = path.join(ROOT_DIR, 'test', 'fixtures', 'acp-stub.mjs')

const HOME = tempDir('solo-batch-e2e-home')
const ENV = {
  PATH: pathWithoutAgents(),
  HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  XDG_STATE_HOME: path.join(HOME, '.state'),
  SHAPEWALL_NO_BROWSER: '1',
  SHAPEWALL_USER_NAME: 'Robin Tester',
}

let projectDir
let git
let engine
let boardUrl
let apiBase
let browser
let context
let page
const errors = []

const shot = async (target, name) =>
  SHOTS && target.screenshot({ path: path.join(SHOTS, `solo-batch-${name}.png`), animations: 'disabled' })
const realErrors = () => errors.filter((text) => !/Failed to load resource|favicon/.test(text))

async function until(check, label, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// A folder with the ACP stub as Claude Code's adapter.
function stubBin() {
  const bin = tempDir('solo-batch-e2e-bin')
  fs.writeFileSync(path.join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec "${process.execPath}" "${ACP_STUB}" --ro-modes "$@"\n`, {
    mode: 0o755,
  })
  return bin
}

// The board API from the signed-in page itself (same origin, its own cookie).
const call = (method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      })
      return { status: response.status, json: await response.json().catch(() => null) }
    },
    { method, url, body },
  )

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the solo engine e2e test')
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  projectDir = tempDir('solo-batch-e2e-project')
  const config = {
    ...structuredClone(SAMPLE),
    title: 'Lumen Notes',
    agent: { branchMode: true, batchFixes: { enabled: true, max: 5 } },
  }
  git = gitRepo(projectDir, {
    'index.html': '<h1>Hello</h1>\n',
    'about.html': '<h1>Hello about</h1>\n',
    'shapewall.config.json': JSON.stringify(config, null, 2),
    '.gitignore': '.shapewall/\n',
  })
  const child = spawn(process.execPath, [CLI, 'serve', '--engine', 'hosted', '--port', '0', '--print-owner-link'], {
    cwd: projectDir,
    env: { ...ENV, PATH: `${stubBin()}${path.delimiter}${ENV.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { out: '', err: '' }
  child.stdout.on('data', (chunk) => (state.out += chunk))
  child.stderr.on('data', (chunk) => (state.err += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  engine = { child, state, exited }
  await until(() => /Sign in: open file:/.test(state.out), `the engine to start\n${state.out}\n${state.err}`)
  boardUrl = /serving 1 board at (\S+)/.exec(state.out)[1]
  apiBase = `${new URL(boardUrl).pathname.replace(/\/$/, '')}/api`
  await until(() => /Local agent: Connected/i.test(state.out + state.err), `the local agent\n${state.out}\n${state.err}`, 60_000)
  assert.match(state.out + state.err, /branch mode is on/)
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

test('the owner fixes two comments in one batch: Select, confirm, each edit allowed in the strip, two branches; the checkout is untouched', async () => {
  const head = git('rev-parse', 'HEAD')
  const made = []
  for (const [text, file] of [
    ['Say Hi on the home page', 'index.html'],
    ['Say Hi on the about page', 'about.html'],
  ]) {
    const answer = await call('POST', `${apiBase}/boards/sample/comments`, {
      pageId: 'home',
      viewport: 'desktop',
      x: 30 + made.length * 20,
      y: 30,
      body: `${text} [[stub-fix:${file}]]`,
    })
    assert.equal(answer.status, 201, JSON.stringify(answer.json))
    made.push(answer.json.comment)
  }
  const info = await call('GET', `${apiBase}/info`)
  assert.equal(info.json.soloFeatures.batchFixes, true)

  await page.goto(boardUrl)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.locator(`[data-sw-comment="${made[0].id}"]`).first().waitFor()
  await page.click('[data-sw-batch-select-mode]')
  for (const comment of made) await page.click(`[data-sw-batch-select="${comment.id}"]`)
  await page.locator('[data-sw-batch-count="2"]').waitFor()
  await shot(page, 'select-1440')
  await page.click('[data-sw-batch-fix="2"]')
  await page.locator('[data-sw-batch-confirm="2"]').waitFor()
  await shot(page, 'confirm-1440')
  await page.click('[data-sw-batch-start]')

  const strip = page.locator('[data-sw-batch-strip]')
  for (const [index, comment] of made.entries()) {
    // Each fix asks the owner before it edits: the batch waits with the card and its diff.
    const waiting = strip.locator(`[data-sw-batch-waiting="${comment.id}"]`)
    await waiting.waitFor({ timeout: 60_000 })
    if (index === 0) {
      await shot(page, 'waiting-1440')
      const phone = await context.newPage()
      await phone.setViewportSize({ width: 390, height: 844 })
      await phone.goto(boardUrl)
      await phone.waitForSelector('[data-sw-node="home"]')
      await phone.click('[data-sw-chat-toggle]')
      await phone.locator('[data-sw-chat-batch] [data-sw-batch-headline]').waitFor()
      await shot(phone, 'waiting-390')
      await phone.close()
    }
    await waiting.locator('[data-sw-batch-answer="allow"]').click()
    await waiting.waitFor({ state: 'detached', timeout: 30_000 })
  }
  await strip.locator('[data-sw-batch="done"]').waitFor({ timeout: 60_000 })
  await strip.locator('[data-sw-batch-toggle]').click()
  const states = await strip
    .locator('[data-sw-batch-item-state]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-sw-batch-item-state')))
  assert.deepEqual(states, ['fixed', 'fixed'])
  await shot(page, 'done-1440')

  // Each comment on a branch of its own; the person's checkout as it was.
  const comments = (await call('GET', `${apiBase}/boards/sample/comments`)).json.comments
  for (const comment of made) assert.equal(comments.find((item) => item.id === comment.id).agentStatus, 'branch-ready')
  const branches = git('branch', '--list', '--format=%(refname:short)')
    .split('\n')
    .filter((name) => name && name !== 'main')
  assert.equal(branches.length, 2, branches.join(', '))
  for (const branch of branches) assert.match(git('show', `${branch}:index.html`) + git('show', `${branch}:about.html`), /Hi there/)
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8'), '<h1>Hello</h1>\n')
  assert.equal(git('status', '--porcelain'), '')

  const phone = await context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(boardUrl)
  await phone.waitForSelector('[data-sw-node="home"]')
  await phone.click('[data-sw-chat-toggle]')
  await phone.locator('[data-sw-chat-batch] [data-sw-batch="done"]').waitFor()
  await shot(phone, 'done-390')
  await phone.close()
  assert.deepEqual(realErrors(), [])
})
