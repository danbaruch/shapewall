// Writers of a hosted board folder and the board-job lock (<board>/capture.lock).
// Only the solo engine's in-process capture takes that lock on a server; the
// lock is planted here on a plain server.
// - rev58 G3-1: a push refuses, in src/hosted/push.js itself, however the
//   push route is spelled.
// - rev58 G3-3: a backup waits for the job to end (and fails if it does not).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { acquireBoardJob } from '../src/board-job.js'
import { backup } from '../src/hosted/backup.js'
import { projectDir } from '../src/hosted/projects.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, createToken, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'

test('a push start and a push commit refuse while a board job holds the board folder (any route spelling)', async () => {
  const hosted = await startHostedServer('push-board-job')
  try {
    const owner = await signUp(hosted, { handle: 'jobs' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const token = await createToken(owner, ws, project.id)
    const remote = createRemote({ origin: hosted.origin, token })
    const config = sampleConfig('push-board-job')
    writeLocalCaptures(config, 'sample')
    const board = config.boards[0]
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
    const folder = { outputDir: projectDir(hosted.dataDir, ws, project.id) }

    // A push started before the job: its commit waits (409), in either case of the route.
    const started = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    const job = acquireBoardJob(folder, 'sample', 'capture')
    assert.equal(job.ok, true)
    try {
      for (const route of [`/api/v1/pushes/${started.id}/commit`, `/api/v1/PUSHES/${started.id}/COMMIT`]) {
        const commit = await tokenCall(hosted, token, 'POST', route, { body: { manifest, variants: [] } })
        assert.equal(commit.status, 409, `${route} ${commit.text}`)
        assert.equal(commit.json.error.code, 'capture_running')
      }
      assert.equal(fs.existsSync(path.join(folder.outputDir, 'sample', 'capture.lock')), true, 'the board folder stayed in place')
      // A new push (whole or pages) is refused at its start too.
      for (const route of ['/api/v1/pushes', '/api/v1/PUSHES']) {
        const start = await tokenCall(hosted, token, 'POST', route, { body: pushDefinition(config, board) })
        assert.equal(start.status, 409, start.text)
        assert.equal(start.json.error.code, 'capture_running')
      }
      const pages = await tokenCall(hosted, token, 'POST', '/api/v1/pushes', {
        body: { mode: 'pages', board: 'sample', pages: { home: ['desktop'] } },
      })
      assert.equal(pages.status, 409, pages.text)
    } finally {
      job.release()
    }
    // Once the job is over, the same push commits.
    const commit = await tokenCall(hosted, token, 'POST', `/api/v1/pushes/${started.id}/commit`, { body: { manifest, variants: [] } })
    assert.equal(commit.status, 200, commit.text)
  } finally {
    await hosted.close()
  }
})

test('a backup waits while a board job holds a board folder, and fails if it does not end', async () => {
  const hosted = await startHostedServer('backup-board-job')
  try {
    const owner = await signUp(hosted, { handle: 'backs' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
    const config = sampleConfig('backup-board-job')
    writeLocalCaptures(config, 'sample')
    const board = config.boards[0]
    const started = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
    await remote.commitPush(started.id, { manifest, variants: [] })

    const job = acquireBoardJob({ outputDir: projectDir(hosted.dataDir, ws, project.id) }, 'sample', 'capture')
    assert.equal(job.ok, true)
    let released = false
    try {
      await assert.rejects(
        backup({ dataDir: hosted.dataDir, to: tempDir('backup-board-job-out'), busyWaitMs: 150, busyPollMs: 30 }),
        /capture of board .*sample is still running/,
      )
      const lines = []
      setTimeout(() => {
        job.release()
        released = true
      }, 120)
      const saved = await backup({
        dataDir: hosted.dataDir,
        to: tempDir('backup-board-job-ok'),
        busyPollMs: 30,
        log: (line) => lines.push(line),
      })
      assert.ok(released, 'the backup waited for the job')
      assert.ok(lines.some((line) => /waiting for the capture of board/.test(line)))
      assert.ok(fs.existsSync(path.join(saved.dir, 'files', ws, project.id, 'sample', 'captures', 'manifest.json')))
    } finally {
      if (!released) job.release()
    }
  } finally {
    await hosted.close()
  }
})

// rev58 RR1-L1: a capture in another process can take its lock after the backup looked and while the pin
// runs. The locks are read again after the pin: the pin is dropped and the backup waits, then pins again.
test('a board job that starts while the backup pins drops the pin, and the backup waits and pins again', async () => {
  const hosted = await startHostedServer('backup-board-job-race')
  const realLink = fs.linkSync
  try {
    const owner = await signUp(hosted, { handle: 'races' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
    const config = sampleConfig('backup-board-job-race')
    writeLocalCaptures(config, 'sample')
    const board = config.boards[0]
    const started = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
    await remote.commitPush(started.id, { manifest, variants: [] })

    const outputDir = projectDir(hosted.dataDir, ws, project.id)
    let job = null
    let links = 0
    // The first link of the pin: a capture takes the board right then (as from another process).
    // (The lock itself is made with a link: only the backup's links count.)
    let taking = false
    fs.linkSync = (...args) => {
      if (taking) return realLink(...args)
      links += 1
      if (!job) {
        taking = true
        try {
          job = acquireBoardJob({ outputDir }, 'sample', 'capture')
        } finally {
          taking = false
        }
        assert.equal(job.ok, true)
        setTimeout(() => job.release(), 150)
      }
      return realLink(...args)
    }
    const lines = []
    const saved = await backup({
      dataDir: hosted.dataDir,
      to: tempDir('backup-board-job-race-out'),
      busyPollMs: 30,
      log: (line) => lines.push(line),
    })
    assert.ok(job, 'the job started during the pin')
    assert.ok(
      lines.some((line) => /waiting for the capture of board/.test(line)),
      'the backup waited for the job',
    )
    assert.ok(links > 1, 'the board was pinned again')
    assert.equal(saved.manifest?.complete ?? true, true)
    assert.ok(fs.existsSync(path.join(saved.dir, 'files', ws, project.id, 'sample', 'captures', 'manifest.json')))
    assert.deepEqual(
      fs.readdirSync(hosted.dataDir).filter((name) => name.startsWith('.backup-pin-')),
      [],
      'no pin is left in the data folder',
    )
  } finally {
    fs.linkSync = realLink
    await hosted.close()
  }
})

// B-7: a short job of another process could start and end inside the pin, unseen by the re-check after it.
// The backup now holds each board's job lock while it pins: a job that tries to start then is refused.
test('a board job cannot start while the backup pins its board: the backup holds the job lock', async () => {
  const hosted = await startHostedServer('backup-board-job-held')
  const realLink = fs.linkSync
  try {
    const owner = await signUp(hosted, { handle: 'holds' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
    const config = sampleConfig('backup-board-job-held')
    writeLocalCaptures(config, 'sample')
    const board = config.boards[0]
    const started = await remote.startPush(pushDefinition(config, board))
    for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
    await remote.commitPush(started.id, { manifest, variants: [] })

    const outputDir = projectDir(hosted.dataDir, ws, project.id)
    let tried = null
    fs.linkSync = (from, to) => {
      // The first link of the pin itself (not a lock being made).
      if (!tried && !/capture\.lock/.test(String(to))) tried = acquireBoardJob({ outputDir }, 'sample', 'capture')
      return realLink(from, to)
    }
    const saved = await backup({ dataDir: hosted.dataDir, to: tempDir('backup-board-job-held-out'), busyPollMs: 30 })
    assert.ok(tried, 'a job tried to start during the pin')
    assert.equal(tried.ok, false, 'refused')
    assert.equal(tried.holder, 'backup')
    assert.equal(fs.existsSync(path.join(outputDir, 'sample', 'capture.lock')), false, 'the backup let go of the lock')
    assert.equal(fs.existsSync(path.join(saved.dir, 'files', ws, project.id, 'sample', 'capture.lock')), false, 'no lock in the backup')
  } finally {
    fs.linkSync = realLink
    await hosted.close()
  }
})

// B-8: the commit checked the board-job lock but did not hold it, so a capture of another process could take
// the board between the check and the swap. The commit now holds the lock from the check through the swap.
test('a board job cannot start while a push commit swaps the board: the commit holds the job lock', async () => {
  const hosted = await startHostedServer('push-board-job-held')
  const realRename = fs.renameSync
  try {
    const owner = await signUp(hosted, { handle: 'swaps' })
    const ws = owner.workspaceId
    const project = await createProject(owner, ws, 'Site')
    const remote = createRemote({ origin: hosted.origin, token: await createToken(owner, ws, project.id) })
    const config = sampleConfig('push-board-job-held')
    writeLocalCaptures(config, 'sample')
    const board = config.boards[0]
    const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
    const push = async () => {
      const started = await remote.startPush(pushDefinition(config, board))
      for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
      return remote.commitPush(started.id, { manifest, variants: [] })
    }
    await push()
    const outputDir = projectDir(hosted.dataDir, ws, project.id)
    const folder = path.join(outputDir, 'sample')
    let tried = null
    let between = null
    let betweenLeft = null
    fs.renameSync = (from, to) => {
      // The swap's first rename: the board folder moving aside.
      if (!tried && path.resolve(String(from)) === folder) tried = acquireBoardJob({ outputDir }, 'sample', 'capture')
      // B-17: between the two renames the folder is not there; a job then is refused too, and leaves none behind.
      if (!between && path.resolve(String(to)) === folder) {
        between = acquireBoardJob({ outputDir }, 'sample', 'capture')
        betweenLeft = fs.existsSync(folder)
      }
      return realRename(from, to)
    }
    await push()
    fs.renameSync = realRename
    assert.ok(tried, 'a job tried to start during the swap')
    assert.equal(tried.ok, false, 'refused')
    assert.equal(tried.holder, 'push')
    assert.equal(between?.ok, false, 'refused between the renames')
    assert.equal(between.holder, 'push')
    assert.equal(betweenLeft, false, 'no folder left where the new one goes')
    assert.equal(fs.existsSync(path.join(folder, 'capture.lock')), false, 'the commit let go of the lock')
    // B-17: the swap lock beside the folder, held through both renames, is gone too.
    assert.equal(fs.existsSync(`${folder}.swap.lock`), false, 'the commit let go of the swap lock')
    const after = acquireBoardJob({ outputDir }, 'sample', 'capture')
    assert.equal(after.ok, true)
    after.release()
  } finally {
    fs.renameSync = realRename
    await hosted.close()
  }
})
