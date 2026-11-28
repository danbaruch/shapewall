// The 2.0 final security review (Areas A and C): regression tests for what is not team-listener routing
// (that is in test/hosted-solo-team.test.js). No real tailnet: the `tailscale` command, its serve proxy and its
// proof are the fakes of test/tailnet-helpers.js. No real agents.
//
//   A-3/C-3  an engine started for one command never turns team mode on, and never runs tailscale
//   A-7      `serve --team` against a running engine proves it first, and cleans what it prints
//   C-2      the engine's own agent takes work from its owner only, unless the owner saves otherwise
//   C-4      the agent's Read deny rules name both spellings of a linked Shapewall folder

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadConfig } from '../src/config.js'
import { engineDir } from '../src/engine-folder.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startEngineHeadless } from '../src/hosted/ops-cli.js'
import { startHosted } from '../src/hosted/server.js'
import { OPEN_KEY_FILE } from '../src/hosted/solo/signin.js'
import { serveEngine } from '../src/hosted/solo/serve.js'
import { readTeamSetting, writeTeamSetting } from '../src/hosted/solo/team.js'
import { createSandbox } from '../src/agent/acp/sandbox.js'
import { sessionSettings } from '../src/agent/backends/acp.js'
import { localAgentDefaults } from '../src/remote/agent-connect.js'
import { SAMPLE, tempDir } from './helpers.js'
import { fakeTailscale, plainFacts } from './tailnet-helpers.js'

quietSqliteWarning()

const stops = []
after(async () => {
  for (const stop of stops.reverse()) await stop()
})

function projectConfig(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes' }, null, 2))
  return loadConfig(file)
}

const fakeTeam = (fake) => ({ run: fake.run, proof: { trusted: () => false, problem: () => null }, facts: () => plainFacts(), watchMs: 0 })

test('A-3/C-3: an engine started for a command leaves team mode off and runs no tailscale, whatever team.json says', async () => {
  const config = projectConfig('sec-headless')
  const data = engineDir(config.outputDir)
  fs.mkdirSync(data, { recursive: true, mode: 0o700 })
  // The owner ran serve --team once, then stopped serve.
  writeTeamSetting(data, { on: true })
  const fake = fakeTailscale()
  const handle = await startEngineHeadless(config, { env: { ...process.env }, team: fakeTeam(fake) })
  stops.push(() => handle.stop())
  const team = handle.app.locals.soloTeam
  assert.equal(team.status().on, false)
  assert.deepEqual(fake.state.calls, [], 'no tailscale command at all')
  // Asked to turn on (serve --team against it, or the console): refused, with why.
  await assert.rejects(team.start(), /started for one command/)
  assert.deepEqual(fake.state.calls, [])
  await handle.stop()
  stops.pop()
  // The owner's setting is as it was, for the next shapewall serve.
  assert.equal(readTeamSetting(data).on, true)
  assert.deepEqual(fake.state.calls, [])
})

// The engine as `serve` starts it, in this process (its lock and serve.json are this process's).
async function serveHere(name) {
  const config = projectConfig(name)
  const fake = fakeTailscale()
  const lines = []
  const handle = await serveEngine(
    { engine: 'hosted', config: config.file, port: 0, 'no-chat': true, 'skip-git-check': true },
    (line) => lines.push(line),
    {
      env: { ...process.env },
      start: (options) => startHosted({ ...options, exitOnStop: false }),
      team: fakeTeam(fake),
    },
  )
  stops.push(() => handle.stop())
  return { config, handle, fake, dir: engineDir(config.outputDir), lines }
}

// Something else on a port, as another user's program could be: it records what it is sent.
async function impostor(answer) {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers })
      answer(req, res, body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  stops.push(() => new Promise((resolve) => server.close(resolve)))
  return { port: server.address().port, seen }
}

// serve.json, as if this engine had been started on `port` (a stale file after a crash, another user on the port).
function pointServeJson(dir, port) {
  const file = path.join(dir, 'serve.json')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const origin = new URL(state.origin)
  origin.port = String(port)
  fs.writeFileSync(file, JSON.stringify({ ...state, port, origin: origin.origin }), { mode: 0o600 })
  return state
}

