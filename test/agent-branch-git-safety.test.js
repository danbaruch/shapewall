// Branch mode and the person's own files and git config, with real
// temporary repositories: an ignored or untracked file (.env) is never
// overwritten by Apply or Undo, the agent's commit follows the base commit's
// ignore rules (not the agent's edited .gitignore), and no filter, merge or
// diff driver from the repository's config runs in any git call made for
// create, commit, the conflict check, Apply (fast-forward and merge), discard
// and Undo. No model calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../src/config.js'
import {
  applyAgentBranch,
  checkoutSignature,
  commitAgentBranch,
  createAgentBranch,
  discardAgentBranch,
  readMeta,
  repoFilters,
  revertAppliedBranch,
} from '../src/agent/branch-mode.js'
import { inertDriverFlags } from '../src/agent/starter/worktree.js'
import { SAMPLE, tempDir } from './helpers.js'

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
for (const key of Object.keys(gitEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CEILING)/.test(key)) delete gitEnv[key]
const sh = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  }).trim()
const read = (file) => fs.readFileSync(file, 'utf8')

function repo(name, files = {}) {
  const dir = tempDir(name)
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'Test Person')
  sh(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Original</h1>\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), '.shapewall/\n.env\n')
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'start')
  return { dir, config: loadConfig(path.join(dir, 'shapewall.config.json')) }
}

async function agentTurn(config, edit, { commentId = 1 } = {}) {
  const work = await createAgentBranch(config, {
    kind: 'comment',
    boardId: 'sample',
    threadId: `comment-${commentId}`,
    commentId,
    text: 'Fix',
  })
  edit(work.tree.projectDir)
  const commit = await commitAgentBranch(config, { ...work, message: `Fix comment #${commentId}\n` })
  return { work, commit, meta: () => readMeta(config, work.meta.id) }
}

const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

test('the commit follows the base ignore rules: an edited .gitignore lets no .env in, and the person’s .env survives Apply', async () => {
  const { dir, config } = repo('safety-env')
  fs.writeFileSync(path.join(dir, '.env'), 'REAL_SECRET=1\n')
  const { commit, meta } = await agentTurn(config, (root) => {
    // The agent un-ignores .env and writes one, plus a real change.
    fs.writeFileSync(path.join(root, '.gitignore'), '.shapewall/\n')
    fs.writeFileSync(path.join(root, '.env'), 'AGENT=1\n')
    write(root, 'dist/bundle.js', 'x\n')
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>Agent</h1>\n')
  })
  assert.equal(commit.committed, true)
  assert.deepEqual(commit.files, ['.gitignore', 'dist/bundle.js', 'index.html'], 'the base-ignored .env is not committed')
  assert.deepEqual(commit.ignoreChanged, ['.gitignore'])
  const applied = await applyAgentBranch(config, meta())
  assert.equal(applied.mode, 'fast-forward')
  assert.equal(read(path.join(dir, '.env')), 'REAL_SECRET=1\n', 'the ignored .env is the person’s, untouched')
  assert.equal(read(path.join(dir, 'index.html')), '<h1>Agent</h1>\n')
})

test('Apply is refused, naming the file, when the branch would overwrite an ignored or untracked file (fast-forward)', async () => {
  const { dir, config } = repo('safety-ff-overwrite')
  const { meta } = await agentTurn(config, (root) => {
    fs.writeFileSync(path.join(root, 'local.cfg'), 'agent\n')
    fs.writeFileSync(path.join(root, 'notes.txt'), 'agent\n')
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>Agent</h1>\n')
  })
  // After the agent committed: the person ignores local.cfg locally and has one.
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'local.cfg\n')
  fs.writeFileSync(path.join(dir, 'local.cfg'), 'mine\n')
  const head = sh(dir, 'rev-parse', 'HEAD')
  await assert.rejects(applyAgentBranch(config, meta()), (error) => {
    assert.equal(error.code, 'apply_overwrite')
    assert.match(error.message, /local\.cfg/)
    assert.match(error.message, /Nothing was changed/)
    return true
  })
  assert.equal(read(path.join(dir, 'local.cfg')), 'mine\n')
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
  assert.equal(read(path.join(dir, 'index.html')), '<h1>Original</h1>\n')
  // An untracked (not ignored) file is named as well.
  fs.rmSync(path.join(dir, 'local.cfg'))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine\n')
  await assert.rejects(applyAgentBranch(config, meta()), /notes\.txt/)
  assert.equal(read(path.join(dir, 'notes.txt')), 'mine\n')
})

