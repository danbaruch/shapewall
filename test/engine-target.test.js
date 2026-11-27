// Commands in a project folder whose solo engine runs (gap G15): comments,
// watch and mcp go to the engine with the token it made for this command
// line (src/engine-target.js, src/cli/engine-mode.js,
// src/hosted/solo/machine-tokens.js), never silently to the 1.x JSON files.
// The token files are 0600, rotated at each start, retired at stop.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { MIGRATED, engineDir } from '../src/engine-folder.js'
import { EngineTargetError, NO_ENGINE_VAR, engineTarget, readPrivateFile, verifyEngine } from '../src/engine-target.js'
import { engineMode } from '../src/cli/engine-mode.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { startHosted } from '../src/hosted/server.js'
import { serveEngine } from '../src/hosted/solo/serve.js'
import { createComment } from '../src/store.js'
import { SAMPLE, tempDir } from './helpers.js'
import { createBrowser } from './hosted-helpers.js'

quietSqliteWarning()

const ENV = { SHAPEWALL_USER_NAME: 'Robin Tester', PATH: process.env.PATH }
const noExit = (options) => startHosted({ ...options, exitOnStop: false })

function project(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Lumen Notes' }, null, 2))
  return loadConfig(file)
}

// The owner signs a browser in by the terminal's one-time page and comments on the board (a person's comment:
// one an agent may take, where a token's own comment never starts an agent).
async function ownerComment(handle, body) {
  const file = handle.app.locals.soloOpenFile()
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{32})"/.exec(fs.readFileSync(file, 'utf8'))[1]
  const browser = createBrowser(handle.server.address().port, handle.origin)
  const opened = await browser.post('/open', 'nonce=' + nonce, {
    sendOrigin: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  })
  assert.equal(opened.status, 200, opened.text)
  const { workspaceId, projectId } = handle.app.locals.solo.owner
  const made = await browser.post('/w/' + workspaceId + '/p/' + projectId + '/api/boards/sample/comments', {
    pageId: 'home',
    viewport: 'desktop',
    x: 10,
    y: 10,
    body,
  })
  assert.equal(made.status, 201, made.text)
  return made.json.comment.id
}

// GET on the engine's port under its own name (the token API answers nothing else, rev57 R57-2) -> status.
function engineGet(origin, pathname, token) {
  const url = new URL(origin)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: url.port, path: pathname, headers: { Host: url.host, Authorization: `Bearer ${token}` }, agent: false },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// main() as the command line runs it, with what it printed.
async function cli(argv) {
  const lines = []
  const errs = []
  const code = await main(argv, { out: (line) => lines.push(String(line)), err: (line) => errs.push(String(line)) })
  return { code, out: lines.join('\n'), err: errs.join('\n') }
}

