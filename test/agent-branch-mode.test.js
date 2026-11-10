// Agent branch mode (src/agent/branch-mode.js) with real temporary git
// repositories: create, commit, apply, discard, conflicts, refusals, hostile
// names, hooks that must never run, the sweep, the branch-ready status and
// Undo in both states. No model calls: the ACP agent is the fix fixture.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '../src/config.js'
import { createApp, stopChildren } from '../src/server/app.js'
import { createMcpServer } from '../src/mcp.js'
import { createComment, getComment, setAgentStatus, STORED_AGENT_STATUSES } from '../src/store.js'
import { feedback } from '../src/feedback.js'
import { cleanImportedComment } from '../src/hosted/import.js'
import { rowToComment } from '../src/hosted/comments.js'
import {
  agentBranchName,
  agentWorktreeRoot,
  applyAgentBranch,
  branchModeSettings,
  cleanBranchPrefix,
  commitAgentBranch,
  createAgentBranch,
  discardAgentBranch,
  listAgentBranches,
  readMeta,
  revertAppliedBranch,
  slugOf,
  sweepAgentBranches,
} from '../src/agent/branch-mode.js'
import { validateUserEntry } from '../src/agent/user-settings.js'
import { SAMPLE, tempDir, request } from './helpers.js'

const fixture = path.resolve('test/fixtures/acp-fix.mjs')
const token = 'branch-mode-test-token'
const HOOKS = [
  'post-checkout',
  'post-merge',
  'pre-commit',
  'commit-msg',
  'prepare-commit-msg',
  'post-commit',
  'pre-merge-commit',
  'reference-transaction',
  'post-rewrite',
]

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
for (const key of Object.keys(gitEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CEILING)/.test(key)) delete gitEnv[key]
const sh = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  }).trim()

// A project in a git repository with one commit, hooks planted that would
// leave a marker file if git ever ran them.
function repo(name, { hooks = true } = {}) {
  const dir = tempDir(name)
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test Person')
  sh(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Original</h1>\n')
  fs.writeFileSync(path.join(dir, 'other.txt'), 'other\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'start')
  const marker = path.join(dir, '..', `${path.basename(dir)}-hook-ran`)
  if (hooks) {
    for (const hook of HOOKS) {
      const file = path.join(dir, '.git', 'hooks', hook)
      fs.writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 })
    }
  }
  return { dir, config: loadConfig(path.join(dir, 'shapewall.config.json')), marker }
}

// A folder in no repository at all (test/.output is inside this one).
const outsides = []
function outsideRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sw-${name}-`))
  outsides.push(dir)
  return dir
}
after(() => {
  for (const dir of outsides) fs.rmSync(dir, { recursive: true, force: true })
})

const hookRan = (marker) => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '')

async function branchWithEdit(config, { text = 'Make the heading bigger', commentId = 1, content = '<h1>Agent</h1>\n' } = {}) {
  const work = await createAgentBranch(config, { kind: 'comment', boardId: 'sample', threadId: `comment-${commentId}`, commentId, text })
  fs.writeFileSync(path.join(work.tree.projectDir, 'index.html'), content)
  const commit = await commitAgentBranch(config, { ...work, message: `Fix comment #${commentId}: ${text}\n` })
  return { work, commit }
}

test('names: prefix and slug are sanitized, never an option, never a protected branch', () => {
  assert.equal(cleanBranchPrefix('shapewall/'), 'shapewall/')
  assert.equal(cleanBranchPrefix('team/agent-'), 'team/agent-')
  for (const bad of ['-x/', '--upload-pack=x', '../x', 'a..b', 'a b', 'x.lock', '/abs', 'a//b', '', 'x'.repeat(41), 'é/']) {
    assert.equal(cleanBranchPrefix(bad), null, bad)
  }
  assert.equal(slugOf('--upload-pack=evil; rm -rf / $(touch x) `id`'), 'upload-pack-evil-rm-rf-touch-x-i')
  assert.equal(slugOf('   \n second line'), 'fix')
  assert.equal(slugOf('Ünïcödé ✓ heading'), 'unicode-heading')
  const name = agentBranchName({ prefix: 'shapewall/', kind: 'comment', commentId: 7, text: '-- -f HEAD main' })
  assert.equal(name, 'shapewall/comment-7-f-head-main')
  assert.equal(agentBranchName({ kind: 'chat', threadId: 'chat-abcdefgh12345678', n: 3 }), 'shapewall/chat-abcdefgh12345678-3')
  assert.equal(agentBranchName({ kind: 'chat', threadId: 'board', n: 1 }), 'shapewall/chat-board-1')
  assert.throws(() => agentBranchName({ prefix: '-', kind: 'chat' }), /prefix/)
  assert.throws(() => agentBranchName({ prefix: 'x/', kind: 'comment', commentId: 0 }), /comment number/)
})

