// Review finding 02: a crash during a hosted push's commit could separate a
// board's row from its files (the swap renames folders inside a SQLite
// transaction that cannot roll a rename back), and the next sweep deleted
// the old folder that recovery needed. Each case below commits in a child
// process that dies at one point of the swap, then the sweep runs, as at
// the next start, and every board row must resolve to one complete
// generation of files: the old one when the commit did not happen, the new
// one when it did.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../src/hosted/db.js'
import { createPushStore, sweepStaging } from '../src/hosted/push.js'
import { tenant } from '../src/hosted/tenancy.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig } from './helpers.js'

const SRC = (file) => pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'hosted', file)).href

// The child: opens the database, commits the push, and exits (no cleanup,
// no rollback handler) at the named point.
//   after-rename-1  right after the first board-folder rename
//   after-rename-2  right after the second one, before COMMIT
//   after-commit    after COMMIT, before the old folder is removed
const CHILD = `
import fs from 'node:fs'
const [dbFile, dataDir, ws, projectId, pushId, manifestFile, crashAt] = process.argv.slice(1)
const { openDatabase } = await import(${JSON.stringify(SRC('db.js'))})
const { createPushStore } = await import(${JSON.stringify(SRC('push.js'))})
const { tenant } = await import(${JSON.stringify(SRC('tenancy.js'))})
const db = await openDatabase(dbFile)
const rename = fs.renameSync
const remove = fs.rmSync
let renames = 0
fs.renameSync = (from, to) => {
  rename(from, to)
  if (!String(to).includes('/files/')) return
  renames += 1
  if (crashAt === 'after-rename-' + renames) process.exit(9)
}
fs.rmSync = (file, options) => {
  if (crashAt === 'after-commit' && String(file).endsWith('.old-' + pushId)) process.exit(9)
  return remove(file, options)
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
createPushStore(tenant(db, ws), { db, dataDir }).commit({ pushId, projectId, manifest, variants: [] })
process.exit(0)
`

