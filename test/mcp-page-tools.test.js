// get_page_capture (local `shapewall mcp` and `mcp --remote`) and add_comment
// on `mcp --remote` with the token route behind it
// (POST /api/v1/boards/:bid/comments): ids only, never paths; the image is
// scaled down to a size a model reads; a token's comment is signed with its
// name, marked as an agent, audited, and never sent to an agent.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { createMcpServer } from '../src/mcp.js'
import { decodePng, encodePng, fitPng } from '../src/png.js'
import { pushBoard } from '../src/remote/cli.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { createRemote } from '../src/remote/remote.js'
import { LIMITS } from '../src/hosted/ratelimit.js'
import { boardDir, readManifest, versionTime } from '../src/store.js'
import { createProject, createToken, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'

const parse = (result) => JSON.parse(result.content[0].text)

// A width x height RGB capture: red left half, blue right half.
function halves(width, height) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels[(y * width + x) * 3 + (x < width / 2 ? 0 : 2)] = 255
  return encodePng({ width, height, channels: 3, colorType: 2, pixels })
}

async function connect(server) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

// The element map of a page: the body and one button in its middle.
const mapFor = (size) => ({
  v: 1,
  width: size.width,
  height: size.height,
  elements: [
    { t: 'body', n: 1, p: -1, b: [0, 0, size.width, size.height], x: 'Live' },
    { t: 'button', n: 1, p: 0, b: [size.width / 2 - 50, 100, 100, 40], x: 'Buy', d: 'buy', h: 'button[data-testid="buy"]', z: 0 },
  ],
})

let config
let hosted
let owner
let project
let token

before(async () => {
  const dir = tempDir('mcp-page-tools')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  config = loadConfig(path.join(dir, 'shapewall.config.json'))
  writeLocalCaptures(config, 'sample', {
    html: '<!DOCTYPE html><html><body><button data-testid="buy">Buy</button></body></html>',
    elements: mapFor,
  })
  const captures = path.join(boardDir(config, 'sample'), 'captures')
  fs.writeFileSync(path.join(captures, 'home.desktop.png'), halves(3200, 40))
  fs.writeFileSync(path.join(captures, 'pricing.desktop.png'), halves(100, 8000))
  const manifest = readManifest(config, 'sample')
  manifest.pages.home.desktop.version = '20261120T093000123Z-abcd'
  fs.writeFileSync(path.join(captures, 'manifest.json'), JSON.stringify(manifest))

  hosted = await startHostedServer('mcp-page-tools')
  owner = await signUp(hosted, { handle: 'pia', displayName: 'Pia' })
  project = await createProject(owner, owner.workspaceId, 'Lumen')
  token = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply', 'status', 'resolve', 'push'])
  await pushBoard({ config, board: config.boards[0], remote: createRemote({ origin: hosted.origin, token }) })
})
after(() => hosted?.close())

test('fitPng scales down by averaging, never up, and crops in the capture pixels first', () => {
  const wide = fitPng(halves(3200, 40))
  assert.deepEqual([wide.width, wide.height, wide.scale], [1600, 20, 0.5])
  assert.deepEqual(wide.size, { width: 3200, height: 40 })
  const image = decodePng(wide.png)
  // Red on the left, blue on the right, as in the capture.
  assert.deepEqual([...image.pixels.subarray(0, 3)], [255, 0, 0])
  assert.deepEqual([...image.pixels.subarray((1600 - 1) * 3, 1600 * 3)], [0, 0, 255])
  // Averaging: a 2x2 checkerboard of black and white is grey.
  const board = encodePng({ width: 2, height: 2, channels: 1, colorType: 0, pixels: Buffer.from([0, 255, 255, 0]) })
  assert.equal(decodePng(fitPng(board, { maxWidth: 1 }).png).pixels[0], 128)
  // Long pages fit the height too; small ones are left as they are.
  const tall = fitPng(halves(100, 20000))
  assert.deepEqual([tall.width, tall.height], [40, 8000])
  assert.equal(fitPng(halves(8, 6)).scale, 1)
  // A crop is clamped to the capture and shown at full size when it fits.
  const cut = fitPng(halves(3200, 40), { crop: { x: 3000, y: 10, width: 900, height: 900 } })
  assert.deepEqual(cut.rect, { x: 3000, y: 10, width: 200, height: 30 })
  assert.deepEqual([cut.width, cut.height, cut.scale], [200, 30, 1])
})

