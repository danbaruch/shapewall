// End to end, the solo engine (experimental) with live HTML and the starter
// agent: the real `shapewall serve --engine hosted` in a project whose
// config points at the demo site.
//
// - G17: live HTML on the engine comes from its separate usercontent origin
//   (http://uc.<label>-<key>.shapewall.localhost:<port>), never the board's
//   own origin: the board frames it opaque (sandbox=""), cannot read its
//   document, and the board's origin answers /uc/ with 404.
// - G21: the sandboxed starter agent (src/agent/starter, as `shapewall agent
//   sandbox run --remote <engine>` runs it) works against the engine with a
//   token the owner made: it reads the comment, asks for a shell command, the
//   owner approves it on the engine board, it edits a fixture repo, opens a
//   (mocked) pull request and replies; the comment ends "done". The
//   container runtime and the model are stand-ins (test/fixtures), as in
//   the hosted e2e test.
// Screenshots at 1440x900 and 390x844 with SHAPEWALL_SHOTS=<dir>.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { loadConfig } from '../../src/config.js'
import { createRemote } from '../../src/remote/remote.js'
import { pinSoloLoopback } from '../../src/remote/loopback-pin.js'
import { remoteSource } from '../../src/agent/starter/source.js'
import { starterSettings } from '../../src/agent/starter/settings.js'
import { runStarter } from '../../src/agent/starter/supervisor.js'
import { startStarterStub } from '../fixtures/starter-model-stub.mjs'
import { hostedStarterRuntime } from '../fixtures/hosted-starter-runtime.mjs'
import { pathWithoutAgents, tempDir } from '../helpers.js'
import { stopChild } from '../child-process-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const CLI = path.join(ROOT_DIR, 'bin', 'shapewall.js')

const HOME = tempDir('solo-starter-e2e-home')
// No agent on PATH and no model in the project config: the engine starts no agent of its own, so the starter takes the comment.
const ENV = {
  PATH: pathWithoutAgents(),
  HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  XDG_STATE_HOME: path.join(HOME, '.state'),
  SHAPEWALL_NO_BROWSER: '1',
  SHAPEWALL_USER_NAME: 'Robin Tester',
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
  SHOTS && target.screenshot({ path: path.join(SHOTS, `solo-starter-${name}.png`), animations: 'disabled' })
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
  const projectDir = tempDir('solo-starter-e2e-project')
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  raw.title = 'Lumen Notes'
  raw.baseUrl = `http://localhost:${site.address().port}`
  delete raw.outputDir
  delete raw.agent
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
  // Captures, in the engine's own process (G3), so the board has frames and live HTML.
  const captured = await page.request.post(`${boardUrl}api/boards/demo/capture`, { data: {}, headers: { Origin: origin } })
  assert.equal(captured.status(), 202, await captured.text())
  await until(
    async () => (await (await page.request.get(`${boardUrl}api/boards/demo`)).json()).capture?.state === 'done',
    'the capture to finish',
    120_000,
  )
})

after(async () => {
  await browser?.close()
  if (engine) await stopChild(engine.child, engine.exited)
  await new Promise((resolve) => (site ? site.close(resolve) : resolve()))
})

test('G17: live HTML on the engine comes from its usercontent origin, opaque; the board origin never serves /uc/', async () => {
  await page.goto(boardUrl)
  const frame = '[data-sw-frame="pricing:desktop"]'
  await page.waitForSelector(frame)
  await page.click(frame)
  await page.click('[data-sw-open-live="pricing|desktop"]')
  await page.waitForSelector(`${frame}[data-sw-live="ready"]`, { timeout: 20_000 })
  // An opaque frame: the board cannot read it; pins come from the element map the capture wrote.
  assert.equal(await page.getAttribute(`${frame} iframe`, 'sandbox'), '')
  assert.equal(await page.getAttribute(frame, 'data-sw-live-anchors'), 'map')
  assert.equal(await page.evaluate((selector) => document.querySelector(`${selector} iframe`).contentDocument, frame), null)
  const loaded = page.frames().find((item) => item.url().includes('/uc/'))
  assert.ok(loaded, 'the live frame loaded from /uc/')
  const live = new URL(loaded.url())
  assert.equal(live.host, `uc.${new URL(origin).host}`, 'the separate usercontent origin, not the board’s')
  assert.match(live.pathname, /^\/uc\/ws_[a-f0-9]{24}\/pr_[a-f0-9]{24}\/demo\/captures\/pricing\.desktop\.html$/)
  await shot(page, 'live-1440')
  // The same signed URL on the board's own origin: 404. The usercontent host serves nothing but /uc/.
  const onBoard = await page.request.get(`${origin}${live.pathname}${live.search}`)
  assert.equal(onBoard.status(), 404)
  const ucRoot = await page.request.get(`${live.origin}/`)
  assert.equal(ucRoot.status(), 404)
  assert.equal(ucRoot.headers()['set-cookie'], undefined)
  // The live HTML response: sandboxed, framed only by the board's origin.
  const answer = await page.request.get(loaded.url())
  assert.equal(answer.status(), 200)
  assert.match(answer.headers()['content-security-policy'], /(^|; )sandbox(;|$)/)
  assert.match(answer.headers()['content-security-policy'], new RegExp(`frame-ancestors ${origin.replace(/\./g, '\\.')}`))
  // The engine does not offer the DOM fallback (it needs a frame the board can read, which a separate origin rules out).
  const info = await (await page.request.get(`${boardUrl}api/info`)).json()
  assert.notEqual(info.soloFeatures?.domFallback, true)

  const phone = await context.newPage()
  try {
    await phone.setViewportSize({ width: 390, height: 844 })
    await phone.goto(boardUrl)
    await phone.waitForFunction(() => {
      const images = [...document.querySelectorAll('[data-sw-frame] img')]
      return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0)
    })
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true)
    await shot(phone, 'board-390')
  } finally {
    await phone.close()
  }
  assert.deepEqual(realErrors(), [])
})

