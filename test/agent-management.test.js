import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import express from 'express'
import { agentRouter } from '../src/agent/routes.js'
import { createAgentManagement, startAgentManagement } from '../src/agent/manage.js'
import { agentControlFile, beginAgentOperation } from '../src/agent/control.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { saveUserAgentEntry, userAgentEntry, userSettingsFile } from '../src/agent/user-settings.js'
import { processStartTime, withFileLock } from '../src/lock.js'
import { registerProject, projectsFile } from '../src/local-projects.js'
import { writeServeState } from '../src/serve-state.js'
import { SAMPLE, sampleConfig, tempDir, request } from './helpers.js'
const stub = path.resolve('test/fixtures/acp-stub.mjs')
const token = 'management-test-capability'
async function setup(t) {
  const config = sampleConfig('management')
  const home = tempDir('management-home')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'codex-acp'), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 })
  const env = { HOME: home, XDG_CONFIG_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  fs.mkdirSync(config.outputDir, { recursive: true })
  const { app } = createAgentManagement({ config, env, token })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const headers = { Origin: origin, 'X-Shapewall-Settings-Token': token }
  const call = (method, route, body, extra = {}) => request(port, method, route, { body, headers: { ...headers, ...extra } })
  const close = async () => {
    app.locals.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
  t.after(close)
  return { config, env, app, server, origin, port, call }
}
const settings = '/api/agent/settings'
test('management exposes only host-authorized settings and preserves server state and project index', async (t) => {
  const b = await setup(t)
  registerProject(b.config, b.env)
  writeServeState(b.config, 'https://fixture.example.ts.net/')
  const serveFile = path.join(b.config.outputDir, 'serve.json')
  const before = fs.readFileSync(serveFile, 'utf8'),
    index = fs.readFileSync(projectsFile(b.env), 'utf8')
  assert.equal((await b.call('GET', settings)).json.project.root, fs.realpathSync(b.config.dir))
  assert.equal((await request(b.port, 'GET', settings)).status, 404)
  for (const headers of [{ Via: 'proxy' }, { Host: 'remote.example.test' }, { Origin: 'https://evil.example.test' }])
    assert.equal((await b.call('POST', settings, { settings: {} }, headers)).status, 403)
  for (const route of [
    '/api/boards',
    '/api/info',
    '/api/agent/status',
    '/api/agent/boards/sample/threads/board/messages',
    '/api/share',
    '/auth/me',
    '/captures/index.html',
    '/sw.js',
  ])
    assert.equal((await b.call('GET', route)).status, 404, route)
  assert.equal((await b.call('POST', '/api/agent/boards/sample/threads/board/messages', { text: 'never dispatch' })).status, 404)
  const nonce = b.app.locals.openLink()
  const opened = await b.call('GET', nonce)
  assert.equal(opened.status, 303)
  assert.equal(opened.headers.location, `/#settings-token=${token}`)
  assert.equal((await b.call('GET', nonce)).status, 404)
  b.app.locals.close()
  assert.equal(fs.readFileSync(serveFile, 'utf8'), before)
  assert.equal(fs.readFileSync(projectsFile(b.env), 'utf8'), index)
})
test(
  'native profile connect is confirmed/tested in management and next board request sees it without automatic dispatch',
  { skip: process.platform === 'win32' },
  async (t) => {
    const b = await setup(t)
    const app = createApp({ config: b.config, env: b.env, settingsToken: token })
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => {
      stopChildren(app)
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    })
    const port = server.address().port
    const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': token }
    const call = (method, route, body) => request(port, method, route, { headers, body })
    assert.equal((await call('GET', '/api/agent/status')).json.configured, false)
    const first = await b.call('POST', settings + '/profiles/connect', { agentId: 'codex' })
    assert.equal(first.json.confirm[0].projectRoot, fs.realpathSync(b.config.dir))
    const connected = await b.call('POST', settings + '/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash })
    assert.equal(connected.json.connected, true, connected.text)
    const status = await call('GET', '/api/agent/status')
    assert.equal(status.json.configured, true)
    assert.equal(status.json.profiles.find((item) => item.id === 'codex').configured, true)
    assert.equal(fs.existsSync(path.join(b.config.outputDir, 'sample', 'chat')), false)
    const sent = await call('POST', '/api/agent/boards/sample/threads/board/messages', { text: 'stream' })
    assert.equal(sent.status, 200)
    assert.match(sent.text, /Hello /)
    assert.equal((await b.call('POST', settings + '/test', {})).json.ok, true)
  },
)
test('shared admission preserves parallel turns and settings exclusivity through final release', async () => {
  const config = sampleConfig('control-admission'),
    home = tempDir('control-admission-home')
  const env = { HOME: home, XDG_CONFIG_HOME: home }
  const first = await beginAgentOperation(config, env, 'turn'),
    second = await beginAgentOperation(config, env, 'turn')
  assert.ok(first && second)
  assert.equal(await beginAgentOperation(config, env, 'settings'), null)
  await first()
  assert.equal(await beginAgentOperation(config, env, 'settings'), null)
  await second()
  const management = await beginAgentOperation(config, env, 'settings')
  assert.ok(management)
  assert.equal(await beginAgentOperation(config, env, 'turn'), null)
  await management()
  assert.equal(fs.existsSync(agentControlFile(config, env)), false)
})
test('malformed registry fails closed; dead process and recycled PID leases are reaped', async (t) => {
  const config = sampleConfig('control-stale'),
    home = tempDir('control-stale-home'),
    env = { HOME: home, XDG_CONFIG_HOME: home }
  const file = agentControlFile(config, env)
  for (const content of ['{', JSON.stringify({ version: 1, leases: [{ kind: 'unknown' }] })]) {
    fs.writeFileSync(file, content, { mode: 0o600 })
    await assert.rejects(beginAgentOperation(config, env, 'settings'))
  }
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'])
  t.after(() => child.kill())
  await once(child, 'spawn')
  const start = processStartTime(child.pid),
    exited = once(child, 'exit')
  child.kill()
  await exited
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      leases: [
        { nonce: 'a'.repeat(32), kind: 'turn', pid: child.pid, start },
        ...(processStartTime(process.pid) === null ? [] : [{ nonce: 'b'.repeat(32), kind: 'settings', pid: process.pid, start: '0' }]),
      ],
    }),
    { mode: 0o600 },
  )
  const release = await beginAgentOperation(config, env, 'settings')
  assert.ok(release)
  await release()
})
test('settings command binds only loopback, rejects invalid ports and cleans up', async () => {
  const config = sampleConfig('management-bind')
  await assert.rejects(startAgentManagement({ config, port: -1 }))
  const managed = await startAgentManagement({ config, env: { HOME: tempDir('management-bind-home') } })
  assert.equal(managed.server.address().address, '127.0.0.1')
  await managed.close()
  assert.equal(managed.server.listening, false)
})

