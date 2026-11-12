// What an agent turn changed, for the chat's run summary, and a safe Undo.
//
// An ACP coding agent (Claude Code, Codex, ...) edits the project folder
// itself. Before an owner's turn, Shapewall reads the project's small files
// into memory (bounded; never the store, dependencies, build output, Git data
// or files that usually hold secrets, never through a symlink). After the
// turn it compares: the files that were added, changed or deleted, each with
// its +/- counts and a bounded diff, and an undo record kept in this
// process's memory only. Files Git ignores are not the agent's work and are
// left out entirely (see ignoredPaths below): never read, listed, counted or
// undone. Nothing read here goes to the model or to a log;
// the stored summary holds diffs of the changed text files only, and never
// of a file that looks like it holds secrets.
//
// Undo restores exactly the turn's files to what they were before it, and
// only when every one of them is still what the agent left (same content
// hash): an edit made since, by a person or a later turn, is never
// overwritten, and nothing is undone partly. It is not offered when the turn
// overlapped another agent turn in the project, made a Git commit, or
// changed a file whose earlier content was not kept (too big, too many, a
// secrets file).
//
// The starter agent (`shapewall agent run`) never touches the checkout: it
// commits on a new branch. Its summary lists that commit's files; its Undo
// deletes the branch, only while it is not pushed and still points at the
// agent's own commit (worktree.js AGENT_AUTHOR, the shapewall:<board>/<id>
// trailer).

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { AgentError } from './errors.js'
import { diffForCard } from './text-diff.js'
import { AGENT_AUTHOR, git, readEntry } from './starter/worktree.js'

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage', '.output', '.shapewall'])
// Shapewall's own folders, whatever they are called (.shapewall, .shapewall-export, ...).
const skipped = (name) => SKIP.has(name) || name.startsWith('.shapewall')
export const ENTRIES_MAX = 30000
export const FILE_KEEP_MAX = 1024 * 1024
export const BASELINE_BYTES_MAX = 32 * 1024 * 1024
export const CHANGED_MAX = 50
const DIFF_FILES_MAX = 12
const SUMMARY_DIFF_BYTES_MAX = 96 * 1024
const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d{1,7}\b/
// Names that usually hold secrets: their text is never kept or shown.
export const SECRET_RE =
  /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|secrets?\.[^/]*)$/i

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const stampOf = (stat) => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`

// Reads a regular file without following a symlink, or null.
function readFile(full, stat) {
  let fd
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return null
    return fs.readFileSync(fd)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

// What Git ignores in the project folder right now, by the working tree's own
// rules: .gitignore files as they are on disk (committed or not),
// .git/info/exclude and the person's global excludes. Another process on the
// machine often writes there during a turn (a dev server's data, logs, a
// cache): those files are not the agent's, so they are never listed or
// counted, and above all never touched by Undo, which would otherwise
// delete or roll back somebody else's data.
// Returns { files: Set, dirs: Set } of paths relative to the project folder
// (directories end in "/"), or null when Git cannot say: the folder is not
// in a repository, or the folder itself is ignored by the repository around
// it (then Git's rules say nothing useful about what is inside). Tracked
// files are never "ignored", whatever .gitignore says.
export async function ignoredPaths(dir) {
  try {
    const inside = await git(['check-ignore', '-q', '.'], { cwd: dir, timeoutMs: 10000, status: true })
    // 1: not ignored. 0: the folder itself is ignored. 128: not a repository.
    if (inside.code !== 1) return null
    const out = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: dir, timeoutMs: 20000 })
    const ignored = { files: new Set(), dirs: new Set() }
    for (const item of out.split('\0')) {
      if (!item || item.startsWith('../')) continue
      if (item.endsWith('/')) ignored.dirs.add(item)
      else ignored.files.add(item)
    }
    return ignored
  } catch {
    return null
  }
}

// Whether `rel` (a file) is ignored: itself, or any folder above it.
export function isIgnored(ignored, rel) {
  if (!ignored) return false
  if (ignored.files.has(rel)) return true
  const parts = rel.split('/')
  let prefix = ''
  for (let index = 0; index < parts.length - 1; index += 1) {
    prefix += `${parts[index]}/`
    if (ignored.dirs.has(prefix)) return true
  }
  return false
}

// The project's files: rel -> { stamp, mode, data? }. `keep`: read content
// (bounded) for the files that may need restoring. `ignored` (ignoredPaths):
// what Git ignores, skipped without being read or counted.
export function scanProject(config, { keep = false, bytesMax = BASELINE_BYTES_MAX, entriesMax = ENTRIES_MAX, ignored = null } = {}) {
  const files = new Map()
  let visited = 0
  let bytes = 0
  let incomplete = false
  const outputDir = config.outputDir ? path.resolve(config.outputDir) : null
  const walk = (dir) => {
    if (outputDir && path.resolve(dir) === outputDir) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++visited > entriesMax) {
        incomplete = true
        return
      }
      if (entry.isSymbolicLink() || skipped(entry.name)) continue
      const full = path.join(dir, entry.name)
      const relPath = path.relative(config.dir, full).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (ignored?.dirs.has(`${relPath}/`)) continue
        walk(full)
        continue
      }
      if (ignored?.files.has(relPath)) continue
      if (!entry.isFile()) continue
      let stat
      try {
        stat = fs.lstatSync(full, { bigint: true })
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      const rel = path.relative(config.dir, full).split(path.sep).join('/')
      const item = { stamp: stampOf(stat), mode: Number(stat.mode & 0o777n), size: Number(stat.size) }
      if (keep && stat.nlink === 1n && item.size <= FILE_KEEP_MAX && bytes + item.size <= bytesMax && !SECRET_RE.test(rel)) {
        const data = readFile(full, stat)
        if (data) {
          item.data = data
          bytes += data.length
        }
      }
      files.set(rel, item)
    }
  }
  walk(config.dir)
  return { files, incomplete }
}

async function gitHead(dir) {
  try {
    return (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir, timeoutMs: 10000 })).trim() || null
  } catch {
    return null
  }
}

// The commits from `before` to `after` (newest first, at most 5) and the branch.
async function commitsBetween(dir, before, after) {
  try {
    const range = before ? `${before}..${after}` : after
    const out = await git(['log', '--no-color', '--format=%H%x1f%s', '-n', '5', range, '--'], { cwd: dir, timeoutMs: 10000 })
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeoutMs: 10000 }).catch(() => '')).trim()
    const commits = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split('\x1f')
        return { sha, subject: String(subject || '').slice(0, 160) }
      })
    return { commits, branch: branch && branch !== 'HEAD' ? branch.slice(0, 200) : null }
  } catch {
    return { commits: [], branch: null }
  }
}

const isText = (data) => {
  if (!data) return false
  if (data.subarray(0, 8192).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}

// One summary entry: the path, what happened, its counts and a bounded diff.
function fileEntry(rel, status, before, after, budget) {
  const entry = { path: rel.slice(0, 300), status, added: null, removed: null, diff: null }
  if (SECRET_RE.test(rel)) return { ...entry, hidden: true }
  const oldText = status === 'added' ? null : before && isText(before) ? before.toString('utf8') : undefined
  const newText = status === 'deleted' ? '' : after && isText(after) ? after.toString('utf8') : undefined
  if (oldText === undefined || newText === undefined) return { ...entry, binary: Boolean(before || after) }
  const diff = diffForCard(rel, oldText, newText)
  entry.added = diff.added
  entry.removed = diff.removed
  if (budget.files < DIFF_FILES_MAX) {
    const size = Buffer.byteLength(diff.preview) + Buffer.byteLength(diff.full || '')
    const keepFull = budget.bytes + size <= SUMMARY_DIFF_BYTES_MAX
    const shown = keepFull ? diff : { ...diff, full: null, truncated: Boolean(diff.full) }
    const shownSize = Buffer.byteLength(shown.preview) + Buffer.byteLength(shown.full || '')
    if (budget.bytes + shownSize <= SUMMARY_DIFF_BYTES_MAX) {
      entry.diff = shown
      budget.bytes += shownSize
      budget.files += 1
    }
  }
  return entry
}

// Taken before an owner's turn. `comments`: the board's comments now.
export async function beginTurnChanges(config, { comments = [], files = true } = {}) {
  const ignored = files ? await ignoredPaths(config.dir) : null
  return {
    ignored,
    scan: files ? scanProject(config, { keep: true, ignored }) : null,
    head: files ? await gitHead(config.dir) : null,
    statuses: new Map(comments.map((comment) => [comment.id, comment.status])),
  }
}

// After the turn: { summary, undo } (summary null when nothing changed).
// `overlapped`: another agent turn ran in this project meanwhile.
// `pageIds`: pages the turn asked to recapture; the thread's comment's page
// (`commentId`) and the pages of comments it resolved are added.
export async function finishTurnChanges(
  config,
  baseline,
  { comments = [], board, reply, pageIds = [], commentId = null, overlapped = false } = {},
) {
  const resolvedComments = comments
    .filter(
      (comment) => comment.status === 'resolved' && baseline.statuses.has(comment.id) && baseline.statuses.get(comment.id) !== 'resolved',
    )
    .slice(0, 50)
  const resolved = resolvedComments.map((comment) => comment.id)
  const pagesOf = [
    commentId ? comments.find((comment) => comment.id === commentId)?.pageId : null,
    ...resolvedComments.map((c) => c.pageId),
  ]
  const changed = []
  const undoFiles = []
  let undoReason = null
  let commit = null
  if (baseline.scan) {
    // Ignored now or when the turn began: either way not the agent's to
    // list or undo. (A file the turn itself made ignored, by editing
    // .gitignore, would otherwise show as deleted.)
    const ignored = await ignoredPaths(config.dir)
    const after = scanProject(config, { ignored })
    const before = baseline.scan.files
    const budget = { files: 0, bytes: 0 }
    const paths = [...new Set([...before.keys(), ...after.files.keys()])].sort()
    for (const rel of paths) {
      if (isIgnored(ignored, rel) || isIgnored(baseline.ignored, rel)) continue
      const was = before.get(rel)
      const now = after.files.get(rel)
      if (was && now && was.stamp === now.stamp) continue
      let nowData = null
      if (now) {
        const entry = readEntry(config.dir, rel)
        nowData = entry.kind === 'entry' && entry.mode !== '120000' ? entry.data : null
        if (!nowData && entry.kind !== 'missing') {
          undoReason = undoReason || `${rel} could not be read`
        }
        if (was?.data && nowData && was.data.equals(nowData)) continue
      }
      if (changed.length >= CHANGED_MAX) {
        undoReason = `the turn changed more than ${CHANGED_MAX} files`
        break
      }
      const status = !was ? 'added' : !now ? 'deleted' : 'modified'
      changed.push(fileEntry(rel, status, was?.data || null, nowData, budget))
      if (was && !was.data) undoReason = undoReason || `the earlier version of ${rel} was not kept`
      undoFiles.push({
        path: rel,
        before: was ? was.data || null : null,
        existed: Boolean(was),
        mode: was?.mode ?? null,
        after: now ? (nowData ? sha256(nowData) : 'unreadable') : null,
      })
    }
    if (baseline.scan.incomplete || after.incomplete) undoReason = undoReason || 'the project has too many files to compare'
    const head = await gitHead(config.dir)
    if (head && head !== baseline.head) {
      const found = await commitsBetween(config.dir, baseline.head, head)
      commit = { sha: head, branch: found.branch, commits: found.commits }
      undoReason = undoReason || 'the agent made a Git commit; revert it with Git'
    }
  }
  if (overlapped && changed.length) undoReason = undoReason || 'another agent turn ran at the same time'
  const pr = PR_RE.exec(reply?.text || '')?.[0] || null
  if (!changed.length && !resolved.length && !commit) return { summary: null, undo: null }
  const knownPages = new Set((board?.pages || []).map((page) => page.id))
  const recapture = [...new Set([...pagesOf, ...pageIds])].filter((id) => knownPages.has(id)).slice(0, 20)
  const summary = {
    kind: 'files',
    files: changed,
    added: changed.reduce((sum, item) => sum + (item.added || 0), 0),
    removed: changed.reduce((sum, item) => sum + (item.removed || 0), 0),
    commit,
    pr: pr ? { url: pr } : null,
    resolved,
    recapture,
    undo: changed.length
      ? undoReason
        ? { kind: 'files', available: false, reason: undoReason }
        : { kind: 'files', available: true }
      : null,
    undone: null,
  }
  return { summary, undo: changed.length && !undoReason ? { files: undoFiles, at: Date.now() } : null }
}

// Whether `rel`'s folders are real folders or missing (to be created), never
// a symlink or a file: checked for every file before Undo writes anything.
function parentsOk(root, rel) {
  let current = root
  for (const part of rel.split('/').slice(0, -1)) {
    current = path.join(current, part)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch {
      return true
    }
    if (!stat.isDirectory()) return false
  }
  return true
}

// Directories down to `rel`'s parent, created where missing, never through a symlink.
function ensureParents(root, rel) {
  const parts = rel.split('/').slice(0, -1)
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    let stat = null
    try {
      stat = fs.lstatSync(current)
    } catch {
      fs.mkdirSync(current, { mode: 0o755 })
      continue
    }
    if (!stat.isDirectory()) throw new AgentError('undo_conflict', `${rel} cannot be restored: its folder was replaced.`, 409)
  }
}

const cleanRel = (rel) =>
  typeof rel === 'string' &&
  rel.length > 0 &&
  rel.length <= 1000 &&
  !rel.startsWith('/') &&
  !rel.includes('\\') &&
  !rel.includes('\0') &&
  rel.split('/').every((part) => part && part !== '.' && part !== '..' && !skipped(part))

// Restores the files of an undo record, all or nothing. Returns the paths.
// `ignored` (ignoredPaths, read by the caller right before): a last check
// that nothing Git ignores is about to be written or removed.
export function undoFiles(config, record, { ignored = null } = {}) {
  const root = config.dir
  const files = record?.files || []
  if (!files.length) throw new AgentError('undo_unavailable', 'There is nothing to undo.', 409)
  for (const item of files) {
    if (isIgnored(ignored, item.path))
      throw new AgentError('undo_unavailable', `${item.path} is ignored by Git, so it is not the agent's to undo. Nothing was undone.`, 409)
    if (!cleanRel(item.path)) throw new AgentError('undo_unavailable', 'This change cannot be undone here.', 409)
    const current = readEntry(root, item.path)
    if (current.kind === 'refused' || (current.kind === 'entry' && current.mode === '120000'))
      throw new AgentError('undo_conflict', `${item.path} changed after the agent's turn, so nothing was undone.`, 409)
    const now = current.kind === 'entry' ? sha256(current.data) : null
    if (now !== item.after)
      throw new AgentError('undo_conflict', `${item.path} changed after the agent's turn, so nothing was undone.`, 409)
    if (item.existed && !Buffer.isBuffer(item.before)) throw new AgentError('undo_unavailable', 'This change cannot be undone here.', 409)
    if (!parentsOk(root, item.path))
      throw new AgentError('undo_conflict', `${item.path} cannot be restored: its folder was replaced, so nothing was undone.`, 409)
  }
  const done = []
  for (const item of files) {
    const full = path.join(root, item.path)
    if (!item.existed) {
      fs.rmSync(full, { force: true })
    } else {
      ensureParents(root, item.path)
      const temp = path.join(path.dirname(full), `.${path.basename(full)}.shapewall-undo-${randomBytes(4).toString('hex')}`)
      fs.writeFileSync(temp, item.before, { mode: item.mode ?? 0o644, flag: 'wx' })
      try {
        fs.chmodSync(temp, item.mode ?? 0o644)
        fs.renameSync(temp, full)
      } catch (error) {
        fs.rmSync(temp, { force: true })
        throw error
      }
    }
    done.push(item.path)
  }
  return done
}

