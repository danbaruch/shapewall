// The starter agent outside the sandbox: a hosted run keeps its claim alive
// (the server's 10-minute claim sweep, src/hosted/claim-sweep.js), and a
// local run's changes go to the configured notification channels.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { agentCommand } from '../src/agent/starter/cli.js'
import { starterSettings } from '../src/agent/starter/settings.js'
import { localSource, remoteSource } from '../src/agent/starter/source.js'
import { CLAIM_HEARTBEAT_MS, runStarter } from '../src/agent/starter/supervisor.js'
import { CLAIM_HEARTBEAT } from '../src/hosted/claim-sweep.js'
import { loadConfig } from '../src/config.js'
import { createComment, getComment } from '../src/store.js'
import { SAMPLE, tempDir } from './helpers.js'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// A project with one commit, a model endpoint nothing listens on, a trusted
// author, and (optionally) notifications.
function project(name, extra = {}) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...structuredClone(SAMPLE),
      agent: { baseUrl: 'http://127.0.0.1:9/v1', model: 'stub-model' },
      starterAgent: { trusted: ['robin'] },
      ...extra,
    }),
  )
  fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\n')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
  return { dir, file, config: loadConfig(file) }
}

// A container runtime whose every command fails: the run stops at its first
// network step, after the claim.
function failingRuntime() {
  return {
    name: 'podman',
    bin: '/usr/bin/podman',
    async exec() {
      return { code: 1, stdout: '', stderr: 'no runtime in tests' }
    },
    spawn() {
      throw new Error('no runtime in tests')
    },
  }
}

test('the heartbeat runs often enough for the hosted claim sweep', () => {
  assert.ok(CLAIM_HEARTBEAT_MS >= CLAIM_HEARTBEAT.touchEveryMs, 'no more often than the server writes it')
  assert.ok(CLAIM_HEARTBEAT_MS * 3 <= CLAIM_HEARTBEAT.staleMs, 'several beats before a claim goes stale')
})

test('a hosted source heartbeat is a token call on the comment', async () => {
  const calls = []
  const source = await remoteSource({ comment: async (board, id) => (calls.push([board, id]), { comment: { id } }) }, 'web')
  await source.heartbeat(7)
  assert.deepEqual(calls, [['web', 7]])
  assert.equal(localSource(project('starter-local-beat').config).heartbeat, undefined, 'a local claim names its process instead')
})

test('a run with a hosted-style source beats while it holds the claim, and stops when it lets go', async () => {
  const { dir, config } = project('starter-heartbeat')
  await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Fix it', author: 'Robin' })
  const beats = []
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  const local = localSource(config)
  // The local board stands in for the server; the run waits in its first
  // runtime step until the test has seen a few beats.
  const source = { ...local, heartbeat: async (id) => beats.push(id) }
  const runtime = {
    ...failingRuntime(),
    async exec() {
      await held
      return { code: 1, stdout: '', stderr: 'no runtime in tests' }
    },
  }
  const run = runStarter({
    source,
    settings: starterSettings(config, { env: {} }),
    runtime,
    image: 'img',
    commentId: 1,
    projectDir: dir,
    workDir: tempDir('starter-heartbeat-work'),
    env: {},
    heartbeatMs: 20,
  })
  const end = Date.now() + 3000
  while (beats.length < 3 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(beats.length >= 3, `beats while the run holds the claim (${beats.length})`)
  assert.ok(beats.every((id) => id === 1))
  release()
  const result = await run
  assert.equal(result.status, 'needs-human')
  const count = beats.length
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(beats.length, count, 'no beats after the run let go of the claim')
})

test('agent sandbox run on a local board sends its changes to the notification channels', async () => {
  const requests = []
  const hook = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200).end('{}')
    })
  })
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve))
  const saved = { ...process.env }
  process.env.SHAPEWALL_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`
  process.env.SHAPEWALL_WEBHOOK_SECRET = 'whsec-test-0123456789'
  try {
    const { config, file } = project('starter-notify', {
      notifications: { retries: 0, channels: [{ id: 'hooks', type: 'webhook', events: ['all'] }] },
    })
    await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Fix it', author: 'Robin' })
    // A podman on PATH that fails every command.
    const bin = tempDir('starter-notify-bin')
    fs.writeFileSync(path.join(bin, 'podman'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const errors = []
    const code = await agentCommand(
      ['sandbox', 'run'],
      { comment: '1', config: file },
      () => {},
      (line) => errors.push(line),
      {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SHAPEWALL_AGENT_RUNTIME: '' },
      },
    )
    assert.equal(code, 1)
    assert.equal(getComment(config, config.boards[0].id, 1).agentStatus, 'needs-human')
    const types = requests.map((item) => item.type)
    assert.ok(types.includes('comment.agent_status_changed'), `status changes are sent (${types.join(', ')})`)
    assert.ok(types.includes('comment.replied'), 'the run reply is sent')
  } finally {
    for (const key of ['SHAPEWALL_WEBHOOK_URL', 'SHAPEWALL_WEBHOOK_SECRET']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await new Promise((resolve) => hook.close(resolve))
  }
})