async function sourceBoard(t, b, options = {}) {
  const app = options.capture ? express() : createApp({ config: b.config, env: b.env, settingsToken: token, ...options })
  if (options.capture) {
    app.locals.agentRouter = agentRouter({
      config: b.config,
      env: b.env,
      settingsToken: token,
      acp: options.agentAcp,
      capture: options.capture,
    })
    app.use('/api/agent', app.locals.agentRouter)
  }
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    stopChildren(app)
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })
  const port = server.address().port,
    origin = `http://127.0.0.1:${port}`
  const headers = { Origin: origin, 'X-Shapewall-Settings-Token': token }
  return { app, server, port, origin, headers, call: (method, route, body) => request(port, method, route, { headers, body }) }
}
async function until(check) {
  const end = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting for test barrier')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('management cannot change or test settings while another instance streams; next idle turn reloads the changed backend', async (t) => {
  const b = await setup(t)
  saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: `${process.execPath} ${stub}`, label: 'Original' }, b.env)
  const board = await sourceBoard(t, b)
  const base = '/api/agent/boards/sample/threads/board'
  const pid = async () => {
    const result = await board.call('POST', base + '/messages', { text: 'pid' })
    const events = result.text.split('\n\n').filter((item) => item.startsWith('event: done'))
    return JSON.parse(events[0].split('\ndata: ')[1]).message.text
  }
  const oldPid = await pid()
  const { createComment } = await import('../src/store.js')
  await createComment(b.config, b.config.boards[0], { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'Independent thread' })
  const response = await fetch(board.origin + base + '/messages', {
    method: 'POST',
    headers: { ...board.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'slowly' }),
  })
  const reader = response.body.getReader()
  let streamed = ''
  while (!streamed.includes('event: text')) streamed += new TextDecoder().decode((await reader.read()).value)
  assert.equal(
    (await board.call('POST', '/api/agent/boards/sample/threads/comment-1/messages', { text: 'stream' })).status,
    200,
    'distinct ordinary threads remain concurrent',
  )
  for (const [method, route, body] of [
    ['POST', settings, { settings: { label: 'Changed' } }],
    ['POST', settings + '/test', {}],
    ['DELETE', settings + '/profiles/codex'],
  ]) {
    const refused = await b.call(method, route, body)
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error.code, 'agent_running')
  }
  await board.call('POST', base + '/stop', {})
  while (!(await reader.read()).done) {
    /* wait for cancelled turn settlement */
  }
  await until(async () => !fs.existsSync(agentControlFile(b.config, b.env)))
  const saved = await b.call('POST', settings, {
    settings: { backend: 'acp', acpCommand: `${process.execPath} ${stub}`, vision: false },
  })
  assert.equal(saved.status, 200)
  assert.notEqual(await pid(), oldPid)
  assert.equal((await board.call('GET', '/api/agent/status')).json.vision, false)
})

