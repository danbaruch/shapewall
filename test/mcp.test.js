// Drives `shapewall mcp` over stdio with the official MCP client.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadConfig } from '../src/config.js'
import { decodePng, encodePng } from '../src/png.js'
import { createJourney, deleteJourney, listJourneys } from '../src/journeys.js'
import { journeyPageIds } from '../src/mcp.js'
import { createComment, getComment } from '../src/store.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shapewall.js')

let config
let client
let readOnlyClient
let file

async function connect(args) {
  const instance = new Client({ name: 'shapewall-test', version: '1.0.0' })
  await instance.connect(
    new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', '--config', file, ...args], stderr: 'pipe' }),
  )
  return instance
}

const parse = (result) => JSON.parse(result.content[0].text)

before(async () => {
  const dir = tempDir('mcp')
  file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  config = loadConfig(file)
  // A real 1440x2200 RGB capture: red left half, blue right half.
  const width = 1440
  const height = 2200
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels[(y * width + x) * 3 + (x < width / 2 ? 0 : 2)] = 255
  const captures = path.join(config.outputDir, 'sample', 'captures')
  fs.mkdirSync(captures, { recursive: true })
  fs.writeFileSync(path.join(captures, 'pricing.desktop.png'), encodePng({ width, height, channels: 3, colorType: 2, pixels }))
  const board = config.boards[0]
  await createComment(config, board, {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 75,
    y: 50,
    body: 'Make the Plus card stand out',
    anchor: { selector: 'a[data-testid="plus-cta"]', text: 'Try Plus', dx: 0.5, dy: 0.5 },
  })
  await createComment(config, board, { pageId: 'home', viewport: 'phone', x: 5, y: 5, body: 'Logo too small' })
  client = await connect([])
  readOnlyClient = await connect(['--read-only'])
})

after(async () => {
  await client?.close()
  await readOnlyClient?.close()
})

test('tools are listed; read-only drops every write', async () => {
  const names = (await client.listTools()).tools.map((item) => item.name).sort()
  assert.deepEqual(names, [
    'get_comment',
    'list_comments',
    'list_journeys',
    'list_pages',
    'recapture_pages',
    'reply_to_comment',
    'resolve_comment',
    'set_comment_status',
  ])
  const readOnly = (await readOnlyClient.listTools()).tools.map((item) => item.name).sort()
  assert.deepEqual(readOnly, ['get_comment', 'list_comments', 'list_journeys', 'list_pages'])
})

test('list_pages and list_comments with filters', async () => {
  const pages = parse(await client.callTool({ name: 'list_pages', arguments: {} }))
  assert.deepEqual(
    pages.pages.map((page) => [page.id, page.captured]),
    [
      ['home', []],
      ['pricing', ['desktop']],
      ['app', []],
    ],
  )
  const all = parse(await client.callTool({ name: 'list_comments', arguments: {} }))
  assert.equal(all.count, 2)
  const pricing = parse(await client.callTool({ name: 'list_comments', arguments: { page: 'pricing' } }))
  assert.deepEqual(
    pricing.comments.map((item) => item.element?.selector),
    ['a[data-testid="plus-cta"]'],
  )
  const journey = await client.callTool({ name: 'list_comments', arguments: { journey: 'checkout' } })
  assert.equal(journey.isError, true)
  assert.match(journey.content[0].text, /has no journeys/)
})

test('journeyPageIds reads config journeys and board journeys (steps of page ids)', async () => {
  const withJourneys = sampleConfig('mcp-journeys', { journeys: [{ id: 'signup', name: 'Sign up', steps: ['home', 'pricing'] }] })
  const board = withJourneys.boards[0]
  assert.deepEqual([...journeyPageIds(withJourneys, board, 'signup')], ['home', 'pricing'])
  await createJourney(withJourneys, board, { name: 'Upgrade', steps: ['pricing', 'app'] })
  const made = listJourneys(withJourneys, board).find((item) => item.source === 'board')
  assert.deepEqual([...journeyPageIds(withJourneys, board, made.id)], ['pricing', 'app'])
  assert.throws(() => journeyPageIds(withJourneys, board, 'nope'), /No journey "nope" on board "sample" \(have: signup, upgrade/)
})

test('list_journeys shows forks; the journey filter covers pages on every branch', async () => {
  const board = config.boards[0]
  const steps = [
    'pricing',
    {
      branches: [
        { id: 'pay', label: 'Payment ok', steps: ['app'] },
        { id: 'declined', label: 'Card declined', steps: ['home'], end: true },
      ],
    },
  ]
  const { id } = await createJourney(config, board, { name: 'Checkout forks', steps })
  const listed = parse(await client.callTool({ name: 'list_journeys', arguments: {} }))
  const journey = listed.journeys.find((item) => item.id === id)
  assert.equal(listed.board, 'sample')
  assert.equal(journey.branching, true)
  assert.deepEqual(journey.steps, steps)
  assert.deepEqual(journey.pages, ['pricing', 'app', 'home'])
  assert.deepEqual(
    journey.paths.map((item) => [item.choices, item.steps, item.ended]),
    [
      [['pay'], ['pricing', 'app'], false],
      [['declined'], ['pricing', 'home'], true],
    ],
  )
  // "home" is only on the declined branch, and its comment still counts.
  const result = parse(await client.callTool({ name: 'list_comments', arguments: { journey: id } }))
  assert.deepEqual(result.comments.map((item) => item.page.id).sort(), ['home', 'pricing'])
  const readOnlyList = parse(await readOnlyClient.callTool({ name: 'list_journeys', arguments: {} }))
  assert.ok(readOnlyList.journeys.some((item) => item.id === id))
  await deleteJourney(config, board, id)
})

test('list_comments filters by a journey made on the board', async () => {
  const board = config.boards[0]
  const { id } = await createJourney(config, board, { name: 'Checkout', steps: ['pricing', 'app'] })
  const result = parse(await client.callTool({ name: 'list_comments', arguments: { journey: id } }))
  assert.deepEqual(
    result.comments.map((item) => item.page.id),
    ['pricing'],
  )
  const unknown = await client.callTool({ name: 'list_comments', arguments: { journey: 'nope' } })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0].text, /No journey "nope"/)
  await deleteJourney(config, board, id)
})

