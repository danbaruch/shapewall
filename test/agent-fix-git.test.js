// What a connected agent's fix leaves on the machine, tested on the pieces
// themselves (src/remote/agent-fix.js) against a throwaway repository with a
// local bare remote: the commit is kept only when it is exactly what was
// allowed (bytes, mode, every allowed file present, nothing removed); Stop
// is honoured between the steps; a fix with an edit nobody looked at is
// held back from the remote; copies a dead process left are swept and their
// branch names freed; and the place fixes are made in is never inside the
// project.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  FixRefusal,
  dropFixFolder,
  finishFix,
  fixRoot,
  heldDiff,
  prepareFix,
  pushFix,
  readHeld,
  sweepFixes,
} from '../src/remote/agent-fix.js'
import { cleanMachinePolicy } from '../src/remote/agent-policy-file.js'
import { gitRepo } from './hosted-chat-helpers.js'
import { tempDir } from './helpers.js'

const sha = (data) => createHash('sha256').update(data).digest('hex')
const jobFor = (comment, body = 'Say Hi instead of Hello') => ({
  turn: { id: `turn_${'a'.repeat(24)}`, board: 'sample', thread: `comment-${comment}`, kind: 'fix', comment },
  context: { comment: { id: comment, body } },
})
// A repository with a bare remote, this machine's policy, and a place for fixes.
function machine(name, { files, policy = {} } = {}) {
  const dir = tempDir(`fix-git-${name}`)
  const git = gitRepo(dir, files || { 'index.html': '<h1>Hello</h1>\n', 'run.sh': '#!/bin/sh\necho hi\n', '.gitignore': 'build/\n*.log\n' })
  const bare = tempDir(`fix-git-${name}-bare`)
  execFileSync('git', ['init', '-q', '--bare', bare])
  git('remote', 'add', 'origin', bare)
  const env = { PATH: process.env.PATH, HOME: dir, XDG_STATE_HOME: tempDir(`fix-git-${name}-state`) }
  const config = { dir, outputDir: path.join(dir, '.shapewall'), agent: null, boards: [] }
  const onRemote = () =>
    execFileSync('git', ['--git-dir', bare, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const branches = () => git('branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()
  return { dir, git, bare, env, config, onRemote, branches, policy: cleanMachinePolicy({ approvals: 'owner', ...policy }) }
}
// Writes `text` to a file of the fix's folder, as the agent would after an allowed edit.
const write = (prepared, rel, data) => {
  const file = path.join(prepared.work.tree.projectDir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}
const allow = (entries) => new Map(Object.entries(entries).map(([rel, data]) => [rel, { hash: sha(data), auto: false }]))
const fixFolders = (m) => {
  const root = fixRoot(m.dir, m.env)
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : []
}

test('the commit is exactly what was allowed: those bytes, that mode, every allowed file, nothing else and nothing removed', async () => {
  const m = machine('exact')
  const run = async (change, approved, options = {}) => {
    const prepared = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(1), env: m.env })
    await change(prepared)
    const out = await finishFix({ config: m.config, policy: m.policy, prepared, job: jobFor(1), approved, env: m.env, ...options })
    return out
  }
  const hi = '<h1>Hi</h1>\n'
  // What was allowed, and only that: kept, pushed, the folder gone.
  const good = await run((p) => write(p, 'index.html', hi), allow({ 'index.html': hi }))
  assert.equal(good.status, 'branch-ready')
  assert.deepEqual(good.summary.files, [{ path: 'index.html', status: 'modified', added: 1, removed: 1 }])
  assert.equal(good.summary.branch.pushed, true)
  assert.deepEqual(m.onRemote(), [good.summary.branch.name])
  assert.match(m.git('log', '-1', '--format=%s', good.summary.branch.name), /^Fix for Shapewall comment 1: Say Hi instead of Hello$/)
  const before = m.branches()
  const refused = async (label, change, approved, pattern) => {
    const out = await run(change, approved)
    assert.equal(out.status, 'needs-human', label)
    assert.equal(out.summary, null, label)
    assert.match(out.notes.join('\n'), pattern, label)
    assert.deepEqual(m.branches(), before, `${label}: no branch`)
    assert.equal(m.git('status', '--porcelain'), '', label)
  }
  // The same text with one byte that is not valid UTF-8 in place of a character: not the bytes that were shown.
  const shown = '<h1>Hi \ufffd</h1>\n'
  await refused(
    'other bytes that decode to the same text',
    (p) => write(p, 'index.html', Buffer.concat([Buffer.from('<h1>Hi '), Buffer.from([0xff]), Buffer.from('</h1>\n')])),
    allow({ 'index.html': shown }),
    /beyond the edits that were allowed \(index\.html\)/,
  )
  // The allowed text, and the file made executable: a mode change nobody was shown.
  await refused(
    'a mode change',
    (p) => {
      write(p, 'index.html', hi)
      fs.chmodSync(path.join(p.work.tree.projectDir, 'index.html'), 0o755)
    },
    allow({ 'index.html': hi }),
    /beyond the edits that were allowed \(index\.html\)/,
  )
  await refused(
    'a new file that is executable',
    (p) => {
      write(p, 'new.txt', 'x\n')
      fs.chmodSync(path.join(p.work.tree.projectDir, 'new.txt'), 0o755)
    },
    allow({ 'new.txt': 'x\n' }),
    /beyond the edits that were allowed \(new\.txt\)/,
  )
  // A file removed, a file turned into a link: nobody was shown that.
  await refused(
    'a deletion',
    (p) => {
      write(p, 'index.html', hi)
      fs.rmSync(path.join(p.work.tree.projectDir, 'run.sh'))
    },
    allow({ 'index.html': hi }),
    /beyond the edits that were allowed \(run\.sh\)/,
  )
  // An allowed edit Git leaves out of the commit (ignored, or one of its own files):
  // the fix is not what was allowed, so there is none. Never a silent drop.
  await refused(
    'an allowed file Git ignores',
    (p) => {
      write(p, 'index.html', hi)
      write(p, 'debug.log', 'x\n')
    },
    allow({ 'index.html': hi, 'debug.log': 'x\n' }),
    /would not have been what was allowed\. Git leaves debug\.log out/,
  )
  await refused(
    'an allowed .gitattributes',
    (p) => {
      write(p, 'index.html', hi)
      write(p, '.gitattributes', '* text=auto\n')
    },
    allow({ 'index.html': hi, '.gitattributes': '* text=auto\n' }),
    /Git leaves \.gitattributes out/,
  )
  // And the question the card asks before it is shown at all: does Git ignore this path?
  const prepared = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(1), env: m.env })
  assert.deepEqual(await Promise.all(['debug.log', 'build/out.js', 'index.html', 'src/new.js'].map((rel) => prepared.ignored(rel))), [
    true,
    true,
    false,
    false,
  ])
  await dropFixFolder(prepared)
  // An edit that leaves a file as it was is no change, and no failure.
  const same = await run((p) => write(p, 'index.html', '<h1>Hello</h1>\n'), allow({ 'index.html': '<h1>Hello</h1>\n' }))
  assert.equal(same.status, 'needs-human')
  assert.match(same.notes.join('\n'), /left no change/)
})

