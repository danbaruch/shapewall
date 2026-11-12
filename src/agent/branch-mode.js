// Agent branch mode: a coding agent connected over ACP (Claude Code, Codex,
// goose) makes its changes in a separate checkout on a new branch, never in
// the person's working checkout. Off by default.
//
// It reuses the starter agent's git side (starter/worktree.js) and its rules:
//
// - the checkout is a plain copy of HEAD with no .git in it, written by
//   Shapewall from the blobs (no git checkout, so no smudge filter runs), in
//   <project>/.shapewall/agent-worktrees/<run id>. Nothing the agent writes
//   there can point git anywhere, and `GIT_CEILING_DIRECTORIES` stops git
//   commands the agent runs from finding the project's own repository;
// - the agent's work is committed by Shapewall at the end of the turn by
//   reading the files itself and writing blobs with hash-object --no-filters
//   (no filter, attribute or hook runs; .gitattributes and .gitmodules keep
//   their base version; symlinks out of the checkout are refused), on a new
//   branch made with update-ref only if it does not exist;
// - every git call runs with hooks, fsmonitor and signing off and the system
//   config ignored (SAFE_GIT_FLAGS), and git's environment scrubbed; on the
//   person's checkout every configured filter, merge and diff driver is
//   overridden with an empty command (inertDriverFlags);
// - the agent's commit leaves out what the base commit's ignore rules ignore,
//   whatever the agent did to .gitignore.
//
// Apply brings the branch into the person's checkout: only when it is clean,
// on a branch, with no merge or rebase in progress, and the agent's branch
// still points at the agent's commit. A fast-forward when possible, else a
// merge that `git merge-tree` checked first: on a conflict nothing changes.
// It is refused, changing nothing, when it would write over a file Git does
// not track (an ignored .env) or touch a file a Git filter handles (LFS);
// Undo has the same check. Submodules are never recursed into, and nothing
// is stashed.
//
// The branch name comes from the comment text, sanitized to [a-z0-9-] and
// never starting with "-"; commits are passed by their id, never by a name a
// person or a model chose. The worktree folder is fixed under the project's
// .shapewall folder: the config's outputDir cannot move it, and a symlinked
// .shapewall or agent-worktrees folder is refused.

import fs from 'node:fs'
import path from 'node:path'
import {
  createWorktree,
  commitWorktree,
  filterNames,
  git,
  inertDriverFlags,
  newRunId,
  processAlive,
  removeWorktree,
  sweepWorkRoot,
  RUN_DIR_RE,
} from './starter/worktree.js'
import { userAgentEntry } from './user-settings.js'
import { THREAD_RE } from './thread-history.js'

export const BRANCH_MODE_VAR = 'SHAPEWALL_AGENT_BRANCH_MODE'
export const BRANCH_PREFIX_VAR = 'SHAPEWALL_AGENT_BRANCH_PREFIX'
export const DEFAULT_BRANCH_PREFIX = 'shapewall/'
export const WORKTREES_DIR = path.join('.shapewall', 'agent-worktrees')
export const FALLBACK_AUTHOR = { name: 'Shapewall agent', email: 'agent@shapewall.invalid' }
const PREFIX_MAX = 40
// Segments of letters, digits, "_" and "-" (each starting with a letter or a
// digit) joined by "/", with or without a trailing "/". No dots at all (no
// "..", no ".lock"), no spaces, nothing git would read as an option.
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*\/?$/
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/
const BRANCH_MAX = 120
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MESSAGE_ID_RE = /^msg_[a-z0-9]{1,40}$/
const PROTECTED = new Set(['main', 'master', 'trunk', 'develop', 'production', 'staging', 'release', 'head'])
const IN_PROGRESS = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
]
// For git on the person's checkout (Apply, revert): no submodule recursion,
// no autostash, no automatic gc or maintenance started from here.
const CHECKOUT_FLAGS = [
  '-c',
  'submodule.recurse=false',
  '-c',
  'merge.autoStash=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'merge.verifySignatures=false',
]

export class BranchError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// A prefix as given, or null when it is not one Shapewall accepts.
export function cleanBranchPrefix(value) {
  if (typeof value !== 'string') return null
  const prefix = value.trim()
  if (!prefix || prefix.length > PREFIX_MAX || !PREFIX_RE.test(prefix)) return null
  return prefix
}

const envFlag = (value) => {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(text)) return true
  if (['0', 'false', 'off', 'no'].includes(text)) return false
  return null
}