test('G21: the starter agent works against the engine: approval on the board, a fixture edit, a mocked pull request, done', async () => {
  // The CLI pins the engine's *.shapewall.localhost name to 127.0.0.1 for every connection (src/cli.js); so does this process.
  await pinSoloLoopback()
  const made = await page.request.post(`${origin}/api/workspaces/${ids.workspace}/projects/${ids.project}/tokens`, {
    data: { name: 'Starter agent', scopes: ['read', 'reply', 'status', 'claim'] },
    headers: { Origin: origin },
  })
  assert.equal(made.status(), 201, await made.text())
  const { token } = await made.json()
  const api = `${boardUrl}api/boards/demo`
  const posted = await page.request.post(`${api}/comments`, {
    data: { pageId: 'home', viewport: 'desktop', x: 20, y: 20, body: 'Create the approved fixture marker' },
    headers: { Origin: origin },
  })
  assert.equal(posted.status(), 201, await posted.text())
  const { comment } = await posted.json()

  const stub = await startStarterStub({
    script: [
      { tools: [{ name: 'run_shell', args: { command: 'echo fixture > approved.txt', reason: 'Write a test marker' } }] },
      { text: 'Fixture done.' },
    ],
  })
  const dir = fs.realpathSync(tempDir('solo-starter-e2e-repo'))
  const bare = fs.realpathSync(tempDir('solo-starter-e2e-remote'))
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
      id: 'demo',
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
  const remote = createRemote({ origin, token })
  const source = await remoteSource(remote, 'demo')
  assert.equal(source.hosted, true, 'the engine is a hosted source to the starter')
  const prs = []
  const controller = new AbortController()
  const running = runStarter({
    signal: controller.signal,
    source,
    settings: starterSettings(config, { env: {} }),
    runtime: hostedStarterRuntime(),
    image: 'fixture',
    projectDir: dir,
    workDir: fs.realpathSync(tempDir('solo-starter-e2e-work')),
    commentId: comment.id,
    env: {},
    log: () => {},
    pr: async (info) => {
      prs.push(info)
      return { number: 1, url: 'https://example.invalid/pull/1' }
    },
  })
  try {
    await page.goto(`${boardUrl}?board=demo`)
    const approve = page.getByRole('button', { name: 'Approve once' })
    await approve.waitFor({ timeout: 30_000 })
    await shot(page, 'approval-1440')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector('[data-sw-toolbar="compact"]')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the approval board fits at 390')
    await shot(page, 'approval-390')
    await approve.click()
    const result = await running
    assert.equal(result.failure, null, JSON.stringify(result))
    assert.deepEqual(result.files, ['approved.txt'])
    assert.equal(prs.length, 1, 'the pull request adapter ran once; no real pull request')
    assert.match(git(bare, 'show', `${result.branch}:approved.txt`), /fixture/)
    assert.match(result.reply, /https:\/\/example.invalid\/pull\/1/)
    const after = (await remote.comment('demo', comment.id)).comment
    assert.equal(after.agentStatus, 'done')
    // The reply is on the engine board, from the starter's token.
    assert.ok(
      (after.replies || []).some((reply) => /example\.invalid\/pull\/1/.test(reply.body)),
      JSON.stringify(after).slice(0, 800),
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    await shot(page, 'done-1440')
  } finally {
    controller.abort()
    await running.catch(() => {})
    await stub.close()
  }
  assert.doesNotMatch(engine.state.out + engine.state.err, /swp_|sw_session/)
  assert.deepEqual(realErrors(), [])
})