test(
  'settings lease blocks another instance before its settings read and profile selection throughout a handshake',
  { skip: process.platform === 'win32' },
  async (t) => {
    const b = await setup(t)
    saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: `${process.execPath} ${stub}` }, b.env)
    const board = await sourceBoard(t, b)
    const marker = path.join(b.env.HOME, 'handshake-started'),
      release = path.join(b.env.HOME, 'handshake-release')
    fs.writeFileSync(
      path.join(b.env.HOME, 'bin', 'codex-acp'),
      `#!/bin/sh\n: > "${marker}"\nwhile [ ! -f "${release}" ]; do sleep 0.01; done\nexec "${process.execPath}" "${stub}"\n`,
      { mode: 0o755 },
    )
    const first = await b.call('POST', settings + '/profiles/connect', { agentId: 'codex' })
    const connecting = b.call('POST', settings + '/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash })
    await until(() => fs.existsSync(marker))
    for (const [route, body] of [
      ['/api/agent/boards/sample/threads/board/messages', { text: 'stream' }],
      ['/api/agent/boards/sample/threads/board/profile', { profileId: 'default' }],
    ])
      assert.equal((await board.call('POST', route, body)).status, 409)
    fs.writeFileSync(release, 'release')
    assert.equal((await connecting).json.connected, true)
    assert.equal((await board.call('POST', '/api/agent/boards/sample/threads/board/messages', { text: 'stream' })).status, 200)
  },
)