// `agent.branchMode` (true or false) and `agent.branchPrefix` in
// shapewall.config.json. Pushes one message per problem.
export function validateBranchConfig(raw, problems) {
  const out = {}
  if (!isObject(raw)) return out
  if (raw.branchMode !== undefined) {
    if (typeof raw.branchMode !== 'boolean') problems.push('agent.branchMode: true or false')
    else out.branchMode = raw.branchMode
  }
  if (raw.branchPrefix !== undefined) {
    const prefix = cleanBranchPrefix(raw.branchPrefix)
    if (!prefix)
      problems.push(`agent.branchPrefix: letters, digits, "-", "_" and "/", at most ${PREFIX_MAX} characters, such as "shapewall/"`)
    else out.branchPrefix = prefix
  }
  return out
}

// Whether the agent works on a branch here, and the branch prefix. The
// environment wins, then Settings (agents.json), then the config.
// { enabled, prefix, sources: { enabled, prefix } } (env | settings | config | null)
export function branchModeSettings(config, env = process.env) {
  const repo = config.agent || {}
  const saved = config.dir ? userAgentEntry(config.dir, env).entry || {} : {}
  const fromEnv = envFlag(env[BRANCH_MODE_VAR])
  let enabled = false
  let enabledSource = null
  if (fromEnv !== null) [enabled, enabledSource] = [fromEnv, 'env']
  else if (typeof saved.branchMode === 'boolean') [enabled, enabledSource] = [saved.branchMode, 'settings']
  else if (typeof repo.branchMode === 'boolean') [enabled, enabledSource] = [repo.branchMode, 'config']
  let prefix = DEFAULT_BRANCH_PREFIX
  let prefixSource = null
  const envPrefix = cleanBranchPrefix(env[BRANCH_PREFIX_VAR])
  if (envPrefix) [prefix, prefixSource] = [envPrefix, 'env']
  else if (cleanBranchPrefix(saved.branchPrefix)) [prefix, prefixSource] = [saved.branchPrefix, 'settings']
  else if (cleanBranchPrefix(repo.branchPrefix)) [prefix, prefixSource] = [repo.branchPrefix, 'config']
  return { enabled, prefix, sources: { enabled: enabledSource, prefix: prefixSource } }
}

// The first line of `text` as a short [a-z0-9-] name, "fix" when nothing is left.
export function slugOf(text, max = 32) {
  const slug = String(text || '')
    .split('\n')[0]
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return slug || 'fix'
}

export function validBranchName(name) {
  if (typeof name !== 'string' || name.length > BRANCH_MAX || !BRANCH_RE.test(name)) return false
  const parts = name.toLowerCase().split('/')
  return !PROTECTED.has(name.toLowerCase()) && !PROTECTED.has(parts.at(-1))
}

// <prefix>comment-<n>-<slug> for a comment, <prefix>chat-<thread>-<n> for a chat.
export function agentBranchName({ prefix = DEFAULT_BRANCH_PREFIX, kind, commentId = null, threadId = 'board', n = 1, text = '' }) {
  const clean = cleanBranchPrefix(prefix)
  if (!clean) throw new BranchError('bad_prefix', 'The branch prefix is not valid.', 400)
  const count = Number.isSafeInteger(Number(n)) && Number(n) > 0 ? Number(n) : 1
  let tail
  if (kind === 'comment') {
    if (!Number.isSafeInteger(commentId) || commentId <= 0)
      throw new BranchError('bad_branch', 'A comment branch needs the comment number.', 400)
    tail = `comment-${commentId}-${slugOf(text)}`
  } else {
    const thread = String(threadId || 'board')
      .replace(/^chat-/, '')
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 16)
    tail = `chat-${thread || 'board'}-${count}`
  }
  const name = `${clean}${tail}`
  if (!validBranchName(name)) throw new BranchError('bad_branch', `refusing branch name "${name.slice(0, 80)}"`, 400)
  return name
}