test('in the folder of a running engine, comments go to the engine; the JSON files are not read', async (t) => {
  const config = project('engine-target-run')
  // A comment in the 1.x JSON files: what `comments list` showed before G15, although the board is the engine's.
  await createComment(config, config.boards[0], {
    pageId: 'home',
    viewport: 'desktop',
    x: 0.1,
    y: 0.1,
    body: 'Old JSON comment',
    author: 'Robin',
  })
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  t.after(() => handle.stop())
  const dir = engineDir(config.outputDir)

  // serve.json names the URL and the token files; the tokens are 0600 and never in it.
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'serve.json'), 'utf8'))
  assert.equal(state.origin, handle.origin)
  assert.deepEqual(state.tokens, { cli: 'cli.token', watch: 'watch.token' })
  assert.doesNotMatch(JSON.stringify(state), /swp_/)
  for (const name of ['cli.token', 'watch.token', 'serve.json'])
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600, name)

  const target = engineTarget(config)
  assert.equal(target.origin, handle.origin)
  assert.match(target.token, /^swp_/)
  assert.notEqual(engineTarget(config, { which: 'watch' }).token, target.token)

  const added = await cli(['comments', 'add', '--config', config.file, '--page', 'home', '--body', 'Tighten the header', '--json'])
  assert.equal(added.code, 0, added.err)
  const id = JSON.parse(added.out).comment.id
  const listed = await cli(['comments', 'list', '--config', config.file, '--json'])
  const report = JSON.parse(listed.out)
  assert.deepEqual(
    report.comments.map((item) => item.body),
    ['Tighten the header'],
    "the engine's comments, not the JSON file's",
  )
  const text = await cli(['comments', 'list', '--config', config.file])
  assert.match(text.err, /^Solo engine: http:\/\/lumen-notes-/)
  assert.doesNotMatch(text.out + text.err, /swp_/)

  assert.equal((await cli(['comments', 'reply', String(id), '--config', config.file, '--body', 'On it'])).code, 0)
  const got = JSON.parse((await cli(['comments', 'get', String(id), '--config', config.file, '--json'])).out)
  assert.deepEqual(
    got.comment.replies.map((reply) => reply.body),
    ['On it'],
  )
  // watch takes work as an agent of its own (watch.token, with claim): it gets the owner's open comment, never the
  // command line's own (agent text never starts an agent).
  await ownerComment(handle, 'Make the logo bigger')
  const watched = await cli(['watch', '--once', '--config', config.file])
  assert.equal(watched.code, 0, watched.err)
  const handed = watched.out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    handed.map((item) => item.comment.body),
    ['Make the logo bigger'],
  )
  assert.equal((await cli(['comments', 'resolve', String(id), '--config', config.file])).code, 0)
  const all = JSON.parse((await cli(['comments', 'list', '--config', config.file, '--json', '--all'])).out)
  assert.equal(all.comments.find((item) => String(item.id) === String(id)).status, 'resolved')

  // mcp (an agent's MCP server started in the folder) goes to the engine too, on every board.
  const mcpFlags = { config: config.file }
  assert.ok(await engineMode('mcp', mcpFlags, { env: {} }))
  assert.equal(mcpFlags.remote, handle.origin)
  assert.equal(mcpFlags.board, undefined)
  // An explicit --remote still names its own server: nothing is changed for it.
  const flags = { remote: 'https://app.example.com' }
  assert.equal(await engineMode('comments', flags, { env: {} }), null)
  assert.equal(flags.remote, 'https://app.example.com')

  // export reads the 1.x files: refused while the engine holds the comments, unless --no-comments.
  await assert.rejects(engineMode('export', { config: config.file }, { env: {} }), /holds its comments.*--no-comments/s)
  assert.equal(await engineMode('export', { config: config.file, 'no-comments': true }, { env: {} }), null)
})

test('the machine tokens rotate at each start, stop working at stop, and are refused when others can read them', async () => {
  const config = project('engine-target-rotate')
  const dir = engineDir(config.outputDir)
  const first = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  const old = engineTarget(config)
  assert.equal(await engineGet(old.origin, '/api/v1/project', old.token), 200)
  const port = first.server.address().port

  // Readable by others: refused, never used.
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(dir, 'cli.token'), 0o644)
    assert.throws(
      () => engineTarget(config),
      (error) => error instanceof EngineTargetError && /other users/.test(error.message),
    )
    fs.chmodSync(path.join(dir, 'cli.token'), 0o600)
    const link = path.join(dir, 'link.token')
    fs.symlinkSync(path.join(dir, 'cli.token'), link)
    assert.throws(() => readPrivateFile(link), /symbolic link/)
    fs.rmSync(link)
  }
  await first.stop()
  // Stopped: no files, no engine, and the old secret is dead.
  assert.equal(fs.existsSync(path.join(dir, 'cli.token')), false)
  assert.equal(fs.existsSync(path.join(dir, 'watch.token')), false)
  assert.equal(engineTarget(config), null)

  const second = await serveEngine({ engine: 'hosted', config: config.file, port }, () => {}, { env: ENV, start: noExit })
  try {
    const fresh = engineTarget(config)
    assert.notEqual(fresh.token, old.token)
    const call = (token) => engineGet(fresh.origin, '/api/v1/project', token)
    assert.equal(await call(old.token), 401, "the last start's token no longer works")
    assert.equal(await call(fresh.token), 200)
    // The same token row each start (its agent, name and claims stay): one cli, one watch.
    const ids = JSON.parse(fs.readFileSync(path.join(dir, 'machine-tokens.json'), 'utf8'))
    const rows = second.db.prepare('SELECT id, scopes FROM api_tokens WHERE revoked_at IS NULL').all()
    assert.deepEqual(rows.map((row) => row.id).sort(), [ids.cli, ids.watch].sort())
    assert.deepEqual(JSON.parse(rows.find((row) => row.id === ids.cli).scopes), ['push', 'read', 'reply', 'resolve', 'status'])
    assert.ok(JSON.parse(rows.find((row) => row.id === ids.watch).scopes).includes('claim'))
    assert.ok(!JSON.parse(rows.find((row) => row.id === ids.cli).scopes).includes('agent'))
  } finally {
    await second.stop()
  }
})

