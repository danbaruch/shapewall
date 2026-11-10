// Hosted live HTML (src/hosted/usercontent.js) with a separate usercontent
// origin: /uc/ only there, nothing else there, never a cookie there; signed
// URLs last 2 minutes and stop at once when their share link is revoked;
// element maps come from the board API and are validated on push.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { SIGNED_URL_MS, createUsercontent, usercontentOriginOf } from '../src/hosted/usercontent.js'
import { createBrowser, createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { request, sampleConfig } from './helpers.js'

let clock = Date.parse('2026-11-05T12:00:00Z')
let hosted
let owner
let project
let token
let ucHost

const mapFor = (size) => ({
  v: 1,
  width: size.width,
  height: size.height,
  elements: [
    { t: 'body', n: 1, p: -1, b: [0, 0, size.width, 200], x: 'Live' },
    { t: 'p', n: 1, p: 0, b: [8, 8, 100, 20], x: 'Live', z: 0 },
  ],
})

async function push(config, files = pushFiles(config, config.boards[0])) {
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of files) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  return remote.commitPush(started.id, { manifest, variants: [] })
}

const boardApi = (rest = '') => `/w/${owner.workspaceId}/p/${project.id}/api${rest}`
// A request to the usercontent host name (uc.localhost:<port>; the app is localhost:<port>).
const onUsercontent = (method, pathname, headers = {}) => request(hosted.port, method, pathname, { headers: { Host: ucHost, ...headers } })
const pathOf = (url) => {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

before(async () => {
  hosted = await startHostedServer('hosted-usercontent', { signup: 'open', usercontent: true, now: () => new Date(clock) })
  ucHost = new URL(hosted.usercontentOrigin).host
  owner = await signUp(hosted, { handle: 'olive', setup: null, invite: null })
  project = await createProject(owner, owner.workspaceId, 'Site')
  token = await createToken(owner, owner.workspaceId, project.id)
  const config = sampleConfig('usercontent')
  writeLocalCaptures(config, 'sample', {
    html: '<!DOCTYPE html><html><head></head><body><p>Live</p></body></html>',
    elements: mapFor,
  })
  await push(config)
})
after(() => hosted?.close())

test('the usercontent origin must be another http(s) origin without a path', () => {
  assert.equal(usercontentOriginOf(null, 'https://app.example.com'), null)
  assert.equal(usercontentOriginOf('https://uc.example.net', 'https://app.example.com'), 'https://uc.example.net')
  for (const bad of ['https://app.example.com', 'https://uc.example.net/x', 'ftp://uc.example.net', 'http://uc.example.net', 'nope'])
    assert.throws(() => usercontentOriginOf(bad, 'https://app.example.com'), /usercontentOrigin/, bad)
  const uc = createUsercontent({
    db: null,
    secret: 'x'.repeat(32),
    appOrigin: 'https://app.example.com',
    usercontentOrigin: 'https://uc.example.net',
    locate: () => null,
  })
  assert.equal(
    uc.boardCsp("default-src 'self'; frame-src 'self'; frame-ancestors 'none'"),
    "default-src 'self'; frame-src 'self' https://uc.example.net; frame-ancestors 'none'",
  )
  assert.equal(uc.csp.startsWith('sandbox; '), true)
  assert.match(uc.csp, /frame-ancestors https:\/\/app\.example\.com$/)
  assert.equal(SIGNED_URL_MS, 2 * 60_000)
})

test('members get the element map from the board API and live HTML from the usercontent origin only', async () => {
  const view = await owner.browser.get(boardApi('/boards/sample'))
  assert.equal(view.json.captures.home.desktop.elements, 'home.desktop.elements.json')
  const map = await owner.browser.get(boardApi('/boards/sample/elements/home.desktop.elements.json'))
  assert.equal(map.status, 200)
  assert.deepEqual(map.json, mapFor({ width: 1440, height: 2200 }))
  assert.equal((await owner.browser.get(boardApi('/boards/sample/elements/home.desktop.html'))).status, 404)
  assert.equal(
    (await createBrowser(hosted.port, hosted.origin).get(boardApi('/boards/sample/elements/home.desktop.elements.json'))).status,
    401,
  )

  const live = await owner.browser.get(boardApi('/boards/sample/live/home.desktop.html'))
  assert.equal(live.status, 302)
  assert.ok(live.headers.location.startsWith(`${hosted.usercontentOrigin}/uc/`), live.headers.location)
  const target = pathOf(live.headers.location)
  const page = await onUsercontent('GET', target, { Cookie: [...owner.browser.jar].map(([name, value]) => `${name}=${value}`).join('; ') })
  assert.equal(page.status, 200)
  assert.match(page.text, /<p>Live<\/p>/)
  assert.equal(page.headers['set-cookie'], undefined, 'no cookie on the usercontent origin')
  assert.equal(
    page.headers['content-security-policy'],
    `sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${hosted.origin}`,
  )
  assert.equal(page.headers['x-frame-options'], undefined, 'framed by the app origin, which is another origin')
  assert.equal(page.headers['cross-origin-resource-policy'], 'cross-origin')
  assert.match(page.headers['cache-control'], /no-store/)
  // The same URL on the app origin is not served.
  const onApp = await request(hosted.port, 'GET', target, { headers: { Host: new URL(hosted.origin).host } })
  assert.equal(onApp.status, 404)
})

test('the usercontent origin serves nothing but /uc/ and never sets a cookie', async () => {
  const cookie = [...owner.browser.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  for (const [method, pathname] of [
    ['GET', '/'],
    ['GET', '/signin'],
    ['GET', '/auth/me'],
    ['GET', `/w/${owner.workspaceId}/p/${project.id}/`],
    ['GET', boardApi('/boards/sample')],
    ['GET', boardApi('/boards/sample/live/home.desktop.html')],
    ['GET', '/api/v1/project'],
    ['POST', '/auth/signin/options'],
    ['POST', '/api/shares/open'],
    ['GET', '/uc'],
    ['GET', '/uc/x'],
  ]) {
    const response = await onUsercontent(method, pathname, { Cookie: cookie, Origin: hosted.usercontentOrigin })
    assert.equal(response.status, 404, `${method} ${pathname}`)
    assert.equal(response.headers['set-cookie'], undefined, `${method} ${pathname}`)
  }
})

test('signed URLs last two minutes and are bound to their file', async () => {
  const live = await owner.browser.get(boardApi('/boards/sample/live/home.desktop.html'))
  const target = pathOf(live.headers.location)
  for (const forged of [
    target.replace('home.desktop.html', 'pricing.desktop.html'),
    target.replace(/e=\d+/, (match) => `e=${Number(match.slice(2)) + 1000}`),
    target.replace(/s=[^&]+/, 's=AAAA'),
    `${target}&g=sh_${'0'.repeat(24)}.x`,
    target.replace('/captures/', '/variants/'),
  ]) {
    assert.equal((await onUsercontent('GET', forged)).status, 404, forged)
  }
  assert.equal((await onUsercontent('POST', target)).status, 404)
  const start = clock
  try {
    clock += SIGNED_URL_MS - 1000
    assert.equal((await onUsercontent('GET', target)).status, 200)
    clock += 2000
    assert.equal((await onUsercontent('GET', target)).status, 404, 'expired')
  } finally {
    clock = start
  }
})

test('a guest URL names its share link: revoking the link stops new loads at once', async () => {
  const ws = owner.workspaceId
  assert.equal((await owner.browser.call('PATCH', `/api/workspaces/${ws}/settings`, { body: { shareLinks: true } })).status, 200)
  const base = `/api/workspaces/${ws}/projects/${project.id}/shares`
  const made = await owner.browser.post(base, { mode: 'view', name: 'Agency', expiresInDays: 7 })
  assert.equal(made.status, 201, made.text)
  const sid = made.json.share.id
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal((await guest.post('/api/shares/open', { token: new URL(made.json.url).hash.slice(1), name: 'Gus' })).status, 200)
  assert.equal((await guest.get(`/s/${sid}/api/boards/sample/elements/home.desktop.elements.json`)).status, 200)
  const live = await guest.get(`/s/${sid}/api/boards/sample/live/home.desktop.html`)
  assert.equal(live.status, 302)
  const target = pathOf(live.headers.location)
  assert.match(target, new RegExp(`[?&]g=${sid}\\.`))
  assert.equal((await onUsercontent('GET', target)).status, 200)
  // The share part cannot be dropped or swapped: it is signed.
  assert.equal((await onUsercontent('GET', target.replace(/&g=[^&]+/, ''))).status, 404)
  assert.equal((await owner.browser.call('DELETE', `${base}/${sid}`)).status, 200)
  assert.equal((await onUsercontent('GET', target)).status, 404, 'revoked: the same URL stops at once')
})

test('push validates element maps: their shape and their viewport size', async () => {
  const config = sampleConfig('usercontent-bad')
  writeLocalCaptures(config, 'sample', { elements: (size) => ({ ...mapFor(size), width: 999 }) })
  await assert.rejects(push(config), /Element map: measured at 999x2200/)
  const broken = sampleConfig('usercontent-broken')
  writeLocalCaptures(broken, 'sample', {
    elements: (size) => ({ ...mapFor(size), elements: [{ t: 'body', n: 1, p: 3, b: [0, 0, 1, 1] }] }),
  })
  await assert.rejects(push(broken), /Element map: elements\[0\]\.p/)
})