test('local get_page_capture: by ids, scaled, with when it was captured; read-only has it', async () => {
  const client = await connect(createMcpServer({ config, readOnly: true }))
  assert.ok((await client.listTools()).tools.some((item) => item.name === 'get_page_capture'))
  const got = await client.callTool({ name: 'get_page_capture', arguments: { page: 'home' } })
  assert.equal(got.isError, undefined, got.content[0].text)
  const info = parse(got)
  assert.deepEqual(info, {
    board: 'sample',
    page: 'home',
    viewport: 'desktop',
    capturedAt: '2026-11-20T09:30:00.123Z',
    size: { width: 3200, height: 40 },
    image: { width: 1600, height: 20, scale: 0.5 },
  })
  const image = got.content.at(-1)
  assert.equal(image.type, 'image')
  assert.equal(image.mimeType, 'image/png')
  assert.equal(decodePng(Buffer.from(image.data, 'base64')).width, 1600)
  // Another viewport, and a crop.
  const phone = parse(await client.callTool({ name: 'get_page_capture', arguments: { page: 'home', viewport: 'phone' } }))
  assert.deepEqual([phone.viewport, phone.size.width, phone.capturedAt], ['phone', 8, versionTime('20261101T100000000Z-ab12')])
  const cropped = parse(
    await client.callTool({ name: 'get_page_capture', arguments: { page: 'home', crop: { x: 1500, y: 0, width: 200, height: 40 } } }),
  )
  assert.deepEqual(cropped.crop, { x: 1500, y: 0, width: 200, height: 40 })
  assert.deepEqual(cropped.image, { width: 200, height: 40, scale: 1 })
  // Ids only: no page, no viewport, no path; nothing captured says so.
  for (const [args, message] of [
    [{ page: '../../etc/passwd' }, /No page/],
    [{ page: 'home', viewport: '../x' }, /no viewport/],
    [{ page: 'app', viewport: 'phone' }, /no viewport "phone"/],
    [{ page: 'home', board: 'other' }, /board/i],
  ]) {
    const refused = await client.callTool({ name: 'get_page_capture', arguments: args })
    assert.equal(refused.isError, true, JSON.stringify(args))
    assert.match(refused.content[0].text, message)
  }
  const bad = await client.callTool({ name: 'get_page_capture', arguments: { page: 'home', crop: { x: 0, y: 0, width: 0, height: 5 } } })
  assert.equal(bad.isError, true)
  // A capture that is a symlink is never read.
  const link = path.join(boardDir(config, 'sample'), 'captures', 'app.desktop.png')
  fs.rmSync(link)
  fs.symlinkSync(path.join(boardDir(config, 'sample'), 'captures', 'home.desktop.png'), link)
  const linked = await client.callTool({ name: 'get_page_capture', arguments: { page: 'app' } })
  assert.equal(linked.isError, true)
  assert.match(linked.content[0].text, /regular capture file/i)
  fs.rmSync(link)
  const missing = await client.callTool({ name: 'get_page_capture', arguments: { page: 'app' } })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /No capture of "app"/)
  await client.close()
})

