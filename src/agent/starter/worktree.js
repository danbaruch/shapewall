// The starter agent's git side, on the host: a fresh checkout per run, the
// commit of what the agent changed on a new branch, and (when asked) a push
// of that branch. Never a push to the base or the main branch.
//
// The folder mounted in the container is a plain checkout of the base
// commit with no .git in it: not a git worktree, so nothing the agent writes
// there can point git anywhere. Git on the host never runs with that folder
// as its repository or (except to list untracked files) as its work tree:
//
// - the folder is written by Shapewall from the blobs git lists (ls-tree,
//   cat-file --batch): no checkout, so no smudge filter runs. Files a filter
//   handles (Git LFS) come out in their stored form (a pointer file);
// - every git call names the repository explicitly (--git-dir, the real
//   common directory found at the start of the run), uses a temporary index
//   kept outside the mount, ignores the system config (GIT_CONFIG_NOSYSTEM),
//   and runs with hooks, fsmonitor and signing off;
// - the commit is built by reading files ourselves (no symlink is followed,
//   by path or as a parent folder, and hard-linked files are refused) and
//   writing blobs with `hash-object --no-filters --stdin`, so no clean or
//   smudge filter, no attribute and no config from the agent's files runs;
// - untracked files the BASE commit's ignore rules ignore are never
//   committed, whatever the agent wrote to .gitignore;
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
import { execFile, spawn } from 'node:child_process'
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
// The default bound on the bytes of changed files one commit reads in.
export const COMMIT_MAX = 2 * 1024 ** 3
export const RUN_DIR_RE = /^\d{14}-[a-f0-9]{6}$/

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

