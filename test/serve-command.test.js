// `shapewall serve` in 2.0.0 (plan R5): which server it runs, the automatic
// migration of a 1.x project on the first start, where `capture` writes,
// and the guard that keeps the 1.x writers off a board the engine holds.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { ENGINE_VAR, LEGACY_ONLY_FLAGS, chooseEngine } from '../src/cli/engine-choice.js'
import { AutoMigrateError, autoMigrate, serveCommand } from '../src/cli/serve-command.js'
import { boardHome } from '../src/cli/board-home.js'
import { MIGRATED, MIGRATING, engineDir } from '../src/engine-folder.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { REFUSED_FLAGS } from '../src/hosted/solo/serve.js'
import { appendUserMessage } from '../src/agent/threads.js'
import { createComment } from '../src/store.js'
import { share } from '../src/remote/share.js'
import { SAMPLE, isolatedEnv, tempDir } from './helpers.js'

quietSqliteWarning()
const ENV = isolatedEnv('serve-command-env', { SHAPEWALL_USER_NAME: 'Robin Tester' })

function project(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Serve Notes' }, null, 2))
  return loadConfig(file)
}

const comment = (config, body = 'Make the logo bigger') =>
  createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body, author: 'Robin' })

function markMigrated(config) {
  fs.mkdirSync(config.outputDir, { recursive: true })
  fs.writeFileSync(path.join(config.outputDir, MIGRATED), JSON.stringify({ runs: [{ boards: { [config.boards[0].id]: {} } }] }))
}

test('chooseEngine: the engine by default, legacy by flag, variable or a 1.x-only flag, with the deprecation line', () => {
  const said = []
  const warn = (...args) => said.push(args)
  assert.deepEqual(chooseEngine({}, {}, { warn }), { engine: 'hosted', source: 'default' })
  assert.deepEqual(chooseEngine({ engine: 'hosted' }, { [ENGINE_VAR]: 'legacy' }, { warn }), { engine: 'hosted', source: 'flag' })
  assert.deepEqual(chooseEngine({}, { [ENGINE_VAR]: 'hosted' }, { warn }), { engine: 'hosted', source: 'env' })
  assert.deepEqual(chooseEngine({}, { [ENGINE_VAR]: '  ' }, { warn }), { engine: 'hosted', source: 'default' })
  assert.equal(said.length, 0, 'no deprecation line for the engine')

  assert.deepEqual(chooseEngine({ engine: 'legacy' }, {}, { warn }), { engine: 'legacy', source: 'flag' })
  assert.deepEqual(chooseEngine({}, { [ENGINE_VAR]: 'Legacy' }, { warn }), { engine: 'legacy', source: 'env' })
  assert.deepEqual(chooseEngine({ host: '0.0.0.0' }, {}, { warn }), { engine: 'legacy', source: 'flags', flag: 'host' })
  assert.deepEqual(
    said.map(([what, , options]) => [what, options.removedIn]),
    [
      ['serve --engine legacy', '3.0'],
      [`${ENGINE_VAR}=legacy`, '3.0'],
      ['serve --host (which only the 1.x board server takes)', '3.0'],
    ],
  )
  // The engine asked for by name with a 1.x-only flag: the engine's own refusal (engineFlagProblem) says why.
  assert.deepEqual(chooseEngine({ engine: 'hosted', lan: true }, {}, { warn }), { engine: 'hosted', source: 'flag' })

  assert.throws(() => chooseEngine({ engine: 'solo' }, {}, { warn }), /--engine: "hosted"/)
  assert.throws(() => chooseEngine({}, { [ENGINE_VAR]: 'old' }, { warn }), /SHAPEWALL_ENGINE: "hosted"/)
})

test('the 1.x-only flags are exactly the flags the solo engine refuses', () => {
  assert.deepEqual([...LEGACY_ONLY_FLAGS].sort(), [...REFUSED_FLAGS].sort())
})

test('autoMigrate: nothing to move in a new project; says what happens, then migrates; a failed run stops serve', async () => {
  const fresh = project('auto-fresh')
  assert.deepEqual(await autoMigrate(fresh, () => {}, { env: ENV }), { migrated: false, boards: [] })

  const lines = []
  const calls = []
  const fake = (code) => ({
    pendingMigration: async () => ({ boards: [{ id: 'site' }] }),
    migrateCommand: async (config, flags, out, options) => {
      calls.push(options)
      return code
    },
  })
  fs.mkdirSync(fresh.outputDir, { recursive: true })
  assert.deepEqual(await autoMigrate(fresh, (line) => lines.push(line), { env: ENV, version: '2.0.0', migrate: fake(0) }), {
    migrated: true,
    boards: ['site'],
  })
  assert.match(lines[0], /first start here, so the 1\.x board data of site/)
  assert.match(lines[1], /backup-1x-<time>.*migrate --rollback.*--engine legacy/)
  assert.equal(calls[0].fromServe, true)
  assert.equal(calls[0].version, '2.0.0')
  await assert.rejects(
    autoMigrate(fresh, () => {}, { env: ENV, migrate: fake(1) }),
    AutoMigrateError,
  )
})

