// In-process capture on the solo engine (G3): src/hosted/solo/capture.js,
// its browser boundary (capture-egress.js), who may start one (owner.js),
// and recapture_pages on HTTP /mcp (src/hosted/mcp-http.js). A team server
// never captures. The capture run itself is stubbed here (the e2e test
// runs a real one); the egress proxy is real.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { acquireBoardJob } from '../src/board-job.js'
import { loadConfig } from '../src/config.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { projectDir } from '../src/hosted/projects.js'
import { CAPTURE_EGRESS_ARGS, captureEgress, pinAppOrigin } from '../src/hosted/solo/capture-egress.js'
import { soloOrigin } from '../src/hosted/solo/signin.js'
import { writeJsonAtomic } from '../src/store.js'
import { SAMPLE, request, tempDir } from './helpers.js'
import { createBrowser, createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'

quietSqliteWarning()

const servers = []
after(async () => {
  for (const server of servers) await server.close()
})

function projectConfig(name, overrides = {}) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), ...overrides }, null, 2))
  return loadConfig(file)
}

// A capture run that stands in for runCapture: records its call, waits for
// `release()` when asked to, and writes a capture like a real one.
function stubRun({ hold = false } = {}) {
  const calls = []
  let release = () => {}
  const gate = hold ? new Promise((resolve) => (release = resolve)) : Promise.resolve()
  const run = async (options) => {
    calls.push(options)
    const dir = path.join(options.config.outputDir, options.boardId)
    fs.mkdirSync(dir, { recursive: true })
    writeJsonAtomic(path.join(dir, 'status.json'), { state: 'running', startedAt: new Date().toISOString(), done: 0, total: 2 })
    const job = acquireBoardJob(options.config, options.boardId, 'capture')
    assert.equal(job.ok, true)
    try {
      await gate
      writeLocalCaptures(options.config, options.boardId)
      writeJsonAtomic(path.join(dir, 'status.json'), { state: 'done', finishedAt: new Date().toISOString(), done: 2, total: 2, failed: 0 })
      return { ok: true, total: 2, failed: 0 }
    } finally {
      job.release()
    }
  }
  return { run, calls, release: () => release() }
}

