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
// `shapewall init` writes it; the first `serve` or `capture` in a project
// with a config adds it once (addAgentDocsOnce) and records that in
// <outputDir>/agent-docs.json, so a section someone deleted is never added
// back. Config "agentDocs": false or `init --no-agent-docs` turns that off;
// `shapewall agent docs --write | --remove | --print` does it by hand.
//
// No ports, paths, names or tokens go in the section: it is meant to be
// committed.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { LOOP_SUMMARY, UNTRUSTED_TEXT } from './mcp-instructions.js'

export const AGENT_DOCS_VERSION = 1
export const START_MARKER = `<!-- shapewall:start v${AGENT_DOCS_VERSION} -->`
export const END_MARKER = '<!-- shapewall:end -->'
// Any version of the start marker, so a newer Shapewall's section is found (and replaced) too.
const START_RE = /^<!-- shapewall:start v(\d+) -->[ \t]*$/
const END_RE = /^<!-- shapewall:end -->[ \t]*$/
const IMPORT_RE = /^[ \t]*@(\.\/)?AGENTS\.md[ \t]*$/m
export const STATE_FILE = 'agent-docs.json'

// The section, without the markers.
export function agentDocsBody() {
  return [
    '## Shapewall',
    '',
    "This project has a Shapewall board: every screen of the app, captured, with comments people pinned to the screens' elements.",
    'Those comments are work for you.',
    '',
    '- The board: `npx shapewall open --print` prints its link. The MCP tool `board_link` links a page, a comment or a before and after.',
    "- The tools: the `shapewall` MCP server. If you do not have its tools, `npx shapewall agent setup` registers it with Claude Code and Codex (the person runs it).",
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

// Where the section is in a file's text: { start, end } line indexes (the
// marker lines), or null. Throws on a start marker without an end marker,
// or on two sections: Shapewall does not guess which text is its own.
export function findBlock(text, name = 'the file') {
  const lines = text.split(/\r?\n/)
  let found = null
  for (let index = 0; index < lines.length; index += 1) {
    if (!START_RE.test(lines[index])) continue
    if (found) throw new Error(`${name} has two Shapewall sections; remove one by hand`)
    const end = lines.findIndex((line, at) => at > index && END_RE.test(line))
    if (end === -1) throw new Error(`${name} has a "${lines[index].trim()}" line with no "${END_MARKER}" after it; fix it by hand`)
    found = { start: index, end }
    index = end
  }
  return found
}

// The text with the section put in (replacing the old one, or added at the
// end after a blank line), in the file's own line endings.
export function withBlock(text, name) {
  const eol = eolOf(text)
  const block = agentDocsBlock().split('\n')
  const where = findBlock(text, name)
  const lines = text.split(/\r?\n/)
  if (where) {
    lines.splice(where.start, where.end - where.start + 1, ...block)
    return lines.join(eol)
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
  const lines = text.split(/\r?\n/)
  let from = where.start
  let to = where.end
  // The blank line before the section, when one is still left after it or it ends the file.
  if (from > 0 && lines[from - 1] === '' && (to + 1 >= lines.length || lines[to + 1] === '')) from -= 1
  if (from === 0 && lines[to + 1] === '') to += 1
  lines.splice(from, to - from + 1)
  return lines.join(eol)
}

function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let mode = 0o644
  try {
    mode = fs.statSync(file).mode & 0o777
  } catch {
    /* a new file */
  }
  try {
    fs.writeFileSync(temp, text, { mode, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

const readText = (file) => fs.readFileSync(file, 'utf8')
const importsAgents = (text) => IMPORT_RE.test(text)

// What writing the section would do in `dir`:
// { changes: [{ file, action: 'create'|'update'|'same', text, before }], notes: [] }.
// Nothing is written.
export function planAgentDocs(dir) {
  const agentsFile = path.join(dir, 'AGENTS.md')
  const claudeFile = path.join(dir, 'CLAUDE.md')
  const agents = kindOf(agentsFile)
  const claude = kindOf(claudeFile)
  const changes = []
  const notes = []
  const put = (file, name) => {
    const before = readText(file)
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

// The state file: { version, added: ISO, files: [...], created: [...], removed: ISO|null }.
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

// Writes the section (planAgentDocs) and records it. Returns
// { written: [names], created: [names], notes, changed }.
export function writeAgentDocs(dir, outputDir, { now = new Date() } = {}) {
  const plan = planAgentDocs(dir)
  const written = []
  const created = []
  for (const change of plan.changes) {
    if (change.action === 'same') continue
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
export function removeAgentDocs(dir, outputDir, { now = new Date() } = {}) {
  const state = readState(outputDir) || {}
  const created = new Set(state.created || [])
  const removed = []
  const deleted = []
  const notes = []
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
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

// The first `serve` or `capture`: adds the section once per project. Never
// throws (a board must start even when the files cannot be written).
// Returns the line to print, or null.
export function addAgentDocsOnce(config, { env = process.env } = {}) {
  try {
    if (config.agentDocs === false) return null
    // A CI run writes into a throwaway checkout: nothing to add there.
    if (env.CI && env.CI !== 'false' && env.CI !== '0') return null
    if (readState(config.outputDir)) return null
    const plan = planAgentDocs(config.dir)
    // A section already there (committed by someone else): only remember it.
    if (plan.changes.length && plan.changes.every((change) => change.action === 'same')) {
      writeState(config.outputDir, { added: null, files: plan.changes.map((change) => change.name), created: [], removed: null })
      return null
    }
    const result = writeAgentDocs(config.dir, config.outputDir)
    if (!result.changed) return null
    return `Added a Shapewall section to ${describeWritten(result)} so coding agents find the board. Remove it with "shapewall agent docs --remove".`
  } catch (error) {
    return `Could not add the Shapewall section to AGENTS.md: ${error.message}`
  }
}

// "AGENTS.md (and CLAUDE.md, which imports it)".
export function describeWritten({ written, created }) {
  if (written.length === 2 && created.includes('CLAUDE.md')) return `${written[0]} (and a CLAUDE.md that imports it)`
  return written.join(' and ')
}