test('Apply is refused for a merge that would overwrite an ignored file, and for an untracked file or symlink where a folder goes', async () => {
  const { dir, config } = repo('safety-merge-overwrite')
  const { meta } = await agentTurn(config, (root) => {
    fs.writeFileSync(path.join(root, 'secret.env'), 'agent\n')
    write(root, 'cache/data.json', '{}\n')
    write(root, 'linked/inner.txt', 'agent\n')
  })
  // The person moved on: *.env ignored from now on, a local secret.env.
  fs.appendFileSync(path.join(dir, '.gitignore'), '*.env\n')
  sh(dir, 'commit', '-q', '-am', 'ignore env files')
  fs.writeFileSync(path.join(dir, 'secret.env'), 'TOKEN=mine\n')
  fs.writeFileSync(path.join(dir, 'cache'), 'a file where a folder goes\n')
  const outside = tempDir('safety-merge-outside')
  fs.symlinkSync(outside, path.join(dir, 'linked'))
  const head = sh(dir, 'rev-parse', 'HEAD')
  await assert.rejects(applyAgentBranch(config, meta()), (error) => {
    assert.equal(error.code, 'apply_overwrite')
    for (const name of ['secret.env', 'cache', 'linked']) assert.match(error.message, new RegExp(name.replace('.', '\\.')))
    return true
  })
  assert.equal(read(path.join(dir, 'secret.env')), 'TOKEN=mine\n')
  assert.equal(read(path.join(dir, 'cache')), 'a file where a folder goes\n')
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the symlink')
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
})

test('Undo is refused when bringing a file back would overwrite an ignored file', async () => {
  const { dir, config } = repo('safety-undo-overwrite', { 'old.txt': 'old\n' })
  const { meta } = await agentTurn(config, (root) => fs.rmSync(path.join(root, 'old.txt')))
  const applied = await applyAgentBranch(config, meta())
  assert.ok(!fs.existsSync(path.join(dir, 'old.txt')))
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'old.txt\n')
  fs.writeFileSync(path.join(dir, 'old.txt'), 'mine now\n')
  await assert.rejects(revertAppliedBranch(config, applied), (error) => {
    assert.equal(error.code, 'undo_conflict')
    assert.match(error.message, /old\.txt/)
    return true
  })
  assert.equal(read(path.join(dir, 'old.txt')), 'mine now\n')
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), applied.after)
})

// A repository whose config names filter, merge and diff drivers that would
// each leave a marker file if git ever ran them.
function plantedRepo(name) {
  const { dir, config } = repo(name, {
    '.gitattributes': '*.txt merge=x diff=x\n*.bin filter=x\n*.dat filter=p\n',
    'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n',
    'b.txt': 'b\n',
    'kept.bin': 'binary\n',
    'kept.dat': 'data\n',
  })
  const markers = tempDir(`${name}-markers`)
  const mark = (kind) => `echo ${kind} >> "${path.join(markers, kind)}"`
  sh(dir, 'config', 'filter.x.smudge', `${mark('smudge')}; cat`)
  sh(dir, 'config', 'filter.x.clean', `${mark('clean')}; cat`)
  sh(dir, 'config', 'filter.x.required', 'true')
  sh(dir, 'config', 'filter.p.process', mark('process'))
  sh(dir, 'config', 'filter.p.required', 'true')
  sh(dir, 'config', 'merge.x.driver', `${mark('driver')}; false`)
  sh(dir, 'config', 'diff.x.textconv', `${mark('textconv')}; cat`)
  // $GIT_DIR/info/attributes names the same drivers for more files.
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.html merge=x diff=x\n')
  return { dir, config, markers: () => fs.readdirSync(markers).sort() }
}

