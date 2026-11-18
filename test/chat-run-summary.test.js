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
import {
  beginTurnChanges,
  finishTurnChanges,
  ignoredPaths,
  isIgnored,
  starterSummary,
  undoFiles,
  undoStarterBranch,
} from '../src/agent/turn-changes.js'
import { AGENT_AUTHOR } from '../src/agent/starter/worktree.js'
import { completedEdits, editedPaths } from '../src/agent/backends/acp.js'
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
// The files the agent's own tools named as edited (acp.js 'edited' events), as absolute paths.
const edits = (config, ...rels) => new Set(rels.map((rel) => path.join(config.dir, rel)))
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
  const { summary, undo } = await finishTurnChanges(config, baseline, {
    comments: [],
    board: config.boards[0],
    reply: { text: '' },
    agentFiles: edits(config, 'src/page.html', 'src/added.txt', 'src/gone.css'),
  })
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

test("Undo puts back only the agent's own edits: a file a person saved during the turn survives", async () => {
  const config = setup('summary-concurrent')
  write(config, 'a.txt', 'a0\n')
  write(config, 'b.txt', 'b0\n')
  const baseline = await beginTurnChanges(config)
  // The agent edits a.txt with its own tool while the developer saves b.txt in their editor.
  write(config, 'a.txt', 'a1 by the agent\n')
  write(config, 'b.txt', 'b1 saved by a person\n')
  const { summary, undo } = await finishTurnChanges(config, baseline, { board: config.boards[0], agentFiles: edits(config, 'a.txt') })
  assert.deepEqual(
    summary.files.map((item) => item.path),
    ['a.txt', 'b.txt'],
    'both changes are listed',
  )
  assert.equal(summary.files[0].outside, undefined)
  assert.equal(summary.files[1].outside, true, "marked as not the agent's own edit")
  assert.deepEqual(summary.undo, { kind: 'files', available: true, files: 1, others: 1 })
  assert.deepEqual(
    undo.files.map((item) => item.path),
    ['a.txt'],
  )
  assert.deepEqual(undoFiles(config, undo), ['a.txt'])
  assert.equal(read(config, 'a.txt'), 'a0\n')
  assert.equal(read(config, 'b.txt'), 'b1 saved by a person\n', "the person's save survives")

  // A turn whose agent edited nothing itself (a read-only turn) offers no Undo of a person's save.
  const second = await beginTurnChanges(config)
  write(config, 'b.txt', 'b2 saved by a person\n')
  for (const agentFiles of [new Set(), undefined]) {
    const readOnly = await finishTurnChanges(config, second, { board: config.boards[0], agentFiles })
    assert.equal(readOnly.undo, null)
    assert.equal(readOnly.summary.undo.available, false)
    assert.match(readOnly.summary.undo.reason, /did not edit these files itself/)
  }
  assert.equal(read(config, 'b.txt'), 'b2 saved by a person\n')
})

test("the files an ACP agent's own file tools name are what its Undo may put back; reads and commands name none", () => {
  const update = {
    locations: [{ path: '/p/a.txt' }, { path: '/p/a.txt' }, { line: 3 }],
    content: [{ type: 'diff', path: '/p/b.txt', oldText: 'x', newText: 'y' }, { type: 'content' }],
  }
  for (const kind of ['edit', 'delete', 'move']) assert.deepEqual(editedPaths(update, kind), ['/p/a.txt', '/p/b.txt'], kind)
  for (const kind of ['read', 'execute', 'fetch', 'search', 'other', undefined])
    assert.deepEqual(editedPaths(update, kind), [], String(kind))
})

