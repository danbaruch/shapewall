// "Agents changed" (src/agent/settings-events.js and GET /api/agent/events):
// one event for every open view when the agent settings change, from this
// server's own settings routes or from an edit of the agents file made
// outside this process. Against the ACP stub only: never a real agent.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, stopChildren } from '../src/server/app.js'
import { normalizeConfig } from '../src/config.js'
import { createSettingsEvents } from '../src/agent/settings-events.js'
import { acpHandshake } from '../src/agent/backends/acp.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const TOKEN = 'settings-token-for-events-0123456789'
const STUB_ACP = fileURLToPath(new URL('./fixtures/acp-stub.mjs', import.meta.url))
const homes = []
after(() => {
  for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true })
})

function settingsHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-events-'))
  homes.push(dir)
  return { dir, file: path.join(dir, 'shapewall', 'agents.json') }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Resolves with the next event, or null when none comes within `ms`.
function nextEvent(events, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop()
      resolve(null)
    }, ms)
    const stop = events.subscribe((event) => {
      clearTimeout(timer)
      stop()
      resolve(event)
    })
  })
}

test('events: changes close together become one event', async () => {
  const events = createSettingsEvents({ watch: false, debounceMs: 30 })
  try {
    const seen = []
    events.subscribe((event) => seen.push(event))
    events.changed('settings')
    events.changed('file')
    await wait(80)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].reasons.sort(), ['file', 'settings'])
    const stop = events.subscribe(() => {})
    assert.equal(events.listenerCount(), 2)
    stop()
    assert.equal(events.listenerCount(), 1)
  } finally {
    events.close()
  }
})

test('events: an edit of the agents file from outside is announced, also when its folder appears later', async () => {
  const home = settingsHome()
  // The folder is not there yet: no settings were ever saved.
  const events = createSettingsEvents({ file: home.file, debounceMs: 30 })
  try {
    let event = nextEvent(events)
    fs.mkdirSync(path.dirname(home.file), { recursive: true })
    assert.ok(await event, 'the folder appearing is a change')

    // `shapewall settings` or a person writing the file (write, then rename).
    await wait(60)
    event = nextEvent(events)
    fs.writeFileSync(`${home.file}.tmp-1`, '{"version":1,"projects":{}}\n')
    fs.renameSync(`${home.file}.tmp-1`, home.file)
    const got = await event
    assert.ok(got)
    assert.deepEqual(got.reasons, ['file'])

    // Other files in the folder are not agent settings.
    await wait(60)
    event = nextEvent(events, 300)
    fs.writeFileSync(path.join(path.dirname(home.file), 'other.json'), '{}')
    assert.equal(await event, null)
  } finally {
    events.close()
  }
})

function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

// Reads GET /api/agent/events and counts "agents" events.
function eventStream(port) {
  return new Promise((resolve, reject) => {
    const seen = []
    const req = http.get({ host: '127.0.0.1', port, path: '/api/agent/events' }, (res) => {
      assert.equal(res.statusCode, 200)
      assert.match(res.headers['content-type'], /text\/event-stream/)
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (block.startsWith('event: agents')) seen.push(JSON.parse(block.split('\ndata: ')[1]))
        }
      })
      resolve({
        response: res,
        seen,
        // Waits until `count` events arrived (or fails after 3 s).
        async until(count) {
          for (let i = 0; i < 60 && seen.length < count; i++) await wait(50)
          return seen.length
        },
        close: () => req.destroy(),
      })
    })
    req.on('error', reject)
  })
}

