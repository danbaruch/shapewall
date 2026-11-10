// The chat's run summary and Undo (src/agent/turn-changes.js): what an
// owner's agent turn changed, with counts and diffs, and an Undo that
// restores exactly those files, all or nothing, only while they are still
// what the agent left. The starter agent's Undo deletes its unpushed branch,
// checked in Git itself. Over HTTP: owner only, same origin, never mid-turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createApp, stopChildren } from '../src/server/app.js'
import { loadConfig } from '../src/config.js'
import { createComment, getComment, setAgentStatus } from '../src/store.js'
import { beginTurnChanges, finishTurnChanges, starterSummary, undoFiles, undoStarterBranch } from '../src/agent/turn-changes.js'
import { AGENT_AUTHOR } from '../src/agent/starter/worktree.js'
import { REFS_RULE, SYSTEM_PROMPT, ACP_PREAMBLE } from '../src/agent/context.js'
import { SAMPLE, request, tempDir } from './helpers.js'

const token = 'run-summary-test-token'
const fixture = path.resolve('test/fixtures/acp-fix.mjs')
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })

function setup(name) {
  const dir = tempDir(name)
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify(SAMPLE))
  return loadConfig(file)
}
const write = (config, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(config.dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(config.dir, rel), text)
}
const read = (config, rel) => fs.readFileSync(path.join(config.dir, rel), 'utf8')
const gitIn = (dir, args, env = {}) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env } }).trim()

test('the agent is told how to point at the board', () => {
  assert.match(REFS_RULE, /\[\[comment:12\]\]/)
  assert.match(REFS_RULE, /Never invent an id/)
  assert.ok(SYSTEM_PROMPT.includes(REFS_RULE))
  assert.ok(ACP_PREAMBLE.includes(REFS_RULE))
})

test('a turn summary lists added, changed and deleted files with counts, and Undo restores them', async () => {
  const config = setup('summary-files')
  write(config, 'src/page.html', '<h1>Old</h1>\n<p>Keep</p>\n')
  write(config, 'src/gone.css', 'a { color: red; }\n')
  write(config, 'src/same.js', 'export const same = 1\n')
  fs.mkdirSync(path.join(config.dir, 'node_modules'), { recursive: true })
  const baseline = await beginTurnChanges(config, { comments: [] })
  write(config, 'src/page.html', '<h1>New</h1>\n<p>Keep</p>\n')
  write(config, 'src/added.txt', 'one\ntwo\n')
  fs.rmSync(path.join(config.dir, 'src/gone.css'))
  // Rewritten with the same text: not a change.
  write(config, 'src/same.js', 'export const same = 1\n')
  write(config, 'node_modules/dep.js', 'ignored')
  fs.mkdirSync(config.outputDir, { recursive: true })
  fs.writeFileSync(path.join(config.outputDir, 'store.json'), '{}')
  const { summary, undo } = await finishTurnChanges(config, baseline, { comments: [], board: config.boards[0], reply: { text: '' } })
  assert.deepEqual(
    summary.files.map((item) => [item.path, item.status, item.added, item.removed]),
    [
      ['src/added.txt', 'added', 2, 0],
      ['src/gone.css', 'deleted', 0, 1],
      ['src/page.html', 'modified', 1, 1],
    ],
  )
  assert.equal(summary.added, 3)
  assert.equal(summary.removed, 2)
  assert.match(summary.files[2].diff.preview, /-<h1>Old<\/h1>\n\+<h1>New<\/h1>/)
  assert.deepEqual(summary.undo, { kind: 'files', available: true })
  assert.ok(undo)
  // Nothing in the summary carries file content beyond the bounded diffs.
  assert.ok(!JSON.stringify(summary).includes('before'))

  const done = undoFiles(config, undo)
  assert.deepEqual(done.sort(), ['src/added.txt', 'src/gone.css', 'src/page.html'])
  assert.equal(read(config, 'src/page.html'), '<h1>Old</h1>\n<p>Keep</p>\n')
  assert.equal(read(config, 'src/gone.css'), 'a { color: red; }\n')
  assert.equal(fs.existsSync(path.join(config.dir, 'src/added.txt')), false)
})

test('Undo changes nothing when a file was edited after the turn', async () => {
  const config = setup('summary-conflict')
  write(config, 'a.txt', 'a0\n')
  write(config, 'b.txt', 'b0\n')
  const baseline = await beginTurnChanges(config)
  write(config, 'a.txt', 'a1\n')
  write(config, 'b.txt', 'b1\n')
  const { undo } = await finishTurnChanges(config, baseline, { board: config.boards[0] })
  write(config, 'b.txt', 'b2 by a person\n')
  assert.throws(
    () => undoFiles(config, undo),
    (error) => error.code === 'undo_conflict' && /b\.txt changed after/.test(error.message),
  )
  assert.equal(read(config, 'a.txt'), 'a1\n', 'all or nothing: a.txt was not restored either')
  // A symlink put where the file was is never written through.
  fs.rmSync(path.join(config.dir, 'b.txt'))
  fs.symlinkSync('/etc/hostname', path.join(config.dir, 'b.txt'))
  assert.throws(
    () => undoFiles(config, undo),
    (error) => error.code === 'undo_conflict',
  )
})