test("a denied or failed edit is not the agent's: a person saving that file during the turn keeps the save after Undo", async () => {
  const config = setup('summary-denied-edit')
  write(config, 'a.txt', 'a0\n')
  write(config, 'b.txt', 'b0\n')
  const file = (rel) => path.join(config.dir, rel)
  // The tool call records as acp.js keeps them between updates.
  const run = (updates) => {
    const tools = new Map()
    const edited = new Set()
    for (const update of updates) {
      const known = tools.get(update.toolCallId) || {}
      const tool = {
        kind: update.kind || known.kind || 'other',
        status: update.status || known.status || 'pending',
        paths: known.paths || [],
        reported: Boolean(known.reported),
      }
      tools.set(update.toolCallId, tool)
      for (const item of completedEdits(tool, update)) edited.add(item)
    }
    return edited
  }
  const baseline = await beginTurnChanges(config)
  // The agent's edit of b.txt is denied (it fails); its edit of a.txt completes, with the path only on the first update.
  const edited = run([
    { toolCallId: 'denied', kind: 'edit', status: 'pending', locations: [{ path: file('b.txt') }] },
    { toolCallId: 'denied', status: 'failed' },
    { toolCallId: 'ok', kind: 'edit', status: 'pending', locations: [{ path: file('a.txt') }] },
    { toolCallId: 'ok', status: 'in_progress' },
    { toolCallId: 'ok', status: 'completed' },
    { toolCallId: 'ok', status: 'completed' },
  ])
  assert.deepEqual([...edited], [file('a.txt')], 'reported once, on completion only')
  write(config, 'a.txt', 'a1 by the agent\n')
  write(config, 'b.txt', 'b1 saved by a person\n')
  const { undo } = await finishTurnChanges(config, baseline, { board: config.boards[0], agentFiles: edited })
  assert.deepEqual(undoFiles(config, undo), ['a.txt'])
  assert.equal(read(config, 'a.txt'), 'a0\n')
  assert.equal(read(config, 'b.txt'), 'b1 saved by a person\n')
})

