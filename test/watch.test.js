import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProgram, splitCommand, watchComments } from '../src/watch.js'
import { boardDir, createComment, getComment, setAgentStatus, updateComment } from '../src/store.js'
import { loadConfig } from '../src/config.js'
import { SAMPLE, tempDir } from './helpers.js'

const FAKE_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs')
const valid = { pageId: 'home', viewport: 'desktop', x: 10, y: 10 }

// A config on disk (the agent command reads it through SHAPEWALL_CONFIG).
function setup(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  return { dir, config: loadConfig(file) }
}

const quiet = () => {}

test('splitCommand splits like a shell but refuses shell syntax', () => {
  assert.deepEqual(splitCommand(`claude -p "Fix the comment on stdin" --allowedTools 'Edit Bash(npm test)'`), [
    'claude',
    '-p',
    'Fix the comment on stdin',
    '--allowedTools',
    'Edit Bash(npm test)',
  ])
  assert.deepEqual(splitCommand(String.raw`a\ b "c\"d" ''`), ['a b', 'c"d', ''])
  for (const bad of [
    'agent | tee log',
    'agent; rm -rf x',
    'agent > out',
    'agent $(id)',
    'agent "$HOME"',
    'agent `id`',
    'agent "open',
    '  ',
  ]) {
    assert.throws(() => splitCommand(bad), /--exec/, bad)
  }
})

test('JSON lines: each open, unclaimed comment once, also across restarts', async () => {
  const { config } = setup('watch-json')
  const board = config.boards[0]
  const a = await createComment(config, board, { ...valid, body: 'One' })
  const b = await createComment(config, board, { ...valid, body: 'Two' })
  const c = await createComment(config, board, { ...valid, body: 'Resolved already' })
  await updateComment(config, board.id, c.id, { status: 'resolved' })
  const d = await createComment(config, board, { ...valid, body: 'An agent has it' })
  await setAgentStatus(config, board.id, d.id, 'working')
  const lines = []
  await watchComments({ config, once: true, out: (line) => lines.push(line), log: quiet })
  const items = lines.map((line) => JSON.parse(line))
  assert.deepEqual(
    items.map((item) => [item.board, item.comment.id, item.comment.agentStatus]),
    [
      ['sample', a.id, 'queued'],
      ['sample', b.id, 'queued'],
    ],
  )
  assert.equal(items[0].comment.page.url, 'http://127.0.0.1:9/')
  assert.equal(getComment(config, board.id, b.id).agentStatus, 'queued')
  // A second run (a restart) hands out nothing new.
  lines.length = 0
  await watchComments({ config, once: true, out: (line) => lines.push(line), log: quiet })
  assert.deepEqual(lines, [])
  // A reopened comment is new work.
  await updateComment(config, board.id, c.id, { status: 'open' })
  await watchComments({ config, once: true, out: (line) => lines.push(line), log: quiet })
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).comment.id),
    [c.id],
  )
})

