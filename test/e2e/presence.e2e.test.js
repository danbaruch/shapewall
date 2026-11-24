// Two actual authenticated browser sessions share cursor/camera state over
// the hosted WebSocket. Guest and public surfaces get their own boundaries.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { createRemote, pushDefinition, pushFiles } from '../../src/remote/remote.js'
import { sampleConfig } from '../helpers.js'
import { createBrowser, createProject, createToken, invite, signUp, startHostedServer, writeLocalCaptures } from '../hosted-helpers.js'
import { ROOT_DIR } from './helpers.js'

let hosted, browser, owner, member, outsider, project
const active = new Set()
const memberPath = () => `/w/${owner.workspaceId}/p/${project.id}/`
const shots = process.env.SHAPEWALL_SHOTS
async function contextFor(person, { width = 1440, pathname = memberPath(), guestPath = null } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    ...(width === 390 ? { isMobile: true, hasTouch: true } : {}),
  })
  active.add(context)
  if (person)
    await context.addCookies([...person.browser.jar].map(([name, value]) => ({ name, value, domain: 'localhost', path: guestPath || '/' })))
  const page = await context.newPage()
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${hosted.origin}${pathname}`)
  await page.waitForSelector('[data-sw-node="home"]')
  await page.waitForSelector('[data-sw-presence]')
  return { context, page, errors }
}
const camera = (page) =>
  page.evaluate(() => {
    const value = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
    return { x: value.e, y: value.f, zoom: value.a }
  })
const shot = async (page, name) => {
  if (shots) {
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: path.join(shots, `presence-${name}.png`), animations: 'disabled' })
  }
}

before(async () => {
  hosted = await startHostedServer('presence-browser', { signup: 'open', clientDir: path.join(ROOT_DIR, 'dist/client') })
  owner = await signUp(hosted, { handle: 'cursor-owner', displayName: 'Fixture Owner' })
  member = await signUp(hosted, {
    handle: 'cursor-member',
    displayName: 'Fixture Reviewer',
    invite: await invite(owner, owner.workspaceId, 'member'),
  })
  outsider = await signUp(hosted, { handle: 'cursor-outsider', displayName: 'Different Workspace' })
  project = await createProject(owner, owner.workspaceId, 'Cursor fixture')
  const config = sampleConfig('presence-browser-local')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, owner.workspaceId, project.id, ['read', 'push']) })
  const start = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
  await remote.commitPush(start.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample/captures/manifest.json'))),
    variants: [],
  })
  browser = await chromium.launch()
})
after(async () => {
  for (const context of active) await context.close()
  await browser?.close()
  await hosted?.close()
})

test('two member sessions render a cursor within 200ms, follow camera, and receive new comments without polling', async () => {
  const a = await contextFor(owner)
  const b = await contextFor(member)
  try {
    await a.page.waitForSelector('[data-sw-presence-count="2"]')
    await b.page.getByRole('button', { name: 'Follow Fixture Owner', exact: true }).waitFor()
    const began = performance.now()
    await a.page.mouse.move(600, 350)
    await b.page.waitForSelector('[data-sw-presence-cursor]')
    const latency = performance.now() - began
    assert.ok(latency < 200, `cursor propagation ${latency.toFixed(1)}ms`)
    assert.match(await b.page.locator('[data-sw-presence-cursor]').first().textContent(), /Fixture Owner/)
    await b.page.getByRole('button', { name: 'Follow Fixture Owner', exact: true }).click()
    await b.page.waitForSelector('[data-sw-stop-follow]')
    const before = await camera(a.page)
    await a.page.mouse.wheel(350, 220)
    await a.page.waitForFunction((before) => {
      const value = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
      return Math.abs(value.e - before.x) > 50 || Math.abs(value.f - before.y) > 50
    }, before)
    const target = await camera(a.page)
    await b.page.waitForFunction((target) => {
      const value = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
      return Math.abs(value.e - target.x) < 0.2 && Math.abs(value.f - target.y) < 0.2 && Math.abs(value.a - target.zoom) < 0.001
    }, target)
    const posted = await owner.browser.post(`${memberPath()}api/boards/sample/comments`, {
      body: 'Live presence comment',
      pageId: 'home',
      viewport: 'desktop',
      x: 20,
      y: 20,
    })
    assert.equal(posted.status, 201)
    await b.page.waitForSelector(`[data-sw-comment="${posted.json.comment.id}"]`, { timeout: 3000 })
    await shot(b.page, 'desktop-follow')
    await b.page.mouse.move(500, 500)
    await b.page.mouse.wheel(0, 100)
    await b.page.waitForSelector('[data-sw-stop-follow]', { state: 'detached' })
    assert.deepEqual(a.errors, [])
    assert.deepEqual(b.errors, [])
    assert.equal(await b.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  } finally {
    await a.context.close()
    active.delete(a.context)
    await b.context.close()
    active.delete(b.context)
  }
})

test('phone guest is named Guest; public sees counts only; a different workspace cannot join the member room', async () => {
  await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/settings`, { body: { shareLinks: true } })
  const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${project.id}/shares`, { mode: 'view' })
  assert.equal(made.status, 201)
  const sid = made.json.share.id
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal(
    (await guest.post(`/s/${sid}/open`, { token: new URL(made.json.url).hash.slice(1), name: 'Private guest label' })).status,
    200,
  )
  const a = await contextFor(owner)
  const g = await contextFor({ browser: guest }, { width: 390, pathname: `/s/${sid}/`, guestPath: `/s/${sid}/` })
  try {
    await a.page.getByRole('button', { name: 'Follow Guest', exact: true }).waitFor()
    assert.equal(await a.page.getByRole('button', { name: /Private guest label/ }).count(), 0)
    const small = await g.page
      .locator('[data-sw-presence] button')
      .evaluateAll((items) => items.filter((item) => item.getBoundingClientRect().height < 44).length)
    assert.equal(small, 0)
    assert.equal(await g.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await shot(g.page, 'phone-guest')
    assert.deepEqual(a.errors, [])
    assert.deepEqual(g.errors, [])
    await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/public-projects`, { body: { enabled: true } })
    const pub = await owner.browser.call('PUT', `/api/workspaces/${owner.workspaceId}/projects/${project.id}/public`, {
      body: { public: true },
    })
    const p = await contextFor(null, { pathname: `/p/${pub.json.public.id}/` })
    await p.page.waitForSelector('[data-sw-presence-count="3"]')
    assert.equal(await p.page.locator('[data-sw-presence-peer], [data-sw-presence-cursor]').count(), 0)
    assert.deepEqual(p.errors, [])
    await shot(p.page, 'public-counts-only')
    await p.context.close()
    active.delete(p.context)
    // Hostile socket starts in a separate authenticated browser context.
    const hostile = await browser.newContext()
    await hostile.addCookies([...outsider.browser.jar].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/' })))
    const attack = await hostile.newPage()
    await attack.goto(`${hosted.origin}/`)
    const refused = await attack.evaluate(
      (url) =>
        new Promise((resolve) => {
          const ws = new WebSocket(url, 'shapewall-presence-v1')
          ws.onopen = () => {
            ws.close()
            resolve(false)
          }
          ws.onerror = () => resolve(true)
        }),
      `${hosted.origin.replace(/^http/, 'ws')}${memberPath()}api/boards/sample/presence`,
    )
    assert.equal(refused, true)
    await hostile.close()
  } finally {
    await a.context.close()
    active.delete(a.context)
    await g.context.close()
    active.delete(g.context)
  }
})
