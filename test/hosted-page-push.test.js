// Page pushes (src/hosted/push.js): only some pages' captures go to a board
// already pushed. Scope, ids, file names and sizes are checked like a whole
// push; every other page stays as the server has it; an older capture never
// replaces a newer one; comments keep pointing at what they were made on.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { encodePng } from '../src/png.js'
import { createPushStore } from '../src/hosted/push.js'
import { tenant } from '../src/hosted/tenancy.js'
import { pushBoard, pushPages } from '../src/remote/cli.js'
import { createRemote } from '../src/remote/remote.js'
import { boardDir, readManifest } from '../src/store.js'
import { createProject, createToken, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { SAMPLE, tempDir } from './helpers.js'

let hosted
let owner
let project
let token
let remote

// One machine's copy of the project: its own config folder and captures.
function machine(name) {
  const dir = tempDir(name)
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  const config = loadConfig(path.join(dir, 'shapewall.config.json'))
  writeLocalCaptures(config, 'sample')
  return config
}

// A new local capture of one page, `width` pixels wide (to tell them apart), as `version`.
function recapture(config, pageId, version, width) {
  const dir = path.join(boardDir(config, 'sample'), 'captures')
  const manifest = readManifest(config, 'sample')
  const page = config.boards[0].pages.find((item) => item.id === pageId)
  for (const viewport of page.viewports) {
    const png = encodePng({ width, height: 4, channels: 3, colorType: 2, pixels: Buffer.alloc(width * 4 * 3, 120) })
    fs.writeFileSync(path.join(dir, `${pageId}.${viewport}.png`), png)
    fs.writeFileSync(path.join(dir, `${pageId}.${viewport}.thumb.png`), png)
    fs.writeFileSync(path.join(dir, `${pageId}.${viewport}.html`), `<!DOCTYPE html><html><body><p>${pageId} ${version}</p></body></html>`)
    manifest.pages[pageId][viewport] = { status: 'ok', url: `${config.boards[0].baseUrl}${page.path}`, version, html: { status: 'ok' } }
  }
  manifest.capturedAt = new Date(Date.UTC(+version.slice(0, 4), +version.slice(4, 6) - 1, +version.slice(6, 8))).toISOString()
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
}

const hostedWidth = async (name) => (await remote.download(`${hosted.origin}/api/v1/boards/sample/files/${name}`)).readUInt32BE(16)
const hostedManifest = async () => {
  const pages = await remote.pages('sample')
  return pages
}
const call = (method, pathname, options) => tokenCall(hosted, token, method, pathname, options)

before(async () => {
  hosted = await startHostedServer('hosted-page-push')
  owner = await signUp(hosted, { handle: 'pia', displayName: 'Pia' })
  project = await createProject(owner, owner.workspaceId, 'Lumen')
  token = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply', 'status', 'resolve', 'push'])
  remote = createRemote({ origin: hosted.origin, token })
})
after(() => hosted?.close())

test('a page push needs the push scope, a pushed board, and its pages and viewports', async () => {
  // Nothing pushed yet: a page push cannot make a board.
  let result = await call('POST', '/api/v1/pushes', { body: { mode: 'pages', board: 'sample', pages: { home: ['desktop'] } } })
  assert.equal(result.status, 404)
  assert.equal(result.json.error.code, 'unknown_board')

  const a = machine('page-push-scope')
  await pushBoard({ config: a, board: a.boards[0], remote })

  const reader = await createToken(owner, owner.workspaceId, project.id, ['read', 'reply', 'status', 'resolve'])
  result = await tokenCall(hosted, reader, 'POST', '/api/v1/pushes', {
    body: { mode: 'pages', board: 'sample', pages: { home: ['desktop'] } },
  })
  assert.equal(result.status, 403)

  for (const [body, status, code] of [
    [{ mode: 'pages', board: 'other', pages: { home: ['desktop'] } }, 404, 'unknown_board'],
    [{ mode: 'pages', board: '../sample', pages: { home: ['desktop'] } }, 400, 'invalid_board'],
    [{ mode: 'pages', board: 'sample', pages: { nope: ['desktop'] } }, 400, 'unknown_page'],
    [{ mode: 'pages', board: 'sample', pages: { app: ['phone'] } }, 400, 'unknown_viewport'],
    [{ mode: 'pages', board: 'sample', pages: { home: [] } }, 400, 'invalid_pages'],
    [{ mode: 'pages', board: 'sample', pages: {} }, 400, 'invalid_pages'],
    [{ mode: 'pages', board: 'sample', pages: ['home'] }, 400, 'invalid_pages'],
  ]) {
    result = await call('POST', '/api/v1/pushes', { body })
    assert.equal(result.status, status, JSON.stringify(body))
    assert.equal(result.json.error.code, code, JSON.stringify(body))
  }
})

test("a page push takes only its own pages' capture files, within the size caps", async () => {
  const start = await call('POST', '/api/v1/pushes', { body: { mode: 'pages', board: 'sample', pages: { home: ['desktop'] } } })
  assert.equal(start.status, 201)
  assert.equal(start.json.mode, 'pages')
  const png = encodePng({ width: 4, height: 4, channels: 3, colorType: 2, pixels: Buffer.alloc(48) })
  const put = (area, name, body = png) => call('PUT', `/api/v1/pushes/${start.json.id}/files/${area}/${name}`, { body })
  for (const [area, name] of [
    ['captures', 'pricing.desktop.png'],
    ['captures', 'home.phone.png'],
    ['versions', 'home.desktop.20261101T100000000Z-ab12.png'],
    ['variants', 'bold-1234.desktop.png'],
    ['captures', 'manifest.json'],
  ]) {
    const result = await put(area, name)
    assert.equal(result.status, 400, `${area}/${name}`)
    assert.equal(result.json.error.code, 'invalid_file', `${area}/${name}`)
  }
  const big = Buffer.alloc(10 * 1024 * 1024 + 1)
  const tooBig = await put('captures', 'home.desktop.png', big)
  assert.equal(tooBig.status, 413)
  assert.equal(tooBig.json.error.code, 'too_large')
  const notPng = await put('captures', 'home.desktop.png', Buffer.from('not a png at all'))
  assert.equal(notPng.status, 400)
  // Committed without its file: refused, nothing changes.
  const commit = await call('POST', `/api/v1/pushes/${start.json.id}/commit`, {
    body: { manifest: { pages: { home: { desktop: { status: 'ok', version: '20261130T100000000Z-aaaa' } } } } },
  })
  assert.equal(commit.status, 400)
  assert.equal(commit.json.error.code, 'missing_file')
  // A file of its own is taken; then a manifest entry without a version is refused.
  assert.equal((await put('captures', 'home.desktop.png')).status, 200)
  const noVersion = await call('POST', `/api/v1/pushes/${start.json.id}/commit`, {
    body: { manifest: { pages: { home: { desktop: { status: 'ok' } } } } },
  })
  assert.equal(noVersion.status, 400)
  assert.equal(noVersion.json.error.code, 'invalid_manifest')
  // A capture dated a day ahead of the server (a clock gone wrong, or a crafted version that would hold the page forever).
  const ahead = new Date(Date.now() + 86_400_000).toISOString().replace(/[-:.]/g, '')
  const future = await call('POST', `/api/v1/pushes/${start.json.id}/commit`, {
    body: { manifest: { pages: { home: { desktop: { status: 'ok', version: `${ahead}-ffff` } } } } },
  })
  assert.equal(future.status, 400)
  assert.match(future.json.error.message, /dated in the future/)
  assert.equal(await hostedWidth('captures/home.desktop.png'), 8, 'the board is unchanged')
})

test('a page push replaces only its pages, keeps what another machine pushed, and never an older capture over a newer one', async () => {
  const a = machine('page-push-a')
  const b = machine('page-push-b')
  await pushBoard({ config: a, board: a.boards[0], remote })

  // A comment made on home as it is now.
  const made = await owner.browser.post(`/w/${owner.workspaceId}/p/${project.id}/api/boards/sample/comments`, {
    pageId: 'home',
    viewport: 'desktop',
    x: 2,
    y: 2,
    body: 'Bigger logo',
  })
  assert.equal(made.status, 201)
  const madeOn = made.json.comment.captureVersion
  assert.equal(madeOn, '20261101T100000000Z-ab12')

  // Machine B recaptures pricing and pushes the whole board.
  recapture(b, 'pricing', '20261120T100000000Z-bbbb', 20)
  await pushBoard({ config: b, board: b.boards[0], remote })
  assert.equal(await hostedWidth('captures/pricing.desktop.png'), 20)

  // Machine A (which never saw B's capture) recaptures home and pushes only home.
  recapture(a, 'home', '20261124T100000000Z-aaaa', 30)
  const result = await pushPages({ config: a, board: a.boards[0], remote, pages: ['home'] })
  assert.equal(result.mode, 'pages')
  assert.equal(result.pages, 1)
  assert.deepEqual(result.sent, { home: ['desktop', 'phone'] })
  assert.equal(await hostedWidth('captures/home.desktop.png'), 30)
  assert.equal(await hostedWidth('captures/home.phone.png'), 30)
  assert.equal(await hostedWidth('captures/pricing.desktop.png'), 20, "B's newer pricing is still there")
  assert.equal(await hostedWidth('captures/app.desktop.png'), 8, 'a page neither touched is unchanged')
  // The capture it replaced is kept as a version, so the comment still shows what it was made on.
  assert.equal(await hostedWidth(`versions/home.desktop.${madeOn}.png`), 8)
  const comment = (await remote.comment('sample', made.json.comment.id)).comment
  assert.equal(comment.files.screenshot, `${hosted.origin}/api/v1/boards/sample/files/versions/home.desktop.${madeOn}.png`)
  assert.equal(comment.files.latestScreenshot, `${hosted.origin}/api/v1/boards/sample/files/captures/home.desktop.png`)
  const pages = await hostedManifest()
  assert.equal(pages.pages.length, 3)
  assert.ok(pages.pages.every((page) => page.captured.length === page.viewports.length))

  // Stale: B still has the November 1 capture of home; a page push of it is refused whole.
  const stale = await pushPages({ config: b, board: b.boards[0], remote, pages: ['home', 'pricing'] }).catch((error) => error)
  assert.equal(stale.status, 409)
  assert.equal(stale.code, 'stale_capture')
  assert.match(stale.message, /newer capture of home \(desktop\), home \(phone\)/)
  assert.equal(await hostedWidth('captures/home.desktop.png'), 30, 'nothing was committed')
  assert.equal(await hostedWidth('captures/pricing.desktop.png'), 20)

  // The same capture again (a retry) is fine.
  await pushPages({ config: a, board: a.boards[0], remote, pages: ['home'] })
  assert.equal(await hostedWidth('captures/home.desktop.png'), 30)

  // The board's byte count is what its folder holds, and the push is audited as a page push.
  const row = hosted.db.prepare('SELECT bytes, push_count FROM boards WHERE project_id = ? AND board_id = ?').get(project.id, 'sample')
  const folder = path.join(hosted.dataDir, 'files', owner.workspaceId, project.id, 'sample')
  const size = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .reduce((n, item) => n + (item.isDirectory() ? size(path.join(dir, item.name)) : fs.statSync(path.join(dir, item.name)).size), 0)
  assert.equal(row.bytes, size(folder))
  const audit = hosted.db.prepare("SELECT detail FROM audit_log WHERE action = 'push_committed' ORDER BY id DESC LIMIT 1").get()
  assert.deepEqual(JSON.parse(audit.detail), { files: 6, mode: 'pages', pages: 1, viewports: 2 })
  // Nothing is left half done: no staging or swap leftovers, no old board folders.
  assert.deepEqual(
    fs.readdirSync(path.dirname(folder)).filter((name) => name.startsWith('sample.old-')),
    [],
  )
})

test('shapewall push --page pushes only those pages', async () => {
  const c = machine('page-push-cli')
  recapture(c, 'app', '20261124T110000000Z-cccc', 40)
  const lines = []
  const saved = process.env.SHAPEWALL_TOKEN
  process.env.SHAPEWALL_TOKEN = token
  try {
    const code = await main(['push', '--remote', hosted.origin, '--page', 'app', '--config', path.join(c.dir, 'shapewall.config.json')], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    })
    assert.equal(code, 0, lines.join('\n'))
  } finally {
    if (saved === undefined) delete process.env.SHAPEWALL_TOKEN
    else process.env.SHAPEWALL_TOKEN = saved
  }
  assert.ok(
    lines.some((line) => /Pushed 3 files of 1 page/.test(line)),
    lines.join('\n'),
  )
  assert.equal(await hostedWidth('captures/app.desktop.png'), 40)
  assert.equal(await hostedWidth('captures/home.desktop.png'), 30, 'other pages untouched')
})

