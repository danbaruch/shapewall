// Fixes from the security review of the 1.3.0 MCP core: compare_captures
// decodes each capture once, a row at a time, diffs the shown images and
// refuses oversized captures from their PNG header; the hosted endpoint
// fits in worker threads with one compare per token; the local current
// capture is re-checked after reading; and "me" on a local board goes by a
// server-side owner stamp, not by a display name anyone can sign with.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { authorFilter, narrowComments } from '../src/comment-filters.js'
import { COMPARE_MAX_PIXELS, HOSTED_COMPARE_MAX_PIXELS, compareImages, readPair } from '../src/compare-captures.js'
import { createCleaner } from '../src/hosted/cleaner.js'
import { hostedCompare } from '../src/hosted/mcp-http.js'
import { createMcpServer, localMe } from '../src/mcp.js'
import { decodePng, encodePng, fitImage, fitPng, pngHeader } from '../src/png.js'
import { createApp } from '../src/server/app.js'
import { commentsFile, createComment } from '../src/store.js'
import { request, sampleConfig, tempDir } from './helpers.js'

// A PNG whose header says width x height, with a body that is not zlib:
// anything that inflated it would fail with a zlib error, not a size one.
function headerOnlyPng(width, height, colorType = 0) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from('not zlib at all')),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// An RGBA PNG (pngjs: adaptive filters, so every filter type shows up).
function pattern(width, height, paint) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) png.data.set([...paint(x, y), 255], (y * width + x) * 4)
  return PNG.sync.write(png)
}
const page = (x, y) => [(x * 7 + y * 3) & 255, (x ^ y) & 255, (y * 5) & 255]

test('decodePng reads every filter type like pngjs, and pngHeader reads the size without inflating', () => {
  for (const [width, height] of [
    [1, 1],
    [3, 7],
    [64, 33],
    [257, 19],
  ]) {
    const png = pattern(width, height, page)
    const ours = decodePng(png)
    assert.deepEqual([ours.width, ours.height, ours.channels], [width, height, 4])
    assert.ok(ours.pixels.equals(PNG.sync.read(png).data), `${width}x${height}`)
  }
  assert.deepEqual(pngHeader(headerOnlyPng(8000, 6000)), { width: 8000, height: 6000, bitDepth: 8, colorType: 0, interlace: 0 })
  assert.throws(() => pngHeader(Buffer.from('nope')), /not a PNG/)
})

test('fitImage: one pass, a row at a time, the same pixels as cutting and averaging the decoded image', () => {
  const png = pattern(301, 157, page)
  const whole = decodePng(png)
  // The reference: cut, then average each block, straight from the decoded pixels.
  const reference = (rect, width, height) => {
    const out = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      const top = rect.y + Math.floor((y * rect.height) / height)
      const bottom = rect.y + Math.max(Math.floor((y * rect.height) / height) + 1, Math.floor(((y + 1) * rect.height) / height))
      for (let x = 0; x < width; x += 1) {
        const left = rect.x + Math.floor((x * rect.width) / width)
        const right = rect.x + Math.max(Math.floor((x * rect.width) / width) + 1, Math.floor(((x + 1) * rect.width) / width))
        for (let c = 0; c < 4; c += 1) {
          let sum = 0
          for (let sy = top; sy < bottom; sy += 1)
            for (let sx = left; sx < right; sx += 1) sum += whole.pixels[(sy * whole.width + sx) * 4 + c]
          out[(y * width + x) * 4 + c] = Math.round(sum / ((bottom - top) * (right - left)))
        }
      }
    }
    return out
  }
  for (const options of [
    { maxWidth: 100, maxHeight: 8000 },
    { maxWidth: 1600, maxHeight: 40 },
    { crop: { x: 20, y: 30, width: 200, height: 90 }, maxWidth: 70 },
    { crop: { x: 280, y: 150, width: 500, height: 500 } },
    { scale: 0.333 },
  ]) {
    const fit = fitImage(png, options)
    assert.ok(fit.pixels.equals(reference(fit.rect, fit.width, fit.height)), JSON.stringify(options))
    assert.ok(decodePng(fitPng(png, options).png).pixels.equals(fit.pixels))
  }
  assert.throws(() => fitImage(headerOnlyPng(5000, 5000), { maxPixels: 1_000_000 }), /too large/)
})

