// Environments and compare on the solo engine (G4): the engine's boards keep
// the config's environments (src/hosted/solo/config.js), a push to the
// engine keeps them and takes the other environments' captures
// (src/hosted/push.js), the board compares them (src/hosted/board-compare.js),
// comments store the environment they were left on (src/hosted/comments.js),
// the token API and MCP filter by it, and a vouch covers it
// (agent-policy.js dispatchHash). A team server keeps collapsing every push
// to one environment, `default`.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { dispatchHash } from '../src/hosted/agent-policy.js'
import { createHash } from 'node:crypto'
import { projectDir } from '../src/hosted/projects.js'
import { soloOrigin } from '../src/hosted/solo/signin.js'
import { pushBoard } from '../src/remote/cli.js'
import { createRemote, pushDefinition, pushEnvironmentFiles, pushFiles } from '../src/remote/remote.js'
import { SAMPLE, request, tempDir } from './helpers.js'
import { createBrowser, createProject, createToken, signUp, startHostedServer, tinyPng, writeLocalCaptures } from './hosted-helpers.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

const ENVIRONMENTS = [
  { id: 'staging', title: 'Staging', baseUrl: 'http://127.0.0.1:9' },
  { id: 'production', title: 'Production', baseUrl: 'http://127.0.0.1:10', publicUrl: 'https://notes.example' },
]

const mapFor = (size) => ({
  v: 1,
  width: size.width,
  height: size.height,
  elements: [
    { t: 'body', n: 1, p: -1, b: [0, 0, size.width, 200], x: 'Live' },
    { t: 'p', n: 1, p: 0, b: [8, 8, 100, 20], x: 'Live', z: 0 },
  ],
})

function projectConfig(name, overrides = { environments: ENVIRONMENTS }) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  const raw = { ...structuredClone(SAMPLE), ...overrides }
  if (raw.environments) delete raw.baseUrl
  fs.writeFileSync(file, JSON.stringify(raw, null, 2))
  return loadConfig(file)
}

