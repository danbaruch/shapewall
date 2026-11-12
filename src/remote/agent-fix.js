// A connected agent's fix: "Fix with <agent>" on a hosted comment, on a
// machine that takes edits from the board (`shapewall agent connect
// --approvals owner|admins`). The agent never works in the person's checkout:
//
//   before   a fresh copy of the base commit, with no .git in it, in a
//            folder outside the project (branch mode's worktree:
//            src/agent/branch-mode.js, src/agent/starter/worktree.js). The
//            base is the branch the machine names (`--base`), else the commit
//            the checkout is on, and then only while the checkout has no
//            uncommitted changes (a fix would silently leave them out).
//            Copies that dead processes left are swept first.
//   during   every edit is checked and asked for one at a time (acp.js
//            remoteRequest); what was allowed is written down here, file by
//            file, as the hash of the bytes the file should hold afterwards,
//            and whether a person allowed it or it went without asking.
//   after    Shapewall commits the folder on a new branch itself (no hook,
//            filter or attribute runs). The commit is kept only when it is
//            exactly what was allowed: every file it changes was allowed and
//            holds those bytes, with the mode it had; every allowed file is
//            in it; nothing was removed. Anything else and the branch is
//            taken back.
//   push     the branch goes to the machine's remote, and a pull request is
//            opened when GitHub is set up here, only when (a) nothing in it
//            runs on install, build, test or CI (src/agent/exec-paths.js) and
//            (b) a person has seen every edit. A fix with an edit that went
//            without asking is HELD: committed here, pushed nowhere, until
//            someone who may answer cards allows one "Push this fix" card
//            that shows its whole diff (agent-link.js).
//
// Stop (the turn's signal) is honoured between every step: after it nothing
// is committed, pushed or opened. A push that had already finished stays,
// and the thread says the branch exists.
//
// The checkout itself is only ever read (git status, rev-parse, check-ignore).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inside } from '../agent/acp/sandbox.js'
import {
  BranchError,
  branchModeSettings,
  checkRepo,
  checkoutSignature,
  commitAgentBranch,
  createAgentBranch,
  validBranchName,
  worktreeAgentEnv,
} from '../agent/branch-mode.js'
import { filesThatRun } from '../agent/exec-paths.js'
import { RUN_DIR_RE, git, processAlive, pushBranch, removeWorktree, sweepWorkRoot } from '../agent/starter/worktree.js'
import { diffForCard, diffForFiles } from '../agent/text-diff.js'
import { commentText } from '../comment-fields.js'
import { DEFAULT_API_URL, githubSettings, openPullRequest } from '../github.js'

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
export const FIX_FILES_MAX = 50
export const FIX_LIMITS = {
  // Fixes held back from a remote, waiting for "Push this fix": the newest stay.
  held: 20,
  heldMs: 14 * 24 * 60 * 60 * 1000,
}

// A fix this machine does not start, with the reason for the board.
export class FixRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const aborted = (signal) => Boolean(signal?.aborted)

// Text from a comment, on its way into a commit subject or a pull request
// title: one line, no NUL or control characters, and nothing GitHub would act
// on. "@name" pings nobody, "#12" links and closes nothing, a URL is not one.
export function inertLine(text, max = 72) {
  const first =
    String(text || '')
      .split('\0')
      .join('')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || ''
  return (
    first
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0001-\u001f\u007f]/g, ' ')
      .replace(/@(?=\S)/g, '@\u200b')
      .replace(/#(?=\S)/g, '#\u200b')
      .replace(/:\/\//g, ':/\u200b/')
      .slice(0, max)
  )
}

