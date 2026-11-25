// The MCP core of 1.3.0 on every server kind: list_comments filters (author
// "me", since/until with "today" in a time zone, q, pageName, paging),
// board_link, compare_captures, links on every result, the shared
// instructions, and the hosted capture history route behind remote compare
// (GET /api/v1/boards/:bid/pages/:pid/versions). "All comments I left today
// on the Features page" is one call on a local board, on `mcp --remote` and
// on a hosted server's own /mcp endpoint.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { parseBoardLink } from '../src/board-links.js'
import { authorFilter, narrowComments, pageByName, timeRange, zonedTime } from '../src/comment-filters.js'
import { captureHistory, pickPair } from '../src/compare-captures.js'
import { loadConfig } from '../src/config.js'
import { createMcpServer, localMe } from '../src/mcp.js'
import { mcpInstructions } from '../src/mcp-instructions.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createComment } from '../src/store.js'
import { createProject, createToken, invite, signUp, startHostedServer, tokenCall } from './hosted-helpers.js'
import { tempDir } from './helpers.js'

const ZONE = 'America/Chicago'
// 23:59:30 on 2026-11-25 in Chicago (CST, UTC-6).
const NOW = Date.parse('2026-11-26T05:59:30.000Z')
const FIRST = '20261124T150000000Z-aaaa'
const SECOND = '20261125T150000000Z-bbbb'

const LUMEN = {
  title: 'Lumen',
  id: 'lumen',
  baseUrl: 'http://127.0.0.1:9',
  groups: ['Site'],
  pages: [
    { id: 'home', path: '/', title: 'Home', group: 'Site' },
    { id: 'features', path: '/features', title: 'Features', group: 'Site' },
    { id: 'flags', path: '/flags', title: 'Feature flags', group: 'Site' },
  ],
}

// The comments both boards get: [author, page, local time in Chicago, body].
const SEED = [
  ['Dan', 'features', '2026-11-25T09:00', 'Make the hero bigger'],
  ['Dan', 'features', '2026-11-25T23:59', 'Tighten the pricing grid'],
  ['Robin', 'features', '2026-11-25T10:00', 'Swap the icons'],
  ['Dan', 'home', '2026-11-25T11:00', 'Logo too small'],
  ['Dan', 'features', '2026-11-24T23:59', 'Yesterday: fix the footer'],
]
const chicago = (local) => {
  const [date, time] = local.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  return zonedTime(ZONE, y, m, d, h, mi)
}

const solidPng = ([r, g, b], width = 40, height = 30) => {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i)
  return PNG.sync.write(png)
}
const RED = [200, 0, 0]
const BLUE = [0, 0, 200]

// A project folder with captures: every page is red at SECOND, except home
// desktop, which is blue at SECOND with the red one at FIRST in its history.
function project(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(LUMEN))
  const config = loadConfig(file)
  const captures = path.join(config.outputDir, 'lumen', 'captures')
  const versions = path.join(config.outputDir, 'lumen', 'versions')
  fs.mkdirSync(captures, { recursive: true })
  fs.mkdirSync(versions, { recursive: true })
  const manifest = { board: 'lumen', capturedAt: '2026-11-25T15:00:00.000Z', viewports: config.viewports, pages: {} }
  for (const page of config.boards[0].pages) {
    manifest.pages[page.id] = {}
    for (const viewport of page.viewports) {
      const blue = page.id === 'home' && viewport === 'desktop'
      fs.writeFileSync(path.join(captures, `${page.id}.${viewport}.png`), solidPng(blue ? BLUE : RED))
      fs.writeFileSync(path.join(captures, `${page.id}.${viewport}.thumb.png`), solidPng(blue ? BLUE : RED, 8, 6))
      fs.writeFileSync(path.join(captures, `${page.id}.${viewport}.html`), '<!DOCTYPE html><html><body>Lumen</body></html>')
      manifest.pages[page.id][viewport] = { status: 'ok', url: `${LUMEN.baseUrl}${page.path}`, version: SECOND }
    }
  }
  fs.writeFileSync(path.join(captures, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(versions, `home.desktop.${FIRST}.png`), solidPng(RED))
  return config
}

