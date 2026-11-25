// End to end: follow an agent (client/src/board/followAgent.js), on a local
// board and on a loopback hosted board, at desktop (1440) and phone (390)
// widths. A stand-in agent (the local store, or a claim token on the hosted
// token API) takes a comment: the following viewer flies to its pin. It then
// recaptures that comment's page and another one: before and after opens for
// the comment's screen only, the other screens wait in a quiet "more screens
// changed" menu. Pressing the canvas stops following. The local viewer has no
// owner link (a plain tab, a visitor); the hosted one is a signed-in member.
// No console errors. Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { normalizeConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { createComment, setAgentStatus } from '../../src/store.js'
import { clearServeState, writeServeState } from '../../src/serve-state.js'
import { openCommand } from '../../src/cli/open-command.js'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { tempDir } from '../helpers.js'
import { createProject, createToken, signUp, startHostedServer } from '../hosted-helpers.js'
import { ROOT_DIR, listen } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const DESKTOP = { viewport: { width: 1440, height: 900 } }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
let site
let config
let server
let browser
let hosted
let owner
let project
let remote
let tokenFile
let agentId

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the follow e2e test')
  site = await startDemoSite({ port: 0 })
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  const dir = path.join(ROOT_DIR, 'test', '.output', 'follow-agent-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  raw.baseUrl = `http://127.0.0.1:${site.address().port}`
  raw.outputDir = path.join(dir, '.shapewall')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  config = normalizeConfig(raw, { dir, file })
  await runCapture({ config, log: () => {} })
  server = await listen(createApp({ config }))
  writeServeState(config, `http://127.0.0.1:${server.address().port}/`)

  hosted = await startHostedServer('follow-agent-e2e', { signup: 'open', clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  owner = await signUp(hosted, { handle: 'follow-owner', displayName: 'Follow Owner' })
  project = await createProject(owner, owner.workspaceId, 'Follow')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply', 'status', 'claim', 'push'])
  remote = createRemote({ origin: hosted.origin, token })
  await pushBoard()
  tokenFile = path.join(tempDir('follow-agent-token'), 'token')
  fs.writeFileSync(tokenFile, token)
  // The token is the project's agent (src/hosted/agents.js): its id is what a follow link names.
  const agents = await owner.browser.get(`/w/${owner.workspaceId}/p/${project.id}/api/boards/demo/agents`)
  assert.equal(agents.status, 200, agents.text)
  agentId = agents.json.agents[0].id
  assert.ok(agentId)
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  if (config) clearServeState(config)
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  await hosted?.close()
  await new Promise((resolve) => (site ? site.close(resolve) : resolve()))
})

// The local captures, pushed to the hosted project as they are now.
async function pushBoard() {
  const board = config.boards[0]
  const start = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, item] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(item))
  await remote.commitPush(start.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'demo', 'captures', 'manifest.json'))),
    variants: [],
  })
}

async function linkFor(flags) {
  const lines = []
  const saved = process.env.SHAPEWALL_BOARD_URL
  delete process.env.SHAPEWALL_BOARD_URL
  try {
    await openCommand({ config: config.file, ...flags, json: true }, (line) => lines.push(line))
  } finally {
    if (saved !== undefined) process.env.SHAPEWALL_BOARD_URL = saved
  }
  return JSON.parse(lines[0]).url
}

async function open(link, options, { signedIn = false } = {}) {
  const context = await browser.newContext(options)
  if (signedIn) await context.addCookies([...owner.browser.jar].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/' })))
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(link)
  await page.waitForSelector('[data-sw-canvas] [data-sw-node]')
  return { context, page, errors }
}

const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `follow-${name}.png`), animations: 'disabled' })
const param = (page, key) => new URL(page.url()).searchParams.get(key)