test('Undo changes nothing when a folder of a deleted file was replaced after the turn', async () => {
  const config = setup('summary-folder-swap')
  write(config, 'a.txt', 'a0\n')
  write(config, 'sub/c.txt', 'c0\n')
  const baseline = await beginTurnChanges(config)
  write(config, 'a.txt', 'a1\n')
  fs.rmSync(path.join(config.dir, 'sub/c.txt'))
  const { undo } = await finishTurnChanges(config, baseline, { board: config.boards[0] })
  assert.ok(undo)
  // The folder becomes a link elsewhere: never written through, and a.txt stays too.
  const elsewhere = tempDir('summary-folder-elsewhere')
  fs.rmSync(path.join(config.dir, 'sub'), { recursive: true })
  fs.symlinkSync(elsewhere, path.join(config.dir, 'sub'))
  assert.throws(
    () => undoFiles(config, undo),
    (error) => error.code === 'undo_conflict',
  )
  assert.equal(read(config, 'a.txt'), 'a1\n', 'all or nothing')
  assert.deepEqual(fs.readdirSync(elsewhere), [])
})

test('secrets files are never diffed, and their change turns Undo off', async () => {
  const config = setup('summary-secrets')
  write(config, '.env', 'API_KEY=one\n')
  const baseline = await beginTurnChanges(config)
  write(config, '.env', 'API_KEY=two\n')
  const { summary, undo } = await finishTurnChanges(config, baseline, { board: config.boards[0] })
  assert.equal(summary.files[0].hidden, true)
  assert.equal(summary.files[0].diff, null)
  assert.ok(!JSON.stringify(summary).includes('API_KEY'))
  assert.equal(summary.undo.available, false)
  assert.match(summary.undo.reason, /earlier version of \.env was not kept/)
  assert.equal(undo, null)
})

test('an overlapping turn or a Git commit turns Undo off; resolved comments and pages are listed', async () => {
  const config = setup('summary-git')
  gitIn(config.dir, ['init', '-q', '-b', 'main'])
  gitIn(config.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base'])
  const board = config.boards[0]
  const comment = await createComment(config, board, { pageId: 'pricing', viewport: 'desktop', x: 1, y: 1, body: 'Fix it' })
  write(config, 'index.html', 'old\n')
  const before = [{ id: comment.id, status: 'open', pageId: 'pricing' }]
  const baseline = await beginTurnChanges(config, { comments: before })
  write(config, 'index.html', 'new\n')
  gitIn(config.dir, ['add', 'index.html'])
  gitIn(config.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'Agent: new heading'])
  const after = [{ id: comment.id, status: 'resolved', pageId: 'pricing' }]
  const { summary, undo } = await finishTurnChanges(config, baseline, {
    comments: after,
    board,
    reply: { text: 'Opened https://github.com/acme/site/pull/42 for review.' },
  })
  assert.equal(summary.commit.commits[0].subject, 'Agent: new heading')
  assert.equal(summary.commit.branch, 'main')
  assert.deepEqual(summary.pr, { url: 'https://github.com/acme/site/pull/42' })
  assert.deepEqual(summary.resolved, [comment.id])
  assert.deepEqual(summary.recapture, ['pricing'])
  assert.equal(summary.undo.available, false)
  assert.match(summary.undo.reason, /Git commit/)
  assert.equal(undo, null)

  const second = await beginTurnChanges(config)
  write(config, 'index.html', 'newer\n')
  const overlapped = await finishTurnChanges(config, second, { board, overlapped: true })
  assert.match(overlapped.summary.undo.reason, /another agent turn/)
  assert.equal(overlapped.undo, null)
})

