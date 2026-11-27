// `shapewall serve --engine hosted` (src/hosted/solo/serve.js) and the solo
// parts of startHosted (src/hosted/server.js): what it refuses (exposure,
// a tracked data folder, a migration in progress, a team folder), the data
// folder's name, a second --open against the running engine, and a stop
// that never cuts an update apply short (review of PR #53, F2), with the
// real force-exit timer armed.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { ENGINE_DIR, MIGRATED, MIGRATING, assertMigrationAllows, engineDir, prepareEngineFolder } from '../src/engine-folder.js'
import { processStartTime } from '../src/lock.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startHosted } from '../src/hosted/server.js'
import { soloFlagGate } from '../src/hosted/solo/flags.js'
import { removeStaleAnswerFolders } from '../src/update/routes.js'
import { engineFlagProblem, serveEngine } from '../src/hosted/solo/serve.js'
import { SAMPLE, isolatedEnv, request, tempDir } from './helpers.js'
import { signUp, startHostedServer } from './hosted-helpers.js'

quietSqliteWarning()

const ENV = isolatedEnv('solo-env', { SHAPEWALL_USER_NAME: 'Robin Tester' })

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

// The nonce a sign-in page holds, and what its form sends.
const nonceOf = (file) => /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
const redeem = (origin, nonce) => {
  const url = new URL(origin)
  return request(Number(url.port), 'POST', '/open', {
    body: `nonce=${nonce}`,
    headers: { Host: url.host, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
}
// An opener that records what it was started with, as another user reading /proc/<pid>/cmdline would see it.
const recordingOpener = () => {
  const argv = []
  const spawnImpl = (command, args) => {
    argv.push([command, ...args].join(' '))
    return { once() {}, unref() {} }
  }
  return { argv, spawnImpl }
}

test('serve --engine hosted: its own random host, no sign-in off a terminal; --open puts no nonce on any command line or output (rev54 F2)', async () => {
  const { config } = project('solo-serve-run')
  const first = quiet()
  const opener = recordingOpener()
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, first.out, { env: ENV, start: noExit })
  try {
    const dir = engineDir(config.outputDir)
    const suffix = fs.readFileSync(path.join(dir, 'host.key'), 'utf8').trim()
    assert.equal(handle.origin, `http://lumen-notes-${suffix}.shapewall.localhost:${handle.server.address().port}`)
    assert.ok(
      first.lines.some((line) =>
        line.startsWith(`Shapewall solo engine (experimental) is serving 1 board at http://lumen-notes-${suffix}`),
      ),
    )
    assert.ok(first.lines.some((line) => /Sign in: run shapewall serve --engine hosted --open/.test(line)))
    // rev54 N3: the agent line gives the address in the environment, never as an argument other users can read.
    assert.ok(first.lines.includes(`Agents: SHAPEWALL_REMOTE=${handle.origin} shapewall agent connect`), first.lines.join('\n'))
    assert.equal(
      first.lines.some((line) => /--remote/.test(line)),
      false,
    )
    assert.equal(
      fs.readdirSync(dir).some((name) => name.startsWith('open-')),
      false,
      'no sign-in page for output that is not a terminal',
    )
    assert.ok(fs.existsSync(path.join(dir, 'shapewall.db')))
    // Without --open, a second start says where the engine runs.
    await assert.rejects(
      serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit }),
      /already runs for this project/,
    )
    // --open against the running engine: the browser is started on a 0600 file in the data folder; the nonce is
    // in that file only.
    const second = quiet()
    assert.equal(
      await serveEngine({ engine: 'hosted', config: config.file, open: true }, second.out, { env: ENV, spawnImpl: opener.spawnImpl }),
      null,
    )
    assert.equal(opener.argv.length, 1)
    const opened = /(file:\/\/\S+)/.exec(opener.argv[0])[1]
    const file = fileURLToPath(opened)
    assert.equal(path.dirname(file), dir)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const nonce = nonceOf(file)
    for (const text of [...opener.argv, ...first.lines, ...second.lines]) assert.equal(text.includes(nonce), false, `nonce in: ${text}`)
    const redeemed = await redeem(handle.origin, nonce)
    assert.equal(redeemed.status, 200)
    assert.match(String(redeemed.headers['set-cookie']), /^sw_session=[^;]+;.*SameSite=Strict/)
    assert.equal(fs.existsSync(file), false, 'used: removed')
    // --print-owner-link prints the page's path, not the nonce.
    const third = quiet()
    await serveEngine({ engine: 'hosted', config: config.file, 'print-owner-link': true }, third.out, { env: ENV })
    const printed = fileURLToPath(/(file:\/\/\S+)/.exec(third.lines.find((line) => line.startsWith('Sign in')))[1])
    assert.equal(
      third.lines.some((line) => line.includes(nonceOf(printed))),
      false,
    )
    assert.equal((await redeem(handle.origin, nonceOf(printed))).status, 200)
  } finally {
    await handle.stop()
  }
  // Stopped: no sign-in page is left behind.
  assert.equal(
    fs.readdirSync(engineDir(config.outputDir)).some((name) => name.startsWith('open-')),
    false,
  )
})