test('turn lease stays active throughout automatic recapture and review status completion', { timeout: 10000 }, async (t) => {
  const b = await setup(t)
  const { createComment } = await import('../src/store.js')
  fs.writeFileSync(b.config.file, JSON.stringify({ ...SAMPLE, outputDir: b.config.outputDir }))
  await createComment(b.config, b.config.boards[0], { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Fix heading' })
  const fixture = path.resolve('test/fixtures/acp-fix.mjs')
  let releaseCapture, captureStarted
  const started = new Promise((r) => {
      captureStarted = r
    }),
    barrier = new Promise((r) => {
      releaseCapture = r
    })
  const board = await sourceBoard(t, b, {
    agentAcp: `${process.execPath} ${fixture}`,
    capture: async () => {
      captureStarted()
      await barrier
      const folder = path.join(b.config.outputDir, 'sample', 'captures')
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(
        path.join(folder, 'manifest.json'),
        JSON.stringify({
          capturedAt: new Date().toISOString(),
          pages: { home: { desktop: { status: 'ok', version: '20261107T120000000Z-abcd' } } },
        }),
      )
      return { ok: true, failed: 0 }
    },
  })
  t.after(() => releaseCapture())
  const sending = board.call('POST', '/api/agent/boards/sample/threads/comment-1/messages', { text: 'Fix', fix: true })
  await Promise.race([
    started,
    sending.then((result) => {
      throw new Error(`Fix ended before recapture: ${result.status}`)
    }),
  ])
  assert.equal((await b.call('POST', settings + '/test', {})).status, 409)
  releaseCapture()
  assert.equal((await sending).status, 200)
  await until(async () => !fs.existsSync(agentControlFile(b.config, b.env)))
  const release = await beginAgentOperation(b.config, b.env, 'settings')
  assert.ok(release)
  await release()
})

test('simultaneous settings and turn admissions cannot both win; a live other process blocks management', async (t) => {
  const config = sampleConfig('control-race'),
    home = tempDir('control-race-home'),
    env = { HOME: home, XDG_CONFIG_HOME: home }
  for (let i = 0; i < 10; i++) {
    const leases = await Promise.all([beginAgentOperation(config, env, 'turn'), beginAgentOperation(config, env, 'settings')])
    assert.equal(leases.filter(Boolean).length, 1)
    await leases.find(Boolean)()
  }
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { beginAgentOperation } from ${JSON.stringify(new URL('../src/agent/control.js', import.meta.url).href)}; const release=await beginAgentOperation({dir:process.argv[1],outputDir:process.argv[2]},{HOME:process.argv[3],XDG_CONFIG_HOME:process.argv[3]},'turn'); if(!release)process.exit(2); process.stdout.write('ready\\n'); process.stdin.resume();`,
      config.dir,
      config.outputDir,
      home,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  t.after(() => child.kill())
  await once(child.stdout, 'data')
  assert.equal(await beginAgentOperation(config, env, 'settings'), null)
  const exited = once(child, 'exit')
  child.kill()
  await exited
  const release = await beginAgentOperation(config, env, 'settings')
  assert.ok(release)
  await release()
})

test('disconnect keeps the turn lease until native cancellation has settled', async (t) => {
  const b = await setup(t)
  saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: `${process.execPath} ${stub}` }, b.env)
  const board = await sourceBoard(t, b, { agentLimits: { acp: { cancelGraceMs: 200 } } })
  const response = await fetch(board.origin + '/api/agent/boards/sample/threads/board/messages', {
    method: 'POST',
    headers: { ...board.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'ignore cancel' }),
  })
  const reader = response.body.getReader()
  let streamed = ''
  while (!streamed.includes('event: text')) streamed += new TextDecoder().decode((await reader.read()).value)
  await reader.cancel()
  assert.equal((await b.call('POST', settings + '/test', {})).status, 409)
  await until(() => !fs.existsSync(agentControlFile(b.config, b.env)))
  assert.equal((await b.call('POST', settings + '/test', {})).json.ok, true)
})

test(
  'management teardown stops a pending handshake child and releases shared admission',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const b = await setup(t)
    const marker = path.join(b.env.HOME, 'pending-agent-pid')
    fs.writeFileSync(path.join(b.env.HOME, 'bin', 'codex-acp'), `#!/bin/sh\nprintf '%s' "$$" > "${marker}"\nwhile :; do sleep 1; done\n`, {
      mode: 0o755,
    })
    const first = await b.call('POST', settings + '/profiles/connect', { agentId: 'codex' })
    const pending = b.call('POST', settings + '/profiles/connect', { agentId: 'codex', confirm: first.json.confirmHash })
    await until(() => fs.existsSync(marker))
    const pid = Number(fs.readFileSync(marker, 'utf8'))
    b.app.locals.close()
    const ended = await pending
    assert.equal(ended.json.connected, false)
    await until(() => !fs.existsSync(agentControlFile(b.config, b.env)))
    assert.throws(() => process.kill(pid, 0))
    assert.equal((await b.call('GET', settings)).status, 503)
    assert.equal(userAgentEntry(b.config.dir, b.env).entry?.acpCommand, undefined)
  },
)

test('malformed activity refuses settings and turn admission with a structured error', async (t) => {
  const b = await setup(t)
  saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: `${process.execPath} ${stub}` }, b.env)
  const board = await sourceBoard(t, b)
  fs.writeFileSync(agentControlFile(b.config, b.env), '{', { mode: 0o600 })
  for (const result of [
    await b.call('POST', settings, { settings: {} }),
    await board.call('POST', '/api/agent/boards/sample/threads/board/messages', { text: 'stream' }),
  ]) {
    assert.equal(result.status, 503)
    assert.equal(result.json.error.code, 'agent_activity_unavailable')
  }
  assert.equal(fs.existsSync(path.join(b.config.outputDir, 'sample', 'chat')), false)
})