// The folder the worktrees go in: <project>/.shapewall/agent-worktrees, both
// real folders (never a symlink). `create`: make them (0700) when missing.
export function agentWorktreeRoot(config, { create = false } = {}) {
  const project = fs.realpathSync(config.dir)
  const store = path.join(project, '.shapewall')
  const root = path.join(store, 'agent-worktrees')
  for (const dir of [store, root]) {
    let stat
    try {
      stat = fs.lstatSync(dir)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return root
      fs.mkdirSync(dir, { mode: 0o700 })
      stat = fs.lstatSync(dir)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new BranchError(
        'bad_worktree_root',
        `${path.relative(project, dir)} is not a plain folder, so the agent cannot work on a branch here. Remove it, or turn off "Agent works on a branch".`,
      )
    }
  }
  if (fs.realpathSync(root) !== root) throw new BranchError('bad_worktree_root', 'The agent worktree folder resolves outside the project.')
  return root
}

const metaFile = (root, id) => path.join(root, `${id}.json`)

// A stored record, checked field by field (the folder is the person's, but
// anything that ends up in a git command is checked again here).
function cleanMeta(raw, id) {
  if (!isObject(raw) || raw.id !== id || !RUN_DIR_RE.test(id)) return null
  if (!validBranchName(raw.branch) || !SHA_RE.test(String(raw.base || ''))) return null
  if (raw.commit !== null && raw.commit !== undefined && !SHA_RE.test(String(raw.commit))) return null
  if (!BOARD_ID_RE.test(String(raw.boardId || '')) || !THREAD_RE.test(String(raw.threadId || ''))) return null
  // The project's folder inside the checkout: plain relative segments only.
  const sub =
    typeof raw.sub === 'string' &&
    raw.sub &&
    raw.sub.length <= 500 &&
    raw.sub.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes('\0'))
      ? raw.sub
      : null
  return {
    version: 1,
    id,
    branch: raw.branch,
    base: raw.base,
    commit: raw.commit || null,
    sub,
    boardId: raw.boardId,
    threadId: raw.threadId,
    commentId: Number.isSafeInteger(raw.commentId) && raw.commentId > 0 ? raw.commentId : null,
    messageId: MESSAGE_ID_RE.test(String(raw.messageId || '')) ? raw.messageId : null,
    kind: raw.kind === 'comment' ? 'comment' : 'chat',
    files: Number.isSafeInteger(raw.files) && raw.files >= 0 ? raw.files : 0,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : null,
    committedAt: typeof raw.committedAt === 'string' ? raw.committedAt.slice(0, 40) : null,
  }
}