async function waitFor(check, what, timeout = 15000) {
  const until = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

// The steps every case shares, once the viewer is following:
// `take()` makes the agent take the comment, `recapture()` recaptures its page and one more.
async function followFlow(page, { comment, take, recapture, name, ...options }) {
  await page.waitForSelector('[data-sw-follow-bar="following"]')
  assert.match(await page.textContent('[data-sw-follow-line]'), /Waiting for .* to take a comment/)
  await take()
  // The pin it took: the board flies there and opens it.
  await page.waitForSelector(`[data-sw-follow-bar="following"][data-sw-follow-comment="${comment.id}"]`)
  await waitFor(async () => param(page, 'c') === String(comment.id), 'the comment to open')
  await page.waitForSelector(`[data-sw-pin="${comment.id}"]`, { state: 'visible' })
  await shot(page, `${name}-took`)
  await recapture()
  // Before and after for the comment's own screen; the rest wait quietly.
  await page.waitForSelector(`[data-sw-follow-bar="comparing"][data-sw-follow-compare="${comment.pageId}|${comment.viewport}"]`, {
    state: 'attached',
  })
  await waitFor(async () => param(page, 'hist') === comment.pageId, 'the before and after to open')
  await page.waitForSelector('[role="dialog"] [data-sw-history-side]')
  // The other page at both sizes, and the comment's page at its other size
  // (one capture run lands screen by screen).
  const others = async () => Number(await page.getAttribute('[data-sw-follow-bar]', 'data-sw-follow-others'))
  await waitFor(async () => (await others()) === 3, 'three more screens')
  assert.equal(param(page, 'hist'), comment.pageId)
  await shot(page, `${name}-compare`)
  // Closing it keeps following; the quiet count is still there.
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-sw-follow-bar="following"]')
  await page.waitForSelector('[role="dialog"] [data-sw-history-side]', { state: 'detached' })
  assert.equal(param(page, 'hist'), null)
  assert.match(await page.textContent('[data-sw-follow-more]'), /3 more screens changed/)
  await shot(page, `${name}-following`)
  // The person moves the canvas: following stops, and leaves the address.
  // On a phone the thread is a sheet over the board: closed first (that is
  // not opening another comment, so following goes on).
  if (options.phone) {
    await page.keyboard.press('Escape')
    await waitFor(async () => param(page, 'c') === null, 'the thread sheet to close')
    await page.waitForTimeout(400)
    assert.ok(await page.$('[data-sw-follow-bar="following"]'), 'still following after closing the thread')
  }
  // A spot of bare canvas (not the open thread, a sheet or the follow bar).
  const spot = await page.evaluate(() => {
    const box = document.querySelector('[data-sw-canvas]').getBoundingClientRect()
    for (let fy = 0.9; fy >= 0.2; fy -= 0.1)
      for (const fx of [0.1, 0.5, 0.9]) {
        const x = box.left + box.width * fx
        const y = box.top + box.height * fy
        const hit = document.elementFromPoint(x, y)
        if (hit?.closest('.react-flow__pane, [data-sw-node]') && hit.closest('[data-sw-canvas]') && !hit.closest('[data-sw-follow-bar]'))
          return { x, y }
      }
    return null
  })
  assert.ok(spot, 'some bare canvas to press')
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.move(spot.x - 30, spot.y - 20)
  await page.mouse.up()
  await waitFor(async () => (await page.$('[data-sw-follow-bar="following"]')) === null, 'following to stop')
  await waitFor(async () => param(page, 'follow') === null, 'follow to leave the address')
}

let round = 0
const pickPage = () => ['pricing', 'blog'][round++ % 2]

for (const [label, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
]) {
  test(`local board, ${label}: a visitor tab follows the agent to its pin, then before and after of that screen only`, async () => {
    const pageId = pickPage()
    const otherPage = pageId === 'pricing' ? 'features' : 'home'
    const comment = await createComment(config, config.boards[0], {
      pageId,
      viewport: label === 'phone' ? 'phone' : 'desktop',
      x: 50,
      y: 20,
      body: `Follow me (${label})`,
      author: 'Jo',
    })
    const link = await linkFor({ follow: true })
    assert.match(link, /[?&]follow=any(&|$)/)
    const { context, page, errors } = await open(link, options)
    try {
      await followFlow(page, {
        comment,
        name: `local-${label}`,
        phone: label === 'phone',
        take: () => setAgentStatus(config, 'demo', comment.id, 'working'),
        recapture: async () => {
          await runCapture({ config, only: [pageId, otherPage], log: () => {} })
          await setAgentStatus(config, 'demo', comment.id, 'done')
        },
      })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  test(`hosted board, ${label}: a member follows the connected agent to its pin, then before and after of that screen only`, async () => {
    const pageId = pickPage()
    const otherPage = pageId === 'pricing' ? 'features' : 'home'
    const viewport = label === 'phone' ? 'phone' : 'desktop'
    const posted = await owner.browser.post(`/w/${owner.workspaceId}/p/${project.id}/api/boards/demo/comments`, {
      body: `Hosted: follow me (${label})`,
      pageId,
      viewport,
      x: 50,
      y: 20,
    })
    assert.equal(posted.status, 201, posted.text)
    const comment = posted.json.comment
    // What the local rounds recaptured goes up first: only this round's recapture is new to the viewer.
    await pushBoard()
    // The agent was heard from just now, so the board shows it online.
    await remote.project()
    const base = `${hosted.origin}/w/${owner.workspaceId}/p/${project.id}/`
    // Desktop: the Follow button; phone: the link `shapewall open --remote --follow ID` prints.
    const link =
      label === 'desktop' ? `${base}?board=demo` : await linkFor({ remote: hosted.origin, 'token-file': tokenFile, follow: agentId })
    if (label !== 'desktop') assert.match(link, new RegExp(`[?&]follow=${agentId}(&|$)`))
    const { context, page, errors } = await open(link, options, { signedIn: true })
    try {
      if (label === 'desktop') {
        await page.click(`[data-sw-follow-agent="${agentId}"]`)
        await waitFor(async () => param(page, 'follow') === agentId, 'follow in the address')
      }
      await followFlow(page, {
        comment,
        name: `hosted-${label}`,
        phone: label === 'phone',
        take: () => remote.setAgentStatus('demo', comment.id, 'working'),
        recapture: async () => {
          await runCapture({ config, only: [pageId, otherPage], log: () => {} })
          await pushBoard()
          await remote.setAgentStatus('demo', comment.id, 'done')
        },
      })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}