async function connect(server) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}
const parse = (result) => {
  assert.notEqual(result.isError, true, result.content?.[0]?.text)
  return JSON.parse(result.content[0].text)
}
const THE_SENTENCE = { author: 'me', since: 'today', pageName: 'Features', timeZone: ZONE }

// ---- Units --------------------------------------------------------------------------

test('timeRange: today and yesterday in the zone, a comment at 23:59 local stays on its day, strict parsing', () => {
  const today = timeRange({ since: 'today', timeZone: ZONE, now: NOW })
  assert.equal(today.stated.since, '2026-11-25T06:00:00.000Z')
  assert.equal(today.to, null)
  assert.equal(today.stated.timeZone, ZONE)
  const day = timeRange({ since: 'today', until: 'today', timeZone: ZONE, now: NOW })
  assert.equal(day.stated.until, '2026-11-26T06:00:00.000Z')
  const late = chicago('2026-11-25T23:59')
  assert.ok(late >= day.from && late < day.to, '23:59 local is today')
  const lateYesterday = chicago('2026-11-24T23:59')
  assert.ok(lateYesterday < day.from, 'yesterday 23:59 local is not today, although it is 11-25 in UTC')
  const yesterday = timeRange({ since: 'yesterday', until: 'yesterday', timeZone: ZONE, now: NOW })
  assert.ok(lateYesterday >= yesterday.from && lateYesterday < yesterday.to)
  // The same instant is "tomorrow" in Tokyo.
  assert.equal(timeRange({ since: 'today', timeZone: 'Asia/Tokyo', now: NOW }).stated.since, '2026-11-25T15:00:00.000Z')
  // Dates, date-times with and without a zone; until a date-time includes it.
  assert.equal(timeRange({ since: '2026-11-20', timeZone: ZONE, now: NOW }).stated.since, '2026-11-20T06:00:00.000Z')
  assert.equal(timeRange({ since: '2026-11-20T08:30', timeZone: ZONE, now: NOW }).stated.since, '2026-11-20T14:30:00.000Z')
  assert.equal(timeRange({ since: '2026-11-20T08:30:00Z', timeZone: ZONE, now: NOW }).stated.since, '2026-11-20T08:30:00.000Z')
  assert.equal(timeRange({ until: '2026-11-20T08:30:00+01:00', now: NOW }).to, Date.parse('2026-11-20T07:30:00.000Z') + 1)
  // A day across a time change is still midnight to midnight (23 or 25 hours).
  const fallBack = timeRange({ since: '2026-11-01', until: '2026-11-01', timeZone: ZONE, now: NOW })
  assert.equal(fallBack.to - fallBack.from, 25 * 3600_000)
  // Strict: no free text, no impossible dates, no unknown zones, no empty ranges.
  for (const [args, message] of [
    [{ since: 'last tuesday' }, /since takes/],
    [{ since: 'Nov 25 2026' }, /since takes/],
    [{ since: '2026-02-30' }, /not a date/],
    [{ until: '2026-11-25T24:00' }, /not a date-time/],
    [{ since: 'today', timeZone: 'Mars/Olympus' }, /Unknown time zone/],
    [{ since: 'today', timeZone: '../etc' }, /Unknown time zone/],
    [{ since: 'today', until: 'yesterday' }, /until is before since/],
  ])
    assert.throws(() => timeRange({ timeZone: ZONE, ...args, now: NOW }), message, JSON.stringify(args))
  assert.equal(timeRange({}), null)
})