test('no engine running: the JSON files, a note when the engine has data, a refusal for a migrated board', async () => {
  const config = project('engine-target-rest')
  const errs = []
  assert.equal(await engineMode('comments', { config: config.file }, { env: {}, err: (line) => errs.push(line) }), null)
  assert.deepEqual(errs, [])
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  await handle.stop()
  await engineMode('comments', { config: config.file }, { env: {}, err: (line) => errs.push(line) })
  assert.match(errs.join('\n'), /also has a solo engine \(not running\)/)
  fs.writeFileSync(path.join(config.outputDir, MIGRATED), JSON.stringify({ version: 1, runs: [{ boards: { sample: {} } }] }))
  await assert.rejects(engineMode('comments', { config: config.file }, { env: {} }), /Board sample was migrated to the solo engine/)
  await assert.rejects(engineMode('mcp', { config: config.file }, { env: {} }), /migrated to the solo engine/)
  // Commands that do not read the board are left alone.
  assert.equal(await engineMode('capture', { config: config.file }, { env: {} }), null)
})

test('a stale serve.lock (the engine crashed) is not an engine', () => {
  const config = project('engine-target-stale')
  const dir = engineDir(config.outputDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'serve.lock'), JSON.stringify({ pid: 999999, start: 'x' }))
  fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify({ pid: 999999, origin: 'http://a-b.shapewall.localhost:1' }), {
    mode: 0o600,
  })
  assert.equal(engineTarget(config), null)
})

test('R57-3: a start rotates a machine token without putting back a scope or an expiry the owner took away', async () => {
  const config = project('engine-target-narrow')
  const dir = engineDir(config.outputDir)
  const first = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  const ids = JSON.parse(fs.readFileSync(path.join(dir, 'machine-tokens.json'), 'utf8'))
  const ws = first.app.locals.solo.owner.workspaceId
  const narrowed = '["read","reply","resolve","status"]'
  first.db
    .prepare('UPDATE api_tokens SET scopes = ?, expires_at = ? WHERE workspace_id = ? AND id = ?')
    .run(narrowed, '2027-12-01T00:00:00.000Z', ws, ids.watch)
  const before = first.db.prepare('SELECT token_hash FROM api_tokens WHERE workspace_id = ? AND id = ?').get(ws, ids.watch)
  await first.stop()
  const second = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  try {
    const row = second.db
      .prepare('SELECT token_hash, scopes, expires_at FROM api_tokens WHERE workspace_id = ? AND id = ?')
      .get(ws, ids.watch)
    assert.equal(row.scopes, narrowed, 'claim stays away')
    assert.equal(row.expires_at, '2027-12-01T00:00:00.000Z', 'the expiry stays')
    assert.notEqual(row.token_hash, before.token_hash, 'a new secret all the same')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'machine-tokens.json'), 'utf8')).watch, ids.watch, 'the same row')
  } finally {
    await second.stop()
  }
})

test("R57-6: before any token goes to the port, the engine proves this start's key; an impostor gets nothing", async (t) => {
  const config = project('engine-target-proof')
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  t.after(() => handle.stop())
  const target = engineTarget(config)
  assert.equal(await verifyEngine(target), target)
  // Another listener on a port, as after a crash and a reused pid: it gets one request, with no token in it.
  const seen = []
  const impostor = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ proof: 'x'.repeat(43) }))
  })
  await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve))
  t.after(() => impostor.close())
  const port = impostor.address().port
  const fake = { ...target, origin: target.origin.replace(/:\d+$/, ':' + port) }
  await assert.rejects(verifyEngine(fake), (error) => error instanceof EngineTargetError && /nothing was sent/.test(error.message))
  assert.deepEqual(seen, [{ url: '/solo/whoami', auth: null }])
  // serve.json with a key that is not this start's: the folder's commands refuse, the engine never sees the token.
  const file = path.join(engineDir(config.outputDir), 'serve.json')
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...state, proof: 'A'.repeat(43) }), { mode: 0o600 })
  await assert.rejects(
    cli(['comments', 'list', '--config', config.file, '--json']),
    (error) => error instanceof EngineTargetError && /No running solo engine of this project answers/.test(error.message),
  )
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
  assert.equal((await cli(['comments', 'list', '--config', config.file, '--json'])).code, 0)
})

