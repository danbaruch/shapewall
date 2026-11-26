// What a command a local board runs in place (in the person's own checkout)
// may never change: the files that run something on their own later, with
// no card and no one running them on purpose (Q7 B2). A git hook manager's
// folder (.husky), .envrc, editor tasks (.vscode), CI (.github), agent
// settings (.claude, .codex, ...), every other dotfile and dot folder,
// shapewall.config.json (it holds agent.localSession and the commands
// themselves), package.json and the other manifests, lockfiles and task
// files (push-guard.js), Makefile, Dockerfile, justfile, and the agent
// instruction files (CLAUDE.md, AGENTS.md, ...). An agent changes those
// through its edit tools, where a card asks first (acp/sandbox.js
// `sensitive`).
//
// How:
//   - before each run, every such file or folder that exists is denied to
//     the command's writes (the OS sandbox's denyWrite: a read-only mount on
//     Linux, a Seatbelt rule on macOS), so it cannot be changed, replaced or
//     removed;
//   - after the run (and every few seconds while a dev server runs) any
//     such file that appeared is moved out of the project, into
//     .shapewall/agent/quarantine/, and any denied one whose content changed
//     anyway is put back (the changed copy goes to the quarantine too). The
//     command's output says what was moved.
//
// Not covered (docs/agent-hardening.md): node_modules and build output
// folders (.next, .nuxt, .svelte-kit, .turbo, .cache, ...), which commands
// write by design and which later runs load; and ordinary source files,
// which run when the person runs the app (the honest limit: the code being
// run is code the agent wrote).

import fs from 'node:fs'
import path from 'node:path'
import { isGuarded } from './starter/push-guard.js'
import { wroteItself } from './acp/sandbox.js'
import { SandboxRefusal } from './sandbox-exec.js'

export const GUARD_LIMITS = {
  // Entries denied to one run: past this the command is refused (a sandbox
  // plan that long would not start reliably).
  deny: 4000,
  walk: 50000,
  // Content kept to put a changed file back.
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
}

// Folders commands write by design: build output and caches. Not guarded.
const BUILD_DIRS = new Set([
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.angular',
  '.astro',
  '.docusaurus',
  '.expo',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.venv',
  '.gradle',
  '.eslintcache',
])
const SKIP = new Set(['.git', 'node_modules', '.shapewall', 'shapewall-export'])
const NAMES = new Set([
  'shapewall.config.json',
  'makefile',
  'gnumakefile',
  'dockerfile',
  'containerfile',
  'justfile',
  'taskfile.yml',
  'taskfile.yaml',
  'procfile',
  'claude.md',
  'claude.local.md',
  'agents.md',
  'gemini.md',
])

// True for a project-relative path (with "/") a command may not change in place.
export function commandProtected(rel) {
  const parts = String(rel || '')
    .split('/')
    .filter(Boolean)
  if (!parts.length) return false
  const lower = parts.map((part) => part.toLowerCase())
  if (lower.includes('node_modules') || BUILD_DIRS.has(lower[0])) return false
  if (parts.some((part) => part.startsWith('.'))) return true
  if (isGuarded(parts.join('/'))) return true
  const name = lower.at(-1)
  return NAMES.has(name) || /^(dockerfile|containerfile)/.test(name) || /\.mk$/.test(name)
}

// The guarded entries of `root` that exist: a dot folder counts whole (one
// entry, not walked into); anything else file by file.
function guardedEntries(root, skipDirs) {
  const out = []
  const stack = ['']
  let seen = 0
  while (stack.length) {
    const rel = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > GUARD_LIMITS.walk)
        throw new SandboxRefusal('too_many_files', 'Not run: the project is too large for Shapewall to guard its files that run code.')
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name) || skipDirs.has(child)) continue
        if (!rel && BUILD_DIRS.has(entry.name.toLowerCase())) continue
        if (entry.name.startsWith('.')) out.push({ rel: child, dir: true })
        else stack.push(child)
      } else if (commandProtected(child)) out.push({ rel: child, dir: false })
    }
  }
  return out
}

// The files under an entry (itself when it is a file), no links followed.
function filesUnder(root, rel) {
  const out = []
  const stack = [rel]
  while (stack.length) {
    const current = stack.pop()
    let stat
    try {
      stat = fs.lstatSync(path.join(root, current))
    } catch {
      continue
    }
    if (!stat.isDirectory()) {
      out.push(current)
      continue
    }
    for (const name of fs.readdirSync(path.join(root, current))) stack.push(`${current}/${name}`)
  }
  return out
}