async function pushBoard(remote, config, { commit }) {
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifestFile = path.join(config.outputDir, board.id, 'captures', 'manifest.json')
  if (commit) await remote.commitPush(started.id, { manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')), variants: [] })
  return { id: started.id, manifestFile }
}

// The board row and the folder agree: no row and no folder, or a row whose
// pages are exactly the folder's manifest pages, every captured shot there.
// -> 'none' | number of pages
function generationOf(db, dataDir, ws, projectId) {
  const row = db
    .prepare("SELECT definition FROM boards WHERE workspace_id = ? AND project_id = ? AND board_id = 'sample'")
    .get(ws, projectId)
  const dir = path.join(dataDir, 'files', ws, projectId, 'sample')
  if (!row) {
    assert.ok(!fs.existsSync(dir), 'no row, no folder')
    return 'none'
  }
  const pages = JSON.parse(row.definition).board.pages.map((page) => page.id)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'captures', 'manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.pages).sort(), [...pages].sort(), 'the row and the files are one generation')
  for (const [pageId, views] of Object.entries(manifest.pages))
    for (const [viewport, entry] of Object.entries(views)) {
      assert.equal(entry.status, 'ok', `${pageId} ${viewport}`)
      assert.ok(fs.existsSync(path.join(dir, 'captures', `${pageId}.${viewport}.png`)), `${pageId}.${viewport}.png`)
    }
  return pages.length
}

test('a commit that dies anywhere in the folder swap leaves every board one whole generation after the sweep', async () => {
  const hosted = await startHostedServer('push-crash')
  const cases = [
    // [name, crash point, board pushed before, expected generation after the sweep]
    ['dies between the renames', 'after-rename-1', true, 3],
    ['dies after both renames, before COMMIT', 'after-rename-2', true, 3],
    ['dies after COMMIT, before the old folder goes', 'after-commit', true, 2],
    ['a new board: dies after its rename, before COMMIT', 'after-rename-1', false, 'none'],
  ]
  const prepared = []
  let ws
  try {
    const owner = await signUp(hosted, { handle: 'crash' })
    ws = owner.workspaceId
    for (const [name, crashAt, before, expected] of cases) {
      const project = await createProject(owner, ws, name.slice(0, 40))
      const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
      // The old generation: three pages.
      const full = sampleConfig('push-crash-old')
      writeLocalCaptures(full, 'sample')
      if (before) await pushBoard(remote, full, { commit: true })
      // The new one: two pages, uploaded and left open for the child to commit.
      const fewer = sampleConfig('push-crash-new', {
        pages: full.boards[0].pages.slice(0, 2).map(({ id, path: p, title }) => ({ id, path: p, title })),
      })
      writeLocalCaptures(fewer, 'sample')
      const open = await pushBoard(remote, fewer, { commit: false })
      prepared.push({ name, crashAt, expected, project: project.id, push: open.id, manifestFile: open.manifestFile })
    }
  } finally {
    await hosted.close()
  }
  const dbFile = path.join(hosted.dataDir, 'shapewall.db')
  for (const item of prepared) {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', CHILD, dbFile, hosted.dataDir, ws, item.project, item.push, item.manifestFile, item.crashAt],
      { encoding: 'utf8' },
    )
    assert.equal(child.status, 9, `${item.name}: the writer died where it was told to (${child.stderr})`)
  }
  // The next start: the sweep runs first.
  const db = await openDatabase(dbFile)
  try {
    const logged = []
    sweepStaging({ db, dataDir: hosted.dataDir, log: (line) => logged.push(line) })
    assert.deepEqual(logged, [], 'nothing left for the operator')
    for (const item of prepared) {
      assert.equal(generationOf(db, hosted.dataDir, ws, item.project), item.expected, item.name)
      const left = fs.readdirSync(path.join(hosted.dataDir, 'files', ws, item.project))
      assert.ok(!left.some((name) => name.includes('.old-')), `${item.name}: no old folder left over`)
      const status = db.prepare('SELECT status FROM pushes WHERE id = ?').get(item.push).status
      if (item.expected === 2) assert.equal(status, 'committed')
      else {
        // Not committed: the push is as it was before its commit, files and all,
        // and committing it again now gives the new generation.
        assert.equal(status, 'open', item.name)
        assert.ok(fs.existsSync(path.join(hosted.dataDir, 'staging', item.push, 'captures')), `${item.name}: the uploads are back`)
        const manifest = JSON.parse(fs.readFileSync(item.manifestFile, 'utf8'))
        createPushStore(tenant(db, ws), { db, dataDir: hosted.dataDir }).commit({
          pushId: item.push,
          projectId: item.project,
          manifest,
          variants: [],
        })
        assert.equal(generationOf(db, hosted.dataDir, ws, item.project), 2, `${item.name}: retried`)
      }
    }
    assert.deepEqual(fs.readdirSync(path.join(hosted.dataDir, 'swaps')), [], 'every journal settled')
  } finally {
    db.close()
  }
})

test('the sweep removes an old board folder only when its push committed, and leaves an unknown one alone', async () => {
  const hosted = await startHostedServer('push-crash-sweep')
  try {
    const owner = await signUp(hosted, { handle: 'sweeper' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
    const config = sampleConfig('push-crash-sweep')
    writeLocalCaptures(config, 'sample')
    const done = await pushBoard(remote, config, { commit: true })
    const base = path.join(hosted.dataDir, 'files', ws, project.id)
    // A committed push's leftover (its removal failed): proven replaced.
    fs.mkdirSync(path.join(base, `sample.old-${done.id}`))
    // A push this database never had: nothing proves it replaced.
    const unknown = path.join(base, 'sample.old-ps_111111111111111111111111')
    fs.mkdirSync(unknown)
    fs.writeFileSync(path.join(unknown, 'keep'), 'not provably orphaned')
    const logged = []
    sweepStaging({ db: hosted.db, dataDir: hosted.dataDir, log: (line) => logged.push(line) })
    assert.ok(!fs.existsSync(path.join(base, `sample.old-${done.id}`)))
    assert.ok(fs.existsSync(path.join(unknown, 'keep')))
    assert.equal(logged.length, 1)
    assert.match(logged[0], /sample\.old-ps_1+ in place/)
    assert.equal(generationOf(hosted.db, hosted.dataDir, ws, project.id), 3)
  } finally {
    await hosted.close()
  }
})