test('autoMigrate for real: a 1.x project moves once, with a backup; capture then writes into the engine folder', async () => {
  const config = project('auto-real')
  await comment(config)
  assert.equal((await boardHome(config, { env: ENV })).engine, false, 'before the move: the 1.x folders')

  const lines = []
  const first = await autoMigrate(config, (line) => lines.push(line), { env: ENV })
  assert.equal(first.migrated, true, lines.join('\n'))
  assert.deepEqual(first.boards, [config.boards[0].id])
  assert.ok(fs.existsSync(path.join(config.outputDir, MIGRATED)))
  assert.ok(
    fs.readdirSync(config.outputDir).some((name) => name.startsWith('backup-1x-')),
    'a backup next to the data',
  )
  assert.ok(!lines.some((line) => /Start the board with shapewall serve/.test(line)), 'serve starts it, no hint to')
  assert.deepEqual(await autoMigrate(config, () => {}, { env: ENV }), { migrated: false, boards: [] }, 'later starts: nothing to move')

  const home = await boardHome(config, { env: ENV })
  assert.equal(home.engine, true)
  assert.ok(home.config.outputDir.startsWith(path.join(engineDir(config.outputDir), 'files') + path.sep))
  assert.match(path.relative(engineDir(config.outputDir), home.config.outputDir), /^files[/\\]ws_[a-f0-9]{24}[/\\]pr_[a-f0-9]{24}$/)
  assert.equal((await boardHome(config, { env: { ...ENV, [ENGINE_VAR]: 'legacy' } })).engine, false)
})

test('serveCommand: starts the engine on a new project, refuses on a migration stopped midway', async () => {
  const config = project('serve-start')
  const started = []
  const startEngine = async (flags) => {
    started.push(flags)
    return 'handle'
  }
  const flags = { config: config.file }
  assert.equal(await serveCommand(flags, () => {}, { env: ENV, startEngine }), 'handle')
  assert.equal(started[0].engine, 'hosted')

  fs.mkdirSync(config.outputDir, { recursive: true })
  fs.writeFileSync(path.join(config.outputDir, MIGRATING), '{}')
  await assert.rejects(
    serveCommand(flags, () => {}, { env: ENV, startEngine }),
    /stopped midway/,
  )
  assert.equal(started.length, 1, 'the engine did not start')
})

test('serveCommand checks the port before it migrates: a taken port leaves the 1.x project as it was (IC4 B7)', async () => {
  const { preflightEngine } = await import('../src/hosted/solo/serve.js')
  const net = await import('node:net')
  const config = project('serve-port-first')
  await comment(config)
  const holder = net.createServer()
  await new Promise((resolve) => holder.listen({ host: '127.0.0.1', port: 0 }, resolve))
  const port = holder.address().port
  const started = []
  const startEngine = async () => {
    started.push(true)
    return 'handle'
  }
  try {
    await assert.rejects(
      serveCommand({ config: config.file, port: String(port) }, () => {}, { env: ENV, startEngine, preflight: preflightEngine }),
      new RegExp(`Port ${port} is in use\\. Pick another with --port\\. Nothing was changed\\.`),
    )
    assert.equal(started.length, 0)
    assert.equal(fs.existsSync(path.join(config.outputDir, MIGRATED)), false, 'not migrated')
    assert.equal(fs.existsSync(engineDir(config.outputDir)), false, 'no engine folder')
    assert.ok(!fs.readdirSync(config.outputDir).some((name) => name.startsWith('backup-1x-')), 'no backup')
    // Other cheap checks run first too: a refused flag or a bad port number.
    await assert.rejects(preflightEngine({ port: 'abc' }), /--port must be a port number/)
    await assert.rejects(preflightEngine({ 'trust-proxy': true }), /--trust-proxy is not for the solo engine/)
  } finally {
    await new Promise((resolve) => holder.close(resolve))
  }
  // The port free again: the same start migrates, then starts the engine.
  assert.equal(
    await serveCommand({ config: config.file, port: String(port) }, () => {}, { env: ENV, startEngine, preflight: preflightEngine }),
    'handle',
  )
  assert.ok(fs.existsSync(path.join(config.outputDir, MIGRATED)))
  assert.equal(started.length, 1)
})

test('the 1.x comment and chat writers refuse a board the engine holds (409 board_migrated)', async () => {
  const config = project('guard-writers')
  await comment(config, 'before the move')
  markMigrated(config)
  await assert.rejects(comment(config, 'after the move'), (error) => error.statusCode === 409 && error.code === 'board_migrated')
  await assert.rejects(
    appendUserMessage(config, config.boards[0].id, 'board', { text: 'hello', attachments: [] }),
    (error) => error.status === 409 && error.code === 'board_migrated' && /migrated to the solo engine/.test(error.message),
  )
})

test('share --remote stops on a board the engine holds instead of sending a stale copy', async () => {
  const config = project('guard-share')
  await comment(config)
  markMigrated(config)
  await assert.rejects(
    share({ remote: 'https://board.example.test', 'dry-run': true }, () => {}, { config, env: ENV }),
    /lives in the solo engine now .*shapewall serve --team .*migrate --rollback/,
  )
})

test('F13a: autoMigrate refuses when plan.boards is empty but plan.problems has errors (respecting skipGitCheck)', async () => {
  const config = project('auto-migrate-problems')
  fs.mkdirSync(config.outputDir, { recursive: true })
  const lines = []
  await assert.rejects(
    autoMigrate(config, (line) => lines.push(line), {
      env: ENV,
      migrate: {
        pendingMigration: async () => ({
          boards: [],
          problems: ['board sample: orphaned tombstone without MIGRATED-TO-2'],
        }),
      },
    }),
    AutoMigrateError,
  )
  assert.ok(lines.some((line) => /orphaned tombstone/.test(line)))

  // git-tracked problem is skipped when skipGitCheck is true.
  const skipped = await autoMigrate(config, () => {}, {
    env: ENV,
    skipGitCheck: true,
    migrate: {
      pendingMigration: async () => ({
        boards: [],
        problems: ['git tracks files in .shapewall/.engine (shapewall.db)'],
      }),
    },
  })
  assert.deepEqual(skipped, { migrated: false, boards: [] })
})