test('a page push that fails at commit (over the quota) leaves the board as it was', async () => {
  // The store itself: uploads with room, then a commit with a quota just above what the workspace holds now
  // (as when comment images filled it meanwhile).
  const t = tenant(hosted.db, owner.workspaceId)
  const held = hosted.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM boards WHERE workspace_id = ?').get(owner.workspaceId).n
  const roomy = createPushStore(t, { db: hosted.db, dataDir: hosted.dataDir })
  const tight = createPushStore(t, { db: hosted.db, dataDir: hosted.dataDir, workspaceQuota: held + 50 })
  const before = await hostedWidth('captures/pricing.desktop.png')
  const started = roomy.start({ projectId: project.id, raw: { mode: 'pages', board: 'sample', pages: { pricing: ['desktop'] } } })
  // Noise does not compress: the new capture is bigger than the one it replaces by more than the room left.
  const pixels = Buffer.from(Array.from({ length: 24 * 24 * 3 }, (_, i) => (i * 7919) % 251))
  const png = encodePng({ width: 24, height: 24, channels: 3, colorType: 2, pixels })
  await roomy.receive({ pushId: started.id, projectId: project.id, area: 'captures', name: 'pricing.desktop.png', body: png })
  const manifest = { pages: { pricing: { desktop: { status: 'ok', version: '20261124T120000000Z-dddd' } } } }
  assert.throws(() => tight.commit({ pushId: started.id, projectId: project.id, manifest }), { code: 'quota_exceeded' })
  assert.equal(await hostedWidth('captures/pricing.desktop.png'), before, 'the board is as it was')
  assert.equal(await hostedWidth('captures/home.desktop.png'), 30)
  // No copy of the board is left behind: only the push's own upload.
  const staging = path.join(hosted.dataDir, 'staging', started.id)
  assert.deepEqual(fs.readdirSync(staging), ['captures'])
  assert.deepEqual(fs.readdirSync(path.join(staging, 'captures')), ['pricing.desktop.png'])
  // The same push, committed again with room: the retry starts from its uploads.
  roomy.commit({ pushId: started.id, projectId: project.id, manifest })
  assert.equal(await hostedWidth('captures/pricing.desktop.png'), 24)
  assert.equal(await hostedWidth('captures/home.desktop.png'), 30)
  assert.equal(await hostedWidth('captures/app.desktop.png'), 40)
})