// ---- The starter agent's branch -----------------------------------------------

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

// The summary of a starter run's commit: its files with counts and diffs,
// read from Git objects (no filter or textconv runs).
export async function starterSummary({ tree, commit, pr = null, branch }) {
  if (!tree || !commit?.commit) return null
  const budget = { files: 0, bytes: 0 }
  // git() returns text: content that is not UTF-8 comes back with U+FFFD
  // in it, and counts as binary (a NUL byte) rather than a wrong diff.
  const blob = async (rev, rel) => {
    try {
      const text = await git(['--git-dir', tree.gitDir, 'cat-file', 'blob', `${rev}:${rel}`], { cwd: tree.repo, timeoutMs: 20000 })
      return /[�\0]/.test(text) ? Buffer.from([0]) : Buffer.from(text, 'utf8')
    } catch {
      return null
    }
  }
  const sub = path.relative(tree.dir, tree.projectDir).split(path.sep).join('/')
  const files = []
  for (const rel of commit.files.slice(0, CHANGED_MAX)) {
    const status = commit.added?.includes(rel) ? 'added' : commit.deleted?.includes(rel) ? 'deleted' : 'modified'
    const before = status === 'added' ? null : await blob(tree.base, rel)
    const after = status === 'deleted' ? null : await blob(commit.commit, rel)
    const shown = sub && rel.startsWith(`${sub}/`) ? rel.slice(sub.length + 1) : rel
    files.push(fileEntry(shown, status, before, after, budget))
  }
  const pushed = Boolean(pr?.url)
  return {
    kind: 'starter',
    files,
    added: files.reduce((sum, item) => sum + (item.added || 0), 0),
    removed: files.reduce((sum, item) => sum + (item.removed || 0), 0),
    more: Math.max(0, commit.files.length - files.length),
    commit: { sha: commit.commit, branch, commits: [] },
    pr: pushed ? { url: String(pr.url).slice(0, 300) } : null,
    resolved: [],
    recapture: [],
    undo: pushed
      ? { kind: 'branch', available: false, reason: 'the branch was pushed; close the pull request instead' }
      : { kind: 'branch', available: true, branch, commit: commit.commit },
    undone: null,
  }
}