// Observe the actual Express admission middleware promise so the disconnect
// occurs while it awaits the held metadata lock, without timing guesses.
function observeAdmission(app, kind) {
  let entered, settled
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const finished = new Promise((resolve) => {
    settled = resolve
  })
  const locate = (stack) => {
    for (const layer of stack) {
      if (kind === 'turn' && layer.route) {
        const found = layer.route.stack.find((entry) => entry.handle.name === 'admitMessage')
        if (found) return found
      }
      if (kind === 'profile' && String(layer.route?.path).endsWith('/profile')) {
        const found = layer.route.stack.find((entry) => entry.handle.constructor.name === 'AsyncFunction')
        if (found) return found
      }
      if (!layer.route && layer.handle?.stack) {
        const found = locate(layer.handle.stack)
        if (found) return found
      }
      if (kind === 'settings' && !layer.route && layer.handle?.constructor.name === 'AsyncFunction') return layer
    }
  }
  const layer = locate(app.router.stack)
  assert.ok(layer, `No ${kind} admission middleware`)
  const original = layer.handle
  layer.handle = function (...args) {
    const result = original.apply(this, args)
    entered()
    return Promise.resolve(result).finally(settled)
  }
  return { started, finished }
}

for (const kind of ['turn', 'settings', 'profile'])
  test(`${kind} disconnect while waiting for metadata admission cannot leak a lease or start work`, { timeout: 10000 }, async (t) => {
    const b = await setup(t)
    saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: `${process.execPath} ${stub}` }, b.env)
    const board = await sourceBoard(t, b)
    let target = board,
      route = '/api/agent/boards/sample/threads/board/messages',
      body = { text: 'stream' }
    if (kind === 'settings') {
      const first = await b.call('POST', settings + '/profiles/connect', { agentId: 'codex' })
      assert.ok(first.json.confirmHash)
      target = b
      route = settings + '/profiles/connect'
      body = { agentId: 'codex', confirm: first.json.confirmHash }
    } else if (kind === 'profile') {
      route = '/api/agent/boards/sample/threads/board/profile'
      body = { profileId: 'default' }
    }
    const settingsFile = userSettingsFile(b.env),
      savedBefore = fs.readFileSync(settingsFile, 'utf8')
    const file = agentControlFile(b.config, b.env)
    let unlock, held
    const barrier = new Promise((resolve) => {
      unlock = resolve
    })
    const ready = new Promise((resolve) => {
      held = resolve
    })
    const holding = withFileLock(
      file,
      async () => {
        held()
        await barrier
      },
      { staleMs: Infinity },
    )
    t.after(() => unlock())
    await ready
    const admission = observeAdmission(target.app, kind)
    let disconnected
    const closed = new Promise((resolve) => {
      disconnected = resolve
    })
    target.server.once('request', (req, res) => res.once('close', disconnected))
    const req = http.request({
      host: '127.0.0.1',
      port: target.port,
      path: route,
      method: 'POST',
      headers: { Origin: target.origin, 'Content-Type': 'application/json', 'X-Shapewall-Settings-Token': token },
    })
    req.on('error', () => {})
    req.end(JSON.stringify(body))
    await admission.started
    req.destroy()
    await closed
    unlock()
    await holding
    await admission.finished
    assert.equal(fs.existsSync(file), false, 'abandoned admission leaves no live-server lease')
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), savedBefore, 'settings remain byte-identical')
    assert.equal(fs.existsSync(path.join(b.config.outputDir, 'sample', 'chat')), false, 'no prompt was dispatched')
    assert.equal(board.app.locals.agentRouter.processes().length, 0)
    const release = await beginAgentOperation(b.config, b.env, 'settings')
    assert.ok(release, 'the next operation is admitted')
    await release()
  })

test('admission cancellation before entry and after atomic lease write leaves no operation', async () => {
  const config = sampleConfig('control-cancel-boundaries'),
    home = tempDir('control-cancel-home')
  const env = { HOME: home, XDG_CONFIG_HOME: home }
  const before = new AbortController()
  before.abort()
  assert.equal(await beginAgentOperation(config, env, 'turn', { signal: before.signal }), null)
  assert.equal(fs.existsSync(path.join(home, 'shapewall', 'agent-activity')), false)
  const file = agentControlFile(config, env),
    during = new AbortController()
  const admitting = beginAgentOperation(config, env, 'settings', { signal: during.signal })
  assert.equal(fs.existsSync(file), true, 'the atomic admission write occurred before cancellation')
  during.abort()
  assert.equal(await admitting, null)
  assert.equal(fs.existsSync(file), false)
  const release = await beginAgentOperation(config, env, 'turn')
  assert.ok(release)
  await release()
})