test('pages a page push leaves keep their version, also entries from before versions existed', async () => {
  const e = machine('page-push-legacy')
  // An older client: no version on app's entry, so its version comes from the run's time.
  const manifest = readManifest(e, 'sample')
  delete manifest.pages.app.desktop.version
  manifest.capturedAt = '2026-11-02T10:00:00.000Z'
  fs.writeFileSync(path.join(boardDir(e, 'sample'), 'captures', 'manifest.json'), JSON.stringify(manifest))
  recapture(e, 'pricing', '20261124T130000000Z-eeee', 50)
  recapture(e, 'home', '20261124T130000000Z-eeee', 50)
  const saved = readManifest(e, 'sample')
  saved.capturedAt = '2026-11-02T10:00:00.000Z'
  fs.writeFileSync(path.join(boardDir(e, 'sample'), 'captures', 'manifest.json'), JSON.stringify(saved))
  await pushBoard({ config: e, board: e.boards[0], remote })
  const folder = path.join(hosted.dataDir, 'files', owner.workspaceId, project.id, 'sample', 'captures', 'manifest.json')
  assert.equal(JSON.parse(fs.readFileSync(folder, 'utf8')).pages.app.desktop.version, undefined)
  recapture(e, 'home', '20261124T140000000Z-eeee', 60)
  await pushPages({ config: e, board: e.boards[0], remote, pages: ['home'] })
  const after = JSON.parse(fs.readFileSync(folder, 'utf8'))
  assert.ok(after.capturedAt > '2026-11-02T10:00:00.000Z', 'the board capturedAt moved on')
  assert.equal(after.pages.app.desktop.version, '20261102T100000000Z', "app keeps the version it had (from the old run's time)")
  assert.equal(after.pages.home.desktop.version, '20261124T140000000Z-eeee')
})