test('authorFilter: "me" by name or handle, never an agent or a guest; @handle; a display name', () => {
  const items = [
    { id: 1, author: 'Dan' },
    { id: 2, author: 'dan ' },
    { id: 3, author: 'Dan', authorAgent: true },
    { id: 4, author: 'Dan', authorGuest: true },
    { id: 5, author: 'Robin', authorHandle: 'robin' },
    { id: 6, author: 'Dan B', authorHandle: 'dan' },
    { id: 7, author: 'Dan', authorHandle: 'dan2' },
  ]
  const ids = (filter) => items.filter(filter.match).map((item) => item.id)
  // Local: no handles known for "me", so the name decides (7 is signed Dan).
  assert.deepEqual(ids(authorFilter('me', { me: { names: ['Dan'], handles: [] } })), [1, 2, 7])
  // Hosted: the token maker's handle decides; a name alone never does.
  assert.deepEqual(ids(authorFilter('ME', { me: { names: [], handles: ['dan'] } })), [6])
  assert.deepEqual(ids(authorFilter('@Robin', {})), [5])
  assert.deepEqual(ids(authorFilter('robin', {})), [5])
  assert.deepEqual(ids(authorFilter('Dan B', {})), [6])
  assert.throws(() => authorFilter('me', { me: null }), /cannot tell who "me" is/)
  assert.throws(() => authorFilter('me', { me: { names: [], handles: [], why: 'Set a name.' } }), /Set a name/)
  assert.throws(() => authorFilter('@../x', {}), /not a handle/)
})

test('pageByName: title first, then id or path, then words in a title; several fits are candidates', () => {
  const pages = LUMEN.pages
  assert.equal(pageByName(pages, 'features').page.id, 'features')
  assert.equal(pageByName(pages, ' FEATURES ').page.id, 'features')
  assert.equal(pageByName(pages, '/flags').page.id, 'flags')
  assert.equal(pageByName(pages, 'home').page.id, 'home')
  assert.deepEqual(
    pageByName(pages, 'feature').candidates.map((page) => page.id),
    ['features', 'flags'],
  )
  assert.equal(pageByName(pages, 'flags').page.id, 'flags')
  assert.ok(pageByName(pages, 'pricing').none)
})

test('narrowComments: q and paging by id; a cursor survives comments added and removed', () => {
  const items = [1, 2, 3, 4, 5].map((id) => ({ id, body: id % 2 ? 'odd one' : 'even one', createdAt: '2026-11-25T10:00:00Z' }))
  const first = narrowComments(items, { limit: 2 })
  assert.deepEqual([first.comments.map((item) => item.id), first.total, first.nextCursor], [[1, 2], 5, '2'])
  // Comment 1 is deleted and 6 is added before the next page is read.
  const changed = [...items.slice(1), { id: 6, body: 'new', createdAt: '2026-11-25T10:00:00Z' }]
  const second = narrowComments(changed, { limit: 2, cursor: first.nextCursor })
  assert.deepEqual(
    second.comments.map((item) => item.id),
    [3, 4],
  )
  const last = narrowComments(changed, { limit: 2, cursor: second.nextCursor })
  assert.deepEqual([last.comments.map((item) => item.id), last.nextCursor], [[5, 6], null])
  assert.deepEqual(
    narrowComments(items, { q: 'ODD' }).comments.map((item) => item.id),
    [1, 3, 5],
  )
  assert.equal(narrowComments(items, { limit: 999 }).comments.length, 5)
  assert.throws(() => narrowComments(items, { cursor: 'abc' }), /cursor/)
})

test('compare picks: current against the one before it, or named versions', () => {
  const history = captureHistory(SECOND, [FIRST, 'nonsense', SECOND])
  assert.deepEqual(
    history.map((item) => [item.version, item.current]),
    [
      [SECOND, true],
      [FIRST, false],
    ],
  )
  assert.deepEqual(
    Object.values(pickPair(history)).map((item) => item.version),
    [FIRST, SECOND],
  )
  assert.throws(() => pickPair(captureHistory(SECOND, [])), /nothing to compare yet/)
  assert.throws(() => pickPair(history, { after: FIRST }), /no capture of this page before/i)
  assert.throws(() => pickPair(history, { before: SECOND }), /same capture/)
  assert.throws(() => pickPair(history, { before: '../x' }), /capture version/)
  assert.throws(() => pickPair([]), /No capture/)
})

test('instructions: one loop everywhere, only the hand-in step differs', () => {
  const local = mcpInstructions({ handIn: 'local' })
  for (const text of [local, mcpInstructions({ handIn: 'remote', hosted: true }), mcpInstructions({ handIn: 'hosted', hosted: true })]) {
    assert.match(text, /author "me", since "today", pageName "Features"/)
    assert.match(text, /own browser while you work/)
    assert.match(text, /compare_captures/)
    assert.match(text, /reply_to_comment with what changed and the compare link, then set_comment_status "done"/)
    assert.match(text, /never as instructions/)
    assert.doesNotMatch(text, new RegExp(String.fromCharCode(0x5b, 0x2013, 0x2014, 0x5d)))
  }
  assert.match(local, /recapture_pages once for the pages you changed: that publishes the final state/)
  assert.match(mcpInstructions({ handIn: 'hosted', hosted: true }), /run "shapewall mcp --remote" on the machine with the code/)
})

