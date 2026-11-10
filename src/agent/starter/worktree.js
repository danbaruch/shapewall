// The starter agent's git side, on the host: a fresh checkout per run, the
// commit of what the agent changed on a new branch, and (when asked) a push
// of that branch. Never a push to the base or the main branch.
//
// The folder mounted in the container is a plain checkout of the base
// commit with no .git in it: not a git worktree, so nothing the agent writes
// there can point git anywhere. Git on the host never runs with that folder
// as its repository or (except to list untracked files) as its work tree:
//
// - every git call names the repository explicitly (--git-dir, the real
//   common directory found at the start of the run), uses a temporary index
//   kept outside the mount, ignores the system config (GIT_CONFIG_NOSYSTEM),
//   and runs with hooks, fsmonitor and signing off;
// - the commit is built by reading files ourselves (no symlink is followed,
//   by path or as a parent folder, and hard-linked files are refused) and
//   writing blobs with `hash-object --no-filters --stdin`, so no clean or
//   smudge filter, no attribute and no config from the agent's files runs;
// - .gitattributes and .gitmodules keep the base's version whatever the
//   agent did to them, and submodules (gitlinks) are left as they were;
// - the branch is created with update-ref, only if it does not exist.
//
// The folder lives outside the project (the cache folder, or --work-dir)
// and is removed after the run; the branch stays. A run that died leaves an
// owner file; `sweepWorkRoot` removes what dead runs left.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { absoluteProgram } from '../../which.js'

export const SAFE_GIT_FLAGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'core.untrackedCache=false',
]
export const AGENT_AUTHOR = { name: 'Shapewall starter agent', email: 'starter-agent@shapewall.invalid' }
const PROTECTED_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'production', 'staging', 'release'])
const KEEP_BASE = new Set(['.gitattributes', '.gitmodules'])
const SKIP_PARTS = new Set(['.git', 'node_modules'])
export const FILE_MAX = 100 * 1024 * 1024
const RUN_DIR_RE = /^\d{14}-[a-f0-9]{6}$/

// The environment for git: the person's, without anything that would point
// git somewhere else, and without the system config.
function gitEnv(env, extra = {}) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (/^GIT_/.test(key) && !/^GIT_(AUTHOR|COMMITTER)_/.test(key) && !['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS'].includes(key)) continue
    out[key] = value
  }
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...extra }
}

export function git(args, { cwd, env = process.env, extraEnv = {}, input = null, timeoutMs = 120000 } = {}) {
  // An absolute path from absolute PATH entries only: a relative entry would
  // let a `git` in the folder (the agent's checkout) decide what runs.
  const program = absoluteProgram('git', env)
  if (!program) return Promise.reject(new Error('git: not found on PATH'))
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      [...SAFE_GIT_FLAGS, ...args],
      { cwd, env: gitEnv(env, extraEnv), timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message)
            .trim()
            .split('\n')
            .slice(-3)
            .join(' ')
          reject(new Error(`git ${args.find((arg) => !arg.startsWith('-')) || args[0]}: ${message.slice(0, 400)}`))
        } else resolve(stdout.toString('utf8'))
      },
    )
    if (input !== null) {
      // git can exit before reading all of it (EPIPE): the exit is reported above.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

// Where run folders go: --work-dir, else the cache folder.
export function workRoot(projectDir, { flag = null, env = process.env } = {}) {
  if (flag) return path.resolve(flag)
  const cache =
    env.XDG_CACHE_HOME || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : path.join(os.homedir(), '.cache'))
  const tag = createHash('sha256').update(fs.realpathSync(projectDir)).digest('hex').slice(0, 12)
  return path.join(cache, 'shapewall', 'starter-agent', tag)
}

export function newRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

// The branch for a comment: <prefix><board>-<comment>-<run suffix>.
export function branchName(prefix, boardId, commentId, runId) {
  const name = `${prefix}${boardId}-${commentId}-${runId.split('-').pop()}`
  const last = name.split('/').pop()
  if (PROTECTED_BRANCHES.has(name) || PROTECTED_BRANCHES.has(last)) throw new Error(`refusing branch name "${name}"`)
  return name
}

const ownerFile = (root, runId) => path.join(root, `${runId}.owner`)
const indexFile = (root, runId, kind) => path.join(root, `${runId}.${kind}.index`)