test('remote get_page_capture reads the hosted capture by ids; read-only tokens have it', async () => {
  const reader = await createToken(owner, owner.workspaceId, project.id, ['read'])
  const client = await connect(await createRemoteMcpServer({ remote: createRemote({ origin: hosted.origin, token: reader }) }))
  const names = (await client.listTools()).tools.map((item) => item.name)
  assert.ok(names.includes('get_page_capture'))
  assert.ok(!names.includes('add_comment'))
  const got = await client.callTool({ name: 'get_page_capture', arguments: { page: 'home' } })
  assert.equal(got.isError, undefined, got.content[0].text)
  assert.deepEqual(parse(got), {
    board: 'sample',
    page: 'home',
    viewport: 'desktop',
    capturedAt: '2026-11-20T09:30:00.123Z',
    size: { width: 3200, height: 40 },
    image: { width: 1600, height: 20, scale: 0.5 },
  })
  assert.equal(got.content.at(-1).type, 'image')
  const tall = parse(await client.callTool({ name: 'get_page_capture', arguments: { page: 'pricing' } }))
  assert.deepEqual(tall.image, { width: 100, height: 8000, scale: 1 })
  const cropped = parse(
    await client.callTool({ name: 'get_page_capture', arguments: { page: 'pricing', crop: { x: 0, y: 7900, width: 50, height: 500 } } }),
  )
  assert.deepEqual(cropped.crop, { x: 0, y: 7900, width: 50, height: 100 })
  for (const [args, message] of [
    [{ page: '../captures/home' }, /No page/],
    [{ page: 'home', viewport: 'desktop/../../x' }, /no viewport/],
    [{ page: 'home', board: '../sample' }, /No board/],
  ]) {
    const refused = await client.callTool({ name: 'get_page_capture', arguments: args })
    assert.equal(refused.isError, true, JSON.stringify(args))
    assert.match(refused.content[0].text, message)
  }
  // The pages route says when each viewport was captured.
  const pages = await createRemote({ origin: hosted.origin, token: reader }).pages('sample')
  assert.deepEqual(pages.pages.find((item) => item.id === 'home').capturedAt, {
    desktop: '2026-11-20T09:30:00.123Z',
    phone: '2026-11-01T10:00:00.000Z',
  })
  await client.close()
})

test('remote add_comment pins on the element, signs as the token, and never goes to an agent', async () => {
  const published = []
  const unsubscribe = hosted.app.locals.events.subscribe((event) => published.push(event.type))
  const client = await connect(await createRemoteMcpServer({ remote: createRemote({ origin: hosted.origin, token }) }))
  let added
  try {
    added = parse(
      await client.callTool({
        name: 'add_comment',
        arguments: { page: 'home', body: 'The Buy button needs more contrast @agent', selector: 'button[data-testid="buy"]' },
      }),
    )
  } finally {
    unsubscribe()
  }
  assert.equal(added.trust, 'untrusted')
  const comment = added.comment
  assert.equal(comment.page.id, 'home')
  assert.equal(comment.viewport.name, 'desktop')
  assert.equal(comment.authorAgent, true)
  assert.equal(comment.element.selector, 'button[data-testid="buy"]')
  // The pin is in the middle of the button (720 px across, 120 px down the 1440x2200 capture).
  assert.ok(Math.abs(comment.position.x - 720) <= 1, String(comment.position.x))
  assert.ok(Math.abs(comment.position.y - 120) <= 1, String(comment.position.y))
  assert.equal(comment.dispatchable, false)
  assert.deepEqual(published, ['comment.created'])
  const row = hosted.db.prepare('SELECT author, author_token_id, author_user_id FROM comments WHERE number = ?').get(comment.id)
  assert.ok(row.author_token_id)
  assert.equal(row.author_user_id, null)
  const audit = hosted.db.prepare("SELECT target, detail FROM audit_log WHERE action = 'token_commented' ORDER BY id DESC LIMIT 1").get()
  assert.equal(audit.target, `sample#${comment.id}`)
  // A trusted person cannot send an agent's comment to an agent either.
  const sent = await owner.browser.post(`/w/${owner.workspaceId}/p/${project.id}/api/boards/sample/comments/${comment.id}/send-to-agent`, {
    dispatchHash: comment.dispatchHash || 'x',
  })
  assert.equal(sent.status, 403)

  // Without a selector: near the top-left corner, on a variant or another viewport too.
  const plain = parse(await client.callTool({ name: 'add_comment', arguments: { page: 'pricing', body: 'Plain', viewport: 'phone' } }))
  assert.equal(plain.comment.viewport.name, 'phone')
  assert.deepEqual([plain.comment.position.xPercent, plain.comment.position.yPercent], [2, 2])
  // A selector the map does not have keeps the selector and says so.
  const unmatched = parse(await client.callTool({ name: 'add_comment', arguments: { page: 'home', body: 'Where?', selector: '#missing' } }))
  assert.equal(unmatched.comment.element.selector, '#missing')
  assert.match(unmatched.notes[0], /finds no element/)
  for (const [args, message] of [
    [{ page: 'nope', body: 'x' }, /^unknown_page: /],
    [{ page: 'app', body: 'x', viewport: 'phone' }, /^invalid_viewport: /],
    [{ page: 'home', body: 'x', selector: 'div.class' }, /is not one Shapewall can use/],
  ]) {
    const refused = await client.callTool({ name: 'add_comment', arguments: args })
    assert.equal(refused.isError, true, JSON.stringify(args))
    assert.match(refused.content[0].text, message)
  }
  await client.close()
})