export function writeMeta(root, meta) {
  const file = metaFile(root, meta.id)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

export function readMeta(config, id) {
  if (!RUN_DIR_RE.test(String(id || ''))) return null
  let root
  try {
    root = agentWorktreeRoot(config)
  } catch {
    return null
  }
  try {
    return cleanMeta(JSON.parse(fs.readFileSync(metaFile(root, id), 'utf8')), id)
  } catch {
    return null
  }
}

function readAllMeta(root) {
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!RUN_DIR_RE.test(id)) continue
    try {
      const meta = cleanMeta(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')), id)
      if (meta) out.push(meta)
    } catch {
      /* a record being written or broken: skipped */
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

// The project's repository: { top, gitDir, head, branch } or a BranchError
// saying why the agent cannot work on a branch here.
export async function checkRepo(config) {
  const run = (args) => git(args, { cwd: config.dir, timeoutMs: 20000 })
  let top
  try {
    top = (await run(['rev-parse', '--show-toplevel'])).trim()
  } catch {
    top = ''
  }
  if (!top)
    throw new BranchError(
      'not_a_repo',
      'This project is not a Git repository, so the agent cannot work on a branch. Run git init and commit, or turn off "Agent works on a branch".',
    )
  const head = (await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')).trim()
  if (!SHA_RE.test(head))
    throw new BranchError(
      'unborn_head',
      'This repository has no commit yet, so there is nothing to branch from. Make a first commit, then try again.',
    )
  const gitDir = (await run(['rev-parse', '--absolute-git-dir'])).trim()
  for (const [marker, what] of IN_PROGRESS) {
    if (fs.existsSync(path.join(gitDir, marker)))
      throw new BranchError('git_busy', `A ${what} is in progress in this repository. Finish or abort it first, then try again.`)
  }
  const branch = (await run(['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')).trim() || null
  return { top, gitDir, head, branch }
}

// The Git filters (['lfs']) the attributes of HEAD and $GIT_DIR/info/attributes
// name. Branch mode runs none of them: the agent's checkout holds those files
// as stored (an LFS pointer file), and Apply refuses a change to one. [] when
// it cannot tell (not a repository yet).
export async function repoFilters(config) {
  try {
    const repo = await checkRepo(config)
    return await filterNames({ gitDir: repo.gitDir, cwd: repo.top, commit: repo.head })
  } catch {
    return []
  }
}

async function refTip(config, branch) {
  if (!validBranchName(branch)) return null
  const out = await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: config.dir, timeoutMs: 20000 }).catch(() => '')
  return SHA_RE.test(out.trim()) ? out.trim() : null
}

// The author of the agent's commit: the repository's user.name and
// user.email (its own config and the person's global one), else Shapewall's.
export async function repoAuthor(cwd) {
  const read = async (key) =>
    (await git(['config', '--get', key], { cwd, timeoutMs: 10000 }).catch(() => ''))
      .trim()
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f<>]/g, '')
      .slice(0, 200)
  const name = await read('user.name')
  const email = await read('user.email')
  return name && email ? { name, email, configured: true } : { ...FALLBACK_AUTHOR, configured: false }
}

// A new worktree for one agent turn, on a branch that does not exist yet
// (made when the turn's work is committed). -> { tree, meta, root }
export async function createAgentBranch(
  config,
  {
    prefix = DEFAULT_BRANCH_PREFIX,
    kind,
    boardId,
    threadId,
    commentId = null,
    text = '',
    n = 1,
    now = new Date(),
    // A connected agent's fix (src/remote/agent-fix.js): a commit to start
    // from other than HEAD, and a worktrees folder outside the project.
    base = null,
    root: givenRoot = null,
  },
) {
  const repo = await checkRepo(config)
  if (base !== null && !SHA_RE.test(String(base))) throw new BranchError('bad_base', 'The commit to start from is not valid.', 400)
  const root = givenRoot || agentWorktreeRoot(config, { create: true })
  const first = agentBranchName({ prefix, kind, commentId, threadId, n, text })
  const taken = new Set(readAllMeta(root).map((item) => item.branch))
  let branch = first
  for (let count = 2; taken.has(branch) || (await refTip(config, branch)); count += 1) {
    if (count > 50) throw new BranchError('branch_taken', `Too many branches named ${first} already exist.`)
    branch = `${first}-${count}`
  }
  const runId = newRunId(now)
  const tree = await createWorktree({ projectDir: config.dir, root, runId, branch, base: base || repo.head })
  const meta = {
    version: 1,
    id: runId,
    branch,
    base: tree.base,
    commit: null,
    sub: path.relative(tree.dir, tree.projectDir).split(path.sep).filter(Boolean).join('/') || null,
    boardId,
    threadId,
    commentId,
    messageId: null,
    kind: kind === 'comment' ? 'comment' : 'chat',
    files: 0,
    createdAt: now.toISOString(),
    committedAt: null,
  }
  writeMeta(root, meta)
  return { tree, meta, root }
}

// Commits what the agent changed in the worktree on its new branch, as the
// repository's author. Symlinks that leave the checkout are refused (the
// branch is taken back). -> commitWorktree's result
export async function commitAgentBranch(config, { tree, meta, root, message }) {
  const author = await repoAuthor(tree.repo)
  // The project's own store, should the checkout hold one (it is ignored as a rule).
  const sub = path.relative(tree.dir, tree.projectDir).split(path.sep).filter(Boolean)
  const exclude = [[...sub, '.shapewall'].join('/')]
  const result = await commitWorktree({ tree, message, exclude, author: { name: author.name, email: author.email } })
  if (result.committed && result.links?.length) {
    await git(['--git-dir', tree.gitDir, 'update-ref', '-d', `refs/heads/${meta.branch}`, result.commit], { cwd: tree.repo }).catch(
      () => {},
    )
    throw new BranchError(
      'symlink_out',
      `The agent made symlinks that point outside the project (${result.links.slice(0, 5).join(', ')}), so nothing was committed.`,
    )
  }
  if (result.committed) {
    Object.assign(meta, { commit: result.commit, files: result.files.length, committedAt: new Date().toISOString() })
    writeMeta(root, meta)
  }
  return result
}

// The worktree, its record and (when it still points at the agent's commit)
// its branch. -> { branchDeleted, branchMoved }
export async function discardAgentBranch(config, meta) {
  const root = agentWorktreeRoot(config)
  let branchDeleted = false
  let branchMoved = false
  if (meta.commit) {
    const tip = await refTip(config, meta.branch)
    if (tip === meta.commit) {
      await git(['update-ref', '-m', 'shapewall: discard agent branch', '-d', `refs/heads/${meta.branch}`, meta.commit], {
        cwd: config.dir,
        timeoutMs: 20000,
      })
      branchDeleted = true
    } else if (tip) branchMoved = true
  }
  await removeWorktree({ tree: { dir: path.join(root, meta.id), root, runId: meta.id } })
  fs.rmSync(metaFile(root, meta.id), { force: true })
  return { branchDeleted, branchMoved }
}

// Git on the person's checkout, with its git dir and work tree named, and
// every configured filter, merge and diff driver overridden with an empty
// command (inertDriverFlags): Apply, Undo and the checks before them run no
// program from the repository's or the person's config.
async function onCheckout(repo) {
  const inert = await inertDriverFlags({ gitDir: repo.gitDir, cwd: repo.top })
  return (args, options = {}) =>
    git(['--git-dir', repo.gitDir, '--work-tree', repo.top, ...CHECKOUT_FLAGS, ...inert, ...args], {
      cwd: repo.top,
      timeoutMs: 120000,
      ...options,
    })
}

// What git sees in the person's checkout: HEAD plus each changed or
// untracked (not ignored) file with its size and time. Compared before and
// after a branch-mode turn to warn when something wrote to the checkout.
// null when it cannot tell (then no warning).
export async function checkoutSignature(config) {
  try {
    const repo = await checkRepo(config)
    const status = await (
      await onCheckout(repo)
    )(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']).catch(() => null)
    if (status === null) return null
    const parts = status.split('\0')
    const files = []
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]
      if (entry.length < 4) continue
      files.push(entry.slice(3))
      if (entry[0] === 'R' || entry[0] === 'C') i++
    }
    const stamps = files.sort().map((file) => {
      try {
        const stat = fs.lstatSync(path.join(repo.top, file), { bigint: true })
        return `${file}:${stat.size}:${stat.mtimeNs}`
      } catch {
        return `${file}:gone`
      }
    })
    return [repo.head || '', ...stamps].join('\n')
  } catch {
    return null
  }
}

