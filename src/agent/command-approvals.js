// Approvals of named commands (plan section 3.8, "Re-approval"), kept on the
// machine that runs them, never on a server.
//
// A record says: this command line, with these inputs, was allowed. It is
// keyed by (name, sha256 of the command line, sha256 of the inputs' content
// when it was allowed). When the agent changes any input (package.json, a
// lockfile, a test config, a script the command names, a relative program
// such as ./run-tests), or the config line changes, the key is another one,
// the record no longer matches, and the next run asks again.
//
// The inputs are read from the folder the command runs in (the fix copy:
// that is what the agent can change); the command line itself always comes
// from the person's checkout (its shapewall.config.json), never from the
// copy the agent writes in.
//
// Where: connected agents under $XDG_STATE_HOME/shapewall/approvals/<as>/,
// a local board under .shapewall/agent/approvals/ (Q4 wires that path). One
// small JSON file per record, 0600, in a 0700 folder; records older than
// APPROVAL_LIMITS.keepMs are swept.
//
// The starter agent keeps its own per-command cards (starter/approvals.js)
// inside its container; the rule for what counts as an input is the same
// (starter/tools.js testInput).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { testInput } from './starter/tools.js'

export const APPROVAL_LIMITS = {
  keepMs: 7 * 24 * 60 * 60 * 1000,
  inputFiles: 400,
  // Every byte of every input is read: past this the inputs count as
  // UNBOUNDED (the command asks every time).
  inputBytes: 256 * 1024 * 1024,
  walkFiles: 20000,
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const SKIP_DIRS = new Set(['.git', 'node_modules', '.shapewall', 'shapewall-export'])
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

// Where a connected agent's records live.
export function approvalsDir(slug, env = process.env) {
  const home = env.HOME || os.homedir()
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state')
  return path.join(state, 'shapewall', 'approvals', SLUG_RE.test(String(slug)) ? slug : 'default')
}

// A project-relative glob ("test/**", "src/*.js") as a RegExp.
function globRe(glob) {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        out += '(?:.*/)?'
        index += 2
      } else {
        out += '.*'
        index += 1
      }
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// The project-relative files of a folder (no .git, node_modules, Shapewall's
// store; no symbolic links followed).
function walk(root, limit = APPROVAL_LIMITS.walkFiles) {
  const out = []
  const stack = ['']
  while (stack.length && out.length < limit) {
    const rel = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(child)
      } else if (entry.isFile() || entry.isSymbolicLink()) out.push(child)
      if (out.length >= limit) break
    }
  }
  return out.sort()
}