// Where fixes are made: outside every project, one folder per project.
// Throws FixRefusal when that place would be inside the project itself
// (the project is the home folder, say): a copy of the project inside the
// project is a write to the checkout.
export function fixRoot(projectDir, env = process.env) {
  const home = env.HOME || os.homedir()
  // Only an absolute XDG_STATE_HOME counts (a relative one would be read against the project).
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state')
  const project = fs.realpathSync(projectDir)
  const root = path.join(state, 'shapewall', 'agent-fixes', sha256(project).slice(0, 16))
  // The nearest folder that exists, resolved: a link in the way does not hide where it lands.
  let existing = root
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing)
  const real = path.join(fs.realpathSync(existing), path.relative(existing, root))
  if (!path.isAbsolute(real) || inside(project, real))
    throw new FixRefusal(
      'bad_fix_root',
      "On the agent's machine, the folder fixes are made in would be inside the project itself. Set XDG_STATE_HOME there to a folder outside the project.",
    )
  return real
}

const heldFile = (root, id) => path.join(root, `held-${id}.json`)

// What dead processes left behind for this project: copies whose owner is
// gone (with their records, so their branch names are free again), records
// without a copy, and held fixes past their time or beyond the newest few.
// Run when `agent connect` starts and around every fix. -> ids removed
export function sweepFixes(projectDir, env = process.env, { isAlive = processAlive, now = Date.now() } = {}) {
  let root
  try {
    root = fixRoot(projectDir, env)
  } catch {
    return []
  }
  if (!fs.existsSync(root)) return []
  const removed = sweepWorkRoot(root, { isAlive, now })
  for (const id of removed) fs.rmSync(path.join(root, `${id}.json`), { force: true })
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return removed
  }
  for (const name of names) {
    // A record (or an index or owner file) whose copy is gone.
    const id = /^(\d{14}-[a-f0-9]{6})\.(json|owner|checkout\.index|commit\.index)$/.exec(name)?.[1]
    if (id && RUN_DIR_RE.test(id) && !fs.existsSync(path.join(root, id))) {
      let pid = null
      try {
        pid = Number(fs.readFileSync(path.join(root, `${id}.owner`), 'utf8').trim())
      } catch {
        /* no owner file */
      }
      if (pid === null || !isAlive(pid)) {
        fs.rmSync(path.join(root, name), { force: true })
        if (!removed.includes(id)) removed.push(id)
      }
    }
    if (/\.tmp$/.test(name)) fs.rmSync(path.join(root, name), { force: true })
  }
  const held = names
    .filter((name) => /^held-\d{14}-[a-f0-9]{6}\.json$/.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const [index, item] of held.entries())
    if (index >= FIX_LIMITS.held || now - item.at > FIX_LIMITS.heldMs) fs.rmSync(path.join(root, item.name), { force: true })
  return removed
}

const REPO_REFUSALS = {
  not_a_repo: "The agent's project folder is not a Git repository, so it cannot make a fix on a branch.",
  unborn_head: "The agent's repository has no commit yet, so there is nothing to branch from.",
}