async function assertClean(run) {
  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=all'])
  if (status.replace(/\0/g, '').trim())
    throw new BranchError(
      'checkout_dirty',
      'Your checkout has uncommitted changes to tracked files. Commit or stash them, then apply. Nothing was changed.',
    )
}

const listOf = (files) => `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`

// The paths that going from the tree `from` (HEAD) to the tree `to` writes,
// after checking that none of them would land on a file Git does not track:
// an untracked or ignored file (.env) at a path the change adds, or an
// untracked file or symlink where it needs a folder. Git itself overwrites
// ignored files without asking. -> { written, blocked }
export async function overwriteCheck(run, repo, from, to) {
  const tracked = new Set((await run(['ls-tree', '-r', '-z', '--name-only', '--full-tree', from])).split('\0').filter(Boolean))
  const parts = (await run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to])).split('\0')
  const written = []
  const blocked = new Set()
  const exists = (rel) => {
    try {
      return fs.lstatSync(path.join(repo.top, rel))
    } catch {
      return null
    }
  }
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const [status, rel] = [parts[index], parts[index + 1]]
    if (!status || !rel || status === 'D') continue
    written.push(rel)
    if (!tracked.has(rel) && exists(rel)) blocked.add(rel)
    const dirs = rel.split('/').slice(0, -1)
    for (let depth = 1; depth <= dirs.length; depth += 1) {
      const dir = dirs.slice(0, depth).join('/')
      if (tracked.has(dir)) break
      const stat = exists(dir)
      if (!stat) break
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        blocked.add(dir)
        break
      }
    }
  }
  return { written, blocked: [...blocked].sort() }
}

// The written paths a Git filter (such as Git LFS) handles, by the
// attributes of `source` and $GIT_DIR/info/attributes. Shapewall runs no
// filter, so it does not bring such files in. -> [{ path, filter }]
async function filteredPaths(run, source, files) {
  if (!files.length) return []
  const input = `${files.join('\0')}\0`
  let out = await run(['check-attr', '-z', '--stdin', `--source=${source}`, 'filter'], { input, status: true })
  if (out.code !== 0) out = await run(['check-attr', '-z', '--stdin', 'filter'], { input, status: true })
  if (out.code !== 0) throw new BranchError('apply_failed', `Git could not read the attributes: ${out.stderr.trim().slice(0, 200)}`)
  const parts = out.stdout.split('\0')
  const found = []
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const value = parts[index + 2]
    if (value && value !== 'unspecified' && value !== 'unset') found.push({ path: parts[index], filter: value })
  }
  return found
}