test('first start with --open: the opener gets the page’s path, never the nonce (rev54 F2)', async () => {
  const { config } = project('solo-serve-open-first')
  const opener = recordingOpener()
  const lines = quiet()
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0, open: true }, lines.out, {
    env: ENV,
    start: noExit,
    spawnImpl: opener.spawnImpl,
  })
  try {
    const file = fileURLToPath(/(file:\/\/\S+)/.exec(opener.argv[0])[1])
    const nonce = nonceOf(file)
    for (const text of [...opener.argv, ...lines.lines]) assert.equal(text.includes(nonce), false)
  } finally {
    await handle.stop()
  }
})

test('the git check fails closed and sees nested repositories, an outside repository and submodules (rev54 F4)', () => {
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'protocol.file.allow=always', ...args], {
      cwd,
      stdio: 'ignore',
    })
  const tracked = (out) => {
    fs.mkdirSync(path.join(out, ENGINE_DIR), { recursive: true })
    fs.writeFileSync(path.join(out, ENGINE_DIR, 'secret.key'), 'x')
  }
  const configAt = (dir, outputDir) => ({ dir, outputDir })
  // (a) The output folder is a repository of its own, nested in the project's.
  const a = tempDir('solo-serve-git-nested')
  git(a, 'init', '-q')
  const aOut = path.join(a, '.shapewall')
  fs.mkdirSync(aOut)
  git(aOut, 'init', '-q')
  tracked(aOut)
  git(aOut, 'add', '-f', '.')
  assert.throws(() => prepareEngineFolder(configAt(a, aOut)), /git tracks files in/)
  // (b) The output folder sits in another repository, outside the project.
  const project = tempDir('solo-serve-git-outside-project')
  const other = tempDir('solo-serve-git-outside-repo')
  git(other, 'init', '-q')
  const bOut = path.join(other, 'out')
  tracked(bOut)
  git(other, 'add', '-f', '.')
  assert.throws(() => prepareEngineFolder(configAt(project, bOut)), /git tracks files in/)
  // (c) The output folder is a submodule that tracks it.
  const sub = tempDir('solo-serve-git-sub-origin')
  git(sub, 'init', '-q')
  tracked(sub)
  git(sub, 'add', '-f', '.')
  git(sub, 'commit', '-q', '-m', 'x')
  const c = tempDir('solo-serve-git-super')
  git(c, 'init', '-q')
  git(c, 'submodule', 'add', '-q', sub, 'out')
  assert.throws(() => prepareEngineFolder(configAt(c, path.join(c, 'out'))), /git tracks files in/)
  // A repository git cannot answer for: refused, with the override named; the override starts.
  const d = tempDir('solo-serve-git-broken')
  git(d, 'init', '-q')
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'garbage\n')
  const dOut = path.join(d, '.shapewall')
  assert.throws(() => prepareEngineFolder(configAt(d, dOut)), /could not check whether git tracks.*--skip-git-check/)
  assert.equal(prepareEngineFolder(configAt(d, dOut), { skipGitCheck: true }), path.join(dOut, ENGINE_DIR))
  // No repository at all: nothing to check.
  const e = tempDir('solo-serve-git-none')
  assert.equal(prepareEngineFolder(configAt(e, path.join(e, '.shapewall'))), path.join(e, '.shapewall', ENGINE_DIR))
})