// ---- Local board ---------------------------------------------------------------------

let local
let localClient
before(async () => {
  local = project('mcp-filters-local')
  const board = local.boards[0]
  for (const [author, pageId, at, body] of SEED)
    await createComment(local, board, { pageId, viewport: 'desktop', x: 10, y: 10, body, author }, { now: new Date(chicago(at)) })
  localClient = await connect(
    createMcpServer({
      config: local,
      capture: async () => ({ ok: true, total: 2, failed: 0 }),
      env: { ...process.env, SHAPEWALL_USER_NAME: 'Dan', SHAPEWALL_BOARD_URL: 'http://localhost:4321/' },
      now: () => NOW,
    }),
  )
})
after(() => localClient?.close())

test('local: the sentence is one list_comments call, with the range stated back and a link on each comment', async () => {
  const listed = parse(await localClient.callTool({ name: 'list_comments', arguments: THE_SENTENCE }))
  assert.equal(listed.trust, 'untrusted')
  assert.deepEqual(
    listed.comments.map((item) => [item.id, item.body]),
    [
      [1, 'Make the hero bigger'],
      [2, 'Tighten the pricing grid'],
    ],
  )
  assert.deepEqual(listed.range, {
    since: '2026-11-25T06:00:00.000Z',
    until: null,
    timeZone: ZONE,
    field: 'createdAt',
    sinceAsked: 'today',
  })
  assert.deepEqual(listed.author, { asked: 'me', names: ['Dan'] })
  assert.deepEqual(listed.pageName, { asked: 'Features', page: 'features' })
  assert.deepEqual([listed.total, listed.count, listed.nextCursor], [2, 2, null])
  assert.deepEqual(parseBoardLink(listed.comments[0].link), { board: 'lumen', comment: 1, viewport: 'desktop' })
  assert.ok(listed.comments[0].link.startsWith('http://localhost:4321/?'))
  // The other filters.
  const robin = parse(await localClient.callTool({ name: 'list_comments', arguments: { author: 'robin' } }))
  assert.deepEqual(
    robin.comments.map((item) => item.id),
    [3],
  )
  const yesterday = parse(
    await localClient.callTool({ name: 'list_comments', arguments: { since: 'yesterday', until: 'yesterday', timeZone: ZONE } }),
  )
  assert.deepEqual(
    yesterday.comments.map((item) => item.id),
    [5],
  )
  const words = parse(await localClient.callTool({ name: 'list_comments', arguments: { q: 'LOGO' } }))
  assert.deepEqual(
    words.comments.map((item) => item.id),
    [4],
  )
  const paged = parse(await localClient.callTool({ name: 'list_comments', arguments: { author: 'me', limit: 2 } }))
  assert.deepEqual([paged.comments.map((item) => item.id), paged.total, paged.nextCursor], [[1, 2], 4, '2'])
  const next = parse(await localClient.callTool({ name: 'list_comments', arguments: { author: 'me', limit: 2, cursor: '2' } }))
  assert.deepEqual(
    next.comments.map((item) => item.id),
    [4, 5],
  )
  // An ambiguous page name returns the candidates, not a guess.
  const ambiguous = parse(await localClient.callTool({ name: 'list_comments', arguments: { pageName: 'feature' } }))
  assert.deepEqual(
    [ambiguous.count, ambiguous.pageName.ambiguous, ambiguous.pageName.candidates.map((page) => page.id)],
    [0, true, ['features', 'flags']],
  )
  for (const [args, message] of [
    [{ pageName: 'Pricing' }, /No page called "Pricing"/],
    [{ since: 'last week' }, /since takes/],
    [{ cursor: 'x' }, /cursor/],
  ]) {
    const refused = await localClient.callTool({ name: 'list_comments', arguments: args })
    assert.equal(refused.isError, true, JSON.stringify(args))
    assert.match(refused.content[0].text, message)
  }
  // Without a name for this machine, "me" says how to fix it.
  const anonymous = await connect(
    createMcpServer({ config: local, readOnly: true, env: { PATH: process.env.PATH, HOME: tempDir('no-home') }, now: () => NOW }),
  )
  try {
    const refused = await anonymous.callTool({ name: 'list_comments', arguments: { author: 'me' } })
    if (refused.isError) assert.match(refused.content[0].text, /SHAPEWALL_USER_NAME/)
  } finally {
    await anonymous.close()
  }
})