// The commit a fix starts from: { commit, name } (`name`: the branch a pull
// request goes into, when known).
async function baseOf(config, policy, repo) {
  const run = (args, options = {}) => git(args, { cwd: config.dir, timeoutMs: 20000, ...options })
  if (policy.base) {
    for (const ref of [`refs/heads/${policy.base}`, ...(policy.remote ? [`refs/remotes/${policy.remote}/${policy.base}`] : [])]) {
      const commit = (await run(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => '')).trim()
      if (SHA_RE.test(commit)) return { commit, name: policy.base }
    }
    throw new FixRefusal('no_base', `The branch "${policy.base}" this agent starts fixes from does not exist on its machine.`)
  }
  // No branch named: the checkout's own commit, and only a clean checkout.
  const status = await run(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=all'])
  if (status.trim())
    throw new FixRefusal(
      'checkout_dirty',
      "The agent's checkout has uncommitted changes, which a fix would not include. On its machine: commit or stash them, or connect with --base BRANCH to always start from that branch.",
    )
  return { commit: repo.head, name: repo.branch }
}

// The worktree for one fix. Throws FixRefusal with words for the board.
// -> { work, workdir, base, checkoutBefore, ignored(rel) }
export async function prepareFix({ config, policy, job, env = process.env }) {
  let repo
  try {
    repo = await checkRepo(config)
  } catch (error) {
    if (error instanceof BranchError)
      throw new FixRefusal(error.code, REPO_REFUSALS[error.code] || `On the agent's machine: ${error.message}`)
    throw error
  }
  const base = await baseOf(config, policy, repo)
  const root = fixRoot(config.dir, env)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  sweepFixes(config.dir, env)
  const body = typeof job.context.comment?.body === 'string' ? job.context.comment.body : commentText(job.context.comment || {}) || ''
  let work
  try {
    work = await createAgentBranch(config, {
      prefix: branchModeSettings(config, env).prefix,
      kind: 'comment',
      boardId: job.turn.board,
      threadId: job.turn.thread,
      commentId: job.turn.comment,
      text: body.split('\0').join(''),
      base: base.commit,
      root,
    })
  } catch (error) {
    if (error instanceof BranchError) throw new FixRefusal(error.code, `On the agent's machine: ${error.message}`)
    throw error
  }
  const { tree } = work
  const sub = path.relative(tree.dir, tree.projectDir).split(path.sep).filter(Boolean).join('/')
  return {
    work,
    base,
    checkoutBefore: await checkoutSignature(config),
    // Whether Git's ignore rules leave this project-relative path out of a
    // commit: asked of the person's repository (read only), about the path
    // as such, tracked or not.
    ignored: async (rel) => {
      const file = sub ? `${sub}/${rel}` : rel
      const out = await git(['check-ignore', '-q', '--no-index', '--', file], { cwd: repo.top, status: true, timeoutMs: 20000 })
      return out.code === 0
    },
    workdir: {
      root: tree.projectDir,
      env: worktreeAgentEnv(work.root),
      protect: [path.join(tree.projectDir, '.shapewall')],
      sensitivePaths: [],
    },
  }
}

// Removes the fix's folder and record. The branch, when one was made, stays.
export async function dropFixFolder(prepared) {
  const { work } = prepared
  await removeWorktree({ tree: work.tree }).catch(() => {})
  fs.rmSync(path.join(work.root, `${work.meta.id}.json`), { force: true })
}

// The mode and type of one path at a revision, or null.
async function entryAt(tree, rev, rel) {
  const out = await git(['--git-dir', tree.gitDir, 'ls-tree', '-z', rev, '--', rel], { cwd: tree.repo }).catch(() => '')
  const line = out.split('\0').find(Boolean)
  if (!line) return null
  const [mode, type] = line.slice(0, line.indexOf('\t')).split(' ')
  return { mode, type }
}
const blobAt = (record, rev, rel) =>
  git(['--git-dir', record.gitDir, 'cat-file', 'blob', `${rev}:${rel}`], { cwd: record.repo }).catch(() => null)

// The files of a fix with their line counts, read from its commit.
async function filesOf(record) {
  const files = []
  for (const item of record.files.slice(0, FIX_FILES_MAX)) {
    const before = item.status === 'added' ? null : await blobAt(record, record.base, item.rel)
    const after = await blobAt(record, record.commit, item.rel)
    const diff = after === null ? null : diffForCard(item.path, before, after)
    files.push({ path: item.path, status: item.status, added: diff?.added ?? null, removed: diff?.removed ?? null })
  }
  return files
}
async function summaryOf(record) {
  const files = await filesOf(record)
  return {
    kind: 'remote-branch',
    files,
    added: files.reduce((sum, item) => sum + (item.added || 0), 0),
    removed: files.reduce((sum, item) => sum + (item.removed || 0), 0),
    more: Math.max(0, record.files.length - files.length),
    branch: {
      name: record.branch,
      commit: record.commit,
      base: record.base,
      baseName: record.baseName || null,
      pushed: false,
      remote: null,
      held: false,
    },
    pr: null,
  }
}

// The whole diff of a fix, every changed file, for the "Push this fix" card.
// null when it cannot be shown in full (then it cannot be approved from the board).
export async function heldDiff(record) {
  const files = []
  for (const item of record.files) {
    const before = item.status === 'added' ? null : await blobAt(record, record.base, item.rel)
    const after = await blobAt(record, record.commit, item.rel)
    if (after === null) return null
    files.push({ path: item.path, oldText: before, newText: after, outside: false })
  }
  const diff = files.length ? diffForFiles(files) : null
  return diff && !diff.truncated ? diff : null
}

// The end of a fix turn. Commits what the agent changed when it is exactly
// what was allowed. `approved`: Map of project-relative path -> { hash, auto }
// (sha256 of the bytes that were shown and allowed; `auto`: nobody looked).
// Then pushes (pushFix), unless an edit went without asking: such a fix is
// held (its record is kept beside the copies) and `out.held` is that record.
// -> { status: 'branch-ready' | 'needs-human' | 'stopped', summary, notes, line, held }
export async function finishFix({
  config,
  policy,
  prepared,
  job,
  approved,
  signal = null,
  env = process.env,
  fetchImpl = undefined,
  log = () => {},
  push = pushBranch,
}) {
  const { work, base, checkoutBefore } = prepared
  const { tree, meta } = work
  const notes = []
  const out = { status: 'needs-human', summary: null, notes, line: null, held: null }
  const sub = path.relative(tree.dir, tree.projectDir).split(path.sep).filter(Boolean).join('/')
  const inProject = (rel) => (!sub ? rel : rel.startsWith(`${sub}/`) ? rel.slice(sub.length + 1) : null)
  const body = typeof job.context.comment?.body === 'string' ? job.context.comment.body : ''
  const subject = inertLine(body)
  const message = `Fix for Shapewall comment ${job.turn.comment}: ${subject || 'agent change'}\n\nshapewall:${job.turn.board}/${job.turn.comment}\nMade by a connected agent from a hosted board; review before merging.\n`
  const stopped = () => {
    out.status = 'stopped'
    out.summary = null
    out.line = null
    return out
  }
  try {
    if (aborted(signal)) return stopped()
    let commit = null
    try {
      commit = await commitAgentBranch(config, { ...work, message })
    } catch (error) {
      log(`fix: commit: ${error.message}`)
      notes.push(error instanceof BranchError ? error.message : "The agent's work could not be committed on its branch.")
      return out
    }
    if (!commit?.committed) {
      if (approved.size) notes.push('Nothing was committed: the edits that were allowed left no change in the files Git keeps.')
      return out
    }
    const takeBack = () =>
      git(['--git-dir', tree.gitDir, 'update-ref', '-d', `refs/heads/${meta.branch}`, commit.commit], { cwd: tree.repo }).catch(() => {})
    // Exactly what was shown and allowed. Every changed file: allowed, those
    // very bytes, a plain file, the mode it had (a new file: not executable).
    const beyond = []
    for (const rel of commit.files) {
      const shown = inProject(rel)
      const expected = shown === null ? null : approved.get(shown)?.hash
      let ok = Boolean(expected) && !commit.deleted.includes(rel) && !commit.links.includes(rel)
      if (ok) {
        try {
          const file = path.join(tree.dir, rel)
          const stat = fs.lstatSync(file)
          const was = await entryAt(tree, tree.base, rel)
          const now = await entryAt(tree, commit.commit, rel)
          ok =
            stat.isFile() &&
            sha256(fs.readFileSync(file)) === expected &&
            now?.type === 'blob' &&
            (was ? was.type === 'blob' && was.mode === now.mode : now.mode === '100644')
        } catch {
          ok = false
        }
      }
      if (!ok) beyond.push(shown ?? rel)
    }
    // And every allowed file is in it: one that Git left out (ignored, kept
    // at its base version) would be an allowed edit that silently vanished.
    const changed = new Set(commit.files.map((rel) => inProject(rel)))
    const missing = []
    for (const [rel, entry] of approved) {
      if (changed.has(rel)) continue
      // An edit that left the file as the base has it is no change at all.
      const baseText = await blobAt({ gitDir: tree.gitDir, repo: tree.repo }, tree.base, sub ? `${sub}/${rel}` : rel)
      if (baseText === null || sha256(baseText) !== entry.hash) missing.push(rel)
    }
    if (beyond.length || missing.length) {
      await takeBack()
      const list = (items) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ` and ${items.length - 5} more` : ''}`
      notes.push(
        beyond.length
          ? `Nothing was committed: the agent's folder held changes beyond the edits that were allowed (${list(beyond)}).`
          : `Nothing was committed: it would not have been what was allowed. Git leaves ${list(missing)} out of a commit (ignored, or one of its own files).`,
      )
      return out
    }
    if (aborted(signal)) {
      await takeBack()
      return stopped()
    }
    const record = {
      id: meta.id,
      branch: meta.branch,
      commit: commit.commit,
      base: tree.base,
      baseName: base.name || null,
      gitDir: tree.gitDir,
      repo: tree.repo,
      board: job.turn.board,
      comment: job.turn.comment,
      subject,
      files: commit.files.map((rel) => ({
        rel,
        path: inProject(rel) ?? rel,
        status: commit.added.includes(rel) ? 'added' : 'modified',
      })),
      madeAt: new Date().toISOString(),
    }
    out.summary = await summaryOf(record)
    out.status = 'branch-ready'
    out.line = `Fix ready on branch ${meta.branch}.`
    // An edit nobody looked at: the fix stays here until someone has seen its whole diff.
    if ([...approved.values()].some((entry) => entry.auto)) {
      const file = heldFile(work.root, meta.id)
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
      out.summary.branch.held = true
      out.held = { ...record, file }
      out.line = `Fix ready on branch ${meta.branch}, on the agent's machine. It is not pushed until someone has looked at its whole diff on the board (Push this fix).`
      return out
    }
    const pushed = await pushFix({ config, policy, record, signal, env, fetchImpl, log, push })
    out.summary = pushed.summary
    notes.push(...pushed.notes)
    if (pushed.line) out.line = pushed.line
    return out
  } finally {
    if (checkoutBefore && (await checkoutSignature(config)) !== checkoutBefore)
      notes.push("Files in the agent's own checkout changed during this fix. Check git status on its machine.")
    await dropFixFolder(prepared)
    sweepFixes(config.dir, env)
  }
}