function runnable(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function stubbornAgent(t, b, mode = '') {
  const dir = path.join(b.env.HOME, 'descendant')
  fs.mkdirSync(dir)
  const wrapper = path.resolve('test/fixtures/acp-descendant.mjs')
  const command = `${process.execPath} ${wrapper} ${dir}${mode ? ` ${mode}` : ''}`
  saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: command }, b.env)
  t.after(() => {
    for (const file of ['parent.pid', 'child.pid']) {
      const marker = path.join(dir, file)
      if (!fs.existsSync(marker)) continue
      const pid = Number(fs.readFileSync(marker, 'utf8'))
      if (runnable(pid)) process.kill(pid, 'SIGKILL')
    }
  })
  return {
    dir,
    pid: (name) => Number(fs.readFileSync(path.join(dir, `${name}.pid`), 'utf8')),
    ticks: () => fs.readFileSync(path.join(dir, 'ticks'), 'utf8').length,
  }
}

for (const kind of ['cancel', 'cancel fix', 'handshake', 'start failure'])
  test(
    `${kind} retains shared admission after adapter exit until its TERM-ignoring descendant stops`,
    { skip: process.platform !== 'linux', timeout: 10000 },
    async (t) => {
      const b = await setup(t)
      const fixture = stubbornAgent(t, b, kind === 'start failure' ? 'start-error' : '')
      const file = agentControlFile(b.config, b.env)
      let pending, board
      const thread = kind === 'cancel fix' ? 'comment-1' : 'board'
      if (kind === 'cancel fix') {
        const { createComment } = await import('../src/store.js')
        for (const body of ['First fix', 'Other fix'])
          await createComment(b.config, b.config.boards[0], { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body })
      }
      let completed = false
      if (kind.startsWith('cancel')) {
        board = await sourceBoard(t, b, { agentLimits: { acp: { cancelGraceMs: 100 } } })
        const response = await fetch(board.origin + `/api/agent/boards/sample/threads/${thread}/messages`, {
          method: 'POST',
          headers: { ...board.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'ignore cancel', ...(kind === 'cancel fix' ? { fix: true } : {}) }),
        })
        const reader = response.body.getReader()
        let streamed = ''
        while (!streamed.includes('event: text')) streamed += new TextDecoder().decode((await reader.read()).value)
        await reader.cancel()
      } else if (kind === 'handshake')
        pending = b.call('POST', settings + '/test', {}).then((result) => {
          completed = true
          return result
        })
      else {
        const board = await sourceBoard(t, b)
        pending = board.call('POST', '/api/agent/boards/sample/threads/board/messages', { text: 'stream' }).then((result) => {
          completed = true
          return result
        })
      }
      await until(() => fs.existsSync(path.join(fixture.dir, 'child.pid')))
      await until(() => !runnable(fixture.pid('parent')))
      assert.equal(runnable(fixture.pid('child')), true, 'the parent has exited but owned work continues')
      const before = fixture.ticks()
      await until(() => fixture.ticks() > before + 2)
      assert.equal(fs.existsSync(file), true, 'live descendant keeps shared admission')
      assert.equal(await beginAgentOperation(b.config, b.env, 'settings'), null)
      if (board) {
        assert.equal((await board.call('POST', `/api/agent/boards/sample/threads/${thread}/messages`, { text: 'stream' })).status, 409)
        if (kind === 'cancel fix')
          assert.equal(
            (await board.call('POST', '/api/agent/boards/sample/threads/comment-2/messages', { text: 'Fix', fix: true })).status,
            409,
          )
      }
      if (kind === 'handshake') {
        assert.equal(completed, false, 'handshake response waits for descendant cleanup')
        assert.equal(await beginAgentOperation(b.config, b.env, 'turn'), null)
      }
      if (pending) {
        assert.equal(completed, false, 'request waits for descendant cleanup')
        const result = await pending
        if (kind === 'handshake') assert.equal(result.json.ok, true)
        else {
          assert.match(result.text, /agent_start/)
          assert.match(result.text, /Fictional startup failure after descendant ready/)
        }
      }
      await until(() => !fs.existsSync(file))
      assert.equal(runnable(fixture.pid('child')), false)
      const ticks = fixture.ticks()
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(fixture.ticks(), ticks, 'no writes after admission releases')
      const release = await beginAgentOperation(b.config, b.env, 'settings')
      assert.ok(release)
      await release()
      if (board) {
        saveUserAgentEntry(b.config.dir, { backend: 'acp', acpCommand: `${process.execPath} ${stub}` }, b.env)
        assert.equal((await board.call('POST', `/api/agent/boards/sample/threads/${thread}/messages`, { text: 'stream' })).status, 200)
      }
    },
  )