// The argv parts that name a file in the project: a relative program
// (./x, bin/x) and the scripts the command names.
export function namedFiles(argv) {
  const out = []
  for (const [index, part] of argv.entries()) {
    if (typeof part !== 'string' || !part || path.isAbsolute(part) || part.startsWith('-')) continue
    const named = index === 0 ? /[/\\]/.test(part) : /[/\\]|\.(c|m)?[jt]s$|\.(py|sh|rb|pl)$/.test(part)
    if (!named) continue
    const rel = path.posix.normalize(part.replace(/\\/g, '/')).replace(/^\.\//, '')
    if (!rel.startsWith('..')) out.push(rel)
  }
  return out
}

// The inputs of a command in `root`: the manifests, lockfiles and configs
// (testInput), the files its `inputs` name (globs), and the files argv
// names, the relative program first of all. -> { files (sorted), complete }:
// `complete` is false when there were more than Shapewall checks (then no
// answer is ever remembered for it: inputsDigest says UNBOUNDED).
export function inputFiles(root, command) {
  const argv = Array.isArray(command.argv) ? command.argv : []
  const globs = Array.isArray(command.inputs) ? command.inputs.map(globRe) : null
  const files = new Set(namedFiles(argv))
  const listed = walk(root)
  let complete = listed.length < APPROVAL_LIMITS.walkFiles
  for (const rel of listed) {
    // The manifests, lockfiles and .npmrc always count; `inputs` adds to them.
    if (testInput(rel, argv) || globs?.some((re) => re.test(rel))) files.add(rel)
    if (files.size > APPROVAL_LIMITS.inputFiles) {
      complete = false
      break
    }
  }
  return { files: [...files].sort(), complete }
}

// The digest of a command's inputs whose content Shapewall could not all
// read (too many files, or too many bytes): it matches no record and no
// base, so such a command asks every time (Q7 B5).
export const UNBOUNDED = 'unbounded'

// sha256 over each input's path, its kind and its bytes, all of them (read
// in chunks: never a size and a time instead of the content, Q7 B5). A
// symbolic link counts as its target text (where it points), never followed.
// -> hex, or UNBOUNDED.
export function inputsDigest(root, command) {
  const { files, complete } = inputFiles(root, command)
  if (!complete) return UNBOUNDED
  const hash = createHash('sha256').update('shapewall-inputs-2\0')
  let bytes = 0
  const chunk = Buffer.alloc(256 * 1024)
  for (const rel of files) {
    const file = path.join(root, rel)
    hash.update(`${rel}\0`)
    let stat
    try {
      stat = fs.lstatSync(file)
    } catch {
      hash.update('missing\0')
      continue
    }
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${fs.readlinkSync(file)}\0`)
      continue
    }
    if (!stat.isFile()) {
      hash.update(`other\0${stat.isDirectory() ? 'dir' : 'special'}\0`)
      continue
    }
    hash.update(`file\0${stat.mode & 0o111 ? 'x' : '-'}\0`)
    let fd
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    } catch {
      hash.update('unreadable\0')
      continue
    }
    try {
      for (;;) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, null)
        if (!read) break
        bytes += read
        if (bytes > APPROVAL_LIMITS.inputBytes) return UNBOUNDED
        hash.update(chunk.subarray(0, read))
      }
    } finally {
      fs.closeSync(fd)
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

// The id git gives a blob of `content` (sha1 or sha256 repositories).
const blobId = (content, format) =>
  createHash(format === 'sha256' ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex')

// Whether every input of `command` in `root` (a checkout with its own Git
// repository) is exactly as committed in HEAD: same content, same kind and
// executable bit, nothing new. A local board in place keeps the agent's
// edits of earlier turns in the checkout, so only the committed state may
// stand in for "the person's own" there (Q7 B7). No Git, an unreadable
// HEAD, or any doubt: false. `git`: starter/worktree.js git (tests pass one).
export async function inputsCommitted(root, command, { git }) {
  const { files, complete } = inputFiles(root, command)
  if (!complete) return false
  if (!files.length) return true
  let format = 'sha1'
  let listing
  try {
    format = (await git(['rev-parse', '--show-object-format'], { cwd: root, timeoutMs: 20000 })).trim() || 'sha1'
    // Paths and names relative to `root`, wherever it is in its repository.
    listing = await git(['ls-tree', '-r', '-z', 'HEAD', '--', ...files], { cwd: root, timeoutMs: 20000 })
  } catch {
    return false
  }
  const committed = new Map()
  for (const line of listing.split('\0')) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line)
    if (match) committed.set(match[4], { mode: match[1], type: match[2], id: match[3] })
  }
  for (const rel of files) {
    const entry = committed.get(rel)
    const file = path.join(root, rel)
    let stat
    try {
      stat = fs.lstatSync(file)
    } catch {
      // Missing now: as committed only if HEAD has no such file either.
      if (entry) return false
      continue
    }
    if (!entry || entry.type !== 'blob') return false
    if (stat.isSymbolicLink()) {
      if (entry.mode !== '120000' || entry.id !== blobId(Buffer.from(fs.readlinkSync(file)), format)) return false
      continue
    }
    if (!stat.isFile()) return false
    if (entry.mode !== (stat.mode & 0o111 ? '100755' : '100644')) return false
    if (stat.size > APPROVAL_LIMITS.inputBytes) return false
    if (entry.id !== blobId(fs.readFileSync(file), format)) return false
  }
  return true
}
// The key of one approval.
// It names where the command runs too (the tier of the turn, the session
// mode, its network and whether it may write): an answer given for a
// sandboxed run with no network is not one for a run with more.
export const approvalKey = ({ scope = '', name, run, inputs, tier = '', mode = '', network = '', readOnly = false }) =>
  sha256(
    JSON.stringify([
      'shapewall-command-approval-2',
      String(scope),
      String(name),
      sha256(String(run)),
      String(inputs),
      String(tier),
      String(mode),
      String(network),
      Boolean(readOnly),
    ]),
  )

// The record store of one connection (or one local board).
export function createApprovalStore(dir, { now = () => Date.now() } = {}) {
  const fileOf = (key) => path.join(dir, `ca_${key}.json`)
  function sweep() {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!/^ca_[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        if (now() - fs.statSync(path.join(dir, name)).mtimeMs > APPROVAL_LIMITS.keepMs) fs.rmSync(path.join(dir, name), { force: true })
      } catch {
        /* gone */
      }
    }
  }
  return {
    dir,
    // Whether this exact (name, line, inputs) was allowed, and is still fresh.
    has(entry) {
      const key = approvalKey(entry)
      try {
        const stat = fs.lstatSync(fileOf(key))
        if (!stat.isFile() || now() - stat.mtimeMs > APPROVAL_LIMITS.keepMs) return false
        const record = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'))
        return record?.key === key
      } catch {
        return false
      }
    },
    // Writes the record. `by`: who allowed it ("base": the inputs as committed, a card's answer otherwise).
    remember(entry, { by = 'card' } = {}) {
      const key = approvalKey(entry)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const record = {
        key,
        name: entry.name,
        runHash: sha256(String(entry.run)),
        inputs: entry.inputs,
        by,
        at: new Date(now()).toISOString(),
      }
      const file = fileOf(key)
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
      sweep()
      return record
    },
    sweep,
  }
}