// A pull request link this machine passes on: on the host of the GitHub it
// is set up for, shaped like one. Anything else is no link.
export function pullLink(url, settings) {
  try {
    const parsed = new URL(String(url))
    const api = new URL(settings?.apiUrl || DEFAULT_API_URL)
    const host = api.hostname === 'api.github.com' ? 'github.com' : api.hostname
    if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.username || parsed.password) return null
    if (!/^\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(parsed.pathname) || parsed.search || parsed.hash) return null
    return parsed.href.slice(0, 300)
  } catch {
    return null
  }
}

// Pushes a committed fix and opens its pull request, where this machine can.
// `record`: what finishFix made (or a held fix, read back). Nothing that
// runs on install, build, test or CI is pushed from here.
// -> { summary, notes, line, pushed }
export async function pushFix({
  config,
  policy,
  record,
  signal = null,
  env = process.env,
  fetchImpl = undefined,
  log = () => {},
  push = pushBranch,
}) {
  const notes = []
  const summary = await summaryOf(record)
  const out = { summary, notes, line: null, pushed: false }
  const remote = policy.remote
  const hasRemote = remote ? (await git(['remote', 'get-url', remote], { cwd: config.dir }).catch(() => '')).trim() : ''
  if (!hasRemote || aborted(signal)) return out
  // A pushed branch runs CI, with the repository's secrets, before anyone reviews it.
  const guarded = filesThatRun(record.files.map((item) => item.rel))
  if (guarded.length) {
    notes.push(
      `Not pushed: the fix changes ${guarded.slice(0, 3).join(', ')}${guarded.length > 3 ? ', ...' : ''}, which runs on install, build, test or CI. Review the branch on the agent's machine.`,
    )
    return out
  }
  try {
    await push({ tree: { branch: record.branch, gitDir: record.gitDir, repo: record.repo }, remote })
    summary.branch.pushed = true
    summary.branch.remote = remote
    out.pushed = true
    out.line = `Fix ready on branch ${record.branch}, pushed to ${remote}.`
  } catch (error) {
    log(`fix: push: ${error.message}`)
    notes.push(`The branch could not be pushed to "${remote}" from the agent's machine. It is there, on that machine.`)
    return out
  }
  // Stop after the push: the branch is out, and the thread says so. No pull request.
  if (aborted(signal)) {
    notes.push(`Stopped after the branch ${record.branch} was pushed to "${remote}": it exists there. No pull request was opened.`)
    return out
  }
  const settings = githubSettings(config, env)
  if (!settings.ready) return out
  try {
    let into = record.baseName
    if (!into) {
      const head = await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { cwd: config.dir }).catch(() => '')
      into = head.trim().split('/').slice(1).join('/') || 'main'
    }
    const pull = await openPullRequest(config, {
      head: record.branch,
      base: into,
      title: `Shapewall comment ${record.comment}: ${inertLine(record.subject, 70) || 'fix'}`,
      body: [
        `Made by a connected Shapewall agent for comment shapewall:${record.board}/${record.comment}.`,
        '',
        'The request came from a board comment (untrusted text). Review the whole diff before merging.',
      ].join('\n'),
      env,
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    const url = pullLink(pull.url, settings)
    if (url) {
      summary.pr = { number: pull.number, url }
      out.line = `Fix ready: ${url} (branch ${record.branch}).`
    } else notes.push(`A pull request (number ${pull.number}) was opened for the branch.`)
  } catch (error) {
    log(`fix: pull request: ${error.message}`)
    notes.push("The branch was pushed, but the pull request could not be opened from the agent's machine.")
  }
  return out
}

// The newest held fix of a comment on this machine, checked field by field
// (the folder is the person's, but everything that reaches git is checked
// again), and only while its branch still is the commit that was made and
// that commit changes exactly the files the record names.
export async function readHeld({ config, env = process.env, board, comment }) {
  let root
  let names = []
  try {
    root = fixRoot(config.dir, env)
    names = fs.readdirSync(root).filter((name) => /^held-\d{14}-[a-f0-9]{6}\.json$/.test(name))
  } catch {
    return null
  }
  const repo = await checkRepo(config).catch(() => null)
  if (!repo) return null
  for (const name of names.sort().reverse()) {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
    } catch {
      continue
    }
    if (raw?.board !== board || raw?.comment !== comment) continue
    if (!validBranchName(raw.branch) || !SHA_RE.test(String(raw.commit || '')) || !SHA_RE.test(String(raw.base || ''))) continue
    const listed = Array.isArray(raw.files) ? raw.files : []
    const files = listed.filter(
      (item) =>
        typeof item?.rel === 'string' &&
        typeof item?.path === 'string' &&
        !item.rel.split('/').some((part) => !part || part === '..' || part === '.') &&
        ['added', 'modified'].includes(item.status),
    )
    if (!files.length || files.length !== listed.length) continue
    const record = {
      id: name.slice(5, -5),
      branch: raw.branch,
      commit: raw.commit,
      base: raw.base,
      baseName: typeof raw.baseName === 'string' && /^[\w./-]{1,120}$/.test(raw.baseName) ? raw.baseName : null,
      // Never from the record: this machine's own repository.
      gitDir: repo.gitDir,
      repo: repo.top,
      board,
      comment,
      subject: inertLine(raw.subject),
      files: files.map((item) => ({ rel: item.rel, path: item.path, status: item.status })),
      file: path.join(root, name),
    }
    const tip = (await git(['rev-parse', '--verify', '-q', `refs/heads/${record.branch}`], { cwd: config.dir }).catch(() => '')).trim()
    if (tip !== record.commit) continue
    const inCommit = (
      await git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', record.base, record.commit], { cwd: config.dir }).catch(() => '')
    )
      .split('\0')
      .filter(Boolean)
      .sort()
    if (JSON.stringify(inCommit) !== JSON.stringify(record.files.map((item) => item.rel).sort())) continue
    return record
  }
  return null
}
export const dropHeld = (record) => fs.rmSync(record.file, { force: true })
export async function heldSummary(record) {
  const summary = await summaryOf(record)
  summary.branch.held = true
  return summary
}
