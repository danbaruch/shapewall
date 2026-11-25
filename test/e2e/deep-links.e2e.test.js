// End to end: the links `shapewall open` prints (src/board-links.js) open the
// right thing in a real browser, on a local board and on a loopback hosted
// one, at desktop (1440) and phone (390) widths: `p` flies to the page, `c`
// opens the comment at its screen size, `vp` picks the screen size, `hist`
// opens the page's before and after, `cmp` two environments side by side,
// and `follow` reaches the board element. No console errors.
// Set SHAPEWALL_SHOTS=<dir> to keep screenshots.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startDemoSite } from '../../examples/demo-site/server.js'
import { normalizeConfig } from '../../src/config.js'
import { runCapture } from '../../src/capture/capture.js'
import { createApp } from '../../src/server/app.js'
import { createComment } from '../../src/store.js'
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
let comment
let hosted
let owner
let project
let tokenFile
let hostedComment

before(async () => {
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'dist', 'client', 'index.html')), 'run "npm run build" before the deep link e2e test')
  site = await startDemoSite({ port: 0 })
  const base = `http://127.0.0.1:${site.address().port}`
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'examples', 'demo-site', 'shapewall.config.json'), 'utf8'))
  const dir = path.join(ROOT_DIR, 'test', '.output', 'deep-links-e2e')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  delete raw.baseUrl
  raw.environments = [
    { id: 'staging', title: 'Staging', baseUrl: base },
    { id: 'production', title: 'Production', baseUrl: base },
  ]
  raw.outputDir = path.join(dir, '.shapewall')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  config = normalizeConfig(raw, { dir, file })
  await runCapture({ config, log: () => {} })
  await runCapture({ config, envId: 'production', log: () => {} })
  // A recapture keeps the previous shot: pricing gets a before and after.
  await runCapture({ config, only: ['pricing'], log: () => {} })
  comment = await createComment(config, config.boards[0], {
    pageId: 'blog',
    viewport: 'phone',
    x: 40,
    y: 30,
    body: 'Cards need more room on phones',
    author: 'Jo',
  })
  server = await listen(createApp({ config }))
  writeServeState(config, `http://127.0.0.1:${server.address().port}/`)

  // The same captures pushed to a hosted project, with a comment there.
  hosted = await startHostedServer('deep-links-e2e', { signup: 'open', clientDir: path.join(ROOT_DIR, 'dist', 'client') })
  owner = await signUp(hosted, { handle: 'link-owner', displayName: 'Link Owner' })
  project = await createProject(owner, owner.workspaceId, 'Deep links')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push'])
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const start = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, item] of pushFiles(config, board)) await remote.pushFile(start.id, area, name, fs.readFileSync(item))
  await remote.commitPush(start.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'demo', 'captures', 'manifest.json'))),
    variants: [],
  })
  const posted = await owner.browser.post(`/w/${owner.workspaceId}/p/${project.id}/api/boards/demo/comments`, {
    body: 'Hosted: cards need more room on phones',
    pageId: 'blog',
    viewport: 'phone',
    x: 40,
    y: 30,
  })
  assert.equal(posted.status, 201, posted.text)
  hostedComment = posted.json.comment
  tokenFile = path.join(tempDir('deep-links-token'), 'token')
  fs.writeFileSync(tokenFile, token)
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

// The link `shapewall open` prints for these flags.
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
  // Any card: a link to one page may leave the others off screen (and unrendered).
  await page.waitForSelector('[data-sw-canvas] [data-sw-node]')
  return { context, page, errors }
}

const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `deep-links-${name}.png`), animations: 'disabled' })

// How much of the canvas a page's card takes, and whether its middle is on screen.
async function cardInView(page, pageId) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-sw-canvas]')
    return canvas && getComputedStyle(canvas.querySelector('.react-flow') || canvas).opacity !== '0'
  })
  // The camera has stopped moving.
  let last = null
  for (let i = 0; i < 20; i += 1) {
    const now = await page.evaluate(() => getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
    if (now === last) break
    last = now
    await page.waitForTimeout(100)
  }
  return page.evaluate((id) => {
    const canvas = document.querySelector('[data-sw-canvas]').getBoundingClientRect()
    const card = document.querySelector(`[data-sw-node="${id}"]`)?.getBoundingClientRect()
    if (!card) return { share: 0, centred: false, offCentre: 1 }
    const x = card.left + card.width / 2
    const y = card.top + Math.min(card.height, canvas.height) / 2
    return {
      share: card.width / canvas.width,
      centred: x > canvas.left && x < canvas.right && y > canvas.top && y < canvas.bottom,
      // How far the card's middle is from the canvas's, as a share of its width.
      offCentre: Math.abs(x - (canvas.left + canvas.width / 2)) / canvas.width,
    }
  }, pageId)
}