test('R57-4: a shapewall command an agent started (watch --exec without --pass-token) gets no engine token', async (t) => {
  const config = project('engine-target-agent')
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  t.after(() => handle.stop())
  await assert.rejects(engineMode('comments', { config: config.file }, { env: { [NO_ENGINE_VAR]: '1' } }), /started by an agent/)
  const flags = { config: config.file }
  await assert.rejects(engineMode('mcp', flags, { env: { [NO_ENGINE_VAR]: '1' } }), /started by an agent/)
  assert.equal(flags.remote, undefined, 'nothing routed')
  // watch --exec puts the marker in its command's environment unless --pass-token.
  const source = fs.readFileSync(new URL('../src/remote/remote-watch.js', import.meta.url), 'utf8')
  assert.match(source, /if \(!passToken\) \{[^}]*NO_ENGINE_VAR\] = '1'/s)
})

test("R57-2: on the solo engine the token API and MCP answer the engine's own name from this machine only", async (t) => {
  const config = project('engine-target-gate')
  const handle = await serveEngine({ engine: 'hosted', config: config.file, port: 0 }, () => {}, { env: ENV, start: noExit })
  t.after(() => handle.stop())
  const token = engineTarget(config).token
  const port = handle.server.address().port
  const call = (pathname, host) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: pathname, headers: { Host: host, Authorization: 'Bearer ' + token } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        },
      )
      req.on('error', () => resolve(null))
      req.end()
    })
  const own = new URL(handle.origin).host
  assert.equal(await call('/api/v1/project', own), 200)
  assert.equal(await call('/api/v1/project', '127.0.0.1:' + port), 403)
  assert.equal(await call('/mcp', '127.0.0.1:' + port), 403)
  assert.equal(await call('/api/v1/project', own.replace(/^[a-z]/, 'z')), 403)
})

test("R57-2: an agent never reads the solo engine's folder: Shapewall's own reads refuse it, and Claude Code gets Read deny rules", async () => {
  const { createSandbox } = await import('../src/agent/acp/sandbox.js')
  const { readOnlySession, remoteEditSession, localRestrictedSession } = await import('../src/agent/backends/acp.js')
  const config = project('engine-target-sandbox')
  const engine = engineDir(config.outputDir)
  fs.mkdirSync(engine, { recursive: true })
  fs.writeFileSync(path.join(engine, 'cli.token'), 'swp_not-a-real-token\n', { mode: 0o600 })
  fs.writeFileSync(path.join(config.dir, 'index.html'), '<h1>Hi</h1>\n')
  const sandbox = createSandbox({ root: config.dir, protect: [config.outputDir] })
  assert.match(sandbox.read({ path: path.join(config.dir, 'index.html') }), /Hi/)
  assert.throws(() => sandbox.read({ path: path.join(engine, 'cli.token') }), /may not read/)
  // A link to it from elsewhere in the project is refused by where it lands.
  fs.symlinkSync(path.join(engine, 'cli.token'), path.join(config.dir, 'innocent.txt'))
  assert.throws(() => sandbox.read({ path: path.join(config.dir, 'innocent.txt') }), /may not read/)
  // The whole store is out of reach (the engine's folder with it), as Claude Code's own reads are.
  const store = fs.realpathSync(config.outputDir)
  assert.ok(sandbox.denyRead.includes(store))
  for (const session of [readOnlySession, remoteEditSession, localRestrictedSession]) {
    const settings = session('claude', { denyRead: sandbox.denyRead })._meta.claudeCode.options.settings
    assert.ok(settings.permissions.deny.includes(`Read(/${store}/**)`))
    assert.equal(settings.autoMemoryEnabled, false)
  }
})