// Deletes the starter agent's unpushed branch. Every condition is checked in
// Git itself, not taken from the stored summary.
export async function undoStarterBranch(config, { boardId, commentId, branch, commit }) {
  if (!BRANCH_RE.test(String(branch || '')) || !SHA_RE.test(String(commit || '')))
    throw new AgentError('undo_unavailable', 'This change cannot be undone here.', 409)
  const run = (args) => git(args, { cwd: config.dir, timeoutMs: 20000 })
  const ref = `refs/heads/${branch}`
  const current = (await run(['rev-parse', '--verify', '-q', ref]).catch(() => '')).trim()
  if (current !== commit) throw new AgentError('undo_conflict', 'The branch moved or is gone, so it was left as it is.', 409)
  const [email, ...body] = (await run(['log', '-1', '--format=%ae%x00%B', commit])).split('\0')
  if (email.trim() !== AGENT_AUTHOR.email || !body.join('').includes(`shapewall:${boardId}/${commentId}`))
    throw new AgentError('undo_unavailable', 'That branch is not the starter agent run for this comment.', 409)
  const remotes = (await run(['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/remotes'])).trim()
  if (remotes)
    throw new AgentError('undo_unavailable', 'The branch was pushed, so it was left as it is. Close its pull request instead.', 409)
  await run(['update-ref', '-m', 'shapewall: undo starter agent run', '-d', ref, commit])
  return { branch }
}