const signature = (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ino}:${stat.mode}`

// One guard for one checkout. `quarantine`: the folder moved files go to
// (inside Shapewall's own folder, which commands cannot read or write).
// `skip`: project-relative folders the guard leaves alone (Shapewall's own).
export function createRunGuard({ root, quarantine, skip = [], now = () => new Date() }) {
  const real = fs.realpathSync(root)
  const skipDirs = new Set(skip.filter(Boolean))
  const moveOut = (rel, stamp) => {
    const to = path.join(quarantine, stamp, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
    fs.renameSync(path.join(real, rel), to)
  }
  return {
    root: real,
    // The real paths no command of the next run may write.
    denyList() {
      const entries = guardedEntries(real, skipDirs)
      if (entries.length > GUARD_LIMITS.deny)
        throw new SandboxRefusal(
          'too_many_protected',
          `Not run: this project has over ${GUARD_LIMITS.deny} files that run code on their own (dotfiles, manifests, task files); Shapewall cannot keep them all unwritable for a command in place. Use Work on a branch.`,
        )
      return entries.map((entry) => path.join(real, entry.rel))
    },
    // What is there before a run: the guarded entries, and the files of
    // each with a signature (and, within a budget, their content).
    before() {
      const entries = guardedEntries(real, skipDirs)
      const files = new Map()
      let budget = GUARD_LIMITS.totalBytes
      for (const entry of entries)
        for (const rel of filesUnder(real, entry.rel)) {
          try {
            const stat = fs.lstatSync(path.join(real, rel))
            let content = null
            if (stat.isFile() && stat.size <= GUARD_LIMITS.fileBytes && stat.size <= budget) {
              content = fs.readFileSync(path.join(real, rel))
              budget -= stat.size
            }
            files.set(rel, { sig: signature(stat), content, mode: stat.mode & 0o777, link: stat.isSymbolicLink() })
          } catch {
            /* gone meanwhile */
          }
        }
      return { files }
    },
    // After a run: guarded files that appeared are moved out; a guarded
    // file that changed is put back from what before() kept. Files
    // Shapewall itself wrote for the agent (an approved card) stay.
    // -> { moved: [rel], restored: [rel], changed: [rel] (changed, not kept, so not put back) }
    after(state) {
      const moved = []
      const restored = []
      const changed = []
      const stamp = now().toISOString().replace(/[:.]/g, '-')
      for (const entry of guardedEntries(real, skipDirs))
        for (const rel of filesUnder(real, entry.rel)) {
          const file = path.join(real, rel)
          let stat
          try {
            stat = fs.lstatSync(file)
          } catch {
            continue
          }
          const was = state.files.get(rel)
          if (was && was.sig === signature(stat)) continue
          if (wroteItself(file)) {
            // Shapewall's own write: what is there now is the baseline.
            state.files.set(rel, { sig: signature(stat), content: null, mode: stat.mode & 0o777, link: false })
            continue
          }
          if (!was) {
            moveOut(rel, stamp)
            moved.push(rel)
            continue
          }
          if (!was.content || was.link) {
            changed.push(rel)
            continue
          }
          moveOut(rel, stamp)
          const temp = `${file}.shapewall-restore`
          fs.writeFileSync(temp, was.content, { mode: was.mode, flag: 'wx' })
          fs.renameSync(temp, file)
          state.files.set(rel, { ...was, sig: signature(fs.lstatSync(file)) })
          restored.push(rel)
        }
      // Folders left empty by a move: the empty dot folder a command made goes too.
      for (const rel of moved) {
        for (let dir = path.posix.dirname(rel); dir !== '.'; dir = path.posix.dirname(dir)) {
          try {
            fs.rmdirSync(path.join(real, dir))
          } catch {
            break
          }
        }
      }
      return { moved, restored, changed }
    },
  }
}

// The words a command's output gets for what after() did. '' for nothing.
export function guardNote(result, quarantine) {
  if (!result) return ''
  const lines = []
  const list = (items) => items.slice(0, 20).join(', ') + (items.length > 20 ? `, and ${items.length - 20} more` : '')
  if (result.moved.length)
    lines.push(
      `[Shapewall: commands may not create files that run code on their own here; moved out of the project to ${quarantine}: ${list(result.moved)}. Make such a change with your edit tools, where a person approves it.]`,
    )
  if (result.restored.length)
    lines.push(`[Shapewall: commands may not change these files here; put back as they were: ${list(result.restored)}.]`)
  if (result.changed.length) lines.push(`[Shapewall: these files changed while the command ran; look at them: ${list(result.changed)}.]`)
  return lines.join('\n')
}
