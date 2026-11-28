// Retention on the solo engine (IC4 B1): each board keeps its project's own
// keepVersions (5 by default, as 1.x), not the team server's 2, and the
// engine's first start (the one right after a migration) prunes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { RETENTION_DEFAULT, runRetention, soloKeep, startRetention } from '../src/hosted/retention.js'
import { VERSIONS_DEFAULT } from '../src/config.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig } from './helpers.js'

async function fixture(name) {
  const hosted = await startHostedServer(name)
  const owner = await signUp(hosted, { handle: 'solo-retention' })
  const ws = owner.workspaceId
  const project = await createProject(owner, ws, 'Fixture')
  const token = await createToken(owner, ws, project.id)
  const config = sampleConfig(`${name}-captures`)
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token })
  const pushed = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, file, from] of pushFiles(config, config.boards[0])) await remote.pushFile(pushed.id, area, file, fs.readFileSync(from))
  await remote.commitPush(pushed.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample/captures/manifest.json'))),
    variants: [],
  })
  const dir = path.join(hosted.dataDir, 'files', ws, project.id, 'sample', 'versions')
  fs.mkdirSync(dir, { recursive: true })
  // Eight older versions of one page and viewport, as a 1.x board brings them.
  for (let i = 1; i <= 8; i += 1)
    for (const suffix of ['png', 'thumb.png', 'html'])
      fs.writeFileSync(path.join(dir, `home.desktop.2026110${i}T100000000Z-ab12.${suffix}`), 'x')
  const setKeep = (keep) => {
    const row = hosted.db.prepare('SELECT definition FROM boards WHERE workspace_id = ?').get(ws)
    const definition = JSON.parse(row.definition)
    if (keep === undefined) delete definition.versions
    else definition.versions = keep
    hosted.db.prepare('UPDATE boards SET definition = ? WHERE workspace_id = ?').run(JSON.stringify(definition), ws)
  }
  const count = () => fs.readdirSync(dir).filter((name) => name.endsWith('.png') && !name.endsWith('.thumb.png')).length
  return { hosted, dir, setKeep, count }
}

test('soloKeep: the config keepVersions, 5 when unset, null (keep all) for 0', () => {
  assert.equal(soloKeep({ versions: 3 }), 3)
  assert.equal(soloKeep({}), VERSIONS_DEFAULT)
  assert.equal(VERSIONS_DEFAULT, 5)
  assert.equal(soloKeep({ versions: 0 }), null)
})

test('the solo engine keeps keepVersions per page and viewport, the team default stays 2', async () => {
  const { hosted, setKeep, count } = await fixture('solo-retention-keep')
  try {
    setKeep(undefined)
    assert.equal(runRetention({ db: hosted.db, dataDir: hosted.dataDir, solo: true, dryRun: true }).files, 3 * 3, 'default 5 of 8')
    setKeep(0)
    assert.equal(runRetention({ db: hosted.db, dataDir: hosted.dataDir, solo: true }).files, 0, '0: 1.x never pruned')
    assert.equal(count(), 8)
    setKeep(6)
    runRetention({ db: hosted.db, dataDir: hosted.dataDir, solo: true })
    assert.equal(count(), 6)
    // A team server is unchanged: its workspace default, whatever the board says.
    assert.equal(runRetention({ db: hosted.db, dataDir: hosted.dataDir, dryRun: true }).files, (6 - RETENTION_DEFAULT) * 3)
  } finally {
    await hosted.close()
  }
})

test('the solo engine prunes nothing on its first start, and to keepVersions on later starts', async () => {
  const { hosted, setKeep, count } = await fixture('solo-retention-first')
  try {
    setKeep(3)
    const lines = []
    // startHostedServer's own team-server job already ran; this database has no solo state yet.
    startRetention({ db: hosted.db, dataDir: hosted.dataDir, solo: true, log: (line) => lines.push(line) })()
    assert.equal(count(), 8, 'first start: everything moved from 1.x stays')
    assert.deepEqual(lines, [])
    startRetention({ db: hosted.db, dataDir: hosted.dataDir, solo: true, log: (line) => lines.push(line) })()
    assert.equal(count(), 3)
    assert.match(lines.join('\n'), /removed 15 old version files/)
  } finally {
    await hosted.close()
  }
})

