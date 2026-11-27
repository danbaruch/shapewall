// `shapewall serve --engine hosted` (src/hosted/solo/serve.js) and the solo
// parts of startHosted (src/hosted/server.js): what it refuses (exposure,
// a tracked data folder, a migration in progress, a team folder), the data
// folder's name, a second --open against the running engine, and a stop
// that never cuts an update apply short (review of PR #53, F2), with the
// real force-exit timer armed.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { ENGINE_DIR, MIGRATED, MIGRATING, assertMigrationAllows, engineDir, prepareEngineFolder } from '../src/engine-folder.js'
import { processStartTime } from '../src/lock.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startHosted } from '../src/hosted/server.js'
import { soloFlagGate } from '../src/hosted/solo/flags.js'
import { engineFlagProblem, serveEngine } from '../src/hosted/solo/serve.js'
import { SAMPLE, request, tempDir } from './helpers.js'
import { signUp, startHostedServer } from './hosted-helpers.js'

quietSqliteWarning()

const ENV = { SHAPEWALL_USER_NAME: 'Robin Tester', PATH: process.env.PATH }

function project(name) {
  const dir = tempDir(name)
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes' }, null, 2))
  return { dir, file: path.join(dir, 'shapewall.config.json'), config: loadConfig(path.join(dir, 'shapewall.config.json')) }
}

const quiet = () => {
  const lines = []
  const out = (line) => lines.push(String(line))
  return { lines, out }
}
const noExit = (options) => startHosted({ ...options, exitOnStop: false })

test('the data folder is .shapewall/.engine: a name no board id can have', () => {
  assert.equal(ENGINE_DIR, '.engine')
  assert.equal(engineDir('/p/.shapewall'), path.join('/p/.shapewall', '.engine'))
  assert.doesNotMatch(ENGINE_DIR, /^[a-z0-9][a-z0-9-]{0,63}$/)
})

test('exposure flags and local-only flags are refused with a reason (G12, G20)', () => {
  assert.match(engineFlagProblem({ engine: 'local' }), /"hosted" \(experimental\) is the only engine/)
  for (const flag of ['host', 'lan', 'tailscale', 'tls-cert', 'allowed-host', 'accounts', 'agent-acp', 'trust-proxy', 'no-identity']) {
    assert.match(engineFlagProblem({ engine: 'hosted', [flag]: true }), new RegExp(`--${flag} is not for --engine hosted`), flag)
  }
  for (const flag of ['port', 'open', 'read-only', 'no-chat', 'no-capture', 'print-owner-link', 'chat', 'config'])
    assert.equal(engineFlagProblem({ engine: 'hosted', [flag]: true }), null, flag)
})