test('api: every settings route that changes something, and an outside edit of the file, tell GET /api/agent/events', async () => {
  const home = settingsHome()
  const dir = tempDir('events-board')
  const config = normalizeConfig(structuredClone(SAMPLE), { dir, file: path.join(dir, 'shapewall.config.json') })
  // A fake Codex adapter on PATH that runs the ACP stub.
  const bin = path.join(home.dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'codex-acp'), `#!/bin/sh\nexec "${process.execPath}" "${STUB_ACP}" "$@"\n`, { mode: 0o755 })
  const env = { HOME: home.dir, XDG_CONFIG_HOME: home.dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  const app = createApp({ config, clientDir: tempDir('events-client'), env, settingsToken: TOKEN })
  const server = await listen(app)
  const port = server.address().port
  const headers = { 'X-Shapewall-Settings-Token': TOKEN, Origin: `http://127.0.0.1:${port}` }
  const post = (pathname, body) => request(port, 'POST', pathname, { body, headers })
  const stream = await eventStream(port)
  try {
    let connected = await post('/api/agent/settings/profiles/connect', { agentId: 'codex' })
    if (connected.json?.confirm)
      connected = await post('/api/agent/settings/profiles/connect', { agentId: 'codex', confirm: connected.json.confirmHash })
    assert.equal(connected.status, 200, JSON.stringify(connected.json))
    assert.equal(connected.json.connected, true, JSON.stringify(connected.json.result))
    assert.equal(await stream.until(1), 1, 'connect')
    const id = 'codex'

    await wait(250)
    assert.equal((await post(`/api/agent/settings/profiles/${id}/default`, {})).status, 200)
    assert.equal(await stream.until(2), 2, 'default')

    await wait(250)
    assert.equal((await post('/api/agent/settings', { settings: { label: 'Renamed' } })).status, 200)
    assert.equal(await stream.until(3), 3, 'save')

    await wait(250)
    assert.equal((await post('/api/agent/settings/test', { profileId: id })).status, 200)
    assert.equal(await stream.until(4), 4, 'test (the agent state changed)')

    // A refused change changes nothing and says nothing.
    await wait(250)
    assert.equal((await post('/api/agent/settings/profiles/nope/default', {})).status, 404)
    await wait(300)
    assert.equal(stream.seen.length, 4, 'refused')

    const removed = await request(port, 'DELETE', `/api/agent/settings/profiles/${id}`, { headers })
    assert.equal(removed.status, 200)
    assert.equal(await stream.until(5), 5, 'remove')

    // Another process edits the file.
    await wait(250)
    const text = fs.readFileSync(home.file, 'utf8')
    fs.writeFileSync(home.file, text.replace(/\n?$/, '\n'))
    assert.equal(await stream.until(6), 6, 'outside edit')
    assert.match(stream.seen[5].at, /^\d{4}-\d\d-\d\dT/)
    // No settings ride along.
    assert.deepEqual(Object.keys(stream.seen[5]), ['at'])
  } finally {
    stream.close()
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})

test('api: a server with open events streams closes promptly', async () => {
  const home = settingsHome()
  const dir = tempDir('events-close')
  const config = normalizeConfig(structuredClone(SAMPLE), { dir, file: path.join(dir, 'shapewall.config.json') })
  const app = createApp({
    config,
    clientDir: tempDir('events-close-client'),
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: home.dir },
    settingsToken: TOKEN,
  })
  const server = await listen(app)
  const port = server.address().port
  const streams = [await eventStream(port), await eventStream(port)]
  const ended = streams.map(
    (stream) =>
      new Promise((resolve) => {
        stream.response.on('end', resolve)
        stream.response.on('close', resolve)
      }),
  )
  const started = Date.now()
  stopChildren(app)
  await Promise.race([
    Promise.all([new Promise((resolve) => server.close(resolve)), ...ended]),
    wait(2000).then(() => assert.fail('the server stayed open behind its events streams')),
  ])
  assert.ok(Date.now() - started < 2000)
  // A stream asked for after close is refused, not held open.
  const late = createApp({
    config,
    clientDir: tempDir('events-close-client-2'),
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: home.dir },
    settingsToken: TOKEN,
  })
  stopChildren(late)
  const lateServer = await listen(late)
  try {
    const answer = await request(lateServer.address().port, 'GET', '/api/agent/events')
    assert.equal(answer.status, 503)
  } finally {
    await new Promise((resolve) => lateServer.close(resolve))
  }
})

test('events: the agent process pool says when an agent starts and when it is gone', async () => {
  const calls = []
  const processPool = { epoch: 0, agents: new Set(), max: 2, changed: () => calls.push([...processPool.agents].map((item) => item.state)) }
  const result = await acpHandshake(
    { label: 'Stub', acp: { argv: [process.execPath, STUB_ACP] } },
    { root: tempDir('events-pool'), processPool },
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(calls[0], ['starting'], 'told when it starts')
  assert.deepEqual(calls.at(-1), [], 'and when it is gone')
  assert.equal(processPool.agents.size, 0)
})