test('settings: off by default; config, saved settings and env each turn it on, env wins', () => {
  const { config } = repo('branch-settings', { hooks: false })
  const env = { XDG_CONFIG_HOME: tempDir('branch-settings-home') }
  assert.deepEqual(branchModeSettings(config, env), { enabled: false, prefix: 'shapewall/', sources: { enabled: null, prefix: null } })
  const fromConfig = { ...config, agent: { branchMode: true, branchPrefix: 'review/' } }
  assert.equal(branchModeSettings(fromConfig, env).enabled, true)
  assert.equal(branchModeSettings(fromConfig, env).prefix, 'review/')
  assert.equal(branchModeSettings(fromConfig, { ...env, SHAPEWALL_AGENT_BRANCH_MODE: '0' }).enabled, false)
  assert.equal(
    branchModeSettings(config, { ...env, SHAPEWALL_AGENT_BRANCH_MODE: 'on', SHAPEWALL_AGENT_BRANCH_PREFIX: '--bad' }).prefix,
    'shapewall/',
  )
  assert.equal(validateUserEntry({ branchMode: 'yes' }).entry, null)
  assert.equal(validateUserEntry({ branchPrefix: '-x' }).entry, null)
  assert.deepEqual(validateUserEntry({ branchMode: true, branchPrefix: 'ai/' }).entry, { branchMode: true, branchPrefix: 'ai/' })
  const problems = []
  const file = path.join(tempDir('branch-config'), 'shapewall.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...SAMPLE, agent: { branchMode: 'yes' } }))
  assert.throws(() => loadConfig(file), /agent\.branchMode: true or false/)
  assert.deepEqual(problems, [])
})

test('create, commit and apply (fast-forward): the checkout changes only on Apply, as the repo author, no hook runs', async () => {
  const { dir, config, marker } = repo('branch-ff')
  const before = sh(dir, 'rev-parse', 'HEAD')
  const work = await createAgentBranch(config, {
    kind: 'comment',
    boardId: 'sample',
    threadId: 'comment-1',
    commentId: 1,
    text: 'Bigger heading',
  })
  assert.equal(work.meta.branch, 'shapewall/comment-1-bigger-heading')
  const root = agentWorktreeRoot(config)
  assert.equal(path.dirname(work.tree.projectDir), root)
  assert.ok(!fs.existsSync(path.join(work.tree.projectDir, '.git')), 'a plain checkout, no .git the agent could rewrite')
  // git run in the worktree with the agent's environment finds no repository.
  assert.throws(() =>
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: work.tree.projectDir,
      env: { ...gitEnv, GIT_CEILING_DIRECTORIES: root },
      stdio: 'pipe',
    }),
  )
  fs.writeFileSync(path.join(work.tree.projectDir, 'index.html'), '<h1>Agent</h1>\n')
  fs.writeFileSync(path.join(work.tree.projectDir, 'new.txt'), 'new\n')
  const commit = await commitAgentBranch(config, { ...work, message: 'Fix comment #1: Bigger heading\n\nshapewall:sample/1\n' })
  assert.equal(commit.committed, true)
  assert.deepEqual(commit.files, ['index.html', 'new.txt'])
  assert.equal(
    sh(dir, 'log', '-1', '--format=%an <%ae>|%s', work.meta.branch),
    'Test Person <test@example.com>|Fix comment #1: Bigger heading',
  )
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Original</h1>\n', 'checkout untouched before Apply')
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), before)
  const listed = await listAgentBranches(config)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].state, 'ready')
  const applied = await applyAgentBranch(config, readMeta(config, work.meta.id))
  assert.equal(applied.mode, 'fast-forward')
  assert.equal(applied.before, before)
  assert.equal(applied.after, commit.commit)
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Agent</h1>\n')
  assert.equal(sh(dir, 'branch', '--list', 'shapewall/*'), '', 'the applied branch is gone')
  assert.ok(!fs.existsSync(path.join(root, work.meta.id)), 'the worktree is gone')
  assert.deepEqual(await listAgentBranches(config), [])
  // Undo after Apply: a revert commit, the file back.
  const reverted = await revertAppliedBranch(config, applied)
  assert.notEqual(reverted.head, applied.after)
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Original</h1>\n')
  assert.ok(!fs.existsSync(path.join(dir, 'new.txt')))
  await assert.rejects(revertAppliedBranch(config, applied), /moved on/)
  assert.equal(hookRan(marker), '')
})