// Another environment's captures, written like `shapewall capture --env`.
function writeEnvCaptures(config, boardId, envId) {
  const dir = path.join(config.outputDir, boardId, 'envs', envId, 'captures')
  fs.mkdirSync(dir, { recursive: true })
  const board = config.boards.find((item) => item.id === boardId)
  const manifest = { board: boardId, capturedAt: '2026-11-02T10:00:00.000Z', viewports: config.viewports, pages: {} }
  for (const page of board.pages) {
    manifest.pages[page.id] = {}
    for (const viewport of page.viewports) {
      fs.writeFileSync(path.join(dir, `${page.id}.${viewport}.png`), tinyPng())
      fs.writeFileSync(path.join(dir, `${page.id}.${viewport}.elements.json`), JSON.stringify(mapFor(config.viewports[viewport])))
      manifest.pages[page.id][viewport] = page.id === 'app' ? { status: 'failed', httpStatus: 500, error: 'HTTP 500' } : { status: 'ok' }
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
}

async function startSolo(name, { config = projectConfig(`${name}-project`) } = {}) {
  const hosted = await startHostedServer(name, {
    origin: (port) => soloOrigin('Sample site', port),
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester' },
  })
  servers.push(hosted)
  const browser = createBrowser(hosted.port, hosted.origin)
  const file = hosted.app.locals.soloOpenFile()
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  const opened = await browser.post('/open', `nonce=${nonce}`, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  assert.equal(opened.status, 200)
  const { owner } = hosted.app.locals.solo
  const token = await createToken({ browser }, owner.workspaceId, owner.projectId)
  const remote = createRemote({ origin: hosted.origin, token })
  const boardFolder = path.join(projectDir(hosted.dataDir, owner.workspaceId, owner.projectId), 'sample')
  return { hosted, browser, owner, base: `/w/${owner.workspaceId}/p/${owner.projectId}/api`, config, token, remote, boardFolder }
}

test('a team server keeps collapsing a push to one environment, default, whatever the push sends', async () => {
  const hosted = await startHostedServer('solo-env-team')
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Team')
  const token = await createToken(owner, owner.workspaceId, project.id)
  const remote = createRemote({ origin: hosted.origin, token })
  const config = projectConfig('solo-env-team-project')
  writeLocalCaptures(config, 'sample')
  writeEnvCaptures(config, 'sample', 'production')
  // A CLI that sends the environments anyway: the server takes one.
  const started = await remote.startPush(pushDefinition(config, config.boards[0], { environments: true }))
  assert.equal('environments' in started, false, 'a team server never asks for other environments')
  const refused = await remote.pushFile(started.id, 'env:production', 'home.desktop.png', tinyPng()).then(
    () => null,
    (error) => error,
  )
  assert.equal(refused?.status, 400)
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [], environments: { production: manifest } })
  const base = `/w/${owner.workspaceId}/p/${project.id}/api`
  const view = (await owner.browser.get(`${base}/boards/sample`)).json
  assert.deepEqual(
    view.environments.map((env) => env.id),
    ['default'],
  )
  const folder = path.join(projectDir(hosted.dataDir, owner.workspaceId, project.id), 'sample')
  assert.equal(fs.existsSync(path.join(folder, 'envs')), false)
  const compare = await owner.browser.get(`${base}/boards/sample/compare?a=default&b=production`)
  assert.equal(compare.status, 404)
  assert.equal('soloFeatures' in (await owner.browser.get(`${base}/info`)).json, false)
  // Comments are on `default`, and the filter knows only that one.
  const made = await owner.browser.post(`${base}/boards/sample/comments`, { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Hi' })
  assert.equal(made.status, 201, made.text)
  assert.equal(made.json.comment.environment, 'default')
  const onProduction = await owner.browser.post(`${base}/boards/sample/comments`, {
    pageId: 'home',
    viewport: 'desktop',
    x: 10,
    y: 10,
    body: 'Hi',
    environment: 'production',
  })
  assert.equal(onProduction.status, 400)
  assert.equal(onProduction.json.error.code, 'invalid_environment')
  assert.equal((await remote.comments('sample', { environment: 'default' })).comments.length, 1)
  const unknown = await remote.comments('sample', { environment: 'production' }).then(
    () => null,
    (error) => error,
  )
  assert.equal(unknown?.status, 404)
})

test('the engine board has the config’s environments; a push keeps them and their captures, and the board compares them', async () => {
  const { browser, base, config, remote, boardFolder } = await startSolo('solo-env-push')
  const info = (await browser.get(`${base}/info`)).json
  assert.equal(info.soloFeatures.compare, true)
  const before = (await browser.get(`${base}/boards/sample`)).json
  assert.deepEqual(
    before.environments.map((env) => [env.id, env.title, env.default]),
    [
      ['staging', 'Staging', true],
      ['production', 'Production', false],
    ],
  )
  // The board shows no capture address of either environment.
  assert.doesNotMatch(JSON.stringify(before), /127\.0\.0\.1:10/)

  writeLocalCaptures(config, 'sample', { elements: mapFor })
  writeEnvCaptures(config, 'sample', 'production')
  const result = await pushBoard({ config, board: config.boards[0], remote, environments: true })
  const envFiles = pushEnvironmentFiles(config, config.boards[0], 'production')
  assert.equal(result.files, pushFiles(config, config.boards[0]).length + envFiles.length)
  const envDir = path.join(boardFolder, 'envs', 'production', 'captures')
  assert.ok(fs.existsSync(path.join(envDir, 'home.desktop.png')))
  const envManifest = JSON.parse(fs.readFileSync(path.join(envDir, 'manifest.json'), 'utf8'))
  assert.equal(envManifest.pages.home.desktop.status, 'ok')
  assert.equal(envManifest.pages.app.desktop.status, 'failed')

  const view = (await browser.get(`${base}/boards/sample`)).json
  assert.deepEqual(
    view.environments.map((env) => [env.id, Boolean(env.capturedAt)]),
    [
      ['staging', true],
      ['production', true],
    ],
  )
  const compare = await browser.get(`${base}/boards/sample/compare?a=staging&b=production`)
  assert.equal(compare.status, 200, compare.text)
  assert.equal(compare.json.pages.home.desktop.status, 'ok')
  assert.equal(compare.json.pages.app.desktop.status, 'failed')
  assert.equal(compare.json.failures.production.app.desktop, 'HTTP 500')
  // An error the engine's own capture wrote (with the address) reaches the board without the capture address.
  const written = JSON.parse(fs.readFileSync(path.join(envDir, 'manifest.json'), 'utf8'))
  written.pages.app.desktop.error = 'net::ERR_FAILED at http://127.0.0.1:10/app?tab=notes'
  fs.writeFileSync(path.join(envDir, 'manifest.json'), JSON.stringify(written))
  const scrubbed = await browser.get(`${base}/boards/sample/compare?a=staging&b=production`)
  assert.match(scrubbed.json.failures.production.app.desktop, /^net::ERR_FAILED at /)
  assert.doesNotMatch(scrubbed.text, /127\.0\.0\.1:10/)
  assert.ok(compare.json.files.production.home.desktop.file)
  assert.equal((await browser.get(`${base}/boards/sample/envs/production/home.desktop.png`)).status, 200)
  assert.equal((await browser.get(`${base}/boards/sample/env-elements/production/home.desktop.elements.json`)).status, 200)
  const diff = compare.json.pages.home.desktop.diff
  assert.equal((await browser.get(`${base}/boards/sample/diffs/staging_production/${diff}`)).status, 200)
  // Names Shapewall never writes, an environment the board has not, a pair out of order: nothing.
  for (const pathname of [
    '/boards/sample/envs/qa/home.desktop.png',
    '/boards/sample/envs/production/manifest.json',
    '/boards/sample/envs/production/..%2F..%2Fcaptures%2Fhome.desktop.png',
    '/boards/sample/diffs/production_qa/home.desktop.png',
    '/boards/sample/env-elements/production/home.desktop.png',
  ])
    assert.equal((await browser.get(`${base}${pathname}`)).status, 404, pathname)
  for (const [query, status] of [
    ['a=staging&b=staging', 400],
    ['a=staging&b=qa', 400],
  ])
    assert.equal((await browser.get(`${base}/boards/sample/compare?${query}`)).status, status, query)
  const crossSite = await browser.get(`${base}/boards/sample/compare?a=staging&b=production`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)

  // A push that does not send the environments (an older CLI) keeps them.
  const started = await remote.startPush(pushDefinition(config, config.boards[0]))
  assert.deepEqual(started.environments, ['production'])
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
  assert.deepEqual(
    (await browser.get(`${base}/boards/sample`)).json.environments.map((env) => env.id),
    ['staging', 'production'],
  )
  // It sent no production captures: the board has none now (a whole push replaces the board).
  assert.equal(fs.existsSync(envDir), false)
})

test('a comment on another environment keeps it, records no version, filters by it, and a vouch covers it', async () => {
  const { hosted, browser, base, config, remote, token } = await startSolo('solo-env-comments')
  writeLocalCaptures(config, 'sample')
  writeEnvCaptures(config, 'sample', 'production')
  await pushBoard({ config, board: config.boards[0], remote, environments: true })
  const at = { pageId: 'home', viewport: 'desktop', x: 20, y: 30, body: 'Prices look off here' }
  const plain = await browser.post(`${base}/boards/sample/comments`, at)
  assert.equal(plain.status, 201, plain.text)
  // No environment: the board's first one, as a local board's default.
  assert.equal(plain.json.comment.environment, 'staging')
  assert.ok(plain.json.comment.captureVersion)
  const other = await browser.post(`${base}/boards/sample/comments`, { ...at, environment: 'production' })
  assert.equal(other.status, 201, other.text)
  assert.equal(other.json.comment.environment, 'production')
  assert.equal(other.json.comment.captureVersion, null)
  const row = hosted.db.prepare('SELECT environment, capture_version FROM comments WHERE number = ?').get(other.json.comment.id)
  assert.deepEqual({ ...row }, { environment: 'production', capture_version: null })
  // A reply's drawing on it records no version either.
  const replied = await browser.post(`${base}/boards/sample/comments/${other.json.comment.id}/replies`, {
    body: 'Here',
    drawing: {
      shapes: [
        {
          tool: 'box',
          ink: 'accent',
          width: 3,
          points: [
            [0.1, 0.1],
            [0.3, 0.2],
          ],
        },
      ],
    },
  })
  assert.equal(replied.status, 201, replied.text)
  const stored = JSON.parse(hosted.db.prepare('SELECT replies FROM comments WHERE number = ?').get(other.json.comment.id).replies)
  assert.equal(stored.at(-1).drawing.captureVersion, null)
  // The same on the default environment records the capture it was drawn on.
  const onPlain = await browser.post(`${base}/boards/sample/comments/${plain.json.comment.id}/replies`, {
    body: 'Here',
    drawing: {
      shapes: [
        {
          tool: 'box',
          ink: 'accent',
          width: 3,
          points: [
            [0.1, 0.1],
            [0.3, 0.2],
          ],
        },
      ],
    },
  })
  assert.equal(onPlain.status, 201, onPlain.text)
  const plainReplies = JSON.parse(hosted.db.prepare('SELECT replies FROM comments WHERE number = ?').get(plain.json.comment.id).replies)
  assert.ok(plainReplies.at(-1).drawing.captureVersion)

  const listed = await remote.comments('sample', { environment: 'production' })
  assert.deepEqual(
    listed.comments.map((item) => item.id),
    [other.json.comment.id],
  )
  assert.equal(listed.environment, 'production')
  // Its screenshot is the production capture, served by the token API.
  const shot = listed.comments[0].files.screenshot
  assert.match(shot, /\/files\/envs\/production\/home\.desktop\.png$/)
  assert.equal((await fetch(shot, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
  assert.deepEqual(
    (await remote.comments('sample', { environment: 'staging' })).comments.map((item) => item.id),
    [plain.json.comment.id],
  )

  // MCP list_comments over the engine's HTTP /mcp takes the same filter.
  const host = new URL(hosted.origin).host
  const answer = await request(hosted.port, 'POST', '/mcp', {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_comments', arguments: { board: 'sample', environment: 'production' } },
    },
    headers: { Host: host, Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' },
  })
  assert.equal(answer.status, 200, answer.text)
  const tool = JSON.parse(answer.json.result.content[0].text)
  assert.deepEqual(
    tool.comments.map((item) => item.id),
    [other.json.comment.id],
  )

  // The board's hash for "Send to agent" covers the environment.
  const comments = (await browser.get(`${base}/boards/sample/comments`)).json.comments
  const hashOf = (id) => comments.find((item) => item.id === id).dispatchHash
  assert.notEqual(hashOf(plain.json.comment.id), hashOf(other.json.comment.id))
})

test('dispatchHash: unchanged for a default-environment row (vouches stored before stay valid), different on another', () => {
  const row = { body: 'Fix it', anchor: null, page_id: 'home', viewport: 'desktop', x: 1, y: 2 }
  const legacy = createHash('sha256')
    .update(JSON.stringify([row.body, row.anchor, row.page_id, row.viewport, row.x, row.y]))
    .digest('hex')
  assert.equal(dispatchHash({ ...row, environment: 'default' }), legacy)
  assert.equal(dispatchHash(row), legacy)
  assert.notEqual(dispatchHash({ ...row, environment: 'production' }), legacy)
  assert.notEqual(dispatchHash({ ...row, environment: 'production' }), dispatchHash({ ...row, environment: 'staging' }))
})

test('the engine captures another environment into envs/<id>/captures/, from that environment’s origin', async () => {
  const config = projectConfig('solo-env-capture-project')
  const calls = []
  const hosted = await startHostedServer('solo-env-capture', {
    origin: (port) => soloOrigin('Sample site', port),
    solo: {
      signIn: 'local',
      config,
      configPath: config.file,
      ownerName: 'Robin Tester',
      allowCapture: true,
      capture: {
        run: async (options) => {
          calls.push({ envId: options.envId })
          return { ok: true, total: 0, failed: 0 }
        },
      },
    },
  })
  servers.push(hosted)
  const browser = createBrowser(hosted.port, hosted.origin)
  const file = hosted.app.locals.soloOpenFile()
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  await browser.post('/open', `nonce=${nonce}`, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  const { owner } = hosted.app.locals.solo
  const base = `/w/${owner.workspaceId}/p/${owner.projectId}/api`
  const unknown = await browser.post(`${base}/boards/sample/capture`, { env: 'qa' })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.json.error.code, 'unknown_environment')
  const started = await browser.post(`${base}/boards/sample/capture`, { env: 'production' })
  assert.equal(started.status, 202, started.text)
  for (let i = 0; i < 200 && calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  for (let i = 0; i < 200; i++) {
    if (!(await browser.get(`${base}/boards/sample`)).json.capture.running) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const again = await browser.post(`${base}/boards/sample/capture`, { env: 'staging' })
  assert.equal(again.status, 202, again.text)
  for (let i = 0; i < 200 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, [{ envId: 'production' }, { envId: null }])
})
