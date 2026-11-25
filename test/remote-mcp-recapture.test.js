// recapture_pages on `mcp --remote`: offered only with a project config, the
// "push" scope and capture allowed; page ids and the board are checked
// against the config; the pages are captured here and the board pushed.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { remoteMcpConfig } from '../src/cli/commands.js'
import { loadConfig } from '../src/config.js'
import { encodePng } from '../src/png.js'
import { createRemote } from '../src/remote/remote.js'
import { pushBoard } from '../src/remote/cli.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { boardDir, readManifest } from '../src/store.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'

const parse = (result) => JSON.parse(result.content[0].text)

async function connect(server) {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'remote-mcp-recapture', version: '1.0.0' })
  await client.connect(b)
  return client
}

const stubRemote = ({ scopes = ['read', 'reply', 'status', 'resolve', 'push'], boards = ['sample'] } = {}) => ({
  origin: 'https://hosted.example',
  project: async () => ({ token: { scopes }, boards: boards.map((id) => ({ id })) }),
})

// A capture that writes new shots of the pages it is given, like runCapture's
// partial run: files in captures/ and the manifest entry for each shot.
function fakeCapture(calls, { fail = [], png = null } = {}) {
  return async ({ config, boardId, only, log }) => {
    calls.push({ boardId, only })
    const board = config.boards.find((item) => item.id === boardId)
    const dir = path.join(boardDir(config, boardId), 'captures')
    fs.mkdirSync(dir, { recursive: true })
    const manifest = readManifest(config, boardId) || { board: boardId, viewports: config.viewports, pages: {} }
    manifest.capturedAt = '2026-11-24T12:00:00.000Z'
    let failed = 0
    let total = 0
    for (const id of only) {
      const page = board.pages.find((item) => item.id === id)
      manifest.pages[id] = manifest.pages[id] || {}
      for (const viewport of page.viewports) {
        total += 1
        if (fail.includes(id)) {
          failed += 1
          manifest.pages[id][viewport] = { status: 'failed', error: 'net::ERR_CONNECTION_REFUSED' }
          continue
        }
        const bytes = png || encodePng({ width: 4, height: 4, channels: 3, colorType: 2, pixels: Buffer.alloc(48, 200) })
        fs.writeFileSync(path.join(dir, `${id}.${viewport}.png`), bytes)
        fs.writeFileSync(path.join(dir, `${id}.${viewport}.thumb.png`), bytes)
        fs.writeFileSync(path.join(dir, `${id}.${viewport}.html`), '<!DOCTYPE html><html><body><p>New</p></body></html>')
        manifest.pages[id][viewport] = {
          status: 'ok',
          url: `${board.baseUrl}${page.path}`,
          version: '20261124T120000000Z-cd34',
          html: { status: 'ok', bytes: 52 },
        }
      }
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
    log(`Done: ${total - failed} ok, ${failed} failed`)
    return { ok: failed === 0, failed, total }
  }
}

const toolNames = async (options) => {
  const client = await connect(await createRemoteMcpServer({ remote: stubRemote(options.remote), ...options.server }))
  const names = (await client.listTools()).tools.map((item) => item.name)
  const instructions = client.getInstructions()
  await client.close()
  return { names, instructions }
}

test('recapture_pages is offered only with a config, capture allowed, not read-only, and the push scope', async () => {
  const config = sampleConfig('rmcp-offer')
  const on = await toolNames({ server: { config } })
  assert.ok(on.names.includes('recapture_pages'))
  assert.match(on.instructions, /change the code, call recapture_pages for the pages you changed/)
  assert.doesNotMatch(on.instructions, /shapewall push/)

  for (const [why, options] of [
    ['no config', { server: {} }],
    ['--no-capture', { server: { config, allowCapture: false } }],
    ['--read-only', { server: { config, readOnly: true } }],
    ['no push scope', { server: { config }, remote: { scopes: ['read', 'reply', 'status', 'resolve'] } }],
  ]) {
    const off = await toolNames(options)
    assert.ok(!off.names.includes('recapture_pages'), why)
    assert.match(off.instructions, /shapewall push/, why)
  }
})

test('recapture_pages takes page ids of the config board only, and captures nothing otherwise', async () => {
  const config = sampleConfig('rmcp-ids')
  const calls = []
  const pushes = []
  const client = await connect(
    await createRemoteMcpServer({
      remote: stubRemote(),
      config,
      capture: fakeCapture(calls),
      push: async () => pushes.push(1),
    }),
  )
  for (const pageIds of [['nope'], ['home', '/pricing'], ['../../etc/passwd']]) {
    const result = await client.callTool({ name: 'recapture_pages', arguments: { pageIds } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /^No page "/)
  }
  const empty = await client.callTool({ name: 'recapture_pages', arguments: { pageIds: [] } })
  assert.equal(empty.isError, true)
  assert.equal(calls.length, 0)
  assert.equal(pushes.length, 0)
  await client.close()
})

test('recapture_pages refuses a hosted board that is not a board of the config, before capturing', async () => {
  const config = sampleConfig('rmcp-mismatch')
  const calls = []
  const pushes = []
  const client = await connect(
    await createRemoteMcpServer({
      remote: stubRemote({ boards: ['marketing', 'sample'] }),
      config,
      capture: fakeCapture(calls),
      push: async () => pushes.push(1),
    }),
  )
  // The default board is the first one pushed ("marketing"), which the config does not have.
  const result = await client.callTool({ name: 'recapture_pages', arguments: { pageIds: ['home'] } })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /hosted board "marketing" is not a board in the local config \(it has: sample\)/)
  assert.match(result.content[0].text, /nothing was captured or pushed/)
  // A board the hosted project does not have is refused as on the other tools.
  const missing = await client.callTool({ name: 'recapture_pages', arguments: { board: 'other', pageIds: ['home'] } })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /No board "other"/)
  assert.equal(calls.length, 0)
  assert.equal(pushes.length, 0)
  await client.close()
})

test('recapture_pages captures the pages here, pushes the board and reports each page and viewport', async () => {
  const config = sampleConfig('rmcp-happy')
  writeLocalCaptures(config, 'sample')
  const calls = []
  const pushes = []
  const remote = stubRemote()
  const client = await connect(
    await createRemoteMcpServer({
      remote,
      config,
      capture: fakeCapture(calls, { fail: ['app'] }),
      push: async (args) => {
        pushes.push(args)
        args.out('Pushed 20 files (0.0 MB). Board: https://hosted.example/w/1/p/2/?board=sample')
        return { files: 20, url: 'https://hosted.example/w/1/p/2/?board=sample' }
      },
    }),
  )
  const result = parse(await client.callTool({ name: 'recapture_pages', arguments: { board: 'sample', pageIds: ['home', 'app', 'home'] } }))
  assert.deepEqual(calls, [{ boardId: 'sample', only: ['home', 'app'] }])
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].board.id, 'sample')
  assert.equal(pushes[0].remote, remote)
  assert.equal(pushes[0].config, config)
  assert.deepEqual(result.pages, {
    home: { desktop: 'ok', phone: 'ok' },
    app: { desktop: 'net::ERR_CONNECTION_REFUSED' },
  })
  assert.equal(result.ok, false, 'a failed shot is not ok, though the rest was pushed')
  assert.equal(result.shots, 3)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.pushed, { ok: true, files: 20, url: 'https://hosted.example/w/1/p/2/?board=sample' })
  assert.ok(result.log.some((line) => line.startsWith('Pushed 20 files')))
  await client.close()
})