for (const [label, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
]) {
  test(`local ${label}: p flies to the page, c opens the comment at its size, vp and before and after`, async () => {
    const plain = await open(await linkFor({}), options)
    const start = await cardInView(plain.page, 'pricing')
    await plain.context.close()

    // p: the page, larger than in the start view and on screen.
    const pageLink = await linkFor({ page: 'pricing' })
    assert.match(pageLink, /[?&]p=pricing(&|$)/)
    let { context, page, errors } = await open(pageLink, options)
    try {
      const view = await cardInView(page, 'pricing')
      assert.ok(view.centred, `${label}: the pricing card is on screen`)
      // Flown to: in the middle and selected. On a desktop it is also far larger than in the
      // start view (the whole board); a phone's start view already shows cards two across.
      assert.ok(view.offCentre < 0.1, `${label}: pricing in the middle (${view.offCentre}, start ${start.offCentre})`)
      // The camera moved to it: the start view had it elsewhere or far smaller.
      assert.ok(
        start.offCentre > view.offCentre + 0.1 || view.share > start.share * 1.5,
        `${label}: the start view differed (${start.offCentre}, ${start.share} vs ${view.share})`,
      )
      if (label === 'desktop') assert.ok(view.share > start.share * 1.5, `flown to pricing (${view.share} vs start ${start.share})`)
      await page.waitForSelector(`[data-sw-frame-bar="pricing|${label}"]`)
      await shot(page, `${label}-page`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }

    // c (with p): the comment wins, its thread open, at its own screen size.
    const commentLink = await linkFor({ comment: String(comment.id), page: 'pricing' })
    assert.match(commentLink, new RegExp(`c=${comment.id}&filter=all&vp=phone`))
    ;({ context, page, errors } = await open(commentLink, options))
    try {
      await page.waitForSelector(`[data-sw-selected-comment="${comment.id}"]`)
      await page.waitForSelector('[data-sw-frame="blog:phone"]')
      assert.equal(await page.locator('[data-sw-frame="blog:desktop"]').count(), 0, 'phone frames only')
      await shot(page, `${label}-comment`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }

    // vp: the other screen size than this width starts with.
    const other = label === 'desktop' ? 'phone' : 'desktop'
    ;({ context, page, errors } = await open(await linkFor({ page: 'features', viewport: other }), options))
    try {
      await page.waitForSelector(`[data-sw-frame="features:${other}"]`)
      assert.equal(await page.locator(`[data-sw-frame="features:${label === 'desktop' ? 'desktop' : 'phone'}"]`).count(), 0)
      assert.ok((await cardInView(page, 'features')).centred)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }

    // compare alone: the page's before and after (its history), two captures.
    const historyLink = await linkFor({ page: 'pricing', viewport: 'desktop', compare: true })
    ;({ context, page, errors } = await open(historyLink, options))
    try {
      await page.waitForSelector('[data-sw-history="pricing|desktop"]')
      assert.equal(await page.locator('[data-sw-history-version]').count(), 2)
      await shot(page, `${label}-history`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }

    // compare A_B: two environments side by side, flown to the page.
    ;({ context, page, errors } = await open(await linkFor({ page: 'home', compare: 'staging_production' }), options))
    try {
      await page.waitForSelector('[data-sw-compare-bar]')
      assert.equal(new URL(page.url()).searchParams.get('cmp'), 'staging_production')
      assert.ok((await cardInView(page, 'home')).centred)
      await shot(page, `${label}-compare`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}

test('local: an unknown page falls back to the start view; follow reaches the board element', async () => {
  const base = await linkFor({})
  const { context, page, errors } = await open(`${base}&p=nope&follow=ag_123`, DESKTOP)
  try {
    await page.waitForSelector('[data-sw-board][data-sw-follow-request="ag_123"]')
    // The board is shown (not left hidden waiting for a page it lacks).
    assert.ok((await cardInView(page, 'home')).centred)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
})

for (const [label, options] of [
  ['desktop', DESKTOP],
  ['phone', PHONE],
]) {
  test(`hosted ${label}: open --remote links fly to the page, open the comment and its before and after`, async () => {
    const remoteLink = async (flags) => {
      const lines = []
      await openCommand({ remote: hosted.origin, 'token-file': tokenFile, json: true, ...flags }, (line) => lines.push(line))
      return JSON.parse(lines[0]).url
    }
    const pageLink = await remoteLink({ page: 'Pricing' })
    assert.ok(pageLink.startsWith(`${hosted.origin}/w/${owner.workspaceId}/p/${project.id}/?board=demo&p=pricing`), pageLink)
    let { context, page, errors } = await open(pageLink, options, { signedIn: true })
    try {
      const view = await cardInView(page, 'pricing')
      assert.ok(view.centred, 'the pricing card is on screen')
      assert.ok(view.offCentre < 0.1, `pricing in the middle (${view.offCentre})`)
      await page.waitForSelector(`[data-sw-frame-bar="pricing|${label}"]`)
      await shot(page, `hosted-${label}-page`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }

    ;({ context, page, errors } = await open(await remoteLink({ comment: String(hostedComment.id) }), options, { signedIn: true }))
    try {
      await page.waitForSelector(`[data-sw-selected-comment="${hostedComment.id}"]`)
      await page.waitForSelector('[data-sw-frame="blog:phone"]')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }

    ;({ context, page, errors } = await open(await remoteLink({ page: 'pricing', viewport: 'desktop', compare: true }), options, {
      signedIn: true,
    }))
    try {
      await page.waitForSelector('[data-sw-history="pricing|desktop"]')
      assert.equal(await page.locator('[data-sw-history-version]').count(), 2)
      await shot(page, `hosted-${label}-history`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
}