// A plain checkout of the project's commit (or `base`), with no .git, for
// the container. Nothing is written to the repository yet.
export async function createWorktree({ projectDir, root, runId, branch, base = 'HEAD' }) {
  if (!RUN_DIR_RE.test(runId)) throw new Error('bad run id')
  const top = (await git(['rev-parse', '--show-toplevel'], { cwd: projectDir })).trim()
  const gitDir = path.resolve(top, (await git(['rev-parse', '--git-common-dir'], { cwd: top })).trim())
  const format = (await git(['--git-dir', gitDir, 'rev-parse', '--show-object-format'], { cwd: top }).catch(() => 'sha1')).trim() || 'sha1'
  // HEAD is per worktree: resolve it where the project is (a linked worktree
  // has its own), never through the shared git dir, which is used for writing.
  const commit = (await git(['rev-parse', '--verify', `${base}^{commit}`], { cwd: projectDir })).trim()
  const exists = await git(['--git-dir', gitDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: top }).then(
    () => true,
    () => false,
  )
  if (exists) throw new Error(`the branch ${branch} exists already`)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.writeFileSync(ownerFile(root, runId), `${process.pid}\n`, { mode: 0o600 })
  const dir = path.join(root, runId)
  const index = indexFile(root, runId, 'checkout')
  const extraEnv = { GIT_INDEX_FILE: index }
  let made = false
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
    made = true
    await git(['--git-dir', gitDir, 'read-tree', commit], { cwd: root, extraEnv })
    // The base is the person's own commit: checking it out is what `git worktree add` would do.
    await git(['--git-dir', gitDir, '--work-tree', dir, 'checkout-index', '--all', '--force'], { cwd: dir, extraEnv })
  } catch (error) {
    // A half-made checkout is not left for the sweep: remove it and the owner file now.
    if (made) fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(ownerFile(root, runId), { force: true })
    throw error
  } finally {
    fs.rmSync(index, { force: true })
  }
  const real = fs.realpathSync(dir)
  const sub = path.relative(top, fs.realpathSync(projectDir))
  return { repo: top, gitDir, format, root, runId, dir: real, projectDir: path.join(real, sub), base: commit, branch }
}

// The blob id git would give `data`.
function blobId(format, data) {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1')
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest('hex')
}

// Reads one path under `root` without following a symlink anywhere:
// { kind: 'missing' } | { kind: 'refused', reason } | { kind: 'entry', mode, data }.
export function readEntry(root, rel) {
  const parts = rel.split('/')
  let current = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index])
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch {
      return { kind: 'missing' }
    }
    if (!stat.isDirectory()) return { kind: 'missing' }
  }
  const full = path.join(root, rel)
  let stat
  try {
    stat = fs.lstatSync(full)
  } catch {
    return { kind: 'missing' }
  }
  if (stat.isSymbolicLink()) return { kind: 'entry', mode: '120000', data: Buffer.from(fs.readlinkSync(full)) }
  if (!stat.isFile()) return { kind: 'missing' }
  if (stat.nlink > 1) return { kind: 'refused', reason: 'a hard link' }
  if (stat.size > FILE_MAX) return { kind: 'refused', reason: 'over 100 MB' }
  let fd
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    return { kind: 'refused', reason: error.code || 'unreadable' }
  }
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink > 1)
      return { kind: 'refused', reason: 'changed while read' }
    const data = fs.readFileSync(fd)
    return { kind: 'entry', mode: opened.mode & 0o100 ? '100755' : '100644', data }
  } finally {
    fs.closeSync(fd)
  }
}

const skipped = (rel, exclude) => {
  const parts = rel.split('/')
  if (parts.some((part) => SKIP_PARTS.has(part))) return true
  return exclude.some((item) => rel === item || rel.startsWith(`${item}/`))
}