test('merge when the checkout moved on; a conflict changes nothing; a dirty checkout is refused and left as it is', async () => {
  const { dir, config, marker } = repo('branch-merge')
  // A merge: the person committed another file meanwhile.
  const first = await branchWithEdit(config)
  fs.writeFileSync(path.join(dir, 'other.txt'), 'person\n')
  sh(dir, 'commit', '-q', '-am', 'person edit')
  const applied = await applyAgentBranch(config, readMeta(config, first.work.meta.id))
  assert.equal(applied.mode, 'merge')
  assert.equal(sh(dir, 'rev-list', '--count', '--merges', 'HEAD'), '1')
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Agent</h1>\n')
  assert.equal(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8'), 'person\n')
  await revertAppliedBranch(config, applied)
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Original</h1>\n')

  // A conflict: both changed index.html.
  const second = await branchWithEdit(config, { commentId: 2, content: '<h1>Agent two</h1>\n' })
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Person</h1>\n')
  sh(dir, 'commit', '-q', '-am', 'person heading')
  const head = sh(dir, 'rev-parse', 'HEAD')
  await assert.rejects(applyAgentBranch(config, readMeta(config, second.work.meta.id)), (error) => {
    assert.equal(error.code, 'apply_conflict')
    assert.match(error.message, /index\.html/)
    assert.match(error.message, /Nothing was changed/)
    return true
  })
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
  assert.equal(sh(dir, 'status', '--porcelain'), '')
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')))
  assert.equal((await listAgentBranches(config))[0].state, 'ready', 'the branch stays for the person to merge')

  // A dirty checkout: refused, the person's edit kept, not carried into a new worktree.
  fs.writeFileSync(path.join(dir, 'other.txt'), 'uncommitted\n')
  const third = await createAgentBranch(config, { kind: 'chat', boardId: 'sample', threadId: 'board', n: 1 })
  assert.equal(fs.readFileSync(path.join(third.tree.projectDir, 'other.txt'), 'utf8'), 'person\n', 'cut from HEAD, not the dirty file')
  fs.writeFileSync(path.join(third.tree.projectDir, 'new.txt'), 'x\n')
  await commitAgentBranch(config, { ...third, message: 'Agent change from chat\n' })
  await assert.rejects(applyAgentBranch(config, readMeta(config, third.meta.id)), /uncommitted changes/)
  assert.equal(fs.readFileSync(path.join(dir, 'other.txt'), 'utf8'), 'uncommitted\n')
  assert.ok(!fs.existsSync(path.join(dir, 'new.txt')))

  // Discard: worktree and branch gone; a branch that moved is left alone.
  const result = await discardAgentBranch(config, readMeta(config, third.meta.id))
  assert.equal(result.branchDeleted, true)
  assert.equal(sh(dir, 'branch', '--list', third.meta.branch), '')
  const moved = readMeta(config, second.work.meta.id)
  sh(dir, 'branch', '-f', moved.branch, 'HEAD')
  await assert.rejects(applyAgentBranch(config, moved), /has moved/)
  assert.deepEqual(await discardAgentBranch(config, moved), { branchDeleted: false, branchMoved: true })
  assert.equal(sh(dir, 'branch', '--list', moved.branch).trim(), moved.branch)
  assert.equal(hookRan(marker), '')
})

test('refusals: not a repository, no commit yet, a merge in progress, a symlinked store, symlinks out of the checkout', async () => {
  const plain = outsideRepo('branch-plain')
  fs.writeFileSync(path.join(plain, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  await assert.rejects(
    createAgentBranch(loadConfig(path.join(plain, 'shapewall.config.json')), { kind: 'chat', boardId: 'sample', threadId: 'board' }),
    (error) => error.code === 'not_a_repo',
  )

  const unborn = tempDir('branch-unborn')
  sh(unborn, 'init', '-q')
  fs.writeFileSync(path.join(unborn, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  await assert.rejects(
    createAgentBranch(loadConfig(path.join(unborn, 'shapewall.config.json')), { kind: 'chat', boardId: 'sample', threadId: 'board' }),
    (error) => error.code === 'unborn_head',
  )

  const { dir, config } = repo('branch-busy', { hooks: false })
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), sh(dir, 'rev-parse', 'HEAD'))
  await assert.rejects(createAgentBranch(config, { kind: 'chat', boardId: 'sample', threadId: 'board' }), /merge is in progress/)
  fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'))

  const outside = tempDir('branch-outside')
  fs.mkdirSync(path.join(dir, '.shapewall'), { recursive: true })
  fs.symlinkSync(outside, path.join(dir, '.shapewall', 'agent-worktrees'))
  await assert.rejects(
    createAgentBranch(config, { kind: 'chat', boardId: 'sample', threadId: 'board' }),
    (error) => error.code === 'bad_worktree_root',
  )
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.rmSync(path.join(dir, '.shapewall', 'agent-worktrees'))

  const work = await createAgentBranch(config, { kind: 'chat', boardId: 'sample', threadId: 'board' })
  fs.symlinkSync('/etc/passwd', path.join(work.tree.projectDir, 'leak'))
  await assert.rejects(commitAgentBranch(config, { ...work, message: 'x\n' }), (error) => error.code === 'symlink_out')
  assert.equal(sh(dir, 'branch', '--list', work.meta.branch), '', 'the branch was taken back')
  await discardAgentBranch(config, work.meta)
})

test('a hostile repo: .gitattributes filters and a redirecting .git in the worktree do nothing', async () => {
  const { dir, config, marker } = repo('branch-hostile')
  sh(dir, 'config', 'filter.evil.clean', `sh -c 'echo clean >> "${marker}"; cat'`)
  sh(dir, 'config', 'filter.evil.smudge', `sh -c 'echo smudge >> "${marker}"; cat'`)
  const work = await createAgentBranch(config, { kind: 'comment', boardId: 'sample', threadId: 'comment-1', commentId: 1, text: 'x' })
  // What the agent writes: attributes naming the filter, and a .git file pointing at another repository.
  fs.writeFileSync(path.join(work.tree.projectDir, '.gitattributes'), '* filter=evil\n')
  fs.writeFileSync(path.join(work.tree.projectDir, '.git'), `gitdir: ${tempDir('branch-elsewhere')}\n`)
  fs.writeFileSync(path.join(work.tree.projectDir, 'index.html'), '<h1>Agent</h1>\n')
  const commit = await commitAgentBranch(config, { ...work, message: 'x\n' })
  assert.deepEqual(commit.files, ['index.html'], '.gitattributes keeps its base version, .git is never committed')
  await applyAgentBranch(config, readMeta(config, work.meta.id))
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Agent</h1>\n')
  assert.equal(hookRan(marker), '')
})

test('sweep: dead turns without commits go, unapplied commits stay, applied ones go', async () => {
  const { dir, config } = repo('branch-sweep', { hooks: false })
  const pending = await createAgentBranch(config, { kind: 'chat', boardId: 'sample', threadId: 'board', n: 1 })
  const waiting = await branchWithEdit(config, { commentId: 1 })
  const merged = await branchWithEdit(config, { commentId: 2, content: '<h1>Two</h1>\n' })
  sh(dir, 'merge', '-q', '--ff-only', merged.commit.commit)
  const alive = await sweepAgentBranches(config)
  assert.deepEqual(alive, [], 'this process owns them all: nothing goes')
  const removed = await sweepAgentBranches(config, { isAlive: () => false })
  assert.deepEqual(removed.sort(), [pending.meta.id, merged.work.meta.id].sort())
  const left = await listAgentBranches(config)
  assert.deepEqual(
    left.map((item) => item.id),
    [waiting.work.meta.id],
  )
  assert.equal(left[0].worktree, true)
})

test('branch-ready goes through the store, comments --json, MCP and the hosted validators', async () => {
  const { config } = repo('branch-status', { hooks: false })
  assert.ok(STORED_AGENT_STATUSES.includes('branch-ready'))
  const board = config.boards[0]
  const comment = await createComment(config, board, { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Fix it' })
  await setAgentStatus(config, board.id, comment.id, 'branch-ready', { branch: 'shapewall/comment-1-fix-it' })
  assert.equal(getComment(config, board.id, comment.id).agentBranch, 'shapewall/comment-1-fix-it')
  const [item] = feedback(config, { boardId: board.id }).comments
  assert.equal(item.agentStatus, 'branch-ready')
  assert.equal(item.agentBranch, 'shapewall/comment-1-fix-it')
  const server = createMcpServer({ config, boardId: 'sample' })
  const client = new Client({ name: 'branch-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const listed = await client.callTool({ name: 'list_comments', arguments: { agentStatus: 'branch-ready' } })
    assert.equal(listed.isError, undefined)
    assert.match(listed.content[0].text, /shapewall\/comment-1-fix-it/)
  } finally {
    await client.close()
  }
  // Another status clears the branch.
  await setAgentStatus(config, board.id, comment.id, 'done')
  assert.equal(getComment(config, board.id, comment.id).agentBranch, undefined)
  const imported = cleanImportedComment({
    importKey: 'a'.repeat(64),
    localId: 1,
    pageId: 'home',
    viewport: 'desktop',
    x: 1,
    y: 1,
    body: 'x',
    status: 'open',
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    agentStatus: 'branch-ready',
    replies: [],
  })
  assert.equal(imported.agentStatus, 'branch-ready')
  assert.throws(() => cleanImportedComment({ ...imported, importKey: 'b'.repeat(64), agentStatus: 'merged' }), /Invalid agent status/)
  // A hosted row reads it back as stored.
  assert.equal(
    rowToComment({ number: 1, replies: '[]', reactions: '[]', agent_status: 'branch-ready', status: 'open' }).agentStatus,
    'branch-ready',
  )
})

// The whole loop through the server with the fix fixture: branch-ready, Undo
// before Apply (Discard), Apply, Undo after Apply (revert), and nothing at
// all when branch mode is off.
test('fix with agent in branch mode: branch-ready, discard by Undo, apply, revert by Undo', async () => {
  const { dir, config, marker } = repo('branch-route')
  const home = tempDir('branch-route-home')
  const env = { ...process.env, XDG_CONFIG_HOME: home, SHAPEWALL_AGENT_SETTINGS_FILE: path.join(home, 'agents.json') }
  delete env.SHAPEWALL_AGENT_BRANCH_MODE
  const app = createApp({ config, env, settingsToken: token, agentAcp: `${process.execPath} ${fixture} edit`, agentLimits: { burst: 100 } })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const port = server.address().port
  const headers = { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': token }
  const fix = async (id) =>
    request(port, 'POST', `/api/agent/boards/sample/threads/comment-${id}/messages`, { headers, body: { text: 'Fix it', fix: true } })
  const lastAnswer = async (id) => {
    const thread = await request(port, 'GET', `/api/agent/boards/sample/threads/comment-${id}`, { headers })
    return thread.json.messages.at(-1)
  }
  try {
    const off = await request(port, 'GET', '/api/agent/settings/branch-mode', { headers })
    assert.equal(off.json.enabled, false)
    const saved = await request(port, 'POST', '/api/agent/settings/branch-mode', { headers, body: { enabled: true } })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.enabled, true)
    assert.equal(saved.json.sources.enabled, 'settings')
    const denied = await request(port, 'POST', '/api/agent/settings/branch-mode', {
      headers: { Origin: headers.Origin },
      body: { enabled: false },
    })
    assert.equal(denied.status, 404)

    const first = await createComment(config, config.boards[0], {
      pageId: 'home',
      viewport: 'desktop',
      x: 1,
      y: 1,
      body: 'Fix the heading',
    })
    assert.equal((await fix(first.id)).status, 200)
    let comment = getComment(config, 'sample', first.id)
    assert.equal(comment.agentStatus, 'branch-ready', JSON.stringify(comment))
    assert.equal(comment.agentBranch, 'shapewall/comment-1-fix-the-heading')
    assert.ok(comment.replies.some((reply) => /ready on branch shapewall\/comment-1-fix-the-heading/.test(reply.body)))
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Original</h1>\n', 'the checkout is untouched')
    let answer = await lastAnswer(first.id)
    assert.equal(answer.summary.kind, 'branch')
    assert.equal(answer.summary.branch.state, 'ready')
    assert.deepEqual(
      answer.summary.files.map((file) => file.path),
      ['index.html'],
    )
    assert.equal(answer.summary.undo.available, true)
    const listed = await request(port, 'GET', '/api/agent/branches', { headers })
    assert.equal(listed.json.branches.length, 1)
    assert.ok(listed.json.branches[0].folder.startsWith(agentWorktreeRoot(config)))
    // A second fix while this one waits is refused with a clear message.
    const again = await fix(first.id)
    assert.equal(again.status, 409)
    assert.match(again.json.error.message, /waiting on a branch/)
    // Undo before Apply is Discard.
    const undone = await request(port, 'POST', `/api/agent/boards/sample/threads/comment-${first.id}/messages/${answer.id}/undo`, {
      headers,
      body: {},
    })
    assert.equal(undone.status, 200, JSON.stringify(undone.json))
    assert.equal(undone.json.message.summary.branch.state, 'discarded')
    assert.equal(sh(dir, 'branch', '--list', 'shapewall/*'), '')
    comment = getComment(config, 'sample', first.id)
    assert.equal(comment.agentStatus, 'needs-human')

    // Fix again, then Apply: the checkout changes; the capture fails here (no dev server), which the comment says.
    const second = await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 2, y: 2, body: 'Fix it again' })
    assert.equal((await fix(second.id)).status, 200)
    answer = await lastAnswer(second.id)
    const id = answer.summary.branch.id
    const crossOrigin = await request(port, 'POST', `/api/agent/branches/${id}/apply`, {
      headers: { 'X-Shapewall-Settings-Token': token, Origin: 'http://evil.test' },
      body: {},
    })
    assert.equal(crossOrigin.status, 403)
    const applied = await request(port, 'POST', `/api/agent/branches/${id}/apply`, { headers, body: {} })
    assert.equal(applied.status, 200, JSON.stringify(applied.json))
    assert.equal(applied.json.applied.mode, 'fast-forward')
    assert.equal(applied.json.message.summary.branch.state, 'applied')
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /Fixed fixture heading/)
    comment = getComment(config, 'sample', second.id)
    assert.notEqual(comment.agentStatus, 'branch-ready')
    assert.equal((await request(port, 'POST', `/api/agent/branches/${id}/apply`, { headers, body: {} })).status, 404)
    // Undo after Apply reverts it.
    const reverted = await request(port, 'POST', `/api/agent/boards/sample/threads/comment-${second.id}/messages/${answer.id}/undo`, {
      headers,
      body: {},
    })
    assert.equal(reverted.status, 200, JSON.stringify(reverted.json))
    assert.equal(reverted.json.message.summary.undone.kind, 'revert')
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<h1>Original</h1>\n')
    assert.equal(hookRan(marker), '')

    // Off again: the fix edits the checkout as before, no worktree.
    await request(port, 'POST', '/api/agent/settings/branch-mode', { headers, body: { enabled: false } })
    const third = await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 3, y: 3, body: 'Plain fix' })
    assert.equal((await fix(third.id)).status, 200)
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /Fixed fixture heading/)
    assert.notEqual(getComment(config, 'sample', third.id).agentStatus, 'branch-ready')
    assert.deepEqual(await listAgentBranches(config), [])
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})

test('branch mode refuses a fix in a project that is not a repository, and leaves the comment as it was', async () => {
  const plain = outsideRepo('branch-route-plain')
  fs.writeFileSync(path.join(plain, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  const config = loadConfig(path.join(plain, 'shapewall.config.json'))
  const env = { ...process.env, SHAPEWALL_AGENT_BRANCH_MODE: '1' }
  const app = createApp({ config, env, settingsToken: token, agentAcp: `${process.execPath} ${fixture} edit` })
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const port = server.address().port
  try {
    const comment = await createComment(config, config.boards[0], { pageId: 'home', viewport: 'desktop', x: 1, y: 1, body: 'Fix' })
    const result = await request(port, 'POST', `/api/agent/boards/sample/threads/comment-${comment.id}/messages`, {
      headers: { Origin: `http://127.0.0.1:${port}`, 'X-Shapewall-Settings-Token': token },
      body: { text: 'Fix it', fix: true },
    })
    assert.equal(result.status, 409)
    assert.equal(result.json.error.code, 'not_a_repo')
    assert.match(result.json.error.message, /not a Git repository/)
    assert.equal(getComment(config, 'sample', comment.id).agentStatus, null)
  } finally {
    stopChildren(app)
    await new Promise((resolve) => server.close(resolve))
  }
})
