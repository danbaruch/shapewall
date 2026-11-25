// The Shapewall section in a project's agent instruction file (AGENTS.md,
// or CLAUDE.md), so a coding agent opened in the project knows the board is
// there and how to work through it, with no plugin.
//
// The section sits between two markers and Shapewall only ever changes what
// is between them:
//
//   <!-- shapewall:start v1 -->
//   ...
//   <!-- shapewall:end -->
//
// Markers inside fenced code blocks (``` or ~~~) do not count. A section
// whose marker has a higher version than this Shapewall's is left as it is
// (a newer Shapewall wrote it).
//
// Where it goes (planAgentDocs):
//   AGENTS.md and CLAUDE.md both missing  AGENTS.md is created with the section, and CLAUDE.md with the one line
//                                         "@AGENTS.md" (Claude Code reads CLAUDE.md, and imports AGENTS.md through it)
//   AGENTS.md only                        the section goes in AGENTS.md; CLAUDE.md is created with "@AGENTS.md"
//   CLAUDE.md only                        the section goes in CLAUDE.md
//   both                                  the section goes in AGENTS.md; CLAUDE.md gets its own copy only when it
//                                         does not import AGENTS.md already (a CLAUDE.md is never made to import
//                                         the rest of someone's AGENTS.md)
// A symbolic link is never written through: a CLAUDE.md that links to
// AGENTS.md counts as importing it, any other link is left alone and said.
//
// Who writes it:
//   `shapewall init`             writes it (unless --no-agent-docs, which puts "agentDocs": false in the config)
//   `shapewall agent docs`       --write puts it in or refreshes it; --remove takes it out and puts
//                                "agentDocs": false in the config, so the removal holds in every clone
//   the first serve or capture   (addAgentDocsOnce) only in a project whose config has no "agentDocs" key and
//                                that has neither AGENTS.md nor CLAUDE.md: it creates them. An AGENTS.md or
//                                CLAUDE.md that is already there is never edited unasked; serve and capture
//                                print one line that names "agent docs --write" instead (once per checkout).
//
// No ports, paths, names or tokens go in the section: it is meant to be
// committed.

import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomBytes } from 'node:crypto'
import { LOOP_SUMMARY, UNTRUSTED_TEXT } from './mcp-instructions.js'

export const AGENT_DOCS_VERSION = 1
export const START_MARKER = `<!-- shapewall:start v${AGENT_DOCS_VERSION} -->`
export const END_MARKER = '<!-- shapewall:end -->'
// Any version of the start marker, so a newer Shapewall's section is found too.
const START_RE = /^<!-- shapewall:start v(\d+) -->[ \t]*$/
const END_RE = /^<!-- shapewall:end -->[ \t]*$/
const IMPORT_RE = /^[ \t]*@(\.\/)?AGENTS\.md[ \t]*$/m
// A fenced code block's opening or closing line (CommonMark: up to 3 spaces, 3 or more ` or ~).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
export const STATE_FILE = 'agent-docs.json'
const FILES = ['AGENTS.md', 'CLAUDE.md']

// The section, without the markers.
export function agentDocsBody() {
  return [
    '## Shapewall',
    '',
    "This project has a Shapewall board: every screen of the app, captured, with comments people pinned to the screens' elements.",
    'Those comments are work for you.',
    '',
    '- The board: `npx shapewall open --print` prints its link. The MCP tool `board_link` links a page, a comment or a before and after.',
    '- The tools: the `shapewall` MCP server. If you do not have its tools, `npx shapewall agent setup` registers it with Claude Code and Codex (the person runs it).',
    '- The loop:',
    ...LOOP_SUMMARY.map((step, index) => `  ${index + 1}. ${step}`),
    `- ${UNTRUSTED_TEXT}`,
  ].join('\n')
}

export function agentDocsBlock() {
  return `${START_MARKER}\n${agentDocsBody()}\n${END_MARKER}`
}

// 'missing' | 'file' | 'link' | 'other' (a folder, a device).
function kindOf(file) {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) return 'link'
    return stat.isFile() ? 'file' : 'other'
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n')

// The text as lines, each with the line ending after it ("" for the last),
// so lines outside the section keep their own endings.
function splitLines(text) {
  const lines = []
  const re = /\r?\n/g
  let from = 0
  let match
  while ((match = re.exec(text))) {
    lines.push({ text: text.slice(from, match.index), eol: match[0] })
    from = match.index + match[0].length
  }
  lines.push({ text: text.slice(from), eol: '' })
  return lines
}