// `status`: resolve { code, stdout } when git exits with an error code,
// instead of rejecting (a timeout or a spawn failure still rejects).
export function git(args, { cwd, env = process.env, extraEnv = {}, input = null, timeoutMs = 120000, status = false } = {}) {
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
        if (error && status && typeof error.code === 'number' && !error.killed) {
          resolve({ code: error.code, stdout: stdout.toString('utf8'), stderr: String(stderr || '') })
        } else if (error) {
          const message = String(stderr || error.message)
            .trim()
            .split('\n')
            .slice(-3)
            .join(' ')
          reject(new Error(`git ${args.find((arg) => !arg.startsWith('-')) || args[0]}: ${message.slice(0, 400)}`))
        } else resolve(status ? { code: 0, stdout: stdout.toString('utf8'), stderr: String(stderr || '') } : stdout.toString('utf8'))
      },
    )
    if (input !== null) {
      // git can exit before reading all of it (EPIPE): the exit is reported above.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

// The repository's configured filter, merge and diff drivers, each overridden
// with an empty command (-c filter.<name>.process= and so on), so a git call
// that would check files out, merge or compare them runs none of the
// repository's or the person's programs. The `.gitattributes` files and
// $GIT_DIR/info/attributes only name drivers: a name with no command
// configured runs nothing, so overriding every configured command is enough.
// core.attributesFile is /dev/null in SAFE_GIT_FLAGS already.
const DRIVER_RE = '^(filter|merge|diff)\\..*\\.(smudge|clean|process|required|driver|textconv|command)$'
export async function inertDriverFlags({ gitDir, cwd }) {
  const listed = await git(['--git-dir', gitDir, 'config', '-z', '--get-regexp', DRIVER_RE], { cwd, status: true, timeoutMs: 20000 })
  if (listed.code !== 0 && listed.code !== 1) throw new Error(`git config: ${listed.stderr.trim().slice(0, 200)}`)
  const flags = new Set(['diff.external='])
  for (const item of listed.stdout.split('\0')) {
    if (!item) continue
    const key = item.split('\n')[0]
    const match = /^(filter|merge|diff)\.(.+)\.([a-z]+)$/s.exec(key)
    if (!match) continue
    const [, section, name] = match
    // `-c` splits at the first "=": such a name cannot be overridden safely.
    if (/[=\n\0]/.test(name)) throw new Error(`refusing the git ${section} driver "${name.slice(0, 40)}": its name has "=" or a line break`)
    if (section === 'filter') for (const key of ['smudge', 'clean', 'process']) flags.add(`filter.${name}.${key}=`)
    if (section === 'filter') flags.add(`filter.${name}.required=false`)
    if (section === 'merge') flags.add(`merge.${name}.driver=`)
    if (section === 'diff') for (const key of ['textconv', 'command']) flags.add(`diff.${name}.${key}=`)
  }
  return [...flags].flatMap((flag) => ['-c', flag])
}

// The filter names the attributes give to files in `commit` (its
// .gitattributes files and $GIT_DIR/info/attributes): ['lfs'] for a
// repository that uses Git LFS. Reads attribute files as text only.
export async function filterNames({ gitDir, cwd, commit }) {
  const names = new Set()
  const scan = (text) => {
    for (const match of String(text).matchAll(/(?:^|\s)filter=([^\s]+)/g)) names.add(match[1].slice(0, 60))
  }
  const listed = await git(['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--full-tree', commit], { cwd })
  for (const line of listed.split('\0')) {
    const tab = line.indexOf('\t')
    if (tab < 0 || path.posix.basename(line.slice(tab + 1)) !== '.gitattributes') continue
    const [, type, oid] = line.slice(0, tab).split(' ')
    if (type === 'blob') scan(await git(['--git-dir', gitDir, 'cat-file', 'blob', oid], { cwd }))
  }
  try {
    const info = (await git(['--git-dir', gitDir, 'rev-parse', '--git-path', 'info/attributes'], { cwd })).trim()
    scan(fs.readFileSync(path.resolve(cwd, info), 'utf8'))
  } catch {
    /* none */
  }
  return [...names].sort()
}

// The entries of a tree, recursively: [{ mode, type, oid, path }].
export async function treeEntries({ gitDir, cwd, commit, extraEnv = {} }) {
  const out = []
  for (const line of (await git(['--git-dir', gitDir, 'ls-tree', '-r', '-z', '--full-tree', commit], { cwd, extraEnv })).split('\0')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    const [mode, type, oid] = line.slice(0, tab).split(' ')
    out.push({ mode, type, oid, path: line.slice(tab + 1) })
  }
  return out
}

// Reads blobs with one `git cat-file --batch`, calling `onBlob(index, data)`
// in the order of `oids`.
function readBlobs({ gitDir, cwd, oids, onBlob }) {
  if (!oids.length) return Promise.resolve()
  const program = absoluteProgram('git', process.env)
  if (!program) return Promise.reject(new Error('git: not found on PATH'))
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...SAFE_GIT_FLAGS, '--git-dir', gitDir, 'cat-file', '--batch'], {
      cwd,
      env: gitEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = Buffer.alloc(0)
    let index = 0
    let need = null
    let failed = null
    let stderr = ''
    const fail = (error) => {
      if (failed) return
      failed = error
      child.kill()
    }
    child.stdout.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      try {
        for (;;) {
          if (need === null) {
            const end = buffer.indexOf(10)
            if (end < 0) break
            const header = buffer.subarray(0, end).toString('utf8').split(' ')
            buffer = buffer.subarray(end + 1)
            if (header[1] !== 'blob' || header[0] !== oids[index])
              throw new Error(`git cat-file: unexpected "${header.join(' ').slice(0, 120)}"`)
            need = Number(header[2])
          }
          if (buffer.length < need + 1) break
          onBlob(index, buffer.subarray(0, need))
          buffer = buffer.subarray(need + 1)
          need = null
          index += 1
        }
      } catch (error) {
        fail(error)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000)
    })
    child.on('error', fail)
    child.on('close', (code) => {
      if (failed) reject(failed)
      else if (code !== 0 || index !== oids.length) reject(new Error(`git cat-file: ${stderr.trim().slice(0, 300) || `exit ${code}`}`))
      else resolve()
    })
    child.stdin.on('error', () => {})
    child.stdin.end(`${oids.join('\n')}\n`)
  })
}