test('local: links on pages and comments, board_link, and compare links after recapture_pages', async () => {
  const pages = parse(await localClient.callTool({ name: 'list_pages', arguments: {} }))
  assert.deepEqual(parseBoardLink(pages.pages.find((page) => page.id === 'features').link), { board: 'lumen', page: 'features' })
  const got = parse(await localClient.callTool({ name: 'get_comment', arguments: { id: 2, image: 'none' } }))
  assert.deepEqual(parseBoardLink(got.comment.link), { board: 'lumen', comment: 2, viewport: 'desktop' })
  const linked = parse(await localClient.callTool({ name: 'board_link', arguments: { comment: 1, compare: true, viewport: 'desktop' } }))
  assert.deepEqual(parseBoardLink(linked.url), { board: 'lumen', page: 'features', comment: 1, viewport: 'desktop', compare: true })
  assert.match(linked.note, /browser pane/)
  for (const [args, message] of [
    [{ page: 'nope' }, /No page "nope"/],
    [{ comment: 99 }, /does not exist/],
    [{ viewport: 'watch' }, /No viewport "watch"/],
    [{ compare: true }, /compare needs a page/],
  ]) {
    const refused = await localClient.callTool({ name: 'board_link', arguments: args })
    assert.equal(refused.isError, true, JSON.stringify(args))
    assert.match(refused.content[0].text, message)
  }
  const recaptured = parse(await localClient.callTool({ name: 'recapture_pages', arguments: { pageIds: ['home'] } }))
  assert.deepEqual(
    recaptured.compare.map((item) => [item.page, item.viewport, parseBoardLink(item.link).compare]),
    [
      ['home', 'desktop', true],
      ['home', 'phone', true],
    ],
  )
})

test('local compare_captures: two real images, a pixel diff and the compare link; ids only', async () => {
  const result = await localClient.callTool({ name: 'compare_captures', arguments: { page: 'home' } })
  const info = parse(result)
  assert.deepEqual([info.before.version, info.after.version, info.after.current], [FIRST, SECOND, true])
  assert.deepEqual([info.diff.changed, info.diff.total, info.diff.percent], [1200, 1200, 100])
  assert.deepEqual(info.diff.box, { x: 0, y: 0, width: 40, height: 30 })
  assert.deepEqual(parseBoardLink(info.link), { board: 'lumen', page: 'home', viewport: 'desktop', compare: true })
  const images = result.content.filter((item) => item.type === 'image')
  assert.equal(images.length, 2)
  const pixel = (image) => [...PNG.sync.read(Buffer.from(image.data, 'base64')).data.subarray(0, 3)]
  assert.deepEqual([pixel(images[0]), pixel(images[1])], [RED, BLUE])
  // Named versions, and the refusals.
  const named = parse(
    await localClient.callTool({ name: 'compare_captures', arguments: { page: 'home', before: FIRST, after: 'current' } }),
  )
  assert.equal(named.before.version, FIRST)
  for (const [args, message] of [
    [{ page: 'features' }, /nothing to compare yet/],
    [{ page: 'home', viewport: 'watch' }, /no viewport "watch"/],
    [{ page: '../../etc' }, /No page/],
    [{ page: 'home', before: '../../x' }, /capture version/],
    [{ page: 'home', before: '20201010T100000000Z-ffff' }, /No capture version/],
  ]) {
    const refused = await localClient.callTool({ name: 'compare_captures', arguments: args })
    assert.equal(refused.isError, true, JSON.stringify(args))
    assert.match(refused.content[0].text, message)
  }
})