test('Undo changes nothing when a file was edited after the turn', async () => {
  const config = setup('summary-conflict')
  write(config, 'a.txt', 'a0\n')
  write(config, 'b.txt', 'b0\n')
  const baseline = await beginTurnChanges(config)
  write(config, 'a.txt', 'a1\n')
  write(config, 'b.txt', 'b1\n')
  const { undo } = await finishTurnChanges(config, baseline, { board: config.boards[0], agentFiles: edits(config, 'a.txt', 'b.txt') })
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
  const { undo } = await finishTurnChanges(config, baseline, { board: config.boards[0], agentFiles: edits(config, 'a.txt', 'sub/c.txt') })
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

// A real case: a dev server writing its data inside the project folder, in a
// folder .gitignore names (the line on disk, not committed yet), while the
// agent edits one file. Before, the card listed dozens of those files and
// Undo would have deleted the new ones and rolled back the changed ones.
test('files Git ignores are never listed, counted or undone: another process writing there during a turn is left alone', async () => {
  const config = setup('summary-ignored')
  gitIn(config.dir, ['init', '-q'])
  write(config, 'src/page.html', '<h1>Old</h1>\n')
  gitIn(config.dir, ['add', '.'])
  gitIn(config.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first'])
  // Ignore rules as they are on disk: .gitignore not committed, and .git/info/exclude.
  write(config, '.gitignore', '.live-demo/\n*.log\n')
  fs.appendFileSync(path.join(config.dir, '.git', 'info', 'exclude'), 'scratch/\n')
  write(config, '.live-demo/data/kept.db', 'before the turn\n')
  write(config, 'server.log', 'line 1\n')
  write(config, 'scratch/notes.txt', 'mine\n')
  assert.deepEqual([...(await ignoredPaths(config.dir)).dirs].sort(), ['.live-demo/', 'scratch/'])

  const baseline = await beginTurnChanges(config)
  // The agent's edit, and an untracked file of its own that is not ignored.
  write(config, 'src/page.html', '<h1>New</h1>\n')
  write(config, 'src/new.css', 'h1 { color: teal; }\n')
  // Meanwhile, somebody else's files in ignored places: changed, added, deleted.
  write(config, '.live-demo/data/kept.db', 'changed by the dev server\n')
  write(config, '.live-demo/data/files/ws_1/new.bin', 'made during the turn\n')
  write(config, 'server.log', 'line 1\nline 2\n')
  fs.rmSync(path.join(config.dir, 'scratch/notes.txt'))
  const { summary, undo } = await finishTurnChanges(config, baseline, {
    board: config.boards[0],
    agentFiles: edits(config, 'src/page.html', 'src/new.css'),
  })
  assert.deepEqual(
    summary.files.map((item) => [item.path, item.status]),
    [
      ['src/new.css', 'added'],
      ['src/page.html', 'modified'],
    ],
    'only what is not ignored',
  )
  assert.deepEqual([summary.added, summary.removed], [2, 1])
  assert.equal(summary.undo.available, true)
  assert.deepEqual(undo.files.map((item) => item.path).sort(), ['src/new.css', 'src/page.html'])

  // Undo puts the agent's files back and leaves the ignored ones byte for byte.
  undoFiles(config, undo, { ignored: await ignoredPaths(config.dir) })
  assert.equal(read(config, 'src/page.html'), '<h1>Old</h1>\n')
  assert.equal(fs.existsSync(path.join(config.dir, 'src/new.css')), false)
  assert.equal(read(config, '.live-demo/data/kept.db'), 'changed by the dev server\n')
  assert.equal(read(config, '.live-demo/data/files/ws_1/new.bin'), 'made during the turn\n')
  assert.equal(read(config, 'server.log'), 'line 1\nline 2\n')
  assert.equal(fs.existsSync(path.join(config.dir, 'scratch/notes.txt')), false, "not brought back either: it was never the turn's")

  // A record that names an ignored file (it could only come from an older build) is refused whole.
  write(config, 'src/page.html', '<h1>Again</h1>\n')
  const forged = { files: [{ path: '.live-demo/data/kept.db', before: Buffer.from('x'), existed: true, mode: 0o644, after: 'any' }] }
  assert.throws(
    () => undoFiles(config, forged, { ignored: { files: new Set(), dirs: new Set(['.live-demo/']) } }),
    (error) => error.code === 'undo_unavailable' && /ignored by Git/.test(error.message),
  )
  assert.equal(read(config, '.live-demo/data/kept.db'), 'changed by the dev server\n')
})

test('a file the turn itself makes ignored is not reported as deleted; a tracked file stays listed whatever .gitignore says', async () => {
  const config = setup('summary-ignored-midturn')
  gitIn(config.dir, ['init', '-q'])
  write(config, 'tracked.log', 'tracked\n')
  write(config, 'notes.tmp', 'untracked\n')
  gitIn(config.dir, ['add', 'tracked.log'])
  gitIn(config.dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first'])
  const baseline = await beginTurnChanges(config)
  write(config, '.gitignore', '*.log\n*.tmp\n')
  write(config, 'tracked.log', 'tracked, edited\n')
  const { summary } = await finishTurnChanges(config, baseline, { board: config.boards[0] })
  assert.deepEqual(
    summary.files.map((item) => [item.path, item.status]),
    [
      ['.gitignore', 'added'],
      ['tracked.log', 'modified'],
    ],
  )
})

test("outside a Git repository, or in a folder its repository ignores: as before, minus Shapewall's own folders", async () => {
  // The test folder sits under test/.output, which this repository ignores.
  const config = setup('summary-no-git')
  assert.equal(await ignoredPaths(config.dir), null)
  write(config, 'a.txt', 'a0\n')
  const baseline = await beginTurnChanges(config)
  write(config, 'a.txt', 'a1\n')
  write(config, 'server.log', 'listed here: no ignore rules to go by\n')
  write(config, '.shapewall-export/index.html', 'never ours\n')
  write(config, '.shapewall/store.json', '{}')
  write(config, 'node_modules/dep/index.js', 'no')
  const { summary } = await finishTurnChanges(config, baseline, { board: config.boards[0] })
  assert.deepEqual(
    summary.files.map((item) => item.path),
    ['a.txt', 'server.log'],
  )
  assert.equal(isIgnored(null, 'anything'), false)
  assert.equal(isIgnored({ files: new Set(['x.log']), dirs: new Set(['a/b/']) }, 'a/b/c/d.txt'), true)
  assert.equal(isIgnored({ files: new Set(['x.log']), dirs: new Set(['a/b/']) }, 'a/bc/d.txt'), false)
  assert.equal(isIgnored({ files: new Set(['x.log']), dirs: new Set(['a/b/']) }, 'x.log'), true)
})

test('secrets files are never diffed, and their change turns Undo off', async () => {
  const config = setup('summary-secrets')
  write(config, '.env', 'API_KEY=one\n')
  const baseline = await beginTurnChanges(config)
  write(config, '.env', 'API_KEY=two\n')
  const { summary, undo } = await finishTurnChanges(config, baseline, { board: config.boards[0], agentFiles: edits(config, '.env') })
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
  // Checked out in another worktree (someone reviewing it): left as it is, that worktree's HEAD intact.
  const review = path.join(tempDir('summary-starter-review'), 'review')
  gitIn(repo, ['worktree', 'add', '-q', review, branch])
  await assert.rejects(undoStarterBranch(config, { boardId: 'sample', commentId: 1, branch, commit }), /checked out in/)
  assert.equal(gitIn(repo, ['rev-parse', 'refs/heads/' + branch]), commit)
  assert.equal(gitIn(review, ['symbolic-ref', 'HEAD']), 'refs/heads/' + branch)
  gitIn(repo, ['worktree', 'remove', '--force', review])
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