test('the token comment route needs the reply scope and takes only text and a pin', async () => {
  const reader = await createToken(owner, owner.workspaceId, project.id, ['read', 'status'])
  const refused = await tokenCall(hosted, reader, 'POST', '/api/v1/boards/sample/comments', { body: { page: 'home', body: 'x' } })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'missing_scope')
  const call = (body) => tokenCall(hosted, token, 'POST', '/api/v1/boards/sample/comments', { body })
  for (const [body, status, code] of [
    [{ page: 'home', body: '' }, 400, null],
    [{ page: 'home', body: 'x'.repeat(5001) }, 400, null],
    [{ page: 'home', body: 'x', x: 101 }, 400, 'invalid_position'],
    [{ page: 'home', body: 'x', viewport: 'tv' }, 400, 'invalid_viewport'],
    [{ page: '../home', body: 'x' }, 404, 'unknown_page'],
  ]) {
    const result = await call(body)
    assert.equal(result.status, status, JSON.stringify(body).slice(0, 80))
    if (code) assert.equal(result.json.error.code, code)
  }
  const other = await tokenCall(hosted, token, 'POST', '/api/v1/boards/other/comments', { body: { page: 'home', body: 'x' } })
  assert.equal(other.status, 404)
  // An author name, images or a drawing in the request are not taken.
  const made = await call({
    page: 'home',
    body: 'Only text',
    author: 'Pia',
    images: [{ name: 'a.png', data: 'aGVsbG8=' }],
    drawing: { strokes: [] },
  })
  assert.equal(made.status, 201, JSON.stringify(made.json))
  assert.notEqual(made.json.comment.author, 'Pia')
  assert.equal(made.json.comment.authorAgent, true)
  assert.deepEqual(made.json.comment.files.images || [], [])
  assert.equal(made.json.comment.files.markup || null, null)
  // Too large a request body is refused before anything is read.
  const huge = await call({ page: 'home', body: 'x'.repeat(70 * 1024) })
  assert.equal(huge.status, 413)
  // New comments have a budget per token of their own.
  const saved = LIMITS.tokenComment
  LIMITS.tokenComment = { limit: 2, windowMs: 60 * 60_000 }
  try {
    const looping = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply'])
    const post = () => tokenCall(hosted, looping, 'POST', '/api/v1/boards/sample/comments', { body: { page: 'home', body: 'again' } })
    assert.equal((await post()).status, 201)
    assert.equal((await post()).status, 201)
    const limited = await post()
    assert.equal(limited.status, 429)
    assert.equal(limited.json.error.code, 'rate_limited')
  } finally {
    LIMITS.tokenComment = saved
  }
})
