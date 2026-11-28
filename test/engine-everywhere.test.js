// 2.0.0 (plan R5b): once the solo engine holds the project, every command
// works on the engine's board or says why it cannot, never on the stale 1.x
// files. Here with the engine stopped (the database a migration made); the
// running engine is test/contract-1x.test.js.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { boardHome } from '../src/cli/board-home.js'
import { engineMode } from '../src/cli/engine-mode.js'
import { autoMigrate } from '../src/cli/serve-command.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { createJourney } from '../src/journeys.js'
import { createComment } from '../src/store.js'
import { startEngineHeadless } from '../src/hosted/ops-cli.js'
import { engineTarget } from '../src/engine-target.js'
import { SAMPLE, isolatedEnv, tempDir } from './helpers.js'
import { b64, solidPng } from './comment-media-fixtures.js'

quietSqliteWarning()
const CLI = fileURLToPath(new URL('../bin/shapewall.js', import.meta.url))
const ENV = isolatedEnv('engine-everywhere-env', { SHAPEWALL_USER_NAME: 'Robin Tester' })

async function migratedProject(name, { image = false } = {}) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Everywhere Notes' }, null, 2))
  const config = loadConfig(file)
  const board = config.boards[0]
  await createComment(config, board, {
    pageId: 'home',
    viewport: 'desktop',
    x: 10,
    y: 10,
    body: 'Bigger logo',
    author: 'Robin',
    ...(image ? { images: [{ name: 'shot.png', mediaType: 'image/png', data: b64(solidPng(8, 8)) }] } : {}),
  })
  await createJourney(config, board, { name: 'Upgrade from 1x', steps: ['pricing', 'app'] })
  const lines = []
  assert.equal((await autoMigrate(config, (line) => lines.push(line), { env: ENV })).migrated, true, lines.join('\n'))
  const home = (await boardHome(config, { env: ENV })).config
  return { config, board, file, home }
}

async function cli(argv) {
  const lines = []
  const errs = []
  try {
    const code = await main(argv, { out: (line) => lines.push(String(line)), err: (line) => errs.push(String(line)) })
    return { code, out: lines.join('\n'), err: errs.join('\n') }
  } catch (error) {
    return { code: 1, out: lines.join('\n'), err: `${errs.join('\n')}\n${error.message}` }
  }
}

test('engine stopped: comments, watch and mcp start it for themselves and stop it after; legacy keeps the 1.x files', async () => {
  const { config, file } = await migratedProject('everywhere-rest')
  // Without a start (an agent's own process has none): a refusal that says what to do.
  for (const command of ['comments', 'watch', 'mcp'])
    await assert.rejects(
      engineMode(command, { config: file }, { env: ENV }),
      /migrated to the solo engine|not running\. Start it with shapewall serve/,
    )
  // Legacy: the 1.x files, which refuse a board the migration moved.
  await assert.rejects(
    engineMode('comments', { config: file }, { env: { ...ENV, SHAPEWALL_ENGINE: 'legacy' } }),
    /migrated to the solo engine/,
  )

  // The CLI: the engine starts headless, answers with the moved comment in the 1.x shape, and stops.
  const listed = await cli(['comments', 'list', '--config', file, '--json'])
  assert.equal(listed.code, 0, listed.err)
  assert.deepEqual(
    JSON.parse(listed.out).comments.map((item) => item.body),
    ['Bigger logo'],
  )
  assert.match(listed.err, /Solo engine: started for this command at http:\/\/[a-z0-9-]+\.shapewall\.localhost:\d+/)
  assert.equal(engineTarget(config), null, 'stopped again when the command ended')

  // An agent's own process never starts it.
  for (const command of ['comments', 'mcp'])
    await assert.rejects(
      engineMode(command, { config: file }, { env: { ...ENV, SHAPEWALL_NO_ENGINE: '1' }, startEngine: startEngineHeadless }),
      /migrated to the solo engine|not running/,
    )

  // mcp and watch: the engine runs as long as they do, with the command's own token.
  for (const command of ['mcp', 'watch']) {
    const flags = { config: file }
    const mode = await engineMode(command, flags, { env: ENV, startEngine: startEngineHeadless })
    assert.ok(mode?.stop, `${command}: started its own engine`)
    assert.equal(flags.remote, mode.target.origin)
    assert.ok(engineTarget(config, { which: command === 'watch' ? 'watch' : 'cli' }), `${command}: the engine answers`)
    await mode.stop()
    assert.equal(engineTarget(config), null, `${command}: stopped after`)
  }

  // One already running (started by another command or by serve): used, not started again.
  const running = await startEngineHeadless(config, { env: ENV })
  try {
    const flags = { config: file }
    const mode = await engineMode('comments', flags, { env: ENV, startEngine: startEngineHeadless })
    assert.equal(mode.stop, null, 'attached, so not ours to stop')
    assert.equal(flags.remote, engineTarget(config).origin)
  } finally {
    await running.stop()
  }
})