test('--exec: comment JSON on stdin, ids in env, status from the exit code', async () => {
  const { config, dir } = setup('watch-exec')
  const board = config.boards[0]
  const ok = await createComment(config, board, { ...valid, body: 'ok' })
  const fail = await createComment(config, board, { ...valid, body: 'fail' })
  const resolve = await createComment(config, board, { ...valid, body: 'resolve' })
  const sneaky = await createComment(config, board, { ...valid, body: '$(touch pwned) `touch pwned2`; touch pwned3' })
  const reply = await createComment(config, board, { ...valid, body: 'reply' })
  const outDir = path.join(dir, 'agent-out')
  fs.mkdirSync(outDir)
  const logs = []
  await watchComments({
    config,
    once: true,
    exec: `"${process.execPath}" "${FAKE_AGENT}" "${outDir}"`,
    log: (line) => logs.push(line),
    out: () => assert.fail('nothing is printed in --exec mode'),
  })
  const got = JSON.parse(fs.readFileSync(path.join(outDir, `got-${ok.id}.json`), 'utf8'))
  assert.equal(got.input.board, 'sample')
  assert.equal(got.input.comment.id, ok.id)
  assert.equal(got.input.comment.element, null)
  assert.equal(got.env.SHAPEWALL_COMMENT_ID, String(ok.id))
  assert.equal(got.env.SHAPEWALL_PAGE_ID, 'home')
  assert.equal(got.env.SHAPEWALL_CONFIG, config.file)
  assert.equal(JSON.parse(fs.readFileSync(got.env.SHAPEWALL_COMMENT_FILE, 'utf8')).comment.id, ok.id)
  assert.deepEqual(got.argv, [outDir])
  // The comment text never reaches a command line or env var.
  const gotSneaky = JSON.parse(fs.readFileSync(path.join(outDir, 'got-4.json'), 'utf8'))
  assert.ok(!Object.values(gotSneaky.env).some((value) => value.includes('pwned')))
  assert.ok(!gotSneaky.argv.some((value) => value.includes('pwned')))
  // Exit 0 without a reply or status is not "done": a person looks.
  const silent = getComment(config, board.id, ok.id)
  assert.equal(silent.agentStatus, 'needs-human')
  assert.match(silent.replies.at(-1).body, /exited 0 without a reply or a status change/)
  const answered = getComment(config, board.id, reply.id)
  assert.equal(answered.agentStatus, 'done')
  assert.equal(answered.replies.at(-1).body, 'Fixed it')
  const failed = getComment(config, board.id, fail.id)
  assert.equal(failed.agentStatus, 'needs-human')
  assert.equal(failed.replies[0].author, 'shapewall')
  assert.match(failed.replies[0].body, /exited with code 3/)
  assert.match(fs.readFileSync(path.join(config.outputDir, 'sample', 'agent', `comment-${fail.id}.log`), 'utf8'), /could not do it/)
  const resolved = getComment(config, board.id, resolve.id)
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.resolution, 'Done by the fake agent')
  assert.equal(getComment(config, board.id, sneaky.id).agentStatus, 'needs-human')
  for (const name of ['pwned', 'pwned2', 'pwned3']) assert.equal(fs.existsSync(path.join(config.dir, name)), false, name)
  assert.ok(logs.some((line) => /#\d+ done \(exit 0/.test(line)))
})

test('live: new comments are picked up as they arrive; one watcher per board', async () => {
  const { config } = setup('watch-live')
  const board = config.boards[0]
  const old = await createComment(config, board, { ...valid, body: 'Before the watch' })
  const controller = new AbortController()
  const seen = []
  let notify
  const running = watchComments({
    config,
    newOnly: true,
    pollMs: 60000, // only the fs watch can wake it in time
    debounceMs: 20,
    signal: controller.signal,
    out: (line) => {
      seen.push(JSON.parse(line).comment.id)
      notify?.()
    },
    log: quiet,
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await assert.rejects(watchComments({ config, once: true, log: quiet }), /Another "shapewall watch" is running/)
    const fresh = await createComment(config, board, { ...valid, body: 'New one' })
    let timer
    await new Promise((resolve, reject) => {
      notify = resolve
      if (seen.length) resolve()
      timer = setTimeout(() => reject(new Error('the watcher did not pick up the comment')), 5000)
    }).finally(() => clearTimeout(timer))
    assert.deepEqual(seen, [fresh.id])
    assert.equal(getComment(config, board.id, old.id).agentStatus, null)
  } finally {
    controller.abort()
    await running
  }
  // The lock is released when the watch stops.
  await watchComments({ config, once: true, out: quiet, log: quiet })
})

test('--exec: a command past its timeout is stopped and handed to a person', async () => {
  const { config, dir } = setup('watch-timeout')
  const { id } = await createComment(config, config.boards[0], { ...valid, body: 'hang' })
  const started = Date.now()
  await watchComments({ config, once: true, timeoutMs: 400, exec: `"${process.execPath}" "${FAKE_AGENT}" "${dir}"`, log: quiet })
  assert.ok(Date.now() - started < 10000)
  const comment = getComment(config, 'sample', id)
  assert.equal(comment.agentStatus, 'needs-human')
  assert.match(comment.replies[0].body, /timeout/)
})

test('--exec refuses a program that is not there', async () => {
  const { config } = setup('watch-missing')
  await assert.rejects(watchComments({ config, once: true, exec: 'no-such-agent-binary --x', log: quiet }), /not an executable on PATH/)
})

test('--exec: a comment whose run fails before the command starts is handed to a person, not left queued', async () => {
  const { config, dir } = setup('watch-throws')
  const { id } = await createComment(config, config.boards[0], { ...valid, body: 'fix it' })
  // The comment file's path is taken by a folder: writing it throws.
  fs.mkdirSync(path.join(boardDir(config, 'sample'), 'agent', `comment-${id}.json`), { recursive: true })
  const lines = []
  await watchComments({ config, once: true, exec: `"${process.execPath}" "${FAKE_AGENT}" "${dir}"`, log: (line) => lines.push(line) })
  assert.equal(getComment(config, 'sample', id).agentStatus, 'needs-human')
  assert.ok(lines.some((line) => line.startsWith(`#${id} error:`)))
})

test('findProgram looks a bare name up on absolute PATH entries only', () => {
  const folder = tempDir('watch-relative-path')
  fs.writeFileSync(path.join(folder, 'my-agent'), '#!/bin/sh\n', { mode: 0o755 })
  const cwd = process.cwd()
  process.chdir(folder)
  try {
    assert.equal(findProgram('my-agent', { PATH: '.' }), null)
    assert.equal(findProgram('my-agent', { PATH: folder }), path.join(folder, 'my-agent'))
    assert.equal(findProgram('./my-agent', { PATH: '' }), path.join(folder, 'my-agent'), 'an explicit path still works')
  } finally {
    process.chdir(cwd)
  }
})