test('compare_captures diffs the shown images: scaled pair, box back in capture pixels, encoded once', () => {
  const width = 3200
  const height = 120
  const before = pattern(width, height, () => [240, 240, 240])
  const after = pattern(width, height, (x, y) => (x >= 1000 && x < 1400 && y >= 40 && y < 80 ? [20, 20, 20] : [240, 240, 240]))
  const result = compareImages({ beforePng: before, afterPng: after })
  assert.equal(result.diff.scale, 0.5)
  assert.deepEqual([result.after.width, result.after.height], [1600, 60])
  // 200 x 20 shown pixels changed; the box is where they are in the capture.
  assert.equal(result.diff.changed, 200 * 20)
  assert.equal(result.diff.total, 1600 * 60)
  assert.deepEqual(result.diff.box, { x: 1000, y: 40, width: 400, height: 40 })
  assert.deepEqual(result.diff.sizes.after, { width, height })
  assert.equal(decodePng(result.after.png).width, 1600)
  // A crop: both cut to it, at full size.
  const cropped = compareImages({ beforePng: before, afterPng: after, crop: { x: 900, y: 0, width: 600, height: 120 } })
  assert.equal(cropped.diff.scale, 1)
  assert.deepEqual(cropped.diff.box, { x: 1000, y: 40, width: 400, height: 40 })
})

test('a capture over the pixel cap is refused from its header, before anything is decoded (large grayscale header)', () => {
  const small = pattern(10, 10, page)
  // 8000 x 6000 gray: 48 MP, past the 40 MP local cap; its body is not even zlib.
  const huge = headerOnlyPng(8000, 6000, 0)
  assert.throws(
    () => compareImages({ beforePng: small, afterPng: huge }),
    (error) =>
      /after capture is 8000x6000 pixels, more than the 40 megapixels/.test(error.message) && !/zlib|header check/i.test(error.message),
  )
  assert.equal(COMPARE_MAX_PIXELS, 40_000_000)
  // The hosted endpoint's cap is the push limit: 3840 x 4400 is over it.
  assert.throws(
    () => compareImages({ beforePng: headerOnlyPng(3840, 4400, 6), afterPng: small, maxPixels: HOSTED_COMPARE_MAX_PIXELS }),
    /before capture is 3840x4400 pixels, more than the 16 megapixels/,
  )
})

test('hosted compare: fitted in the cleaner workers like inline, one compare per token, busy is a retry error', async () => {
  const before = pattern(2000, 50, page)
  const after = pattern(2000, 50, (x, y) => page(x + 1, y))
  const cleaner = createCleaner({ size: 2 })
  try {
    const gate = hostedCompare(cleaner)({ tokenId: 'token-a', workspaceId: 'w1' })
    assert.equal(gate.maxPixels, HOSTED_COMPARE_MAX_PIXELS)
    const inWorkers = await compareImages({ beforePng: before, afterPng: after, maxPixels: gate.maxPixels, fit: gate.fit })
    const inline = compareImages({ beforePng: before, afterPng: after })
    assert.ok(inWorkers.after.png.equals(inline.after.png))
    assert.deepEqual(inWorkers.diff, inline.diff)
    // A broken capture comes back as a readable error from the worker, and
    // one that is not a PNG at all as a rejection too (never a throw).
    await assert.rejects(
      compareImages({ beforePng: before, afterPng: headerOnlyPng(10, 10, 6), fit: gate.fit }),
      /after capture could not be read as a PNG/,
    )
    await assert.rejects(
      compareImages({ beforePng: Buffer.from('not a png at all, not at all, not at all'), afterPng: after, fit: gate.fit }),
      /before capture could not be read as a PNG \(not a PNG\)/,
    )
  } finally {
    await cleaner.close()
  }
  const forToken = hostedCompare(null, { globalMax: 3 })
  let release
  const first = forToken({ tokenId: 'token-a', workspaceId: 'w1' }).run(() => new Promise((resolve) => (release = resolve)))
  await assert.rejects(
    forToken({ tokenId: 'token-a', workspaceId: 'w1' }).run(async () => 'second'),
    (error) => error.code === 'busy' && error.status === 429 && /this token/.test(error.message) && /Retry/.test(error.message),
  )
  // Another workspace's token is not held up, and the slot frees when the first ends.
  assert.equal(await forToken({ tokenId: 'token-b', workspaceId: 'w2' }).run(async () => 'other'), 'other')
  release('first')
  assert.equal(await first, 'first')
  assert.equal(await forToken({ tokenId: 'token-a', workspaceId: 'w1' }).run(async () => 'again'), 'again')
})