test("export: the engine's comments through its token API (started for the command), its captures with --no-comments", async () => {
  const { config, file } = await migratedProject('everywhere-export', { image: true })
  // Without a start: still the refusal.
  await assert.rejects(engineMode('export', { config: file }, { env: ENV }), /holds this project's comments.*--no-comments/)

  const out = path.join(config.dir, 'exported')
  const run = await cli(['export', '--config', file, '--out', out])
  assert.equal(run.code, 0, run.err)
  const exported = JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample', 'comments.json'), 'utf8')).comments
  assert.deepEqual(
    exported.map((comment) => [comment.body, comment.pageId, comment.status]),
    [['Bigger logo', 'home', 'open']],
  )
  const view = JSON.parse(fs.readFileSync(path.join(out, 'data', 'boards', 'sample.json'), 'utf8'))
  assert.deepEqual(view.commentCounts, { home: { open: 1, resolved: 0 } })
  // The image, read from the engine under the name the comment lists.
  const [image] = exported[0].images
  assert.match(image.file, /^[a-f0-9]{24}\.png$/)
  assert.ok(fs.statSync(path.join(out, 'data', 'boards', 'sample', 'comment-files', image.file)).size > 0)
  assert.equal(engineTarget(config), null, 'the engine stopped after the export')

  const bare = path.join(config.dir, 'exported-bare')
  const captures = await cli(['export', '--config', file, '--no-comments', '--out', bare])
  assert.equal(captures.code, 0, captures.err)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bare, 'data', 'boards', 'sample', 'comments.json'), 'utf8')).comments, [])
})

test("journeys and variants read the engine's board folder; github goes to the engine", async () => {
  const { board, file, home } = await migratedProject('everywhere-folders')
  // Only in the engine's folder: proves the command reads there, not .shapewall/<board>/.
  await createJourney(home, board, { name: 'Made on the engine', steps: ['home', 'pricing'] })
  const listed = await cli(['journeys', '--config', file, '--json'])
  assert.equal(listed.code, 0, listed.err)
  const names = JSON.parse(listed.out).journeys.map((journey) => journey.name)
  assert.ok(names.includes('Upgrade from 1x'), names.join(', '))
  assert.ok(names.includes('Made on the engine'), names.join(', '))

  const variants = await cli(['variant', 'list', '--config', file, '--json'])
  assert.equal(variants.code, 0, variants.err)
  assert.deepEqual(JSON.parse(variants.out).variants, [])

  const github = await cli(['github', 'issue', '1', '--config', file])
  assert.notEqual(github.code, 0)
  // The engine's comment, found (test/github-engine.test.js has the whole flow): only GitHub is not set up here.
  assert.match(github.err, /Solo engine: started for this command/)
  assert.match(github.err, /GitHub/)
  assert.doesNotMatch(github.err, /works on the 1\.x board files/)
})

test('share --remote stays refused on an engine board', async () => {
  const { file } = await migratedProject('everywhere-share')
  const run = await cli(['share', '--config', file, '--remote', 'https://board.example.test', '--dry-run'])
  assert.notEqual(run.code, 0)
  assert.match(run.err, /lives in the solo engine now/)
})

test('an agent starts shapewall mcp with no serve running: the tools answer from the engine, and it stops with the session', async () => {
  const { config, file } = await migratedProject('everywhere-mcp')
  const client = new Client({ name: 'engine-everywhere', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--config', file],
      cwd: config.dir,
      env: { ...process.env, ...ENV },
      stderr: 'pipe',
    }),
  )
  let closed = false
  try {
    const { tools } = await client.listTools()
    assert.ok(tools.some((tool) => tool.name === 'list_comments'))
    const listed = await client.callTool({ name: 'list_comments', arguments: {} })
    assert.match(JSON.stringify(listed.content), /Bigger logo/)
    assert.ok(engineTarget(config), 'the engine runs while the session does')
    await client.close()
    closed = true
    const until = Date.now() + 15000
    while (engineTarget(config) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(engineTarget(config), null, 'the engine stopped with the session')
  } finally {
    if (!closed) await client.close()
  }
})
