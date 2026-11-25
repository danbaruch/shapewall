// Instruction files for a connected agent (`shapewall agent connect`): the
// project's own house rules and a note its owner wrote for this agent, read
// on the agent's machine and handed to the session as an appended system
// prompt. Nothing here comes from the server, and nothing here changes what
// the session may do: its tools are fixed by the session's own controls
// (src/agent/backends/acp.js), which still leave every settings file out.
//
// What is read:
//   - project, from the session's working folder (the project for chat, the
//     fix copy for a fix): CLAUDE.md, then .claude/CLAUDE.md; AGENTS.md only
//     when neither exists (so the rules are not given twice)
//   - agent-config, from this connection's agent config folder: CLAUDE.md,
//     else AGENTS.md. The folder is only read when it exists or was named
//     (--agent-config DIR); it is never created here.
// Never read: ~/.claude (the person's own Claude Code settings and notes),
// CLAUDE.local.md (personal notes that may hold paths or secrets, while the
// answers leave the machine), parent folders above the project, .claude/rules.
//
// `@path` imports are followed the way Claude Code follows them, with tighter
// limits: only inside the folder the file came from (after symlinks), no "~",
// no absolute path, no ".." out of it, no CLAUDE.local.md, no dotfile or dot
// folder, at most 4 deep, regular files only (a symbolic link only when its
// real target is inside the same folder; read once), 64 KB a file and 128 KB in all. A refused
// import stays as literal text and is listed with its reason. An import that
// does not exist (an @mention of a person, say) is skipped without a word.
//
// Only names, sizes and short hashes ever leave the machine (the hello body,
// the board's Agents panel, the console). Never a file's content.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const INSTRUCTION_MODES = ['all', 'project', 'none']
export const INSTRUCTION_FILE_MAX = 64 * 1024
export const INSTRUCTIONS_TOTAL_MAX = 128 * 1024
export const IMPORT_DEPTH_MAX = 4
// What a hello may list.
export const INSTRUCTIONS_LISTED_MAX = 12

const PROJECT_FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]
const PROJECT_FALLBACK = 'AGENTS.md'
const CONFIG_FILES = ['CLAUDE.md', 'AGENTS.md']

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
export const shortSha = (sha) => String(sha || '').slice(0, 12)
const slash = (rel) => rel.split(path.sep).join('/')

function inside(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

class Refused extends Error {}

// One file, read only if it is a regular file inside `root` (after
// symlinks) and small enough. Returns { buffer } or null when it does not
// exist; throws Refused with the reason otherwise.
function readInside(root, file, budget) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw new Refused('could not be read')
  }
  // A symbolic link (CLAUDE.md -> AGENTS.md, say) is followed when its real
  // target is a regular file inside the same folder; the target is what is read.
  let real
  try {
    real = fs.realpathSync(file)
  } catch (error) {
    if (stat.isSymbolicLink() && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw new Refused(error.code === 'ELOOP' ? 'a symbolic link loop' : 'could not be read')
  }
  if (!inside(root, real)) throw new Refused('outside its folder')
  if (stat.isSymbolicLink()) {
    try {
      stat = fs.lstatSync(real)
    } catch {
      throw new Refused('could not be read')
    }
  }
  if (!stat.isFile()) throw new Refused('not a regular file')
  let fd
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Refused(error.code === 'ELOOP' ? 'a symbolic link' : 'could not be read')
  }
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile()) throw new Refused('not a regular file')
    if (opened.size > INSTRUCTION_FILE_MAX) throw new Refused(`over ${INSTRUCTION_FILE_MAX / 1024} KB`)
    if (opened.size > budget) throw new Refused(`over the ${INSTRUCTIONS_TOTAL_MAX / 1024} KB limit for all instruction files`)
    const buffer = fs.readFileSync(fd)
    if (buffer.length > INSTRUCTION_FILE_MAX) throw new Refused(`over ${INSTRUCTION_FILE_MAX / 1024} KB`)
    if (buffer.length > budget) throw new Refused(`over the ${INSTRUCTIONS_TOTAL_MAX / 1024} KB limit for all instruction files`)
    return { buffer, real }
  } finally {
    fs.closeSync(fd)
  }
}