test('F12: headless engine commands never consume solo_retention or prune migrated 1.x versions before first serve', async () => {
  const { loadConfig } = await import('../src/config.js')
  const { autoMigrate } = await import('../src/cli/serve-command.js')
  const { startEngineHeadless } = await import('../src/hosted/ops-cli.js')
  const { startHosted } = await import('../src/hosted/server.js')
  const { engineDir } = await import('../src/engine-folder.js')
  const { openDatabase } = await import('../src/hosted/db.js')
  const { getState } = await import('../src/hosted/rebind.js')
  const { readSoloBinding } = await import('../src/hosted/solo/binding.js')
  const { SAMPLE, isolatedEnv, tempDir } = await import('./helpers.js')

  const dir = tempDir('f12-headless-retention')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...structuredClone(SAMPLE), keepVersions: 3 }, null, 2))
  const config = loadConfig(file)
  writeLocalCaptures(config, 'sample')
  const vDir1x = path.join(config.outputDir, 'sample', 'versions')
  fs.mkdirSync(vDir1x, { recursive: true })
  for (let i = 1; i <= 8; i += 1)
    for (const suffix of ['png', 'thumb.png', 'html'])
      fs.writeFileSync(path.join(vDir1x, `home.desktop.2026110${i}T100000000Z-ab12.${suffix}`), 'x')

  const env = isolatedEnv('f12-env', { SHAPEWALL_USER_NAME: 'Robin Tester' })
  assert.equal((await autoMigrate(config, () => {}, { env })).migrated, true)
  const data = engineDir(config.outputDir)

  // Two headless engine starts (as comments/mcp would run): 0 versions pruned, solo_retention untouched.
  for (let run = 0; run < 2; run += 1) {
    const h = await startEngineHeadless(config, { env })
    await h.stop()
  }
  const db = await openDatabase(path.join(data, 'shapewall.db'))
  const bound = readSoloBinding(db)
  assert.equal(getState(db, 'solo_retention'), null, 'headless starts did not consume first-start skip')
  const engineVersionsDir = path.join(data, 'files', bound.workspaceId, bound.projectId, 'sample', 'versions')
  const count = () => fs.readdirSync(engineVersionsDir).filter((name) => name.endsWith('.png') && !name.endsWith('.thumb.png')).length
  assert.equal(count(), 8)
  db.close()

  // First real serve start: skips pruning once and records solo_retention.
  const firstServe = await startHosted({
    dataDir: data,
    port: 0,
    out: () => {},
    exitOnStop: false,
    origin: (p) => `http://f12-test-abcdefghijklmn.shapewall.localhost:${p}`,
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester' },
  })
  assert.equal(count(), 8, 'first real serve preserves all migrated 1.x versions')
  assert.ok(getState(firstServe.db, 'solo_retention'))
  await firstServe.stop()

  // Second real serve start: now trims to keepVersions (3).
  const secondServe = await startHosted({
    dataDir: data,
    port: 0,
    out: () => {},
    exitOnStop: false,
    origin: (p) => `http://f12-test-abcdefghijklmn.shapewall.localhost:${p}`,
    solo: { signIn: 'local', config, configPath: config.file, ownerName: 'Robin Tester' },
  })
  assert.equal(count(), 3)
  await secondServe.stop()
})

test('F12: pruneBoard skips boards with an active board-job lock, and startRetention passes now into runRetention', async () => {
  const { acquireBoardJob } = await import('../src/board-job.js')
  const { hosted, dir, setKeep, count } = await fixture('solo-retention-lock')
  try {
    setKeep(3)
    const boardFolder = path.dirname(dir)
    const projectOutputDir = path.dirname(boardFolder)
    const lock = acquireBoardJob({ outputDir: projectOutputDir }, 'sample', 'capture')
    assert.equal(lock.ok, true)
    try {
      const skipped = runRetention({ db: hosted.db, dataDir: hosted.dataDir, solo: true })
      assert.equal(skipped.files, 0, 'active capture lock skips pruning')
      assert.equal(count(), 8)
    } finally {
      lock.release()
    }
    // Verify startRetention passes injected `now` into runRetention (old usage row pruned relative to `now`).
    const ws = hosted.db.prepare('SELECT id FROM workspaces LIMIT 1').get().id
    const projectId = hosted.db.prepare('SELECT id FROM projects LIMIT 1').get().id
    const oldAt = '2025-01-01T00:00:00.000Z'
    hosted.db
      .prepare(
        `INSERT INTO agent_runs (workspace_id, project_id, id, kind, board_id, started_at, ended_at)
         VALUES (?, ?, 'run_old', 'chat', 'sample', ?, ?)`,
      )
      .run(ws, projectId, oldAt, oldAt)
    assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1)
    startRetention({
      db: hosted.db,
      dataDir: hosted.dataDir,
      solo: false,
      now: () => new Date('2027-06-01T00:00:00.000Z'),
    })()
    assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 0, 'now passed through to usage prune')
    assert.equal(count(), 2)
  } finally {
    await hosted.close()
  }
})