async function startSolo(name, { solo = {}, config = projectConfig(`${name}-project`) } = {}) {
  const hosted = await startHostedServer(name, {
    origin: (port) => soloOrigin('Sample site', port),
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester', allowCapture: true, ...solo },
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
  const base = `/w/${owner.workspaceId}/p/${owner.projectId}/api`
  return { hosted, browser, owner, base, config }
}

async function settled(browser, base) {
  for (let i = 0; i < 200; i++) {
    const view = await browser.get(`${base}/boards/sample`)
    if (!view.json.capture.running && view.json.capture.state !== 'running') return view.json
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('the capture did not finish')
}

// One JSON-RPC call to /mcp (stateless: no session).
async function mcp(hosted, token, method, params = {}, headers = {}) {
  const response = await request(hosted.port, 'POST', '/mcp', {
    body: { jsonrpc: '2.0', id: 1, method, params },
    headers: {
      Host: new URL(hosted.origin).host,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
  })
  return response
}
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }

test('a team server never captures: 403, allowCapture false, no capture feature, no recapture_pages on /mcp', async () => {
  const hosted = await startHostedServer('solo-capture-team')
  servers.push(hosted)
  const owner = await signUp(hosted, { handle: 'owner' })
  const project = await createProject(owner, owner.workspaceId, 'Team')
  const base = `/w/${owner.workspaceId}/p/${project.id}/api`
  const capture = await owner.browser.post(`${base}/boards/sample/capture`, {})
  assert.equal(capture.status, 403)
  assert.equal(capture.json.error.code, 'capture_disabled')
  const info = await owner.browser.get(`${base}/info`)
  assert.equal(info.json.allowCapture, false)
  assert.equal('soloFeatures' in info.json, false)
  assert.equal(hosted.app.locals.soloCapture, undefined)
  const token = await createToken(owner, owner.workspaceId, project.id)
  const listed = await mcp(hosted, token.value || token.token || token, 'tools/list')
  const names = (listed.json?.result?.tools || []).map((tool) => tool.name)
  assert.ok(names.length > 0, listed.text)
  assert.equal(names.includes('recapture_pages'), false)
})

test('the app origin: only the configured one, never the engine, its usercontent origin or this machine’s own addresses', async () => {
  const engine = { origins: ['http://sample-site-abcdefghijklmn.shapewall.localhost:4000'], port: 4000 }
  const interfaces = {
    lo: [{ address: '127.0.0.1' }],
    eth0: [{ address: '192.168.1.20' }],
    tailscale0: [{ address: '100.101.102.103' }, { address: 'fd7a:115c:a1e0::1' }],
  }
  const lookup = async (name) => {
    if (name === 'lan.example.com') return [{ address: '192.168.1.20', family: 4 }]
    if (name === 'app.example.com') return [{ address: '93.184.215.14', family: 4 }]
    if (name === 'devbox.local') return [{ address: '192.168.1.20', family: 4 }]
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
  }
  const pin = (url) => pinAppOrigin(url, { engine, lookup, interfaces })
  const refused = async (url, pattern) => {
    await assert.rejects(
      pin(url),
      (error) => error.code === 'capture_origin_refused' && error.statusCode === 400 && pattern.test(error.message),
    )
  }
  assert.deepEqual(await pin('http://localhost:5173/app'), {
    origin: 'http://localhost:5173',
    host: 'localhost',
    port: 5173,
    protocol: 'http:',
    address: '127.0.0.1',
  })
  assert.equal((await pin('http://127.0.0.1:3000/')).address, '127.0.0.1')
  assert.equal((await pin('https://app.example.com/')).address, '93.184.215.14')
  await refused('http://sample-site-abcdefghijklmn.shapewall.localhost:4000/', /own origin|engine/)
  await refused('http://uc.sample-site-abcdefghijklmn.shapewall.localhost:4000/', /engine/)
  await refused('http://other-xyz.shapewall.localhost:5000/', /engine/)
  await refused('http://localhost:4000/', /engine itself/)
  await refused('http://127.0.0.1:4000/', /engine itself/)
  await refused('http://[::1]:4000/', /engine itself/)
  await refused('http://localhost:9222/', /debugging/)
  await refused('http://192.168.1.20:3000/', /own network addresses/)
  await refused('http://100.101.102.103:3000/', /own network addresses/)
  await refused('http://[fd7a:115c:a1e0::1]:3000/', /own network addresses/)
  await refused('http://devbox.local:3000/', /own network addresses/)
  await refused('http://lan.example.com:3000/', /private network/)
  await refused('http://169.254.169.254/', /link-local/)
  await refused('file:///etc/passwd', /file:/)
})

test('the capture proxy opens the app origin only; the launch goes through it', async () => {
  const hit = []
  const serve = (name) =>
    new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        hit.push(name)
        res.end(name)
      })
      server.listen(0, '127.0.0.1', () => resolve(server))
    })
  const app = await serve('app')
  const other = await serve('other')
  try {
    const launches = []
    const real = {
      executablePath: () => '/bin/true',
      launch: async (options) => {
        launches.push(options)
        return { close: async () => {}, on: () => {} }
      },
    }
    const egress = await captureEgress(
      {
        origin: `http://localhost:${app.address().port}`,
        host: 'localhost',
        port: app.address().port,
        protocol: 'http:',
        address: '127.0.0.1',
      },
      { real },
    )
    const viaProxy = (url) =>
      new Promise((resolve, reject) => {
        const target = new URL(url)
        const req = http.request(
          { host: '127.0.0.1', port: egress.proxyPort, method: 'GET', path: url, headers: { Host: target.host } },
          (res) => {
            let text = ''
            res.on('data', (chunk) => (text += chunk))
            res.on('end', () => resolve({ status: res.statusCode, text }))
          },
        )
        req.on('error', reject)
        req.end()
      })
    assert.deepEqual(await viaProxy(`http://localhost:${app.address().port}/`), { status: 200, text: 'app' })
    assert.equal((await viaProxy(`http://127.0.0.1:${other.address().port}/`)).status, 403)
    assert.equal((await viaProxy(`http://localhost:${other.address().port}/`)).status, 403)
    assert.equal(
      (await viaProxy(`http://127.0.0.1:${app.address().port}/`)).status,
      403,
      'the same server by another name is another origin',
    )
    assert.deepEqual(hit, ['app'])
    assert.equal(egress.blocked.length, 3)

    await egress.chromium.launch({ args: ['--hide-scrollbars'], headless: true })
    assert.deepEqual(launches[0].proxy, { server: `http://127.0.0.1:${egress.proxyPort}`, bypass: '<-loopback>' })
    assert.deepEqual(launches[0].args, ['--hide-scrollbars', ...CAPTURE_EGRESS_ARGS])
    assert.equal(launches[0].args.at(-1), '--proxy-bypass-list=<-loopback>')
    await egress.close()
  } finally {
    app.close()
    other.close()
  }
})