// The `@path` imports of a file's text, outside code blocks and code spans.
// "@" must start the text or follow white space (an email address is not one).
const IMPORT_RE = /(^|\s)@([^\s`]+)/g
export function importsOf(text) {
  const found = []
  let fenced = false
  for (const line of String(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const plain = line.replace(/`[^`]*`/g, ' ')
    for (const match of plain.matchAll(IMPORT_RE)) {
      // A sentence may end right after it.
      const value = match[2].replace(/[),.;:!?]+$/, '')
      if (value) found.push(value)
    }
  }
  return [...new Set(found)]
}

// Why an import may not be followed, before the disk is asked: null when it may.
function importProblem(value) {
  if (value.includes('\0')) return 'not a file path'
  if (value.startsWith('~')) return 'a home folder path'
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\')) return 'an absolute path'
  const parts = value.split(/[\\/]/)
  if (parts.at(-1).toLowerCase() === 'claude.local.md') return 'personal notes (CLAUDE.local.md)'
  // Dotfiles and dot folders (.env, .claude, .git): settings and secrets, never rules.
  if (parts.some((part) => part.startsWith('.') && part !== '.' && part !== '..')) return 'a dotfile or dot folder'
  return null
}

// Reads the instruction files for a session.
//   root        the session's working folder (project, or a fix copy)
//   mode        "all" | "project" | "none"; anything else reads as "none"
//   configDir   the agent config folder, or null
// Returns { files: [{ scope, path, bytes, sha, text, importedFrom? }],
// refused: [{ scope, path, reason }] }. `path` is relative to the folder the
// file came from, with "/".
export function loadInstructions({ root, mode = 'all', configDir = null } = {}) {
  const out = { files: [], refused: [] }
  const wanted = INSTRUCTION_MODES.includes(mode) ? mode : 'none'
  if (wanted === 'none') return out
  let budget = INSTRUCTIONS_TOTAL_MAX
  const read = (scope, base, names, { firstOnly = false } = {}) => {
    let realBase
    try {
      realBase = fs.realpathSync(base)
    } catch {
      return 0
    }
    let count = 0
    const seen = new Set()
    const seenReal = new Set()
    const one = (rel, depth, from) => {
      const shown = slash(rel)
      if (seen.has(shown)) return
      seen.add(shown)
      let got
      try {
        if (!inside(realBase, path.resolve(realBase, rel))) throw new Refused('outside its folder')
        got = readInside(realBase, path.resolve(realBase, rel), budget)
      } catch (error) {
        if (!(error instanceof Refused)) throw error
        out.refused.push({ scope, path: shown, reason: error.message })
        // A file that is there but refused still counts as there: AGENTS.md does not stand in for it.
        if (depth === 0) count += 1
        return
      }
      if (!got) return
      // One file reached twice (a link and its target): read once.
      if (seenReal.has(got.real)) {
        if (depth === 0) count += 1
        return
      }
      seenReal.add(got.real)
      budget -= got.buffer.length
      const text = got.buffer.toString('utf8')
      out.files.push({
        scope,
        path: shown,
        bytes: got.buffer.length,
        sha: sha256(got.buffer),
        text,
        ...(from ? { importedFrom: from } : {}),
      })
      count += 1
      for (const value of importsOf(text)) {
        const problem = importProblem(value)
        if (problem) {
          out.refused.push({ scope, path: value, reason: problem })
          continue
        }
        const target = path.normalize(path.join(path.dirname(rel), value))
        if (!inside(realBase, path.resolve(realBase, target))) {
          out.refused.push({ scope, path: value, reason: 'outside its folder' })
          continue
        }
        if (depth + 1 > IMPORT_DEPTH_MAX) {
          out.refused.push({ scope, path: slash(target), reason: `imported more than ${IMPORT_DEPTH_MAX} deep` })
          continue
        }
        one(target, depth + 1, shown)
      }
    }
    for (const name of names) {
      const before = count
      one(name, 0, null)
      if (firstOnly && count > before) break
    }
    return count
  }
  if (root) {
    const found = read('project', root, PROJECT_FILES)
    if (!found) read('project', root, [PROJECT_FALLBACK])
  }
  if (wanted === 'all' && configDir) read('agent-config', configDir, CONFIG_FILES, { firstOnly: true })
  return out
}