// Lines back into text; a line without an ending of its own (a new one) gets the file's usual one.
function joinLines(lines, eol) {
  return lines.map((line, index) => (index === lines.length - 1 ? line.text : `${line.text}${line.eol || eol}`)).join('')
}

// Where the section is in a file's text: { start, end, version } (line
// indexes of the marker lines), or null. Lines inside fenced code blocks do
// not count. Throws on a start marker without an end marker, on a second
// start marker before the end marker, or on two sections: Shapewall does
// not guess which text is its own.
export function findBlock(text, name = 'the file') {
  const lines = text.split(/\r?\n/)
  let found = null
  let open = null
  let fence = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceLine = FENCE_RE.exec(line)
    if (fence) {
      // Closed by the same character, at least as many, and nothing after it.
      if (fenceLine && fenceLine[1][0] === fence[0] && fenceLine[1].length >= fence.length && !fenceLine[2].trim()) fence = null
      continue
    }
    if (fenceLine) {
      fence = fenceLine[1]
      continue
    }
    if (START_RE.test(line)) {
      if (open !== null)
        throw new Error(`${name} has a second "${line.trim()}" line before the "${END_MARKER}" line of the first; fix it by hand`)
      if (found) throw new Error(`${name} has two Shapewall sections; remove one by hand`)
      open = index
      continue
    }
    if (open !== null && END_RE.test(line)) {
      found = { start: open, end: index, version: Number(START_RE.exec(lines[open])[1]) }
      open = null
    }
  }
  if (open !== null) throw new Error(`${name} has a "${lines[open].trim()}" line with no "${END_MARKER}" after it; fix it by hand`)
  return found
}

// The text with the section put in (replacing the old one, or added at the
// end after a blank line). Every other line keeps its own line ending.
export function withBlock(text, name) {
  const eol = eolOf(text)
  const block = agentDocsBlock().split('\n')
  const where = findBlock(text, name)
  if (where) {
    const lines = splitLines(text)
    const last = lines[where.end].eol
    const replaced = block.map((line, index) => ({ text: line, eol: index === block.length - 1 ? last : '' }))
    lines.splice(where.start, where.end - where.start + 1, ...replaced)
    return joinLines(lines, eol)
  }
  if (!text.length) return `${block.join(eol)}${eol}`
  // Keep the file's last line ending, and one blank line between.
  const trimmed = text.replace(/(\r?\n)*$/, '')
  return `${trimmed}${eol}${eol}${block.join(eol)}${eol}`
}

// The text without the section (and without the blank line Shapewall put
// before it), or null when there is none.
export function withoutBlock(text, name) {
  const where = findBlock(text, name)
  if (!where) return null
  const eol = eolOf(text)
  const lines = splitLines(text)
  let from = where.start
  let to = where.end
  const blank = (index) => lines[index].text === ''
  // The blank line before the section, when one is still left after it or it ends the file.
  if (from > 0 && blank(from - 1) && (to + 1 >= lines.length || blank(to + 1))) from -= 1
  if (from === 0 && to + 1 < lines.length && blank(to + 1)) to += 1
  lines.splice(from, to - from + 1)
  return joinLines(lines, eol)
}