async function assertWritable(run, repo, from, to, { code, what, branch }) {
  const { written, blocked } = await overwriteCheck(run, repo, from, to)
  if (blocked.length)
    throw new BranchError(
      code,
      `${what} would overwrite files in your checkout that Git does not track: ${listOf(blocked)}. Nothing was changed. Move them out of the way, or ${branch ? `merge ${branch}` : 'do it'} yourself with Git.`,
    )
  const filtered = await filteredPaths(run, from, written)
  if (filtered.length)
    throw new BranchError(
      code,
      `${what} touches files that a Git filter handles (${listOf(filtered.map((item) => item.path))}, filter ${[...new Set(filtered.map((item) => item.filter))].join(', ')}). Shapewall runs no Git filters, such as Git LFS, so nothing was changed. ${branch ? `Merge ${branch}` : 'Do it'} yourself with Git.`,
    )
}

// Who makes a merge or revert commit: the repository's identity, or
// Shapewall's when the repository has none (git would stop and ask).
async function identityEnv(repo) {
  const author = await repoAuthor(repo.top)
  if (author.configured) return {}
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  }
}

// Brings the agent's branch into the current branch of the person's
// checkout. Nothing changes unless every check passes; a conflict changes
// nothing. -> { mode: 'fast-forward' | 'merge', before, after, branch }
export async function applyAgentBranch(config, meta, { message = null } = {}) {
  if (!meta?.commit) throw new BranchError('nothing_to_apply', 'The agent made no commit on this branch.')
  const repo = await checkRepo(config)
  if (!repo.branch)
    throw new BranchError(
      'detached_head',
      'Your checkout is not on a branch (detached HEAD). Check out a branch, then apply. Nothing was changed.',
    )
  const tip = await refTip(config, meta.branch)
  if (tip !== meta.commit)
    throw new BranchError(
      'branch_moved',
      `The branch ${meta.branch} ${tip ? 'has moved since the agent committed' : 'is gone'}, so Shapewall does not apply it. Merge it yourself with Git.`,
    )
  const run = await onCheckout(repo)
  await assertClean(run)
  const before = repo.head
  const ancestor = await run(['merge-base', '--is-ancestor', before, meta.commit], { status: true })
  let mode
  if (before === meta.commit) throw new BranchError('already_applied', 'Your checkout already has this change.')
  if (ancestor.code === 0) {
    await assertWritable(run, repo, before, meta.commit, { code: 'apply_overwrite', what: 'Apply', branch: meta.branch })
    await run(['merge', '--ff-only', '--no-autostash', '--no-stat', '--no-verify', meta.commit])
    mode = 'fast-forward'
  } else {
    // Checked without touching the checkout: on a conflict, nothing changes.
    const tried = await run(['merge-tree', '--write-tree', '--name-only', '--no-messages', before, meta.commit], { status: true })
    if (tried.code === 1) {
      const files = tried.stdout.split('\n').slice(1).filter(Boolean).slice(0, 8)
      throw new BranchError(
        'apply_conflict',
        `The agent's branch conflicts with your checkout${files.length ? ` in ${files.join(', ')}` : ''}. Nothing was changed. Merge ${meta.branch} yourself with Git, or discard it.`,
      )
    }
    if (tried.code !== 0) throw new BranchError('apply_failed', `Git could not check the merge: ${tried.stderr.trim().slice(0, 200)}`)
    const merged = tried.stdout.split('\n')[0].trim()
    if (!SHA_RE.test(merged)) throw new BranchError('apply_failed', 'Git could not check the merge.')
    await assertWritable(run, repo, before, merged, { code: 'apply_overwrite', what: 'Apply', branch: meta.branch })
    const env = { ...process.env, ...(await identityEnv(repo)) }
    try {
      await run(
        [
          'merge',
          '--no-ff',
          '--no-edit',
          '--no-autostash',
          '--no-stat',
          '--no-verify',
          '-m',
          message || `Apply ${meta.branch}`,
          meta.commit,
        ],
        { env },
      )
    } catch (error) {
      await run(['merge', '--abort']).catch(() => {})
      throw new BranchError('apply_failed', `The merge did not go through, so it was taken back: ${error.message.slice(0, 200)}`)
    }
    mode = 'merge'
  }
  const after = (await run(['rev-parse', '--verify', 'HEAD'])).trim()
  await discardAgentBranch(config, meta).catch(() => {})
  return { mode, before, after, branch: repo.branch }
}