test(
  'real settings CLI shutdown waits for a pending handshake descendant and its lease release',
  { skip: process.platform !== 'linux', timeout: 12000 },
  async (t) => {
    const b = await setup(t)
    const fixture = stubbornAgent(t, b, 'silent')
    fs.writeFileSync(b.config.file, JSON.stringify(SAMPLE))
    const cli = spawn(process.execPath, [path.resolve('bin/shapewall.js'), 'settings', '--config', b.config.file, '--port', '0'], {
      env: b.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => {
      if (runnable(cli.pid)) cli.kill('SIGKILL')
    })
    let output = ''
    cli.stdout.on('data', (chunk) => {
      output += chunk
    })
    const ended = once(cli, 'exit')
    await until(() => /http:\/\/127\.0\.0\.1:\d+\/#settings-token=\S+/.test(output))
    const link = new URL(/http:\/\/127\.0\.0\.1:\d+\/#settings-token=\S+/.exec(output)[0])
    const pending = fetch(link.origin + settings + '/test', {
      method: 'POST',
      headers: {
        Origin: link.origin,
        'X-Shapewall-Settings-Token': link.hash.slice('#settings-token='.length),
        'Content-Type': 'application/json',
      },
      body: '{}',
    }).catch(() => null)
    await until(() => fs.existsSync(path.join(fixture.dir, 'child.pid')))
    cli.kill('SIGTERM')
    cli.kill('SIGINT')
    await until(() => !runnable(fixture.pid('parent')))
    assert.equal(runnable(fixture.pid('child')), true)
    const before = fixture.ticks()
    await until(() => fixture.ticks() > before + 2)
    assert.equal(runnable(cli.pid), true, 'CLI does not force-exit during owned cleanup')
    assert.equal(fs.existsSync(agentControlFile(b.config, b.env)), true)
    assert.equal(await beginAgentOperation(b.config, b.env, 'settings'), null)
    const [code, signal] = await ended
    await pending
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.equal(runnable(fixture.pid('child')), false)
    assert.equal(fs.existsSync(agentControlFile(b.config, b.env)), false)
    const release = await beginAgentOperation(b.config, b.env, 'settings')
    assert.ok(release)
    await release()
  },
)

test(
  'idle settings CLI exits naturally after repeated shutdown signals without starting an agent',
  { skip: process.platform !== 'linux', timeout: 5000 },
  async (t) => {
    const b = await setup(t)
    fs.writeFileSync(b.config.file, JSON.stringify(SAMPLE))
    const cli = spawn(process.execPath, [path.resolve('bin/shapewall.js'), 'settings', '--config', b.config.file, '--port', '0'], {
      env: b.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => {
      if (runnable(cli.pid)) cli.kill('SIGKILL')
    })
    let output = ''
    cli.stdout.on('data', (chunk) => {
      output += chunk
    })
    const ended = once(cli, 'exit')
    await until(() => output.includes('This temporary server'))
    cli.kill('SIGINT')
    cli.kill('SIGTERM')
    const [code, signal] = await ended
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.equal(fs.existsSync(agentControlFile(b.config, b.env)), false)
    assert.equal(b.app.locals.openLink().startsWith('/open/'), true)
  },
)

test('the settings page gets its theme script and icon from an install inside a dot folder', async (t) => {
  // ~/.local/share/..., node_modules/.pnpm/...: the client files of a real install sit under a dot folder.
  const clientDir = path.join(tempDir('management-dot-install'), '.local', 'share', 'client')
  fs.mkdirSync(path.join(clientDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
  fs.writeFileSync(path.join(clientDir, 'theme-boot.js'), '// theme\n')
  fs.writeFileSync(path.join(clientDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const config = sampleConfig('management-dot')
  fs.mkdirSync(config.outputDir, { recursive: true })
  const { app } = createAgentManagement({ config, env: { HOME: tempDir('management-dot-home') }, token, clientDir })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    app.locals.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })
  const port = server.address().port
  const script = await request(port, 'GET', '/theme-boot.js')
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /javascript/)
  assert.equal((await request(port, 'GET', '/favicon.svg')).status, 200)
  assert.equal((await request(port, 'GET', '/')).status, 200)
})