test('the owner captures from the board: 202, the state in the board view, files in the engine’s board folder', async (t) => {
  const stub = stubRun({ hold: true })
  t.after(() => stub.release())
  const { hosted, browser, owner, base, config } = await startSolo('solo-capture-owner', { solo: { capture: { run: stub.run } } })
  const info = await browser.get(`${base}/info`)
  assert.equal(info.json.allowCapture, true)
  assert.equal(info.json.soloFeatures.capture, true)
  const idle = await browser.get(`${base}/boards/sample`)
  assert.equal(idle.json.capture.state, 'idle')

  const started = await browser.post(`${base}/boards/sample/capture`, { pages: ['home'] })
  assert.equal(started.status, 202, started.text)
  assert.match(started.json.message, /Capturing 1 page\./)
  for (let i = 0; i < 100 && !stub.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const call = stub.calls[0]
  assert.equal(call.boardId, 'sample')
  assert.deepEqual(call.only, ['home'])
  assert.equal(call.checkExternal, false)
  assert.equal(typeof call.chromium.launch, 'function', 'the browser goes through the egress proxy')
  const dir = projectDir(hosted.dataDir, owner.workspaceId, owner.projectId)
  assert.equal(call.config.outputDir, dir)
  assert.equal(call.config.file, config.file, 'the live config file the binding names')
  const running = await browser.get(`${base}/boards/sample`)
  assert.equal(running.json.capture.running, true)
  assert.equal(running.json.capture.state, 'running')

  // One at a time; a push waits.
  const again = await browser.post(`${base}/boards/sample/capture`, {})
  assert.equal(again.status, 409)
  assert.equal(again.json.error.code, 'capture_running')
  const push = await request(hosted.port, 'POST', '/api/v1/pushes', { body: {}, headers: { Host: new URL(hosted.origin).host } })
  assert.equal(push.status, 409)
  assert.equal(push.json.error.code, 'capture_running')

  stub.release()
  const done = await settled(browser, base)
  assert.equal(done.capture.state, 'done')
  assert.ok(fs.existsSync(path.join(dir, 'sample', 'captures', 'manifest.json')))
  assert.ok(done.manifest?.pages?.home, 'the board view reads the new files')
  const row = hosted.db.prepare('SELECT bytes FROM boards WHERE project_id = ? AND board_id = ?').get(owner.projectId, 'sample')
  assert.ok(row.bytes > 0, 'the storage count follows the folder')
  // After the run, a push goes through to the token API again (401 here: no token).
  const later = await request(hosted.port, 'POST', '/api/v1/pushes', { body: {}, headers: { Host: new URL(hosted.origin).host } })
  assert.equal(later.status, 401)
})

test('bad input, another environment, and an app origin that is the engine are refused before anything runs', async () => {
  const stub = stubRun()
  const { browser, base, config, hosted } = await startSolo('solo-capture-input', { solo: { capture: { run: stub.run } } })
  for (const [body, code] of [
    [{ pages: ['nope'] }, 'unknown_page'],
    [{ pages: [] }, 'unknown_page'],
    [{ pages: 'home' }, 'unknown_page'],
    [{ env: 'staging' }, 'unknown_environment'],
  ]) {
    const response = await browser.post(`${base}/boards/sample/capture`, body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(response.json.error.code, code)
  }
  const unknown = await browser.post(`${base}/boards/other/capture`, {})
  assert.equal(unknown.status, 404)
  // The config now points the board at the engine itself.
  const raw = JSON.parse(fs.readFileSync(config.file, 'utf8'))
  fs.writeFileSync(config.file, JSON.stringify({ ...raw, baseUrl: `http://localhost:${hosted.port}` }, null, 2))
  const self = await browser.post(`${base}/boards/sample/capture`, {})
  assert.equal(self.status, 400)
  assert.equal(self.json.error.code, 'capture_origin_refused')
  assert.equal(stub.calls.length, 0)
  // Refused starts leave no capture slot taken.
  fs.writeFileSync(config.file, JSON.stringify(raw, null, 2))
  assert.equal((await browser.post(`${base}/boards/sample/capture`, {})).status, 202)
})

test('only the owner, on this machine: no session, a proxy header, another Host or a cross-site page are refused', async () => {
  const stub = stubRun()
  const { hosted, browser, base } = await startSolo('solo-capture-who', { solo: { capture: { run: stub.run } } })
  const anonymous = createBrowser(hosted.port, hosted.origin)
  assert.equal((await anonymous.post(`${base}/boards/sample/capture`, {})).status, 401)
  const proxied = await browser.post(`${base}/boards/sample/capture`, {}, { headers: { 'X-Forwarded-For': '10.0.0.9' } })
  assert.ok([401, 403].includes(proxied.status), proxied.text)
  const info = await browser.get(`${base}/info`, { headers: { 'X-Forwarded-For': '10.0.0.9' } })
  assert.notEqual(info.json?.allowCapture, true)
  const cross = await browser.post(`${base}/boards/sample/capture`, {}, { headers: { Origin: 'http://evil.example' } })
  assert.equal(cross.status, 403)
  assert.equal(cross.json.error.code, 'bad_origin')
  const otherHost = await browser.post(`${base}/boards/sample/capture`, {}, { headers: { Host: `localhost:${hosted.port}` } })
  assert.ok([401, 403].includes(otherHost.status), otherHost.text)
  assert.equal(stub.calls.length, 0)
})

test('--no-capture and --read-only: no capture route, allowCapture false', async () => {
  const stub = stubRun()
  const off = await startSolo('solo-capture-off', { solo: { allowCapture: false, capture: { run: stub.run } } })
  const refused = await off.browser.post(`${off.base}/boards/sample/capture`, {})
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'capture_disabled')
  assert.equal((await off.browser.get(`${off.base}/info`)).json.allowCapture, false)
  const readOnly = await startSolo('solo-capture-ro', { solo: { readOnly: true, allowCapture: false, capture: { run: stub.run } } })
  assert.equal((await readOnly.browser.post(`${readOnly.base}/boards/sample/capture`, {})).status, 403)
  assert.equal(stub.calls.length, 0)
})

test('recapture_pages on /mcp: listed for the owner’s push token here, waits for the run, answers per page with compare links', async () => {
  const stub = stubRun()
  const { hosted, browser, owner } = await startSolo('solo-capture-mcp', { solo: { capture: { run: stub.run } } })
  const made = await browser.post(`/api/workspaces/${owner.workspaceId}/projects/${owner.projectId}/tokens`, {
    name: 'agent',
    scopes: ['read', 'reply', 'status', 'push'],
  })
  assert.equal(made.status, 201, made.text)
  const token = made.json.token
  const init = await mcp(hosted, token, 'initialize', INIT)
  assert.equal(init.status, 200, init.text)
  assert.match(init.json.result.instructions, /the engine captures them on this machine/)
  const listed = await mcp(hosted, token, 'tools/list')
  assert.ok(listed.json.result.tools.some((tool) => tool.name === 'recapture_pages'))
  const called = await mcp(hosted, token, 'tools/call', { name: 'recapture_pages', arguments: { pageIds: ['home', 'home'] } })
  assert.equal(called.status, 200, called.text)
  const result = JSON.parse(called.json.result.content[0].text)
  assert.equal(result.ok, true, called.text)
  assert.deepEqual(Object.keys(result.pages), ['home'])
  assert.equal(result.pages.home.desktop, 'ok')
  assert.ok(result.compare.every((entry) => entry.link.startsWith(`${hosted.origin}/w/${owner.workspaceId}/p/${owner.projectId}/`)))
  assert.deepEqual(stub.calls[0].only, ['home'])
  const unknown = await mcp(hosted, token, 'tools/call', { name: 'recapture_pages', arguments: { pageIds: ['nope'] } })
  assert.equal(unknown.json.result.isError, true)
  assert.match(unknown.json.result.content[0].text, /^unknown_page:/)

  // Without push, from another Host, or through a proxy: no tool.
  const read = await browser.post(`/api/workspaces/${owner.workspaceId}/projects/${owner.projectId}/tokens`, {
    name: 'reader',
    scopes: ['read'],
  })
  const names = async (value, headers) =>
    ((await mcp(hosted, value, 'tools/list', {}, headers)).json?.result?.tools || []).map((tool) => tool.name)
  assert.equal((await names(read.json.token)).includes('recapture_pages'), false)
  assert.equal((await names(token, { 'X-Forwarded-For': '10.0.0.9' })).includes('recapture_pages'), false)
  assert.equal((await names(token, { Host: `localhost:${hosted.port}` })).includes('recapture_pages'), false)
  assert.equal(stub.calls.length, 1)
})

test('stopping the engine closes a running capture’s browser and waits for the run to end', async () => {
  let closedBrowser = null
  const browserClosed = new Promise((resolve) => (closedBrowser = resolve))
  const real = {
    executablePath: () => '/bin/true',
    launch: async () => ({ close: async () => closedBrowser(), on: () => {} }),
  }
  let ended = false
  const run = async (options) => {
    await options.chromium.launch({ args: [] })
    await browserClosed
    ended = true
    throw new Error('the browser closed')
  }
  const { hosted, browser, base } = await startSolo('solo-capture-stop', { solo: { capture: { run, chromium: real } } })
  assert.equal((await browser.post(`${base}/boards/sample/capture`, {})).status, 202)
  servers.splice(servers.indexOf(hosted), 1)
  await hosted.close()
  assert.equal(ended, true)
})
