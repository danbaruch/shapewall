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