test('get_comment returns the anchor, the paths and a crop around the pin', async () => {
  const result = await client.callTool({ name: 'get_comment', arguments: { id: 1 } })
  const { comment } = parse(result)
  assert.equal(comment.page.url, 'http://127.0.0.1:9/pricing')
  assert.equal(comment.element.text, 'Try Plus')
  assert.deepEqual([comment.position.x, comment.position.y], [1080, 1100])
  assert.deepEqual([comment.captureVersion, comment.fixRef], [null, null], 'no manifest yet, nothing fixed yet')
  assert.equal(comment.files.screenshot, path.join(config.outputDir, 'sample', 'captures', 'pricing.desktop.png'))
  const image = result.content.find((item) => item.type === 'image')
  assert.equal(image.mimeType, 'image/png')
  const crop = decodePng(Buffer.from(image.data, 'base64'))
  assert.deepEqual([crop.width, crop.height], [900, 700])
  // The crop is x 540-1440: its first column is red, the rest past 180 px blue.
  assert.deepEqual([...crop.pixels.subarray(0, 3)], [255, 0, 0])
  assert.deepEqual([...crop.pixels.subarray(200 * 3, 200 * 3 + 3)], [0, 0, 255])
  const none = await client.callTool({ name: 'get_comment', arguments: { id: 2, image: 'full' } })
  assert.equal(
    none.content.some((item) => item.type === 'image'),
    false,
    'nothing captured, no image',
  )
})

test('reply, set status and resolve change the store', async () => {
  const reply = parse(await client.callTool({ name: 'reply_to_comment', arguments: { id: 2, body: 'Doubled the logo size' } }))
  assert.equal(reply.reply.author, 'agent')
  parse(await client.callTool({ name: 'set_comment_status', arguments: { id: 2, agentStatus: 'working' } }))
  assert.equal(getComment(config, 'sample', 2).agentStatus, 'working')
  const working = parse(await client.callTool({ name: 'list_comments', arguments: { agentStatus: 'working' } }))
  assert.deepEqual(
    working.comments.map((item) => item.id),
    [2],
  )
  const ref = 'https://github.com/example/site/pull/3'
  const resolved = parse(await client.callTool({ name: 'resolve_comment', arguments: { id: 2, note: 'Logo is 48 px now', fixRef: ref } }))
  assert.deepEqual(
    [resolved.status, resolved.agentStatus, resolved.resolution, resolved.fixRef],
    ['resolved', 'done', 'Logo is 48 px now', ref],
  )
  const fetched = parse(await client.callTool({ name: 'get_comment', arguments: { id: 2, image: 'none' } }))
  assert.equal(fetched.comment.fixRef, ref)
  const stored = getComment(config, 'sample', 2)
  assert.equal(stored.replies[0].body, 'Doubled the logo size')
  assert.equal(stored.status, 'resolved')
})

test('ids never become paths: bad ids are errors, not file reads', async () => {
  const missing = await client.callTool({ name: 'get_comment', arguments: { id: 999 } })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /does not exist/)
  const board = await client.callTool({ name: 'list_pages', arguments: { board: '../../etc' } })
  assert.equal(board.isError, true)
  assert.match(board.content[0].text, /No board/)
  const notInt = await client.callTool({ name: 'get_comment', arguments: { id: '../comments.json' } })
  assert.equal(notInt.isError, true)
  const page = await client.callTool({ name: 'recapture_pages', arguments: { pageIds: ['../../secret'] } })
  assert.equal(page.isError, true)
  assert.match(page.content[0].text, /No page/)
  const write = await readOnlyClient.callTool({ name: 'resolve_comment', arguments: { id: 1, note: 'x' } })
  assert.equal(write.isError, true)
  assert.equal(getComment(config, 'sample', 1).status, 'open')
})