test('no configured filter, merge or diff driver runs: create, commit, Apply (fast-forward), discard, Undo', async () => {
  const { dir, config, markers } = plantedRepo('safety-drivers-ff')
  const { commit, work, meta } = await agentTurn(config, (root) => {
    assert.equal(read(path.join(root, 'kept.bin')), 'binary\n', 'written from the blob, no smudge')
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>Agent</h1>\n')
  })
  assert.deepEqual(commit.files, ['a.txt', 'index.html'])
  assert.notEqual(work.tree.base, null)
  assert.ok(await checkoutSignature(config))
  const applied = await applyAgentBranch(config, meta())
  assert.equal(applied.mode, 'fast-forward')
  await revertAppliedBranch(config, applied)
  assert.equal(read(path.join(dir, 'index.html')), '<h1>Original</h1>\n')
  const second = await agentTurn(config, (root) => fs.writeFileSync(path.join(root, 'b.txt'), 'agent\n'), { commentId: 2 })
  await discardAgentBranch(config, second.meta())
  assert.deepEqual(markers(), [])
})

test('no configured driver runs in a true merge, its Undo, or the conflict check; a filtered file is refused by name', async () => {
  const { dir, config, markers } = plantedRepo('safety-drivers-merge')
  const merged = await agentTurn(config, (root) => fs.writeFileSync(path.join(root, 'b.txt'), 'agent b\n'))
  const conflicting = await agentTurn(
    config,
    (root) => fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\nagent\n'),
    {
      commentId: 2,
    },
  )
  const filtered = await agentTurn(config, (root) => fs.writeFileSync(path.join(root, 'kept.bin'), 'agent binary\n'), { commentId: 3 })
  // The person moved on, in a.txt too (another line: a merge driver would be asked).
  fs.writeFileSync(path.join(dir, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n')
  // The person's own commit, with the drivers switched off so they leave no marker here.
  const off = ['filter.x.clean=', 'filter.x.smudge=', 'filter.x.required=false', 'filter.p.process=', 'filter.p.required=false']
  sh(dir, ...off.flatMap((flag) => ['-c', flag]), 'commit', '-q', '-am', 'person edit')
  assert.deepEqual(markers(), [])
  const applied = await applyAgentBranch(config, merged.meta())
  assert.equal(applied.mode, 'merge')
  assert.equal(read(path.join(dir, 'b.txt')), 'agent b\n')
  await revertAppliedBranch(config, applied)
  assert.equal(read(path.join(dir, 'b.txt')), 'b\n')
  // Both sides changed a.txt: the merge driver is not run, so the check
  // reports a conflict and nothing changes.
  const head = sh(dir, 'rev-parse', 'HEAD')
  await assert.rejects(applyAgentBranch(config, conflicting.meta()), /conflicts/)
  assert.equal(sh(dir, 'rev-parse', 'HEAD'), head)
  await assert.rejects(applyAgentBranch(config, filtered.meta()), (error) => {
    assert.equal(error.code, 'apply_overwrite')
    assert.match(error.message, /kept\.bin/)
    assert.match(error.message, /filter x/)
    return true
  })
  assert.equal(read(path.join(dir, 'kept.bin')), 'binary\n')
  assert.deepEqual(markers(), [])
  assert.deepEqual(await repoFilters(config), ['p', 'x'])
})

test('a driver name git cannot override safely is refused', async () => {
  const { dir } = repo('safety-driver-name')
  sh(dir, 'config', 'filter.a=b.clean', 'cat')
  await assert.rejects(inertDriverFlags({ gitDir: path.join(dir, '.git'), cwd: dir }), /refusing the git filter driver/)
})