test('Stop is honoured between the steps: nothing committed, pushed or opened after it; a push that finished is said', async () => {
  const m = machine('stop')
  const hi = '<h1>Hi</h1>\n'
  const start = async () => {
    const prepared = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(2), env: m.env })
    write(prepared, 'index.html', hi)
    return prepared
  }
  // Stopped before the commit.
  const early = new AbortController()
  early.abort('stopped')
  let out = await finishFix({
    config: m.config,
    policy: m.policy,
    prepared: await start(),
    job: jobFor(2),
    approved: allow({ 'index.html': hi }),
    signal: early.signal,
    env: m.env,
  })
  assert.deepEqual([out.status, out.summary, out.line], ['stopped', null, null])
  assert.deepEqual(m.branches(), ['main'])
  // Stopped while the push runs: the push that was already under way finishes, the thread says the branch
  // exists, and nothing follows it.
  const during = new AbortController()
  let pushes = 0
  out = await finishFix({
    config: m.config,
    policy: m.policy,
    prepared: await start(),
    job: jobFor(2),
    approved: allow({ 'index.html': hi }),
    signal: during.signal,
    env: m.env,
    push: async () => {
      pushes += 1
      during.abort('stopped')
    },
  })
  assert.equal(pushes, 1)
  assert.equal(out.summary.branch.pushed, true)
  assert.match(out.notes.join('\n'), /Stopped after the branch .* was pushed to "origin": it exists there\. No pull request was opened\./)
  // Stopped between the commit and the push (the signal fires as the commit is checked): the branch is taken back.
  const between = new AbortController()
  const prepared = await start()
  const approved = allow({ 'index.html': hi })
  // The check reads each allowed entry: abort on the first read after the commit exists.
  const tripwire = new Map()
  tripwire.get = (key) => {
    if (m.branches().length > 2) between.abort('stopped')
    return approved.get(key)
  }
  tripwire[Symbol.iterator] = () => approved[Symbol.iterator]()
  Object.defineProperty(tripwire, 'size', { get: () => approved.size })
  tripwire.values = () => approved.values()
  const count = m.branches().length
  out = await finishFix({
    config: m.config,
    policy: m.policy,
    prepared,
    job: jobFor(2),
    approved: tripwire,
    signal: between.signal,
    env: m.env,
    push: async () => {
      throw new Error('must not push after Stop')
    },
  })
  assert.equal(out.status, 'stopped')
  assert.equal(m.branches().length, count, 'the commit was taken back')
  assert.equal(m.git('status', '--porcelain'), '')
})