test('startHosted refuses a solo engine with any exposure, and a solo folder as a team server', async () => {
  const { config } = project('solo-serve-exposure')
  const solo = { signIn: 'local', config, configPath: config.file }
  const dataDir = tempDir('solo-serve-exposure-data')
  for (const [options, pattern] of [
    [{ host: '0.0.0.0' }, /a non-loopback --host is refused/],
    [{ trustProxy: true }, /--trust-proxy is refused/],
    [{ signup: 'open' }, /--signup open is refused/],
    [{ tailscale: { httpsPort: 443 } }, /--tailscale is refused/],
  ])
    await assert.rejects(noExit({ dataDir, port: 0, out: () => {}, solo, ...options }), pattern)
  await assert.rejects(noExit({ dataDir, port: 0, out: () => {}, solo: { config } }), /solo\.signIn: local/)

  // Started once as the owner's engine: the folder is a solo folder from then on.
  const solo1 = await noExit({ dataDir, port: 0, out: () => {}, solo, origin: (port) => `http://lumen.shapewall.localhost:${port}` })
  await solo1.stop()
  await assert.rejects(noExit({ dataDir, port: 0, out: () => {} }), /is a solo engine's folder/)
})

test('a team folder is refused as a solo engine folder', async () => {
  const team = await startHostedServer('solo-serve-team')
  await signUp(team, { handle: 'ada' })
  await team.close()
  const { config } = project('solo-serve-team-project')
  await assert.rejects(
    noExit({
      dataDir: team.dataDir,
      port: 0,
      out: () => {},
      solo: { signIn: 'local', config, configPath: config.file },
      origin: (port) => `http://lumen.shapewall.localhost:${port}`,
    }),
    /holds accounts but is not a solo engine folder/,
  )
})

test('stop() waits for an update apply in flight with the real force timer armed, then exits with the code asked for', async () => {
  const { config } = project('solo-serve-stop')
  const exits = []
  const handle = await startHosted({
    dataDir: tempDir('solo-serve-stop-data'),
    port: 0,
    out: () => {},
    exitOnStop: true,
    exit: (code) => exits.push(code),
    forceExitMs: 50,
    solo: { signIn: 'local', config, configPath: config.file },
    origin: (port) => `http://lumen.shapewall.localhost:${port}`,
  })
  // An apply in flight, as the solo self-update router reports it (src/update/routes.js lifecycle).
  let finish
  const settled = new Promise((resolve) => (finish = resolve))
  let applying = true
  let stopped = 0
  handle.app.locals.appUpdate = {
    applying: () => applying,
    settled: () => settled,
    stop: () => {
      stopped += 1
    },
  }
  const stopping = handle.stop(75)
  // Well past the force timeout: still nothing exited, nothing closed.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(exits, [], 'never exits while the apply runs')
  assert.equal(stopped, 1, 'no new apply starts once stopping')
  assert.equal(handle.server.listening, true)
  applying = false
  finish()
  await stopping
  assert.deepEqual(exits, [75], 'the restart code, once, after the apply settled')
  assert.equal(handle.server.listening, false)
})

test('serve --engine hosted: refuses a data folder git tracks, and a migration running or stopped midway', async () => {
  const { dir, config } = project('solo-serve-git')
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  fs.mkdirSync(path.join(config.outputDir, ENGINE_DIR), { recursive: true })
  fs.writeFileSync(path.join(config.outputDir, ENGINE_DIR, 'shapewall.db'), 'x')
  git('add', '-f', '.')
  assert.throws(() => prepareEngineFolder(config), /git tracks files in/)
  await assert.rejects(
    serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit }),
    /git tracks files/,
  )
  git('rm', '-q', '-r', '--cached', '.')
  const folder = prepareEngineFolder(config)
  assert.equal(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').trim().split('\n').pop(), '*')
  if (process.platform !== 'win32') assert.equal(fs.statSync(folder).mode & 0o777, 0o700)

  fs.writeFileSync(path.join(config.outputDir, MIGRATING), '{}')
  await assert.rejects(
    serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit }),
    /stopped midway/,
  )
  fs.rmSync(path.join(config.outputDir, MIGRATING))
  fs.writeFileSync(path.join(config.outputDir, 'migrate.lock'), JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) }))
  assert.throws(() => assertMigrationAllows(config), /shapewall migrate is running/)
  fs.rmSync(path.join(config.outputDir, 'migrate.lock'))
  // A board the migration moved: the local server and watch refuse it, the engine does not.
  fs.writeFileSync(path.join(config.outputDir, MIGRATED), JSON.stringify({ version: 1, runs: [{ boards: { sample: {} } }] }))
  assert.throws(() => assertMigrationAllows(config, { local: true }), /Board sample was migrated to the solo engine/)
  assert.deepEqual([...assertMigrationAllows(config)], ['sample'])
})