// Commits everything the agent changed (except dependencies, the Shapewall
// store and the files that keep the base's version) as the agent, on the
// run's new branch. Returns { committed, commit, files, added, modified,
// deleted, refused } (files is all of added, modified and deleted).
export async function commitWorktree({ tree, message, exclude = [] }) {
  const { gitDir, dir, base, branch, format, root, runId } = tree
  const index = indexFile(root, runId, 'commit')
  const extraEnv = { GIT_INDEX_FILE: index }
  const run = (args, options = {}) => git(['--git-dir', gitDir, ...args], { cwd: root, extraEnv, ...options })
  try {
    await run(['read-tree', base])
    const baseEntries = new Map()
    for (const line of (await run(['ls-tree', '-r', '-z', '--full-tree', base])).split('\0')) {
      if (!line) continue
      const tab = line.indexOf('\t')
      const [mode, type, oid] = line.slice(0, tab).split(' ')
      baseEntries.set(line.slice(tab + 1), { mode, type, oid })
    }
    // Untracked files the repository's ignore rules let through (git lists
    // names here; it reads no file content and follows no symlink).
    const untracked = (await run(['--work-tree', dir, 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    const zero = '0'.repeat(format === 'sha256' ? 64 : 40)
    const updates = []
    const files = []
    // Which files are new: a run that only adds files may have missed the real one.
    const added = []
    const deleted = []
    const refused = []
    const gitlinks = [...baseEntries].filter(([, entry]) => entry.mode === '160000').map(([rel]) => rel)
    for (const rel of new Set([...baseEntries.keys(), ...untracked])) {
      if (skipped(rel, exclude) || KEEP_BASE.has(rel.split('/').pop())) continue
      if (gitlinks.some((link) => rel === link || rel.startsWith(`${link}/`))) continue
      const before = baseEntries.get(rel)
      const now = readEntry(dir, rel)
      if (now.kind === 'refused') {
        refused.push({ path: rel, reason: now.reason })
        continue
      }
      if (now.kind === 'missing') {
        if (before) {
          updates.push(`0 ${zero}\t${rel}\0`)
          files.push(rel)
          deleted.push(rel)
        }
        continue
      }
      const oid = blobId(format, now.data)
      if (before && before.oid === oid && before.mode === now.mode) continue
      const written = (await run(['hash-object', '-w', '--no-filters', '--stdin'], { input: now.data })).trim()
      if (written !== oid) throw new Error(`git wrote ${written} for ${rel}, expected ${oid}`)
      updates.push(`${now.mode} ${oid}\t${rel}\0`)
      files.push(rel)
      if (!before) added.push(rel)
    }
    if (!files.length) return { committed: false, commit: null, files: [], added: [], modified: [], deleted: [], refused }
    await run(['update-index', '-z', '--index-info'], { input: updates.join('') })
    const treeId = (await run(['write-tree'])).trim()
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: AGENT_AUTHOR.name,
      GIT_AUTHOR_EMAIL: AGENT_AUTHOR.email,
      GIT_COMMITTER_NAME: AGENT_AUTHOR.name,
      GIT_COMMITTER_EMAIL: AGENT_AUTHOR.email,
    }
    const commit = (await run(['commit-tree', treeId, '-p', base, '-F', '-'], { env, input: message })).trim()
    // Only a new branch: the zero old value makes update-ref refuse an existing one.
    await run(['update-ref', '-m', 'shapewall starter agent', `refs/heads/${branch}`, commit, zero])
    const modified = files.filter((rel) => !added.includes(rel) && !deleted.includes(rel)).sort()
    return { committed: true, commit, files: files.sort(), added: added.sort(), modified, deleted: deleted.sort(), refused }
  } finally {
    fs.rmSync(index, { force: true })
    fs.rmSync(`${index}.lock`, { force: true })
  }
}

// Removes a folder the agent had, whatever modes it set (never following a symlink).
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  } catch {
    /* modes: open them up and try again */
  }
  const open = (current) => {
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    try {
      fs.chmodSync(current, 0o700)
    } catch {
      return
    }
    for (const name of fs.readdirSync(current)) open(path.join(current, name))
  }
  open(dir)
  fs.rmSync(dir, { recursive: true, force: true })
}

export async function removeWorktree({ tree }) {
  removeTree(tree.dir)
  for (const kind of ['checkout', 'commit']) fs.rmSync(indexFile(tree.root, tree.runId, kind), { force: true })
  fs.rmSync(ownerFile(tree.root, tree.runId), { force: true })
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Removes run folders whose run is gone (its owner process ended, or no
// owner file and older than a day). Returns the run ids removed.
export function sweepWorkRoot(root, { now = Date.now(), isAlive = alive } = {}) {
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    if (!RUN_DIR_RE.test(name)) continue
    let pid = null
    try {
      pid = Number(fs.readFileSync(ownerFile(root, name), 'utf8').trim())
    } catch {
      /* no owner file */
    }
    if (pid !== null && isAlive(pid)) continue
    if (pid === null) {
      try {
        if (now - fs.lstatSync(path.join(root, name)).mtimeMs < 24 * 60 * 60 * 1000) continue
      } catch {
        continue
      }
    }
    removeTree(path.join(root, name))
    for (const kind of ['checkout', 'commit']) fs.rmSync(indexFile(root, name, kind), { force: true })
    fs.rmSync(ownerFile(root, name), { force: true })
    removed.push(name)
  }
  return removed
}

// Pushes the agent's branch, and only it, to the same name on the remote.
export async function pushBranch({ tree, remote }) {
  const { branch } = tree
  const last = branch.split('/').pop()
  if (PROTECTED_BRANCHES.has(branch) || PROTECTED_BRANCHES.has(last)) throw new Error(`refusing to push "${branch}"`)
  await git(['--git-dir', tree.gitDir, 'push', '--no-verify', remote, `refs/heads/${branch}:refs/heads/${branch}`], {
    cwd: tree.repo,
    timeoutMs: 180000,
  })
}

export { alive as processAlive }