test('recapture_pages pushes nothing when no shot landed, and reports a failed push', async () => {
  const config = sampleConfig('rmcp-nothing')
  writeLocalCaptures(config, 'sample')
  const pushes = []
  const client = await connect(
    await createRemoteMcpServer({
      remote: stubRemote(),
      config,
      capture: fakeCapture([], { fail: ['home'] }),
      push: async () => {
        pushes.push(1)
        throw new Error('quota_exceeded')
      },
    }),
  )
  const none = parse(await client.callTool({ name: 'recapture_pages', arguments: { pageIds: ['home'] } }))
  assert.equal(none.ok, false)
  assert.deepEqual(none.pushed, { ok: false, error: 'No page was captured, so nothing was pushed.' })
  assert.equal(pushes.length, 0)
  const refused = await client.callTool({ name: 'recapture_pages', arguments: { pageIds: ['pricing'] } })
  const body = parse(refused)
  assert.equal(body.ok, false)
  assert.deepEqual(body.pushed, { ok: false, error: 'quota_exceeded' })
  assert.deepEqual(body.pages, { pricing: { desktop: 'ok', phone: 'ok' } })
  await client.close()
})

test('recapture_pages runs one capture and push at a time', async () => {
  const config = sampleConfig('rmcp-serial')
  writeLocalCaptures(config, 'sample')
  let running = 0
  let most = 0
  const inner = fakeCapture([])
  const client = await connect(
    await createRemoteMcpServer({
      remote: stubRemote(),
      config,
      capture: async (args) => {
        running += 1
        most = Math.max(most, running)
        await new Promise((resolve) => setTimeout(resolve, 20))
        return inner(args)
      },
      push: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        running -= 1
        return { files: 1, url: 'u' }
      },
    }),
  )
  const results = await Promise.all(
    ['home', 'pricing', 'app'].map((id) => client.callTool({ name: 'recapture_pages', arguments: { pageIds: [id] } })),
  )
  assert.ok(results.every((item) => parse(item).pushed.ok))
  assert.equal(most, 1)
  await client.close()
})