test('serve --engine hosted: starts on the project’s own host, prints no link off a terminal, and a second --open asks the running engine', async () => {
  const { config } = project('solo-serve-run')
  const first = quiet()
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, first.out, { env: ENV, start: noExit })
  try {
    assert.match(handle.origin, /^http:\/\/lumen-notes\.shapewall\.localhost:\d+$/)
    assert.ok(first.lines.some((line) => line.startsWith('Shapewall solo engine (experimental) is serving 1 board at http://lumen-notes')))
    assert.ok(first.lines.some((line) => /Sign in: run shapewall serve --engine hosted --open/.test(line)))
    assert.equal(
      first.lines.some((line) => line.includes('/open/')),
      false,
      'no sign-in link in output that is not a terminal',
    )
    assert.ok(fs.existsSync(path.join(engineDir(config.outputDir), 'shapewall.db')))
    // Without --open, a second start says where the engine runs.
    await assert.rejects(
      serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit }),
      /already runs for this project/,
    )
    // With --print-owner-link: a fresh link from the running engine, and it signs a browser in there.
    const second = quiet()
    assert.equal(await serveEngine({ engine: 'hosted', config: config.file, 'print-owner-link': true }, second.out, { env: ENV }), null)
    const line = second.lines.find((item) => item.startsWith('Sign in'))
    const link = new URL(/(http:\/\/\S+)/.exec(line)[1])
    const redeemed = await request(Number(link.port), 'GET', link.pathname, { headers: { Host: link.host } })
    assert.equal(redeemed.status, 303)
    assert.match(String(redeemed.headers['set-cookie']), /^sw_session=/)
  } finally {
    await handle.stop()
  }
})

test('SHAPEWALL_UPDATE_RESTART=1: a finished update apply stops the engine with the restart code (PR #53 review, F3)', async () => {
  const { config } = project('solo-serve-restart')
  const calls = []
  let options
  const start = async (given) => {
    options = given
    const handle = await noExit(given)
    const stop = handle.stop
    return {
      ...handle,
      stop: (code) => {
        calls.push(code)
        return stop()
      },
    }
  }
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, {
    env: { ...ENV, SHAPEWALL_UPDATE_RESTART: '1' },
    start,
  })
  assert.equal(typeof options.solo.appUpdate.onRestart, 'function')
  await options.solo.appUpdate.onRestart()
  assert.deepEqual(calls, [75])
  assert.equal(handle.server.listening, false)

  // Without the opt-in there is no restart hook: the installer restarts nothing.
  const other = project('solo-serve-norestart')
  let plain
  const again = await serveEngine({ engine: 'hosted', config: other.config.file, port: 0 }, () => {}, {
    env: ENV,
    start: async (given) => {
      plain = given
      return noExit(given)
    },
  })
  assert.equal(plain.solo.appUpdate.onRestart, undefined)
  await again.stop()
})

test('--read-only and --no-chat: the board API refuses writes and chat, the command line is untouched (G20)', () => {
  const run = (gate, method, url) => {
    const result = { next: false, status: 200, body: null }
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code
        result.status = code
        return this
      },
      json(body) {
        result.body = body
        return this
      },
    }
    gate({ method, path: url }, res, () => (result.next = true))
    result.res = res
    return result
  }
  assert.equal(soloFlagGate({}), null)
  const readOnly = soloFlagGate({ readOnly: true })
  assert.equal(run(readOnly, 'POST', '/w/ws1/p/p1/api/boards/sample/comments').body.error.code, 'read_only')
  assert.equal(run(readOnly, 'GET', '/w/ws1/p/p1/api/boards/sample/comments').next, true)
  assert.equal(run(readOnly, 'POST', '/api/v1/boards/sample/comments').next, true, 'the token API (CLI, agents) still writes')
  const info = run(readOnly, 'GET', '/w/ws1/p/p1/api/info')
  info.res.json({ title: 'x' })
  assert.deepEqual(info.body, { title: 'x', readOnly: true })
  const noChat = soloFlagGate({ chat: false })
  assert.equal(run(noChat, 'POST', '/w/ws1/p/p1/api/boards/sample/threads').body.error.code, 'chat_off')
  assert.equal(run(noChat, 'GET', '/w/ws1/p/p1/api/boards/sample/permissions/abc').body.error.code, 'chat_off')
  assert.equal(run(noChat, 'POST', '/w/ws1/p/p1/api/boards/sample/comments').next, true)
})
