// End to end: the "Follow <agent>" chip over the canvas never covers the
// first group's heading on the board's first view (IC4), on a hosted board
// with its agent online, at desktop (1440) and phone (390) widths, with the
// first-run tip open and closed. Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { normalizeConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer } from '../hosted-helpers.js'
import { ROOT_DIR } from './helpers.js'

const SHOTS = process.env.SHAPEWALL_SHOTS ? path.resolve(process.env.SHAPEWALL_SHOTS) : null
const DESKTOP = { viewport: { width: 1440, height: 900 } }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
let site
let browser
let hosted
let owner
let project
let remote
let agentId

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before this e2e test')
  site = await startDemoSite({ port: 0 })
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  const dir = path.join(ROOT_DIR, 'test', '.output', 'follow-chip-room-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  raw.baseUrl = `http://127.0.0.1:${site.address().port}`
  raw.outputDir = path.join(dir, '.shapewall')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  const config = normalizeConfig(raw, { dir, file })
  await runCapture({ config, log: () => {} })
  hosted = await startHostedServer('follow-chip-room-e2e', { signup: 'open', clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  owner = await signUp(hosted, { handle: 'chip-owner', displayName: 'Chip Owner' })
  project = await createProject(owner, owner.workspaceId, 'Chip')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply', 'status', 'claim', 'push'])
  remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const start = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, item] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(item))
  await remote.commitPush(start.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'demo', 'captures', 'manifest.json'))),
    variants: [],
  })
  const agents = await owner.browser.get(`/w/${owner.workspaceId}/p/${project.id}/api/boards/demo/agents`)
  assert.equal(agents.status, 200, agents.text)
  agentId = agents.json.agents[0].id
  // An open comment: the Comments panel opens beside the canvas, which narrows it, so the board starts at its left
  // edge, under the bar (the IC4 testbed's case).
  const posted = await owner.browser.post(`/w/${owner.workspaceId}/p/${project.id}/api/boards/demo/comments`, {
    body: 'Make the heading bigger',
    pageId: config.boards[0].pages[0].id,
    viewport: 'desktop',
    x: 50,
    y: 20,
  })
  assert.equal(posted.status, 201, posted.text)
  browser = await chromium.launch()
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
})

after(async () => {
  await browser?.close()
  await hosted?.close()
  await new Promise((resolve) => (site ? site.close(resolve) : resolve()))
})

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

for (const [label, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
]) {
  for (const tip of ['tip open', 'tip closed']) {
    test(`the Follow chip leaves the first group heading readable: ${label}, ${tip}`, async () => {
      // The agent was heard from just now, so the board shows it online and offers to follow it.
      await remote.project()
      const context = await browser.newContext(options)
      await context.addCookies([...owner.browser.jar].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/' })))
      // client/src/board/prefs.js TIP_KEY: the first-run tip dismissed before.
      if (tip === 'tip closed') await context.addInitScript(() => localStorage.setItem('shapewall.tip.board', '1'))
      const page = await context.newPage()
      const errors = []
      page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.goto(`${hosted.origin}/w/${owner.workspaceId}/p/${project.id}/?board=demo`)
        await page.waitForSelector('[data-sw-canvas] [data-sw-node]')
        const chip = page.locator(`[data-sw-follow-agent="${agentId}"]`)
        await chip.waitFor({ timeout: 15000 })
        // The first view settles (and moves out of the way once the chip shows).
        await page.waitForTimeout(800)
        const box = await chip.boundingBox()
        const labels = page.locator('[data-sw-group-label]')
        const heading = await labels.first().boundingBox()
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `follow-chip-${label}-${tip.replace(' ', '-')}.png`) })
        assert.ok(box && heading, 'chip and heading on screen')
        assert.ok(!overlaps(box, heading), `chip ${JSON.stringify(box)} over the heading ${JSON.stringify(heading)}`)
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    })
  }
}