test('an edit nobody looked at: the fix is committed here and pushed nowhere, until its whole diff was looked at', async () => {
  const m = machine('held')
  const hi = '<h1>Hi</h1>\n'
  const prepared = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(3), env: m.env })
  write(prepared, 'index.html', hi)
  write(prepared, 'about.html', '<h1>About</h1>\n')
  let pushed = 0
  const approved = new Map([
    ['index.html', { hash: sha(hi), auto: true }],
    ['about.html', { hash: sha('<h1>About</h1>\n'), auto: false }],
  ])
  const out = await finishFix({
    config: m.config,
    policy: m.policy,
    prepared,
    job: jobFor(3),
    approved,
    env: m.env,
    push: async () => (pushed += 1),
  })
  assert.equal(out.status, 'branch-ready')
  assert.equal(pushed, 0, 'one edit went without asking: nothing is pushed')
  assert.deepEqual([out.summary.branch.pushed, out.summary.branch.held, out.summary.pr], [false, true, null])
  assert.match(out.line, /not pushed until someone has looked at its whole diff on the board \(Push this fix\)/)
  assert.deepEqual(m.onRemote(), [])
  // The held fix is found again, by comment, with this machine's own repository (never a path from its record).
  const record = await readHeld({ config: m.config, env: m.env, board: 'sample', comment: 3 })
  assert.equal(record.branch, out.summary.branch.name)
  assert.equal(await readHeld({ config: m.config, env: m.env, board: 'sample', comment: 4 }), null)
  // The card shows the whole diff: every file.
  const diff = await heldDiff(record)
  assert.match(diff.preview, /Hi/)
  assert.match(diff.full || diff.preview, /About/)
  // A record someone tampered with (another commit, another repository) is not a fix to push.
  const raw = JSON.parse(fs.readFileSync(record.file, 'utf8'))
  fs.writeFileSync(record.file, JSON.stringify({ ...raw, gitDir: '/somewhere/else/.git', commit: m.git('rev-parse', 'main') }))
  assert.equal(await readHeld({ config: m.config, env: m.env, board: 'sample', comment: 3 }), null)
  fs.writeFileSync(record.file, JSON.stringify({ ...raw, files: raw.files.slice(0, 1) }))
  assert.equal(
    await readHeld({ config: m.config, env: m.env, board: 'sample', comment: 3 }),
    null,
    'the commit changes more than the record says',
  )
  fs.writeFileSync(record.file, JSON.stringify({ ...raw, gitDir: '/somewhere/else/.git' }))
  const again = await readHeld({ config: m.config, env: m.env, board: 'sample', comment: 3 })
  assert.notEqual(again.gitDir, '/somewhere/else/.git')
  // After the card: pushed, that branch only.
  const done = await pushFix({ config: m.config, policy: m.policy, record: again, env: m.env })
  assert.equal(done.pushed, true)
  assert.deepEqual(m.onRemote(), [record.branch])
  // A fix that changes something that runs is never pushed from here, looked at or not.
  const other = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(5), env: m.env })
  write(other, 'run.sh', '#!/bin/sh\necho owned\n')
  const kept = await finishFix({
    config: m.config,
    policy: m.policy,
    prepared: other,
    job: jobFor(5),
    approved: allow({ 'run.sh': '#!/bin/sh\necho owned\n' }),
    env: m.env,
  })
  assert.equal(kept.summary.branch.pushed, false)
  assert.match(kept.notes.join('\n'), /Not pushed: the fix changes run\.sh, which runs on install, build, test or CI/)
  assert.deepEqual(m.onRemote(), [record.branch])
})

