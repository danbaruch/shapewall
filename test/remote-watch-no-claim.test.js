// `watch --no-claim` against the solo engine (IC4 B2b): the remote loop only
// looks, as the local one does. Every open comment once per process (again
// when it is reopened), printed or run, and never an agent status or a reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { watchRemote } from '../src/remote/remote-watch.js'
import { tempDir } from './helpers.js'

const item = (id, extra = {}) => ({
  id,
  body: `Comment ${id}`,
  status: 'open',
  agentStatus: null,
  reopenCount: 0,
  replies: [],
  viewport: { name: 'desktop' },
  page: { id: 'home', url: 'http://127.0.0.1:1/' },
  files: {},
  ...extra,
})

function fakeRemote(pages) {
  const writes = []
  let call = 0
  return {
    writes,
    origin: 'http://127.0.0.1:1',
    comments: async () => ({ board: { id: 'main' }, comments: pages[Math.min(call++, pages.length - 1)] }),
    setAgentStatus: async (...args) => {
      writes.push(['status', ...args])
      return { changed: true, comment: null }
    },
    reply: async (...args) => {
      writes.push(['reply', ...args])
      return {}
    },
    comment: async () => ({ comment: null }),
    download: async () => Buffer.from(''),
  }
}

test('--no-claim prints every open comment once, whatever its agent status, and writes nothing', async () => {
  const remote = fakeRemote([[item(1), item(2, { agentStatus: 'done' })]])
  const printed = []
  await watchRemote({
    remote,
    boardId: 'main',
    projectId: 'pr_' + 'a'.repeat(24),
    once: true,
    claim: false,
    cwd: tempDir('remote-no-claim-print'),
    out: (line) => printed.push(JSON.parse(line).comment.id),
    log: () => {},
  })
  assert.deepEqual(printed, [1, 2])
  assert.deepEqual(remote.writes, [])
})

test('--no-claim with --exec runs each comment once, again after a reopen, and sets no status', async () => {
  const cwd = tempDir('remote-no-claim-exec')
  const remote = fakeRemote([[item(1)], [item(1)], [item(1, { reopenCount: 1 })]])
  const logs = []
  const controller = new AbortController()
  let scans = 0
  const comments = remote.comments
  remote.comments = async (...args) => {
    scans += 1
    // The last page (the reopened comment) repeats: it is run once more, not on every scan.
    if (scans > 40) controller.abort()
    return comments(...args)
  }
  await watchRemote({
    remote,
    boardId: 'main',
    projectId: 'pr_' + 'b'.repeat(24),
    exec: `${process.execPath} --version`,
    claim: false,
    pollMs: 10,
    signal: controller.signal,
    cwd,
    out: () => {},
    log: (line) => logs.push(line),
    env: { PATH: process.env.PATH },
  })
  const finished = logs.filter((line) => /^#1 finished \(exit 0, \d+s\); --no-claim leaves its agent status alone$/.test(line))
  assert.equal(finished.length, 2, logs.join('\n'))
  assert.deepEqual(remote.writes, [])
  assert.ok(fs.existsSync(path.join(cwd, '.shapewall', 'remote', 'pr_' + 'b'.repeat(24), 'main', 'agent', 'comment-1.json')))
})