test('A-7: serve --team and serve --open against a running engine send its key only after the engine proves itself', async () => {
  const engine = await serveHere('sec-a7-proof')
  const other = await impostor((req, res) =>
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"proof":"nope","on":false,"lines":[]}'),
  )
  pointServeJson(engine.dir, other.port)
  const out = []
  const flags = { engine: 'hosted', config: engine.config.file, 'skip-git-check': true }
  await assert.rejects(
    serveEngine({ ...flags, team: 'off' }, (line) => out.push(line)),
    /No running solo engine/,
  )
  await assert.rejects(
    serveEngine({ ...flags, open: true }, (line) => out.push(line)),
    /No running solo engine/,
  )
  const key = fs.readFileSync(path.join(engine.dir, OPEN_KEY_FILE), 'utf8').trim()
  assert.ok(other.seen.length >= 2, 'it was asked for the proof')
  for (const request of other.seen) {
    assert.equal(request.url, '/solo/whoami')
    assert.equal(request.headers['x-shapewall-solo-key'], undefined)
    assert.ok(!JSON.stringify(request.headers).includes(key))
  }
})

test('A-7: what a running engine answers to serve --team is cleaned before it is printed', async () => {
  const engine = await serveHere('sec-a7-print')
  const real = new URL(engine.handle.origin)
  // In front of the real engine: the proof is the engine's own, the answer to the switch is not.
  const front = await impostor((req, res, body) => {
    if (req.url !== '/solo/whoami')
      return res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ on: false, lines: ['Team mode: off\u001b[2J\u001b]0;owned\u0007', 'second\u202eline'] }))
    const upstream = http.request(
      { host: '127.0.0.1', port: Number(real.port), method: 'POST', path: req.url, headers: { ...req.headers, host: real.host } },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.end(body)
  })
  pointServeJson(engine.dir, front.port)
  const out = []
  await serveEngine({ engine: 'hosted', config: engine.config.file, 'skip-git-check': true, team: 'off' }, (line) => out.push(line))
  assert.ok(out.length >= 2, out.join('\n'))
  // eslint-disable-next-line no-control-regex
  for (const line of out) assert.doesNotMatch(line, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/)
  assert.match(out[0], /^Team mode: off/)
})

test('C-2: the engine’s own agent takes work from its owner only unless the owner saved otherwise', () => {
  const config = projectConfig('sec-c2-defaults')
  assert.deepEqual(localAgentDefaults(config, {}), { audience: 'owner' })
})

test('C-4: the Read deny rules name a linked .shapewall both as the project spells it and as it really is', () => {
  const root = tempDir('sec-c4-project')
  // The store sits in another folder of the project, linked in as .shapewall.
  const elsewhere = path.join(root, 'data')
  fs.mkdirSync(path.join(elsewhere, 'store', '.engine'), { recursive: true })
  fs.writeFileSync(path.join(elsewhere, 'store', '.engine', 'agent.token'), 'x')
  fs.symlinkSync(path.join(elsewhere, 'store'), path.join(root, '.shapewall'))
  const sandbox = createSandbox({ root, protect: [path.join(root, '.shapewall')] })
  const spelled = path.join(root, '.shapewall')
  const real = fs.realpathSync(path.join(elsewhere, 'store'))
  assert.ok(sandbox.denyRead.includes(spelled), sandbox.denyRead.join(', '))
  assert.ok(sandbox.denyRead.includes(real), sandbox.denyRead.join(', '))
  const deny = sessionSettings(sandbox.denyRead).permissions.deny
  const rule = (dir) => `Read(/${dir.split(path.sep).join('/')}/**)`
  assert.ok(deny.includes(rule(spelled)), deny.join(', '))
  assert.ok(deny.includes(rule(real)), deny.join(', '))
  // The sandbox's own check still refuses the file by either spelling.
  assert.throws(() => sandbox.resolve(path.join(spelled, '.engine', 'agent.token')), /Shapewall's own data/)
  assert.throws(() => sandbox.resolve(path.join(real, '.engine', 'agent.token')), /Shapewall's own data/)
})