test('copies a dead process left are swept, at the next fix and at connect, and their branch names are free again', async () => {
  const m = machine('sweep')
  // A fix that was never finished: its process "died" (the owner file names a pid that is gone).
  const dead = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(6), env: m.env })
  const root = dead.work.root
  const id = dead.work.meta.id
  fs.writeFileSync(path.join(root, `${id}.owner`), '999999999\n')
  assert.ok(fixFolders(m).includes(id))
  assert.ok(fixFolders(m).includes(`${id}.json`))
  // A live one beside it stays.
  const live = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(7), env: m.env })
  assert.equal(fs.existsSync(path.join(root, id)), false, 'the next fix swept the dead copy')
  assert.deepEqual(
    fixFolders(m).filter((name) => name.startsWith(id)),
    [],
    'with its record and owner file',
  )
  assert.ok(fs.existsSync(path.join(root, live.work.meta.id)))
  // Its branch name is free: the same comment gets the same name again, not "-2".
  const again = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(6), env: m.env })
  assert.equal(again.work.meta.branch, dead.work.meta.branch)
  await dropFixFolder(again)
  await dropFixFolder(live)
  // What `agent connect` runs at its start: the same sweep. Records without a copy go too.
  const orphan = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(8), env: m.env })
  fs.writeFileSync(path.join(root, `${orphan.work.meta.id}.owner`), '999999999\n')
  fs.rmSync(path.join(root, orphan.work.meta.id), { recursive: true })
  assert.deepEqual(sweepFixes(m.dir, m.env), [orphan.work.meta.id])
  assert.deepEqual(fixFolders(m), [])
  // Held fixes are kept, the newest twenty, for two weeks.
  for (let index = 0; index < 23; index += 1) {
    const name = `held-202601${String(index + 1).padStart(2, '0')}000000-abcdef.json`
    fs.writeFileSync(path.join(root, name), '{}')
    const at = new Date(Date.now() - (index < 2 ? 20 : index) * 24 * 3600 * 1000 * (index < 2 ? 1 : 0.1))
    fs.utimesSync(path.join(root, name), at, at)
  }
  sweepFixes(m.dir, m.env)
  const held = fixFolders(m)
  assert.equal(held.length, 20)
  assert.ok(!held.includes('held-20260101000000-abcdef.json'), 'older than two weeks')
})

test('where fixes are made is never inside the project: the home folder as a project, a relative state folder', async () => {
  // The project is the home folder (a dotfiles repository): the default place would be inside it.
  const home = tempDir('fix-git-home')
  gitRepo(home, { '.bashrc': 'export A=1\n' })
  assert.throws(
    () => fixRoot(home, { HOME: home }),
    (error) => error instanceof FixRefusal && /would be inside the project itself/.test(error.message),
  )
  const policy = cleanMachinePolicy({ approvals: 'owner' })
  await assert.rejects(
    prepareFix({ config: { dir: home, agent: null, boards: [] }, policy, job: jobFor(1), env: { PATH: process.env.PATH, HOME: home } }),
    /would be inside the project itself\. Set XDG_STATE_HOME there to a folder outside the project/,
  )
  assert.equal(fs.existsSync(path.join(home, '.local')), false, 'nothing was made in it')
  // With a state folder outside it, the same project works.
  const outside = tempDir('fix-git-home-state')
  assert.ok(fixRoot(home, { HOME: home, XDG_STATE_HOME: outside }).startsWith(fs.realpathSync(outside)))
  // A relative XDG_STATE_HOME is not read against the project (or anything): the default is used.
  const project = tempDir('fix-git-rel')
  gitRepo(project)
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-fix-home-'))
  try {
    assert.ok(
      fixRoot(project, { HOME: elsewhere, XDG_STATE_HOME: 'state' }).startsWith(path.join(fs.realpathSync(elsewhere), '.local', 'state')),
    )
    // A state folder that is a link into the project is where it lands, not what it is called.
    const link = path.join(elsewhere, 'link')
    fs.symlinkSync(project, link)
    assert.throws(() => fixRoot(project, { HOME: elsewhere, XDG_STATE_HOME: link }), FixRefusal)
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('comment text never reaches git or GitHub as something to act on: NUL, mentions, closing words', async () => {
  const m = machine('inert')
  const body = 'Fixes #12, cc @octocat\u0000 and\u0000more\nsecond line'
  const prepared = await prepareFix({ config: m.config, policy: m.policy, job: jobFor(9, body), env: m.env })
  write(prepared, 'index.html', '<h1>Hi</h1>\n')
  const out = await finishFix({
    config: m.config,
    policy: { ...m.policy, remote: null },
    prepared,
    job: jobFor(9, body),
    approved: allow({ 'index.html': '<h1>Hi</h1>\n' }),
    env: m.env,
  })
  assert.equal(out.status, 'branch-ready')
  assert.match(out.summary.branch.name, /^shapewall\/comment-9-fixes-12-cc-octocat/)
  const subject = m.git('log', '-1', '--format=%s', out.summary.branch.name)
  assert.doesNotMatch(subject, /#\d|@octocat/)
  assert.equal(subject.includes(String.fromCharCode(0)), false)
  assert.match(subject.replace(/\u200b/g, ''), /^Fix for Shapewall comment 9: Fixes #12, cc @octocat andmore$/)
  assert.doesNotMatch(m.git('log', '-1', '--format=%B', out.summary.branch.name), /(fix|close|resolve)[a-z]* #\d/i)
})