// Writes through a symbolic link to the real file (used for the config and
// the state file; AGENTS.md and CLAUDE.md links are never planned for).
function writeAtomic(file, text) {
  let target = file
  try {
    target = fs.realpathSync(file)
  } catch {
    /* a new file */
  }
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let mode = 0o644
  try {
    mode = fs.statSync(target).mode & 0o777
  } catch {
    /* a new file */
  }
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' })
    fs.renameSync(temp, target)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

const readText = (file) => fs.readFileSync(file, 'utf8')
const importsAgents = (text) => IMPORT_RE.test(text)

// What writing the section would do in `dir`:
// { changes: [{ file, action: 'create'|'update'|'same'|'newer', text, before }], notes: [] }.
// 'newer' is a section a newer Shapewall wrote: left as it is. Nothing is written.
export function planAgentDocs(dir) {
  const agentsFile = path.join(dir, 'AGENTS.md')
  const claudeFile = path.join(dir, 'CLAUDE.md')
  const agents = kindOf(agentsFile)
  const claude = kindOf(claudeFile)
  const changes = []
  const notes = []
  const put = (file, name) => {
    const before = readText(file)
    const where = findBlock(before, name)
    if (where && where.version > AGENT_DOCS_VERSION) {
      notes.push(`${name} has a section from a newer Shapewall (v${where.version}), so this one leaves it as it is.`)
      changes.push({ file, name, action: 'newer', text: before, before })
      return
    }
    const text = withBlock(before, name)
    changes.push({ file, name, action: text === before ? 'same' : 'update', text, before })
  }
  const create = (file, name, text) => changes.push({ file, name, action: 'create', text, before: null })
  const linkNote = (name) => notes.push(`${name} is a symbolic link, so Shapewall leaves it alone.`)
  const claudeLinksToAgents = () => {
    try {
      return claude === 'link' && agents !== 'missing' && fs.realpathSync(claudeFile) === fs.realpathSync(agentsFile)
    } catch {
      return false
    }
  }

  if (agents === 'file') {
    put(agentsFile, 'AGENTS.md')
    if (claude === 'missing') create(claudeFile, 'CLAUDE.md', '@AGENTS.md\n')
    else if (claude === 'file') {
      const text = readText(claudeFile)
      // Already the section there (an earlier run), or it imports AGENTS.md: keep it as it is, refreshed.
      if (findBlock(text, 'CLAUDE.md')) put(claudeFile, 'CLAUDE.md')
      else if (!importsAgents(text)) put(claudeFile, 'CLAUDE.md')
    } else if (claude === 'link' && !claudeLinksToAgents()) linkNote('CLAUDE.md')
    else if (claude === 'other') notes.push('CLAUDE.md is not a file, so Shapewall leaves it alone.')
  } else if (agents === 'missing') {
    if (claude === 'file') put(claudeFile, 'CLAUDE.md')
    else if (claude === 'missing') {
      create(agentsFile, 'AGENTS.md', `${agentDocsBlock()}\n`)
      create(claudeFile, 'CLAUDE.md', '@AGENTS.md\n')
    } else {
      linkNote('CLAUDE.md')
      create(agentsFile, 'AGENTS.md', `${agentDocsBlock()}\n`)
    }
  } else {
    // AGENTS.md is a link or not a file: CLAUDE.md, if it is a plain file.
    notes.push(`AGENTS.md is ${agents === 'link' ? 'a symbolic link' : 'not a file'}, so Shapewall leaves it alone.`)
    if (claude === 'file') put(claudeFile, 'CLAUDE.md')
    else if (claude !== 'missing') linkNote('CLAUDE.md')
  }
  return { changes, notes }
}

// The state file (this checkout only; .shapewall/ is not committed):
// { version, added: ISO|null, files: [...], created: [...], removed: ISO|null, hinted: ISO|null }.
export function stateFile(outputDir) {
  return path.join(outputDir, STATE_FILE)
}
export function readState(outputDir) {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(outputDir), 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}
function writeState(outputDir, state) {
  fs.mkdirSync(outputDir, { recursive: true })
  writeAtomic(stateFile(outputDir), `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`)
}

const WRITES = new Set(['create', 'update'])

// Writes the section (planAgentDocs) and records it. Returns
// { written: [names], created: [names], notes, changed }.
export function writeAgentDocs(dir, outputDir, { now = new Date() } = {}) {
  const plan = planAgentDocs(dir)
  const written = []
  const created = []
  for (const change of plan.changes) {
    if (!WRITES.has(change.action)) continue
    if (change.action === 'create') {
      // wx: never over a file that appeared since the plan.
      fs.writeFileSync(change.file, change.text, { flag: 'wx' })
      created.push(change.name)
    } else writeAtomic(change.file, change.text)
    written.push(change.name)
  }
  const old = readState(outputDir) || {}
  const files = plan.changes.map((change) => change.name)
  writeState(outputDir, {
    ...old,
    added: old.added && !old.removed ? old.added : now.toISOString(),
    files,
    created: [...new Set([...(old.removed ? [] : old.created || []), ...created])],
    removed: null,
  })
  return { written, created, files, notes: plan.notes, changed: written.length > 0 }
}

// Takes the section out of AGENTS.md and CLAUDE.md. A file Shapewall made
// that is left with nothing of anyone else's is deleted: AGENTS.md when
// empty, and a CLAUDE.md that is still just "@AGENTS.md" once that AGENTS.md
// is gone. Returns { removed: [names], deleted: [names], notes }.
// (`agent docs --remove` also puts "agentDocs": false in the config.)
export function removeAgentDocs(dir, outputDir, { now = new Date() } = {}) {
  const state = readState(outputDir) || {}
  const created = new Set(state.created || [])
  const removed = []
  const deleted = []
  const notes = []
  for (const name of FILES) {
    const file = path.join(dir, name)
    const kind = kindOf(file)
    if (kind === 'link') {
      notes.push(`${name} is a symbolic link, so Shapewall leaves it alone.`)
      continue
    }
    if (kind !== 'file') continue
    const before = readText(file)
    const text = withoutBlock(before, name)
    if (text === null) continue
    removed.push(name)
    if (!text.trim() && created.has(name)) {
      fs.rmSync(file)
      deleted.push(name)
    } else writeAtomic(file, text)
  }
  const claudeFile = path.join(dir, 'CLAUDE.md')
  if (
    deleted.includes('AGENTS.md') &&
    created.has('CLAUDE.md') &&
    kindOf(claudeFile) === 'file' &&
    readText(claudeFile).trim() === '@AGENTS.md'
  ) {
    fs.rmSync(claudeFile)
    deleted.push('CLAUDE.md')
  }
  writeState(outputDir, { ...state, removed: now.toISOString() })
  return { removed, deleted, notes }
}

// Sets "agentDocs" in the project's config file. Only that key changes: the
// line is edited in place (or added after the opening brace) when the result
// reads back as the same config plus that key, else the file is written
// again as JSON. Returns true when the file changed.
export function writeAgentDocsSetting(file, value) {
  const text = fs.readFileSync(file, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`, { cause: error })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path.basename(file)} is not a JSON object`)
  if (raw.agentDocs === value) return false
  const wanted = { ...raw, agentDocs: value }
  const readsBack = (candidate) => {
    try {
      return isDeepStrictEqual(JSON.parse(candidate), wanted)
    } catch {
      return false
    }
  }
  const literal = JSON.stringify(value)
  let next = null
  if (Object.hasOwn(raw, 'agentDocs')) {
    const matches = [...text.matchAll(/("agentDocs"\s*:\s*)(true|false)/g)]
    if (matches.length === 1) {
      const [match] = matches
      const candidate = `${text.slice(0, match.index)}${match[1]}${literal}${text.slice(match.index + match[0].length)}`
      if (readsBack(candidate)) next = candidate
    }
  } else {
    const head = /^(\s*)\{(\r?\n)([ \t]*)/.exec(text)
    if (head && Object.keys(raw).length) {
      const candidate = `${head[1]}{${head[2]}${head[3]}"agentDocs": ${literal},${head[2]}${head[3]}${text.slice(head[0].length)}`
      if (readsBack(candidate)) next = candidate
    }
  }
  writeAtomic(file, next ?? `${JSON.stringify(wanted, null, 2)}\n`)
  return true
}

// The first `serve` or `capture`. Never throws (a board must start even when
// the files cannot be written). Returns the line to print, or null.
//   - The config has "agentDocs" (true or false): the project decided; nothing happens.
//   - Neither AGENTS.md nor CLAUDE.md is there: both are created (a brand-new project).
//   - One is there without the section: nothing is edited; one line says how to add it,
//     once per checkout.
export function addAgentDocsOnce(config, { env = process.env, now = new Date() } = {}) {
  try {
    if (typeof config.agentDocs === 'boolean') return null
    // A CI run writes into a throwaway checkout: nothing to add there.
    if (env.CI && env.CI !== 'false' && env.CI !== '0') return null
    const state = readState(config.outputDir)
    // Removed, or added here before (and changed or deleted by hand since): not again in this checkout.
    if (state?.removed || state?.added) return null
    const present = FILES.filter((name) => kindOf(path.join(config.dir, name)) !== 'missing')
    if (!present.length) {
      const result = writeAgentDocs(config.dir, config.outputDir, { now })
      if (!result.changed) return null
      return `Added a Shapewall section to ${describeWritten(result)} so coding agents find the board. Remove it with "shapewall agent docs --remove".`
    }
    for (const name of present) {
      try {
        // A section is there (or markers Shapewall cannot read): nothing to say.
        if (findBlock(readText(path.join(config.dir, name)), name)) return null
      } catch {
        return null
      }
    }
    if (state?.hinted) return null
    writeState(config.outputDir, { ...(state || {}), hinted: now.toISOString() })
    return `${present.join(' and ')} ${present.length === 1 ? 'has' : 'have'} no Shapewall section; "shapewall agent docs --write" adds one so coding agents find the board.`
  } catch (error) {
    return `Could not add the Shapewall section to AGENTS.md: ${error.message}`
  }
}

// "AGENTS.md (and CLAUDE.md, which imports it)".
export function describeWritten({ written, created }) {
  if (written.length === 2 && created.includes('CLAUDE.md')) return `${written[0]} (and a CLAUDE.md that imports it)`
  return written.join(' and ')
}