const BAD_PART = (part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes('\0')

// Writes the files of `commit` into the empty folder `dir` ourselves, with
// no checkout: git only lists the tree and hands over blob contents, so no
// smudge filter, attribute or other configured program runs. Modes and
// symlinks as recorded; a submodule (gitlink) becomes an empty folder.
// Files tracked by Git LFS (or any filter) come out as their stored form
// (an LFS pointer file).
export async function materializeTree({ gitDir, cwd, commit, dir }) {
  const entries = await treeEntries({ gitDir, cwd, commit })
  const made = new Set([''])
  const parentOf = (rel) => {
    const parts = rel.split('/')
    if (parts.some(BAD_PART)) throw new Error(`refusing the path "${rel.slice(0, 120)}" in the tree`)
    let current = ''
    for (const part of parts.slice(0, -1)) {
      current = current ? `${current}/${part}` : part
      if (made.has(current)) continue
      const full = path.join(dir, current)
      let stat = null
      try {
        stat = fs.lstatSync(full)
      } catch {
        fs.mkdirSync(full, { mode: 0o755 })
        stat = fs.lstatSync(full)
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing to write under "${current.slice(0, 120)}": not a folder`)
      made.add(current)
    }
    return path.join(dir, rel)
  }
  const blobs = []
  for (const entry of entries) {
    const full = parentOf(entry.path)
    if (entry.mode === '160000') {
      fs.mkdirSync(full, { mode: 0o755 })
      made.add(entry.path)
    } else if (entry.type === 'blob') blobs.push({ ...entry, full })
  }
  await readBlobs({
    gitDir,
    cwd,
    oids: blobs.map((entry) => entry.oid),
    onBlob: (index, data) => {
      const entry = blobs[index]
      if (entry.mode === '120000') {
        fs.symlinkSync(data.toString('utf8'), entry.full)
        return
      }
      const mode = entry.mode === '100755' ? 0o755 : 0o644
      const fd = fs.openSync(entry.full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode)
      try {
        fs.writeSync(fd, data)
      } finally {
        fs.closeSync(fd)
      }
    },
  })
  return entries.length
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
  let made = false
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
    made = true
    // Written by Shapewall from the blobs, not checked out by git: no smudge
    // filter or other program from the repository's config runs.
    await materializeTree({ gitDir, cwd: root, commit, dir })
  } catch (error) {
    // A half-made checkout is not left for the sweep: remove it and the owner file now.
    if (made) removeTree(dir)
    fs.rmSync(ownerFile(root, runId), { force: true })
    throw error
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
// `maxSize`: refuse a file larger than this without reading it.
export function readEntry(root, rel, { maxSize = FILE_MAX } = {}) {
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
  if (stat.size > maxSize) return { kind: 'refused', reason: "over the run's size limit" }
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

// Whether a symlink at `rel` with this target points outside the repository.
export function linkLeaves(rel, target) {
  if (!target || path.posix.isAbsolute(target) || /^[A-Za-z]:|^\\\\/.test(target)) return true
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target))
  return resolved === '..' || resolved.startsWith('../')
}

// The untracked files in the run folder that the base commit's ignore rules
// (its .gitignore files, plus the repository's info/exclude and the person's
// excludes file) do not ignore. The rules are read from a folder holding only
// the base's .gitignore files, never from the agent's edited ones.
async function untrackedByBaseRules({ run, root, runId, dir, baseEntries }) {
  const all = (await run(['--work-tree', dir, 'ls-files', '--others', '-z', '--exclude=node_modules', '--exclude=.git']))
    .split('\0')
    .filter((rel) => rel && !rel.endsWith('/'))
  if (!all.length) return []
  const shadow = path.join(root, `${runId}.ignore`)
  removeTree(shadow)
  fs.mkdirSync(shadow, { mode: 0o700 })
  try {
    for (const [rel, entry] of baseEntries) {
      if (rel.split('/').pop() !== '.gitignore' || entry.type !== 'blob' || entry.mode === '120000') continue
      if (rel.split('/').some(BAD_PART)) continue
      fs.mkdirSync(path.join(shadow, path.dirname(rel)), { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(shadow, rel), await run(['cat-file', 'blob', entry.oid]), { mode: 0o600 })
    }
    const checked = await run(['--work-tree', shadow, 'check-ignore', '-z', '--stdin', '--no-index'], {
      cwd: shadow,
      input: `${all.join('\0')}\0`,
      status: true,
    })
    if (checked.code > 1) throw new Error(`git check-ignore: ${checked.stderr.trim().slice(0, 200)}`)
    const ignored = new Set(checked.stdout.split('\0').filter(Boolean))
    return all.filter((rel) => !ignored.has(rel))
  } finally {
    removeTree(shadow)
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
// `maxBytes` bounds what is read in for changed files: `du` sees a sparse file
// as small, and a folder of them could keep the host reading for hours.
// `author`: { name, email } for the commit (the starter agent's own by default).
export async function commitWorktree({ tree, message, exclude = [], maxBytes = COMMIT_MAX, author = AGENT_AUTHOR }) {
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
    // Untracked files the BASE commit's ignore rules let through: the agent's
    // own edits to .gitignore never let an ignored file (.env) into the
    // commit. Git lists names here; it reads no file content and follows no
    // symlink.
    const untracked = await untrackedByBaseRules({ run, root, runId, dir, baseEntries })
    const zero = '0'.repeat(format === 'sha256' ? 64 : 40)
    const updates = []
    const files = []
    // Which files are new: a run that only adds files may have missed the real one.
    const added = []
    const deleted = []
    const refused = []
    let total = 0
    // Symlinks that point outside the repository (absolute, or up past its root).
    const links = []
    const gitlinks = [...baseEntries].filter(([, entry]) => entry.mode === '160000').map(([rel]) => rel)
    for (const rel of new Set([...baseEntries.keys(), ...untracked])) {
      if (skipped(rel, exclude) || KEEP_BASE.has(rel.split('/').pop())) continue
      if (gitlinks.some((link) => rel === link || rel.startsWith(`${link}/`))) continue
      const before = baseEntries.get(rel)
      const now = readEntry(dir, rel, { maxSize: Math.max(0, maxBytes - total) })
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
      total += now.data.length
      const written = (await run(['hash-object', '-w', '--no-filters', '--stdin'], { input: now.data })).trim()
      if (written !== oid) throw new Error(`git wrote ${written} for ${rel}, expected ${oid}`)
      updates.push(`${now.mode} ${oid}\t${rel}\0`)
      files.push(rel)
      if (!before) added.push(rel)
      if (now.mode === '120000' && linkLeaves(rel, now.data.toString('utf8'))) links.push(rel)
    }
    if (!files.length)
      return { committed: false, commit: null, files: [], added: [], modified: [], deleted: [], links: [], ignoreChanged: [], refused }
    await run(['update-index', '-z', '--index-info'], { input: updates.join('') })
    const treeId = (await run(['write-tree'])).trim()
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    }
    const commit = (await run(['commit-tree', treeId, '-p', base, '-F', '-'], { env, input: message })).trim()
    // Only a new branch: the zero old value makes update-ref refuse an existing one.
    await run(['update-ref', '-m', 'shapewall starter agent', `refs/heads/${branch}`, commit, zero])
    const modified = files.filter((rel) => !added.includes(rel) && !deleted.includes(rel)).sort()
    return {
      committed: true,
      commit,
      files: files.sort(),
      added: added.sort(),
      modified,
      deleted: deleted.sort(),
      links: links.sort(),
      // .gitignore files the agent changed: what they ignore now did not decide the commit.
      ignoreChanged: files.filter((rel) => rel.split('/').pop() === '.gitignore').sort(),
      refused,
    }
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
// owner file and older than a day). Returns the run ids removed. `keep(id)`:
// true for a folder that must stay whatever its owner (agent branch mode keeps
// a worktree whose commit is not applied yet).
export function sweepWorkRoot(root, { now = Date.now(), isAlive = alive, keep = () => false } = {}) {
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    if (!RUN_DIR_RE.test(name) || keep(name)) continue
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
  // No tags (push.followTags) and no submodule pushes (push.recurseSubmodules)
  // from the person's config: the branch is all that goes.
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`
  await git(['--git-dir', tree.gitDir, 'push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', remote, refspec], {
    cwd: tree.repo,
    timeoutMs: 180000,
  })
}

export { alive as processAlive }