test('mcp --remote finds the project config like the other commands', () => {
  const dir = tempDir('rmcp-config')
  const errs = []
  assert.equal(
    remoteMcpConfig({}, (line) => errs.push(line), { env: {}, cwd: dir }),
    null,
    'no config: no recapture',
  )
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  assert.equal(remoteMcpConfig({}, () => {}, { env: {}, cwd: dir }).boards[0].id, 'sample')
  // Named with --config: loaded from there, and an error when it is missing.
  const other = tempDir('rmcp-config-other')
  fs.writeFileSync(path.join(other, 'site.json'), JSON.stringify(SAMPLE))
  assert.equal(remoteMcpConfig({ config: path.join(other, 'site.json') }, () => {}, { env: {}, cwd: dir }).boards[0].id, 'sample')
  assert.throws(() => remoteMcpConfig({ config: path.join(other, 'missing.json') }, () => {}, { env: {}, cwd: dir }), /No config at/)
  // Found but broken: the server still starts, without recapture_pages, and says why.
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), '{ not json')
  assert.equal(
    remoteMcpConfig({}, (line) => errs.push(line), { env: {}, cwd: dir }),
    null,
  )
  assert.match(errs.at(-1), /^recapture_pages is off: /)
})

let hosted
after(() => hosted?.close())

test('against a hosted server: recapture_pages through MCP replaces the capture on the hosted board', async () => {
  hosted = await startHostedServer('rmcp-hosted')
  const owner = await signUp(hosted, { handle: 'rhea', displayName: 'Rhea' })
  const project = await createProject(owner, owner.workspaceId, 'Lumen')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply', 'status', 'resolve', 'push'])
  const dir = tempDir('rmcp-hosted-site')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  const config = loadConfig(path.join(dir, 'shapewall.config.json'))
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token })
  await pushBoard({ config, board: config.boards[0], remote })
  const before = await remote.pages('sample')
  assert.equal(before.capturedAt, '2026-11-01T10:00:00.000Z')

  const wide = encodePng({ width: 12, height: 5, channels: 3, colorType: 2, pixels: Buffer.alloc(12 * 5 * 3, 90) })
  const client = await connect(
    await createRemoteMcpServer({ remote, config, capture: fakeCapture([], { png: wide }), heartbeatMs: 60_000 }),
  )
  assert.ok((await client.listTools()).tools.some((item) => item.name === 'recapture_pages'))
  const result = parse(await client.callTool({ name: 'recapture_pages', arguments: { pageIds: ['pricing'] } }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.pages, { pricing: { desktop: 'ok', phone: 'ok' } })
  assert.equal(result.pushed.ok, true)
  assert.match(result.pushed.url, new RegExp(`^${hosted.origin}/w/`))

  const now = await remote.pages('sample')
  assert.equal(now.capturedAt, '2026-11-24T12:00:00.000Z')
  assert.equal(now.pages.length, 3, 'every page is still on the hosted board')
  const png = await remote.download(`${hosted.origin}/api/v1/boards/sample/files/captures/pricing.desktop.png`)
  assert.equal(png.readUInt32BE(16), 12, 'the new capture of pricing is served')
  const home = await remote.download(`${hosted.origin}/api/v1/boards/sample/files/captures/home.desktop.png`)
  assert.equal(home.readUInt32BE(16), 8, 'the other pages keep their captures')
  await client.close()
})