test('a stray .git above the project that git does not see is no repository; other git errors still refuse (rev54 N4)', () => {
  // Outside this checkout, so git has no real repository to fall through to.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-n4-'))
  try {
    fs.mkdirSync(path.join(root, '.git'))
    const project = path.join(root, 'code', 'my-app')
    fs.mkdirSync(project, { recursive: true })
    const out = path.join(project, '.shapewall')
    assert.equal(prepareEngineFolder({ dir: project, outputDir: out }), path.join(out, ENGINE_DIR))
    // git missing, while a .git is above: still refused, with the override named.
    assert.throws(
      () => prepareEngineFolder({ dir: project, outputDir: out }, { git: path.join(root, 'no-such-git') }),
      /could not check whether git tracks.*git is not installed.*--skip-git-check/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
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

test('with the real self-update router: Ctrl+C during an apply waits past the force timer, then exits 75 for the restart (rev54 F6)', async () => {
  const { config } = project('solo-serve-f6')
  const helperDir = tempDir('solo-serve-f6-helper')
  const helper = path.join(helperDir, 'update')
  const answer = (extra) => JSON.stringify({ latest: { version: '9.9.9', revision: 'abcdef1234567' }, updateAvailable: true, ...extra })
  fs.writeFileSync(
    helper,
    `#!${process.execPath}\nif (process.argv[2] === 'apply') await new Promise((resolve) => setTimeout(resolve, 600))\nconsole.log(${JSON.stringify(answer({ restartRequired: true }))})\n`,
    { mode: 0o700 },
  )
  const exits = []
  const start = (options) => startHosted({ ...options, exitOnStop: true, exit: (code) => exits.push(code), forceExitMs: 50 })
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0, 'print-owner-link': true }, () => {}, {
    env: { ...ENV, SHAPEWALL_UPDATE_RESTART: '1', SHAPEWALL_UPDATE_HELPER: helper },
    start,
  })
  // The engine's own lifecycle, from src/update/routes.js, not a stand-in.
  const lifecycle = handle.app.locals.appUpdate
  assert.equal(typeof lifecycle?.applying, 'function')
  assert.equal(typeof lifecycle.restartPending, 'function')

  const page = fs.readdirSync(engineDir(config.outputDir)).find((name) => name.startsWith('open-'))
  const signedIn = await redeem(handle.origin, nonceOf(path.join(engineDir(config.outputDir), page)))
  const cookie = String([].concat(signedIn.headers['set-cookie'])[0]).split(';')[0]
  const { owner } = handle.app.locals.solo
  const url = new URL(handle.origin)
  const call = (method, pathname) =>
    request(Number(url.port), method, `/w/${owner.workspaceId}/p/${owner.projectId}/api/app-update${pathname}`, {
      body: method === 'POST' ? {} : undefined,
      headers: { Host: url.host, Cookie: cookie, ...(method === 'POST' ? { Origin: handle.origin } : {}) },
    })
  assert.equal((await call('GET', '')).json.canUpdate, true, 'the signed-in owner on this machine may update')
  assert.equal((await call('POST', '/check')).status, 202)
  for (let i = 0; i < 300 && (await call('GET', '')).json.job?.state === 'running'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal((await call('POST', '/apply')).status, 202)
  assert.equal(lifecycle.applying(), true)

  // Ctrl+C now: well past the 50 ms force timer, nothing exits while the helper runs.
  const stopping = handle.stop(0)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(exits, [], 'no exit during the apply')
  assert.equal(handle.server.listening, true)
  await stopping
  assert.deepEqual(exits, [75], 'a finished apply that needs a restart exits 75, even from Ctrl+C')
  assert.equal(lifecycle.restartPending(), true)
  // onRestart (its own timer) finds the stop under way: no second exit.
  await new Promise((resolve) => setTimeout(resolve, 1700))
  assert.deepEqual(exits, [75])
})

test('operator commands refuse a solo engine’s folder (a second account would lock the owner out)', async () => {
  const { config } = project('solo-serve-ops')
  const dataDir = tempDir('solo-serve-ops-data')
  const handle = await noExit({
    dataDir,
    port: 0,
    out: () => {},
    solo: { signIn: 'local', config, configPath: config.file },
    origin: (port) => `http://lumen-abcdefghijklmn.shapewall.localhost:${port}`,
  })
  await handle.stop()
  const { hostedCommand } = await import('../src/hosted/ops-cli.js')
  for (const args of [['admin', 'list'], ['claim'], ['setup-link']])
    await assert.rejects(
      hostedCommand(args, { data: dataDir, login: 'someone@example.com' }, () => {}),
      /a solo engine's folder/,
      args.join(' '),
    )
  // A team server's folder is unaffected.
  const team = await startHostedServer('solo-serve-ops-team')
  await signUp(team, { handle: 'ada' })
  await team.close()
  assert.equal(await hostedCommand(['admin', 'list'], { data: team.dataDir }, () => {}), 0)
})

test('update answers: stale folders of this user are removed after a day; nothing else is touched (#53 RR1-L2)', () => {
  const tmp = tempDir('solo-serve-update-tmp')
  const now = Date.now()
  const make = (name, ageMs) => {
    const dir = path.join(tmp, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'answer'), 'x')
    const when = new Date(now - ageMs)
    fs.utimesSync(dir, when, when)
    return dir
  }
  const stale = make('shapewall-update-old', 2 * 86_400_000)
  const fresh = make('shapewall-update-new', 60_000)
  const other = make('something-else', 3 * 86_400_000)
  const target = make('shapewall-update-target', 3 * 86_400_000)
  fs.symlinkSync(target, path.join(tmp, 'shapewall-update-link'))
  const linkTime = new Date(now - 3 * 86_400_000)
  fs.lutimesSync(path.join(tmp, 'shapewall-update-link'), linkTime, linkTime)
  assert.equal(removeStaleAnswerFolders({ tmp, now }), 2)
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(target), false, 'a stale folder of its own')
  assert.equal(fs.existsSync(fresh), true, 'an apply may still be using it')
  assert.equal(fs.existsSync(other), true)
  assert.equal(fs.lstatSync(path.join(tmp, 'shapewall-update-link')).isSymbolicLink(), true, 'a link is never followed or removed')
  // Another user's folder is left alone.
  const mine = make('shapewall-update-theirs', 2 * 86_400_000)
  assert.equal(removeStaleAnswerFolders({ tmp, now, uid: (process.getuid?.() ?? 0) + 1 }), 0)
  assert.equal(fs.existsSync(mine), true)
})