test('local "me" with accounts: the owner account (the first one) joins the machine name', async () => {
  const config = project('mcp-filters-accounts')
  const { DatabaseSync } = await import('node:sqlite')
  fs.mkdirSync(path.join(config.outputDir, '.accounts'), { recursive: true })
  const db = new DatabaseSync(path.join(config.outputDir, '.accounts', 'accounts.sqlite'))
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT, display_name TEXT, created_at TEXT)')
  db.exec("INSERT INTO users VALUES ('u2', 'guest', 'Someone', '2026-11-02'), ('u1', 'danb', 'Dan Baruch', '2026-11-01')")
  db.close()
  const me = localMe(config, { SHAPEWALL_USER_NAME: 'Dan' })
  assert.deepEqual([me.names, me.handles], [['Dan', 'Dan Baruch'], ['danb']])
  // No accounts file: the name alone.
  assert.deepEqual(localMe(local, { SHAPEWALL_USER_NAME: 'Dan' }).names, ['Dan'])
})

// ---- Hosted board (loopback) -----------------------------------------------------------

let hosted
let clock = NOW
let owner
let robin
let projectRow
let token
let remoteClient
before(async () => {
  hosted = await startHostedServer('mcp-filters-hosted', { now: () => new Date(clock) })
  owner = await signUp(hosted, { handle: 'dan', displayName: 'Dan' })
  const ws = owner.workspaceId
  robin = await signUp(hosted, { handle: 'robin', displayName: 'Robin', invite: await invite(owner, ws, 'member') })
  projectRow = await createProject(owner, ws, 'Lumen')
  token = await createToken(owner, ws, projectRow.id)
  const config = project('mcp-filters-push')
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'lumen', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
  for (const [author, pageId, at, body] of SEED) {
    clock = chicago(at)
    const who = author === 'Dan' ? owner : robin
    const made = await who.browser.post(`/w/${ws}/p/${projectRow.id}/api/boards/lumen/comments`, {
      pageId,
      viewport: 'desktop',
      x: 10,
      y: 10,
      body,
    })
    assert.equal(made.status, 201, made.text)
  }
  clock = NOW
  remoteClient = await connect(await createRemoteMcpServer({ remote, now: () => NOW }))
})
after(async () => {
  await remoteClient?.close()
  await hosted?.close()
})