// A cleaner whose jobs the test settles by hand.
function handCleaner({ queued = 0, maxQueue = 32 } = {}) {
  const jobs = []
  return {
    jobs,
    queued,
    clean() {
      return new Promise((resolve, reject) => jobs.push({ resolve, reject }))
    },
    stats() {
      return { busy: jobs.length, idle: 0, queued: this.queued, size: 2, maxQueue }
    },
  }
}
const fitted = () => ({ buffer: Buffer.alloc(8), pixelBytes: 4, width: 1, height: 1 })
const holding = () => {
  let release
  const work = () => new Promise((resolve) => (release = resolve))
  return { work, release: (value) => release(value) }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('hosted compare: one compare on the whole server at a time, whatever the workspace or token', async () => {
  const compare = hostedCompare(null)
  const held = holding()
  const first = compare({ tokenId: 'a', workspaceId: 'w1' }).run(held.work)
  await assert.rejects(
    compare({ tokenId: 'b', workspaceId: 'w2' }).run(async () => 'x'),
    /another compare/,
  )
  await assert.rejects(
    compare({ tokenId: 'c', workspaceId: 'w3' }).run(async () => 'x'),
    (error) => error.status === 429,
  )
  held.release('done')
  assert.equal(await first, 'done')
  assert.equal(await compare({ tokenId: 'b', workspaceId: 'w2' }).run(async () => 'next'), 'next')
})

test('hosted compare: one compare per workspace at a time, even with room on the server', async () => {
  const compare = hostedCompare(null, { globalMax: 4 })
  const held = holding()
  const first = compare({ tokenId: 'a', workspaceId: 'w1' }).run(held.work)
  // Another token of the same workspace waits; another workspace does not.
  await assert.rejects(
    compare({ tokenId: 'b', workspaceId: 'w1' }).run(async () => 'x'),
    /this workspace/,
  )
  assert.equal(await compare({ tokenId: 'c', workspaceId: 'w2' }).run(async () => 'other'), 'other')
  held.release('done')
  await first
  assert.equal(await compare({ tokenId: 'b', workspaceId: 'w1' }).run(async () => 'now'), 'now')
})

test('hosted compare: refused while the shared queue is over half full, so pushes keep their half', async () => {
  const cleaner = handCleaner({ queued: 16, maxQueue: 32 })
  const compare = hostedCompare(cleaner)
  await assert.rejects(
    compare({ tokenId: 'a', workspaceId: 'w1' }).run(async () => 'x'),
    (error) => error.status === 429 && /busy cleaning files/.test(error.message),
  )
  assert.equal(cleaner.jobs.length, 0, 'nothing went into the pool')
  cleaner.queued = 15
  const gate = compare({ tokenId: 'a', workspaceId: 'w1' })
  const run = gate.run(() => gate.fit(Buffer.alloc(1), {}))
  await tick()
  assert.equal(cleaner.jobs.length, 1)
  cleaner.jobs[0].resolve(fitted())
  assert.equal((await run).width, 1)
  // The queue filling up between a compare's two captures stops the second one.
  const second = compare({ tokenId: 'a', workspaceId: 'w1' })
  const both = second.run(() => Promise.all([second.fit(Buffer.alloc(1), {}), second.fit(Buffer.alloc(1), {})]))
  await tick()
  cleaner.queued = 20
  cleaner.jobs[1].resolve(fitted())
  await assert.rejects(both, (error) => error.status === 429)
  assert.equal(cleaner.jobs.length, 2, 'the second capture never went into the pool')
})

test('hosted compare: a compare holds one worker at a time, and its slots wait for both fits to settle', async () => {
  const cleaner = handCleaner()
  const compare = hostedCompare(cleaner)
  const gate = compare({ tokenId: 'a', workspaceId: 'w1' })
  let second
  const run = gate.run(async () => {
    const first = gate.fit(Buffer.alloc(1), {})
    second = gate.fit(Buffer.alloc(1), {})
    second.catch(() => {})
    await first
    // The tool gives up after the first capture (an error of its own).
    throw new Error('gave up')
  })
  await tick()
  assert.equal(cleaner.jobs.length, 1, 'the captures go into the pool one after the other')
  cleaner.jobs[0].resolve(fitted())
  await tick()
  assert.equal(cleaner.jobs.length, 2)
  // The second capture is still in the pool: the slots stay taken.
  await tick()
  await assert.rejects(
    compare({ tokenId: 'b', workspaceId: 'w2' }).run(async () => 'x'),
    /another compare/,
  )
  cleaner.jobs[1].resolve(fitted())
  await assert.rejects(run, /gave up/)
  assert.equal(await compare({ tokenId: 'b', workspaceId: 'w2' }).run(async () => 'free'), 'free')

  // A first capture that fails: the second is never started, and the slots free.
  const next = compare({ tokenId: 'a', workspaceId: 'w1' })
  const failing = next.run(() => Promise.all([next.fit(Buffer.alloc(1), {}), next.fit(Buffer.alloc(1), {})]))
  await tick()
  cleaner.jobs[2].reject(Object.assign(new Error('bad'), { code: 'clean_failed' }))
  await assert.rejects(failing, /bad/)
  assert.equal(cleaner.jobs.length, 3)
  assert.equal(await compare({ tokenId: 'c', workspaceId: 'w3' }).run(async () => 'ok'), 'ok')
})

test('local compare: a capture that lands while the pair is read is refused, not mislabeled', () => {
  const pair = { before: { version: 'v1', current: false }, after: { version: 'v2', current: true } }
  let version = 'v2'
  const read = (entry) => {
    if (entry.current) version = 'v3' // a capture replaces the current file meanwhile
    return Buffer.from(entry.version)
  }
  assert.throws(
    () => readPair({ pair, read, current: 'v2', currentNow: () => version, what: '"home" (desktop)' }),
    /current capture of "home" \(desktop\) changed while comparing/,
  )
  version = 'v2'
  const steady = readPair({ pair, read: (entry) => Buffer.from(entry.version), current: 'v2', currentNow: () => version })
  assert.equal(steady.afterPng.toString(), 'v2')
  // Two kept versions: nothing to re-check.
  const old = { before: { version: 'v0', current: false }, after: { version: 'v1', current: false } }
  assert.equal(
    readPair({ pair: old, read: (entry) => Buffer.from(entry.version), current: 'v2', currentNow: () => 'v9' }).afterPng.toString(),
    'v1',
  )
})

// ---- "me" on a local board --------------------------------------------------------

let server
let port
let config
before(async () => {
  config = sampleConfig('me-owner-stamp')
  server = await new Promise((resolve) => {
    const instance = createApp({ config, clientDir: tempDir('me-owner-client') }).listen(0, '127.0.0.1', () => resolve(instance))
  })
  port = server.address().port
})
after(() => server?.close())

const pin = { pageId: 'home', viewport: 'desktop', x: 10, y: 10 }

test('local comments carry a server-side owner stamp the request body cannot set', async () => {
  const mine = await request(port, 'POST', '/api/boards/sample/comments', { body: { ...pin, body: 'From my browser', author: 'Dan' } })
  assert.equal(mine.status, 201, mine.text)
  assert.equal(mine.json.comment.byOwner, true)
  // A board shared beyond this machine: the same request is nobody's owner stamp, whatever it sends.
  const shared = await new Promise((resolve) => {
    const instance = createApp({ config, clientDir: tempDir('me-owner-client'), allowedHosts: null }).listen(0, '127.0.0.1', () =>
      resolve(instance),
    )
  })
  try {
    const visitor = await request(shared.address().port, 'POST', '/api/boards/sample/comments', {
      body: { ...pin, body: 'Signed as the owner', author: 'Dan', byOwner: true },
    })
    assert.equal(visitor.status, 201, visitor.text)
    assert.equal(visitor.json.comment.byOwner, false)
  } finally {
    shared.close()
  }
})

test('local "me" matches the owner stamp, never an impostor by name; unstamped older comments match by name and say so', async () => {
  const dir = path.dirname(commentsFile(config, 'sample'))
  fs.mkdirSync(dir, { recursive: true })
  const board = config.boards.find((item) => item.id === 'sample')
  const own = await createComment(config, board, { ...pin, body: 'Mine, stamped', author: 'Somebody else' }, { owner: true })
  const impostor = await createComment(config, board, { ...pin, body: 'LAN visitor as Dan', author: 'Dan' }, { owner: false })
  const legacy = await createComment(config, board, { ...pin, body: 'From 1.2.0', author: 'Dan' }, { owner: true })
  // A comment from before the stamp: no byOwner at all.
  const store = JSON.parse(fs.readFileSync(commentsFile(config, 'sample'), 'utf8'))
  delete store.comments.find((item) => item.id === legacy.id).byOwner
  fs.writeFileSync(commentsFile(config, 'sample'), JSON.stringify(store))

  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([createMcpServer({ config, env: { ...process.env, SHAPEWALL_USER_NAME: 'Dan' } }).connect(b), client.connect(a)])
  try {
    const listed = JSON.parse((await client.callTool({ name: 'list_comments', arguments: { author: 'me' } })).content[0].text)
    const ids = listed.comments.map((item) => item.id)
    assert.ok(ids.includes(own.id), 'the stamped comment is mine whatever name it shows')
    assert.ok(!ids.includes(impostor.id), 'a comment signed "Dan" from elsewhere is not')
    assert.ok(ids.includes(legacy.id), 'an unstamped older comment falls back to the name')
    assert.equal(listed.author.meMatch, 'owner+name')
    assert.deepEqual(listed.author.matchedByName, [legacy.id])
    assert.match(listed.author.note, /no owner stamp/)
  } finally {
    await client.close()
  }
  // The filter on its own: stamped only, it says "owner".
  const me = authorFilter('me', { me: localMe(config, { SHAPEWALL_USER_NAME: 'Dan' }) })
  const stamped = narrowComments(
    [
      { id: 1, author: 'x', byOwner: true },
      { id: 2, author: 'Dan', byOwner: false },
    ],
    { author: me },
  )
  assert.deepEqual(
    stamped.comments.map((item) => item.id),
    [1],
  )
  assert.equal(me.stated.meMatch, 'owner')
  // "me" works with no name at all: the stamp is enough.
  const nameless = authorFilter('me', { me: { names: [], handles: [], ownerStamp: true } })
  assert.equal(nameless.match({ id: 3, author: 'anyone', byOwner: true }), true)
})

test('the PNG writer still writes what the reader reads at either zlib level', () => {
  const image = {
    width: 5,
    height: 4,
    channels: 3,
    colorType: 2,
    pixels: Buffer.from(Array.from({ length: 60 }, (_, i) => (i * 37) & 255)),
  }
  for (const level of [3, 6]) assert.ok(decodePng(encodePng(image, { level })).pixels.equals(image.pixels))
})