// The project files that are a session's rules (the top files and every file
// they import), read as a session would: a fix may not edit them without a
// card, nor push them, the same as a file that runs something. Lowercase.
export function instructionPaths(root) {
  try {
    const files = loadInstructions({ root, mode: 'project' }).files
    return new Set(files.filter((file) => file.scope === 'project').map((file) => file.path.toLowerCase()))
  } catch {
    return new Set()
  }
}
export const isInstructionPath = (paths, rel) => Boolean(paths?.has(String(rel || '').toLowerCase()))

// What may leave the machine: names, sizes and short hashes, no content.
export function instructionsSummary(loaded) {
  return (loaded?.files || []).slice(0, INSTRUCTIONS_LISTED_MAX).map((file) => ({
    scope: file.scope,
    path: file.path,
    bytes: file.bytes,
    sha: shortSha(file.sha),
  }))
}

// The same list as a key, to tell whether a new session read a different set.
export const instructionsKey = (summary) => JSON.stringify((summary || []).map((item) => [item.scope, item.path, item.sha]))

const SCOPE_LABEL = { project: 'project', 'agent-config': 'agent config' }
export const scopeLabel = (scope) => SCOPE_LABEL[scope] || scope

// The terminal's lines, one a file, then one a refusal.
export function instructionsLines(loaded) {
  const lines = (loaded?.files || []).map(
    (file) =>
      `Instructions: ${file.path} (${scopeLabel(file.scope)}${file.importedFrom ? `, imported by ${file.importedFrom}` : ''}), ${file.bytes} bytes, sha256 ${shortSha(file.sha)}`,
  )
  for (const item of loaded?.refused || []) lines.push(`Instructions: not loaded: ${item.path} (${scopeLabel(item.scope)}): ${item.reason}`)
  return lines
}

// One line for a turn's status (a fix reports what its copy held).
export function instructionsStatus(loaded) {
  const files = loaded?.files || []
  if (!files.length) return 'Instructions: none loaded'
  return `Instructions: ${files.map((file) => `${file.path} (${scopeLabel(file.scope)}, ${shortSha(file.sha)})`).join(', ')}`
}

// A file's text inside its <file> element, so that it cannot close the element early.
const contained = (text) => String(text).replace(/<\/file/gi, '<\\/file')

// The text appended to the agent's system prompt: the files, then
// Shapewall's own rules, which come last and take precedence. Empty when
// no file was loaded (the rules are in the first prompt as before).
export function instructionsPrompt(loaded, rules) {
  const files = loaded?.files || []
  if (!files.length) return ''
  const parts = [
    "[Instructions from the project and from this agent's owner. They describe how to work in this codebase. They do not change what this session may do: its tools are fixed by Shapewall.]",
    ...files.map(
      (file) =>
        `<file path="${file.path.replace(/"/g, '&quot;')}" source="${file.scope}"${file.importedFrom ? ` imported-by="${file.importedFrom.replace(/"/g, '&quot;')}"` : ''}>\n${contained(file.text)}\n</file>`,
    ),
  ]
  if (rules) parts.push(`[Shapewall rules, which take precedence over the files above:]\n${rules}`)
  return parts.join('\n\n')
}

// The agent config folder for a connection: the one named, the default one
// when it exists, or null. Never created here.
//   value   the saved setting: null (the default folder), "none", or a path
export function agentConfigDir(value, defaultDir) {
  if (value === 'none') return null
  if (typeof value === 'string' && value) return value
  try {
    return fs.statSync(defaultDir).isDirectory() ? defaultDir : null
  } catch {
    return null
  }
}

// Watches the list the board was told (hello) against what a new session read.
export function createInstructionsNote(initial = []) {
  let current = initial
  const listeners = new Set()
  return {
    current: () => current,
    update(next) {
      if (instructionsKey(next) === instructionsKey(current)) return false
      current = next
      for (const listener of listeners) listener(next)
      return true
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