test('the starter agent summary reads its commit, and Undo deletes only its own unpushed branch', async () => {
  const config = setup('summary-starter')
  const repo = config.dir
  gitIn(repo, ['init', '-q', '-b', 'main'])
  write(config, 'page.html', 'one\n')
  gitIn(repo, ['add', 'page.html'])
  gitIn(repo, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base'])
  const base = gitIn(repo, ['rev-parse', 'HEAD'])
  const agentEnv = {
    GIT_AUTHOR_NAME: AGENT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: AGENT_AUTHOR.email,
    GIT_COMMITTER_NAME: AGENT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: AGENT_AUTHOR.email,
  }
  const branch = 'shapewall/sample-1-abc123'
  gitIn(repo, ['checkout', '-q', '-b', branch])
  write(config, 'page.html', 'two\n')
  gitIn(repo, ['add', 'page.html'])
  gitIn(repo, ['commit', '-q', '-m', 'Shapewall starter agent: comment sample/1\n\nshapewall:sample/1\nRun x.'], agentEnv)
  const commit = gitIn(repo, ['rev-parse', 'HEAD'])
  gitIn(repo, ['checkout', '-q', 'main'])
  const gitDir = path.join(repo, '.git')
  const tree = { gitDir, repo, base, dir: repo, projectDir: repo }
  const summary = await starterSummary({
    tree,
    commit: { commit, files: ['page.html'], added: [], deleted: [], modified: ['page.html'] },
    branch,
  })
  assert.deepEqual(
    summary.files.map((item) => [item.path, item.status, item.added, item.removed]),
    [['page.html', 'modified', 1, 1]],
  )
  assert.deepEqual(summary.undo, { kind: 'branch', available: true, branch, commit })
  const pushed = await starterSummary({
    tree,
    commit: { commit, files: ['page.html'] },
    branch,
    pr: { url: 'https://github.com/a/b/pull/1' },
  })
  assert.equal(pushed.undo.available, false)

  // Another comment's run, a moved branch, a pushed branch: all refused.
  await assert.rejects(undoStarterBranch(config, { boardId: 'sample', commentId: 2, branch, commit }), /not the starter agent run/)
  await assert.rejects(undoStarterBranch(config, { boardId: 'sample', commentId: 1, branch, commit: base }), /moved or is gone/)
  await assert.rejects(undoStarterBranch(config, { boardId: 'sample', commentId: 1, branch: '../main', commit }), /cannot be undone/)
  gitIn(repo, ['update-ref', 'refs/remotes/origin/feature', commit])
  await assert.rejects(undoStarterBranch(config, { boardId: 'sample', commentId: 1, branch, commit }), /was pushed/)
  gitIn(repo, ['update-ref', '-d', 'refs/remotes/origin/feature'])
  await undoStarterBranch(config, { boardId: 'sample', commentId: 1, branch, commit })
  assert.equal(gitIn(repo, ['branch', '--list', branch]), '')
  assert.equal(gitIn(repo, ['rev-parse', 'main']), base, 'the base branch is untouched')
})

test('over HTTP: an owner ACP turn stores a summary, Undo is owner-only and restores the file once', async () => {
  const config = setup('summary-http')
  write(config, 'index.html', '<h1>Before</h1>\n')
  const comment = await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Heading' })
  const app = createApp({
    config,
    settingsToken: token,
    agentAcp: `${process.execPath} ${fixture} edit`,
    capture: async () => ({ ok: true }),
  })
  const server = await listen(app)
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  const owner = { Origin: origin, 'X-Shapewall-Settings-Token': token }
  const thread = `/api/agent/boards/sample/threads/comment-${comment.id}`
  try {
    const sent = await request(port, 'POST', `${thread}/messages`, { headers: owner, body: { text: 'Change the heading' } })
    assert.equal(sent.status, 200)
    assert.match(read(config, 'index.html'), /Fixed fixture heading/)
    const stored = (await request(port, 'GET', thread, { headers: owner })).json
    const reply = stored.messages.findLast((message) => message.role === 'assistant')
    assert.deepEqual(
      reply.summary.files.map((item) => [item.path, item.status]),
      [['index.html', 'modified']],
    )
    assert.equal(reply.summary.undo.available, true)
    assert.deepEqual(reply.summary.recapture, ['home'])

    const undoPath = `${thread}/messages/${reply.id}/undo`
    assert.equal((await request(port, 'POST', undoPath, { headers: { Origin: origin }, body: {} })).status, 403, 'no owner token')
    assert.equal(
      (await request(port, 'POST', undoPath, { headers: { ...owner, Origin: 'http://evil.example' }, body: {} })).status,
      403,
      'another origin',
    )
    assert.match(read(config, 'index.html'), /Fixed fixture heading/)
    // A comment the turn left as "Agent done" needs a person again after Undo.
    await setAgentStatus(config, 'sample', comment.id, 'done', { actor: 'shapewall' })
    const undone = await request(port, 'POST', undoPath, { headers: owner, body: {} })
    assert.equal(undone.status, 200, undone.text)
    assert.equal(undone.json.message.summary.undone.kind, 'files')
    assert.equal(undone.json.message.summary.undo.available, false)
    assert.equal(read(config, 'index.html'), '<h1>Before</h1>\n')
    const reviewed = getComment(config, 'sample', comment.id)
    assert.equal(reviewed.agentStatus, 'needs-human')
    assert.match(reviewed.replies.at(-1).body, /change was undone/)
    assert.equal((await request(port, 'POST', undoPath, { headers: owner, body: {} })).status, 409, 'only once')
    const after = (await request(port, 'GET', thread, { headers: owner })).json.messages.findLast((m) => m.role === 'assistant')
    assert.ok(after.summary.undone)
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})
