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
//   during   every edit is checked and asked for one at a time (acp.js
//            remoteRequest); what was allowed is written down here, file by
//            file, as the hash of what the file should hold afterwards.
//   after    Shapewall commits the folder on a new branch itself (no hook,
//            filter or attribute runs). The commit is kept only when every
//            file it changes was allowed and holds exactly what was shown:
//            anything else and the branch is taken back. Then the branch is
//            pushed, when the machine has a remote for it and the change
//            touches nothing that runs in CI, and a pull request is opened
//            when GitHub is set up on this machine.
//
// The checkout itself is only ever read (git status, git rev-parse).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  BranchError,
  branchModeSettings,
  checkRepo,
  checkoutSignature,
  commitAgentBranch,
  createAgentBranch,
  worktreeAgentEnv,
} from '../agent/branch-mode.js'
import { guardedFiles } from '../agent/starter/push-guard.js'
import { git, pushBranch, removeWorktree } from '../agent/starter/worktree.js'
import { diffForCard } from '../agent/text-diff.js'
import { commentText } from '../comment-fields.js'
import { githubSettings, openPullRequest } from '../github.js'

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/
export const FIX_FILES_MAX = 50

// A fix this machine does not start, with the reason for the board.
export class FixRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex')

// Where fixes are made: outside every project, one folder per project.
export function fixRoot(projectDir, env = process.env) {
  const state = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state')
  return path.join(state, 'shapewall', 'agent-fixes', sha256(fs.realpathSync(projectDir)).slice(0, 16))
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
// -> { work, workdir, base, checkoutBefore }
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
  let work
  try {
    work = await createAgentBranch(config, {
      prefix: branchModeSettings(config, env).prefix,
      kind: 'comment',
      boardId: job.turn.board,
      threadId: job.turn.thread,
      commentId: job.turn.comment,
      text: typeof job.context.comment?.body === 'string' ? job.context.comment.body : commentText(job.context.comment || {}) || '',
      base: base.commit,
      root,
    })
  } catch (error) {
    if (error instanceof BranchError) throw new FixRefusal(error.code, `On the agent's machine: ${error.message}`)
    throw error
  }
  return {
    work,
    base,
    checkoutBefore: await checkoutSignature(config),
    workdir: {
      root: work.tree.projectDir,
      env: worktreeAgentEnv(work.root),
      protect: [path.join(work.tree.projectDir, '.shapewall')],
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

const firstLine = (text) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 72) || ''

// The end of a fix turn. Commits what the agent changed when it is exactly
// what was allowed, pushes it and opens a pull request where this machine
// can, and removes the folder. `approved`: Map of project-relative path ->
// sha256 of the content that was shown and allowed.
// -> { status: 'branch-ready' | 'needs-human', summary, notes: [text], line }
export async function finishFix({
  config,
  policy,
  prepared,
  job,
  approved,
  env = process.env,
  fetchImpl = undefined,
  log = () => {},
  push = pushBranch,
}) {
  const { work, base, checkoutBefore } = prepared
  const { tree, meta } = work
  const notes = []
  const out = { status: 'needs-human', summary: null, notes, line: null }
  const sub = path.relative(tree.dir, tree.projectDir).split(path.sep).filter(Boolean).join('/')
  const inProject = (rel) => (!sub ? rel : rel.startsWith(`${sub}/`) ? rel.slice(sub.length + 1) : null)
  const body = typeof job.context.comment?.body === 'string' ? job.context.comment.body : ''
  const message = `Fix comment #${job.turn.comment}: ${firstLine(body) || 'agent change'}\n\nshapewall:${job.turn.board}/${job.turn.comment}\nMade by a connected agent from a hosted board; review before merging.\n`
  try {
    let commit = null
    try {
      commit = await commitAgentBranch(config, { ...work, message })
    } catch (error) {
      log(`fix: commit: ${error.message}`)
      notes.push(error instanceof BranchError ? error.message : "The agent's work could not be committed on its branch.")
      return out
    }
    if (!commit?.committed) return out
    // Only what was shown and allowed: every changed file, with exactly that content.
    const takeBack = () =>
      git(['--git-dir', tree.gitDir, 'update-ref', '-d', `refs/heads/${meta.branch}`, commit.commit], { cwd: tree.repo }).catch(() => {})
    const beyond = []
    for (const rel of commit.files) {
      const shown = inProject(rel)
      const expected = shown === null ? null : approved.get(shown)
      let ok = Boolean(expected) && !commit.deleted.includes(rel) && !commit.links.includes(rel)
      if (ok) {
        try {
          const stat = fs.lstatSync(path.join(tree.dir, rel))
          ok = stat.isFile() && sha256(fs.readFileSync(path.join(tree.dir, rel), 'utf8')) === expected
        } catch {
          ok = false
        }
      }
      if (!ok) beyond.push(shown ?? rel)
    }
    if (beyond.length) {
      await takeBack()
      notes.push(
        `Nothing was committed: the agent's folder held changes beyond the edits that were allowed (${beyond.slice(0, 5).join(', ')}${beyond.length > 5 ? ` and ${beyond.length - 5} more` : ''}).`,
      )
      return out
    }
    // The files, with line counts, read from the commit. No diff leaves here: the cards showed them.
    const blob = async (rev, rel) =>
      git(['--git-dir', tree.gitDir, 'cat-file', 'blob', `${rev}:${rel}`], { cwd: tree.repo }).catch(() => null)
    const files = []
    for (const rel of commit.files.slice(0, FIX_FILES_MAX)) {
      const status = commit.added.includes(rel) ? 'added' : 'modified'
      const before = status === 'added' ? null : await blob(tree.base, rel)
      const after = await blob(commit.commit, rel)
      const diff = after === null ? null : diffForCard(rel, before, after)
      files.push({ path: inProject(rel) ?? rel, status, added: diff?.added ?? null, removed: diff?.removed ?? null })
    }
    const summary = {
      kind: 'remote-branch',
      files,
      added: files.reduce((sum, item) => sum + (item.added || 0), 0),
      removed: files.reduce((sum, item) => sum + (item.removed || 0), 0),
      more: Math.max(0, commit.files.length - files.length),
      branch: { name: meta.branch, commit: commit.commit, base: tree.base, baseName: base.name || null, pushed: false, remote: null },
      pr: null,
    }
    out.summary = summary
    out.status = 'branch-ready'
    out.line = `Fix ready on branch ${meta.branch}.`
    // ---- Push, when this machine has somewhere to push ----
    const remote = policy.remote
    const hasRemote = remote ? (await git(['remote', 'get-url', remote], { cwd: config.dir }).catch(() => '')).trim() : ''
    if (hasRemote) {
      // A pushed branch runs CI, with the repository's secrets, before anyone reviews it.
      const guarded = guardedFiles(commit.files)
      if (guarded.length) {
        notes.push(
          `Not pushed: the fix changes ${guarded.slice(0, 3).join(', ')}${guarded.length > 3 ? ', ...' : ''}, which would run in CI on push. Review the branch on the agent's machine.`,
        )
      } else {
        try {
          await push({ tree, remote })
          summary.branch.pushed = true
          summary.branch.remote = remote
        } catch (error) {
          log(`fix: push: ${error.message}`)
          notes.push(`The branch could not be pushed to "${remote}" from the agent's machine. It is there, on that machine.`)
        }
      }
    }
    // ---- A pull request, when GitHub is set up here ----
    if (summary.branch.pushed && githubSettings(config, env).ready) {
      try {
        let into = base.name
        if (!into) {
          const head = await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { cwd: config.dir }).catch(() => '')
          into = head.trim().split('/').slice(1).join('/') || 'main'
        }
        const first = firstLine(body)
        const pull = await openPullRequest(config, {
          head: meta.branch,
          base: into,
          title: `Shapewall #${job.turn.comment}: ${first.length > 70 ? `${first.slice(0, 67)}...` : first || 'fix'}`,
          body: [
            `Made by a connected Shapewall agent for comment shapewall:${job.turn.board}/${job.turn.comment}.`,
            '',
            'The request came from a board comment (untrusted text), and each edit was allowed from the board. Review the whole diff before merging.',
          ].join('\n'),
          env,
          ...(fetchImpl ? { fetchImpl } : {}),
        })
        summary.pr = { number: pull.number, url: String(pull.url).slice(0, 300) }
        out.line = `Fix ready: ${summary.pr.url} (branch ${meta.branch}).`
      } catch (error) {
        log(`fix: pull request: ${error.message}`)
        notes.push("The branch was pushed, but the pull request could not be opened from the agent's machine.")
      }
    }
    return out
  } finally {
    if (checkoutBefore && (await checkoutSignature(config)) !== checkoutBefore)
      notes.push("Files in the agent's own checkout changed during this fix. Check git status on its machine.")
    await dropFixFolder(prepared)
  }
}