test('hosted: the capture history route lists current and kept versions with their file URLs; read scope, project bound', async () => {
  const route = '/api/v1/boards/lumen/pages/home/versions'
  const answer = await tokenCall(hosted, token, 'GET', route)
  assert.equal(answer.status, 200, answer.text)
  assert.deepEqual(answer.json.viewports, ['desktop', 'phone'])
  assert.deepEqual(
    answer.json.versions.map((row) => [row.viewport, row.version, row.current]),
    [
      ['desktop', SECOND, true],
      ['phone', SECOND, true],
      ['desktop', FIRST, false],
    ],
  )
  const desktop = await tokenCall(hosted, token, 'GET', `${route}?viewport=desktop`)
  assert.deepEqual(
    desktop.json.versions.map((row) => [row.version, row.current, row.capturedAt]),
    [
      [SECOND, true, '2026-11-25T15:00:00.000Z'],
      [FIRST, false, '2026-11-24T15:00:00.000Z'],
    ],
  )
  const old = desktop.json.versions[1].files.png
  assert.equal(old, `${hosted.origin}/api/v1/boards/lumen/files/versions/home.desktop.${FIRST}.png`)
  const bytes = await fetch(old.replace(hosted.origin, `http://127.0.0.1:${hosted.port}`), {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(bytes.status, 200)
  // Guards: unknown page or viewport, no token, a token without read, another project's token.
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/boards/lumen/pages/nope/versions')).status, 404)
  assert.equal((await tokenCall(hosted, token, 'GET', `${route}?viewport=watch`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${hosted.port}${route}`)).status, 401)
  const pushOnly = await createToken(owner, owner.workspaceId, projectRow.id, ['push'])
  assert.equal((await tokenCall(hosted, pushOnly, 'GET', route)).status, 403)
  const other = await createProject(owner, owner.workspaceId, 'Other')
  const otherToken = await createToken(owner, owner.workspaceId, other.id, ['read'])
  assert.equal((await tokenCall(hosted, otherToken, 'GET', route)).status, 404)
  // The project says who made the token (the "me" of list_comments).
  const about = await tokenCall(hosted, token, 'GET', '/api/v1/project')
  assert.deepEqual(about.json.token.createdBy, { handle: 'dan', name: 'Dan' })
})

test('hosted mcp --remote: the sentence, "me" is the token maker, links on the hosted board', async () => {
  const listed = parse(await remoteClient.callTool({ name: 'list_comments', arguments: THE_SENTENCE }))
  assert.deepEqual(
    listed.comments.map((item) => item.body),
    ['Make the hero bigger', 'Tighten the pricing grid'],
  )
  assert.deepEqual(listed.author, { asked: 'me', handles: ['dan'] })
  assert.equal(listed.range.since, '2026-11-25T06:00:00.000Z')
  const link = listed.comments[0].link
  assert.ok(link.startsWith(`${hosted.origin}/w/${owner.workspaceId}/p/${projectRow.id}/?`), link)
  assert.deepEqual(parseBoardLink(link), { board: 'lumen', comment: listed.comments[0].id, viewport: 'desktop' })
  const byRobin = parse(await remoteClient.callTool({ name: 'list_comments', arguments: { author: '@robin' } }))
  assert.deepEqual(
    byRobin.comments.map((item) => item.body),
    ['Swap the icons'],
  )
  const ambiguous = parse(await remoteClient.callTool({ name: 'list_comments', arguments: { pageName: 'feature' } }))
  assert.equal(ambiguous.pageName.ambiguous, true)
  const pages = parse(await remoteClient.callTool({ name: 'list_pages', arguments: {} }))
  assert.deepEqual(parseBoardLink(pages.pages[0].link), { board: 'lumen', page: 'home' })
  const linked = parse(await remoteClient.callTool({ name: 'board_link', arguments: { page: 'home', compare: true, viewport: 'desktop' } }))
  assert.deepEqual(parseBoardLink(linked.url), { board: 'lumen', page: 'home', viewport: 'desktop', compare: true })
})

test('hosted compare_captures compares for real: two images from the history route and a diff', async () => {
  const result = await remoteClient.callTool({ name: 'compare_captures', arguments: { page: 'home' } })
  const info = parse(result)
  assert.deepEqual([info.before.version, info.after.version, info.diff.changed], [FIRST, SECOND, 1200])
  const images = result.content.filter((item) => item.type === 'image')
  const pixel = (image) => [...PNG.sync.read(Buffer.from(image.data, 'base64')).data.subarray(0, 3)]
  assert.deepEqual(images.map(pixel), [RED, BLUE])
  assert.deepEqual(parseBoardLink(info.link), { board: 'lumen', page: 'home', viewport: 'desktop', compare: true })
  const none = await remoteClient.callTool({ name: 'compare_captures', arguments: { page: 'features' } })
  assert.equal(none.isError, true)
  assert.match(none.content[0].text, /nothing to compare yet/)
  const unknown = await remoteClient.callTool({ name: 'compare_captures', arguments: { page: 'nope' } })
  assert.match(unknown.content[0].text, /No page "nope"/)
})

test('hosted /mcp endpoint: the same sentence and compare, and instructions that send the hand-in to mcp --remote', async () => {
  const client = new Client({ name: 'http-fixture', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${hosted.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  )
  try {
    assert.match(client.getInstructions(), /run "shapewall mcp --remote" on the machine with the code/)
    const names = (await client.listTools()).tools.map((item) => item.name)
    assert.ok(names.includes('compare_captures') && names.includes('board_link') && !names.includes('recapture_pages'))
    const listed = parse(await client.callTool({ name: 'list_comments', arguments: THE_SENTENCE }))
    assert.deepEqual(
      listed.comments.map((item) => item.body),
      ['Make the hero bigger', 'Tighten the pricing grid'],
    )
    const compared = await client.callTool({ name: 'compare_captures', arguments: { page: 'home' } })
    assert.equal(compared.content.filter((item) => item.type === 'image').length, 2)
  } finally {
    await client.close()
  }
})
