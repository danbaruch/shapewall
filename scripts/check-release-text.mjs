#!/usr/bin/env node
// The release text gate: the lines a change adds must hold no en or em dash
// (U+2013, U+2014) or look-alike (DASH_RULES), no banned phrase and no
// competitor or employer name (matched loosely: nameRule). The lists live in
// scripts/release-text.config.json, which is never checked itself (it has to
// name what it bans); this file spells the dashes by code point so it holds
// none.
//
//   node scripts/check-release-text.mjs                 added lines vs origin/main
//   node scripts/check-release-text.mjs --base REF      added lines vs REF (any commit, no merge base needed)
//   node scripts/check-release-text.mjs --all           every tracked file, every line
//   node scripts/check-release-text.mjs --files a b     these files, every line
//
// It exits 1 and prints file:line for each hit, 0 when clean. CI runs it on
// pull requests against the target branch's main (.github/workflows/ci.yml).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_FILE = path.join(ROOT, 'scripts', 'release-text.config.json')
export const DASHES = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]

// Names (employers, competitors) live outside the public repository, in a private file with the same
// names/phrases keys. Without one, the gate checks dashes and the phrases in the config only.
export const PRIVATE_FILE =
  process.env.SHAPEWALL_RELEASE_NAMES ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'shapewall-dev', 'release-names.json')

export function readPrivate(file = PRIVATE_FILE) {
  try {
    const extra = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { names: extra.names || [], phrases: extra.phrases || [] }
  } catch {
    return { names: [], phrases: [] }
  }
}

export function loadRules(config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), extra = readPrivate()) {
  config = { ...config, names: [...(config.names || []), ...extra.names], phrases: [...(config.phrases || []), ...extra.phrases] }
  const covers = (list) => (file) => list.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
  return {
    excluded: covers(config.exclude || []),
    dashesAllowed: covers(config.dashesAllowed?.paths || []),
    phrasesAllowed: covers(config.phrasesAllowed?.paths || []),
    binary: (file) => (config.binaryExtensions || []).includes(path.extname(file).toLowerCase()),
    phrases: (config.phrases || []).map((entry) => ({ re: new RegExp(entry.pattern, 'i'), why: entry.why || 'banned phrase' })),
    names: (config.names || []).map(nameRule),
  }
}

// Every dash-like character a line may not hold, by code point: the en and
// em dash, and the look-alikes that pass for them (figure dash, horizontal
// bar, minus sign).
export const DASH_RULES = [
  [0x2013, 'en dash'],
  [0x2014, 'em dash'],
  [0x2012, 'figure dash'],
  [0x2015, 'horizontal bar'],
  [0x2212, 'minus sign'],
].map(([code, name]) => ({ char: String.fromCharCode(code), why: `${name} (U+${code.toString(16).toUpperCase()})` }))

// A name, matched case-folded with spaces, dashes and underscores taken out
// of both sides, so "Acme Corp", "acme-corp", "ACME_CORP" and "AcmeCorpHQ"
// all count; it must start a word (a letter or digit right before it does
// not count).
const SEPARATOR = /[\s\-_\u2010-\u2015\u2212]/
export const foldName = (text) => [...String(text).toLowerCase()].filter((char) => !SEPARATOR.test(char)).join('')
function nameRule(entry) {
  const wanted = foldName(entry.name)
  const test = (line) => {
    if (!wanted) return false
    // The folded line, and where each of its characters came from.
    const chars = []
    const from = []
    const lower = String(line).toLowerCase()
    for (let index = 0; index < lower.length; index += 1) {
      if (SEPARATOR.test(lower[index])) continue
      chars.push(lower[index])
      from.push(index)
    }
    const folded = chars.join('')
    for (let at = folded.indexOf(wanted); at !== -1; at = folded.indexOf(wanted, at + 1)) {
      if (!/[a-z0-9]/i.test(line[from[at] - 1] || '')) return true
    }
    return false
  }
  return { re: { test }, why: `${entry.kind || 'banned'} name ${entry.name}` }
}

// The hits on one line: [{ why, text }].
export function lineHits(line, file, rules) {
  const hits = []
  if (!rules.dashesAllowed(file)) for (const { char, why } of DASH_RULES) if (line.includes(char)) hits.push(why)
  const phrases = rules.phrasesAllowed(file) ? [] : rules.phrases
  for (const { re, why } of [...phrases, ...rules.names]) if (re.test(line)) hits.push(why)
  return hits
}

// { file: [[lineNumber, text], ...] } for the lines HEAD adds against base.
// The diff is read with its hunk counts: a "+++ " or "--- " line is a file
// header only between hunks, so an added line whose text starts "++ " is
// still checked.
export function addedLines(base, cwd = ROOT) {
  const diff = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=AMR', base, 'HEAD'],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  return parseDiff(diff)
}

export function parseDiff(diff) {
  const out = {}
  let file = null
  let number = 0
  let oldLeft = 0
  let newLeft = 0
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        if (file) out[file].push([number, line.slice(1)])
        number += 1
        newLeft -= 1
      } else if (line.startsWith('-')) oldLeft -= 1
      else if (line.startsWith(' ')) {
        number += 1
        oldLeft -= 1
        newLeft -= 1
      } else if (!line.startsWith('\\')) oldLeft = newLeft = 0
      continue
    }
    if (line.startsWith('diff --git ')) file = null
    else if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6)
      if (file) out[file] ||= []
    } else if (line.startsWith('@@')) {
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!match) continue
      oldLeft = match[1] === undefined ? 1 : Number(match[1])
      number = Number(match[2])
      newLeft = match[3] === undefined ? 1 : Number(match[3])
    }
  }
  return out
}

function wholeFiles(files, cwd = ROOT) {
  const out = {}
  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(path.join(cwd, file), 'utf8')
    } catch {
      continue
    }
    out[file] = text.split('\n').map((line, index) => [index + 1, line])
  }
  return out
}

export function check(linesByFile, rules = loadRules()) {
  const hits = []
  for (const [file, lines] of Object.entries(linesByFile)) {
    if (rules.excluded(file) || rules.binary(file)) continue
    for (const [number, text] of lines) {
      for (const why of lineHits(text, file, rules)) hits.push({ file, line: number, why, text: text.trim().slice(0, 160) })
    }
  }
  return hits
}

function main(argv) {
  let lines
  let what
  if (argv.includes('--all')) {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    lines = wholeFiles(files)
    what = 'every tracked file'
  } else if (argv.includes('--files')) {
    const files = argv.slice(argv.indexOf('--files') + 1).map((file) => path.relative(ROOT, path.resolve(file)))
    lines = wholeFiles(files)
    what = `${files.length} file(s)`
  } else {
    const at = argv.indexOf('--base')
    const base = at >= 0 ? argv[at + 1] : 'origin/main'
    if (!base) throw new Error('--base needs a ref')
    lines = addedLines(base)
    what = `the lines added since ${base}`
  }
  const hits = check(lines)
  for (const hit of hits) process.stdout.write(`${hit.file}:${hit.line}: ${hit.why}: ${hit.text}\n`)
  if (hits.length) {
    process.stdout.write(`\nRelease text gate: ${hits.length} hit(s) in ${what}. Lists: scripts/release-text.config.json\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`Release text gate: no hits in ${what}.\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`check-release-text: ${error.message}\n`)
    process.exitCode = 2
  }
}
