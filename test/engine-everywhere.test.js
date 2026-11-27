// 2.0.0 (plan R5b): once the solo engine holds the project, every command
// works on the engine's board or says why it cannot, never on the stale 1.x
// files. Here with the engine stopped (the database a migration made); the
// running engine is test/contract-1x.test.js.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { main } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { boardHome } from '../src/cli/board-home.js'
import { engineMode } from '../src/cli/engine-mode.js'
import { autoMigrate } from '../src/cli/serve-command.js'
import { quietSqliteWarning } from '../src/hosted/db.js'
import { createJourney } from '../src/journeys.js'
import { createComment } from '../src/store.js'
import { SAMPLE, isolatedEnv, tempDir } from './helpers.js'

quietSqliteWarning()
const ENV = isolatedEnv('engine-everywhere-env', { SHAPEWALL_USER_NAME: 'Robin Tester' })

async function migratedProject(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), title: 'Everywhere Notes' }, null, 2))
  const config = loadConfig(file)
  const board = config.boards[0]
  await createComment(config, board, { pageId: 'home', viewport: 'desktop', x: 10, y: 10, body: 'Bigger logo', author: 'Robin' })
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

test('engine stopped: comments, watch and mcp say to start serve; legacy keeps the 1.x files', async () => {
  const { config, file } = await migratedProject('everywhere-rest')
  for (const command of ['comments', 'watch', 'mcp'])
    await assert.rejects(
      engineMode(command, { config: file }, { env: ENV }),
      /migrated to the solo engine|not running\. Start it with shapewall serve/,
    )
  // A project the engine holds without a migration (serve started here first): the same, by the database.
  fs.rmSync(path.join(config.outputDir, 'MIGRATED-TO-2'))
  for (const command of ['comments', 'watch', 'mcp'])
    await assert.rejects(engineMode(command, { config: file }, { env: ENV }), /not running\. Start it with shapewall serve/)
  assert.equal(await engineMode('comments', { config: file }, { env: { ...ENV, SHAPEWALL_ENGINE: 'legacy' } }), null)
  const listed = await cli(['comments', '--config', file])
  assert.notEqual(listed.code, 0)
  assert.match(listed.err, /Start it with shapewall serve/)
})

test('export: refused with comments, the engine captures with --no-comments', async () => {
  const { config, file } = await migratedProject('everywhere-export')
  await assert.rejects(engineMode('export', { config: file }, { env: ENV }), /holds this project's comments.*--no-comments/)
  assert.equal(await engineMode('export', { config: file, 'no-comments': true }, { env: ENV }), null)
  const out = path.join(config.dir, 'exported')
  const run = await cli(['export', '--config', file, '--no-comments', '--out', out])
  assert.equal(run.code, 0, run.err)
  assert.ok(fs.existsSync(out))
})

test("journeys and variants read the engine's board folder; github refuses", async () => {
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
  assert.match(github.err, /shapewall github works on the 1\.x board files, and the solo engine holds this project's board/)
})

test('share --remote stays refused on an engine board', async () => {
  const { file } = await migratedProject('everywhere-share')
  const run = await cli(['share', '--config', file, '--remote', 'https://board.example.test', '--dry-run'])
  assert.notEqual(run.code, 0)
  assert.match(run.err, /lives in the solo engine now/)
})