// Undo after Apply: new commits that revert what Apply brought in, only
// while the checkout is clean and its branch still ends at what Apply made.
export async function revertAppliedBranch(config, applied) {
  if (!applied || !SHA_RE.test(String(applied.before || '')) || !SHA_RE.test(String(applied.after || '')))
    throw new BranchError('undo_unavailable', 'This change cannot be undone here.')
  const repo = await checkRepo(config)
  if (repo.branch !== applied.branch || repo.head !== applied.after)
    throw new BranchError(
      'undo_conflict',
      `Your branch moved on since the agent's change was applied, so it was left as it is. Revert ${applied.after.slice(0, 7)} with Git.`,
    )
  const run = await onCheckout(repo)
  await assertClean(run).catch(() => {
    throw new BranchError('undo_conflict', 'Your checkout has uncommitted changes, so nothing was undone. Commit or stash them first.')
  })
  // Undo brings back the tree from before Apply: the same check for what it writes.
  await assertWritable(run, repo, applied.after, applied.before, { code: 'undo_conflict', what: 'Undo', branch: null })
  const env = { ...process.env, ...(await identityEnv(repo)) }
  try {
    if (applied.mode === 'merge') await run(['revert', '--no-edit', '-m', '1', applied.after], { env })
    else await run(['revert', '--no-edit', `${applied.before}..${applied.after}`], { env })
  } catch (error) {
    await run(['revert', '--abort']).catch(() => {})
    throw new BranchError('undo_conflict', `The revert did not go through, so nothing was undone: ${error.message.slice(0, 200)}`)
  }
  return { head: (await run(['rev-parse', '--verify', 'HEAD'])).trim() }
}

// The agent's branches waiting here: [{ ...meta, state, worktree }] with
// state ready (the branch is the agent's commit), moved, gone, or pending
// (a turn still working, nothing committed yet).
export async function listAgentBranches(config) {
  let root
  try {
    root = agentWorktreeRoot(config)
  } catch {
    return []
  }
  const out = []
  for (const meta of readAllMeta(root)) {
    const tip = meta.commit ? await refTip(config, meta.branch) : null
    const state = !meta.commit ? 'pending' : tip === meta.commit ? 'ready' : tip ? 'moved' : 'gone'
    out.push({ ...meta, state, worktree: fs.existsSync(path.join(root, meta.id)) })
  }
  return out
}

// What dead turns left: worktrees whose server process is gone, with the
// starter's rules (sweepWorkRoot). A worktree whose commit is not in HEAD yet
// is never removed. Records whose worktree and branch are both gone go too.
export async function sweepAgentBranches(config, { isAlive = processAlive, now = Date.now() } = {}) {
  let root
  try {
    root = agentWorktreeRoot(config)
  } catch {
    return []
  }
  if (!fs.existsSync(root)) return []
  const metas = readAllMeta(root)
  const keep = new Set()
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: config.dir, timeoutMs: 20000 }).catch(() => '')).trim()
  for (const meta of metas) {
    if (!meta.commit) continue
    const tip = await refTip(config, meta.branch)
    if (tip !== meta.commit) continue
    const applied =
      SHA_RE.test(head) &&
      (
        await git(['merge-base', '--is-ancestor', meta.commit, head], { cwd: config.dir, status: true, timeoutMs: 20000 }).catch(() => ({
          code: 1,
        }))
      ).code === 0
    if (!applied) keep.add(meta.id)
  }
  const removed = sweepWorkRoot(root, { isAlive, now, keep: (id) => keep.has(id) })
  for (const id of removed) fs.rmSync(metaFile(root, id), { force: true })
  // A record without its folder and without an unapplied commit is nothing to keep.
  for (const meta of metas) {
    if (keep.has(meta.id) || removed.includes(meta.id) || fs.existsSync(path.join(root, meta.id))) continue
    fs.rmSync(metaFile(root, meta.id), { force: true })
    removed.push(meta.id)
  }
  return removed
}

// The environment an agent working in a worktree under `worktreesRoot` gets
// on top of its own: git run there finds no repository above the worktree
// (in particular not the project's own, which holds .shapewall).
export function worktreeAgentEnv(worktreesRoot) {
  return { GIT_CEILING_DIRECTORIES: worktreesRoot }
}
