// A careful editor for one table of Codex's config.toml:
// [mcp_servers.shapewall] (and its subtables, such as
// [mcp_servers.shapewall.env]). Everything else in the file stays byte for
// byte: other tables, comments, blank lines, line endings.
//
// Why not `codex mcp add`: it silently replaces the whole entry and drops
// tool_timeout_sec (spike S4), and it has no "only if it is not there".
//
// It reads TOML only as far as it must: where table headers are (outside
// multi-line strings and arrays), the keys of our table and their simple
// values (strings, arrays of strings, numbers, booleans). A file where the
// entry is written another way (an inline table, dotted keys, an array of
// tables) is refused, so it is edited by hand rather than guessed at.

const SERVER = 'shapewall'

// Splits a dotted key ("mcp_servers.\"shapewall\"") into its parts, or null.
export function keyParts(text) {
  const parts = []
  let rest = text.trim()
  while (rest.length) {
    let match
    if ((match = /^"((?:[^"\\]|\\.)*)"/.exec(rest))) {
      try {
        parts.push(JSON.parse(`"${match[1]}"`))
      } catch {
        return null
      }
    } else if ((match = /^'([^']*)'/.exec(rest))) parts.push(match[1])
    else if ((match = /^[A-Za-z0-9_-]+/.exec(rest))) parts.push(match[0])
    else return null
    rest = rest.slice(match[0].length).trim()
    if (!rest.length) break
    if (rest[0] !== '.') return null
    rest = rest.slice(1).trim()
    if (!rest.length) return null
  }
  return parts.length ? parts : null
}

// Walks a value's text from `start`, tracking strings, comments and
// brackets. Returns { depth, multi } after the text: depth > 0 means an
// array or inline table goes on, multi is an open ''' or """ string.
function walk(text, state) {
  let { depth, multi } = state
  let index = 0
  while (index < text.length) {
    if (multi === "'''") {
      // A multi-line literal string: no escapes.
      const close = text.indexOf(multi, index)
      if (close === -1) return { depth, multi }
      index = close + 3
      // A closing '''' puts one quote in the string.
      while (text[index] === "'") index += 1
      multi = null
      continue
    }
    if (multi) {
      // A multi-line basic string: a backslash escapes the next character, so \""" does not end it.
      if (text[index] === '\\') {
        index += 2
        continue
      }
      if (!text.startsWith('"""', index)) {
        index += 1
        continue
      }
      index += 3
      // A closing """" puts one quote in the string.
      while (text[index] === '"') index += 1
      multi = null
      continue
    }
    const char = text[index]
    if (char === '#') break
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      multi = text.slice(index, index + 3)
      index += 3
      continue
    }
    if (char === '"') {
      index += 1
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
      index += 1
      continue
    }
    if (char === "'") {
      const close = text.indexOf("'", index + 1)
      index = close === -1 ? text.length : close + 1
      continue
    }
    if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    index += 1
  }
  return { depth, multi }
}

// The text as lines, each with the line ending after it ("\r\n", "\n", or ""
// for the last), so the lines Shapewall does not change keep their own.
export function splitLines(source) {
  const lines = []
  const re = /\r?\n/g
  let from = 0
  let match
  while ((match = re.exec(source))) {
    lines.push({ text: source.slice(from, match.index), eol: match[0] })
    from = match.index + match[0].length
  }
  lines.push({ text: source.slice(from), eol: '' })
  return lines
}

// Lines back into text: each line keeps its own ending, and a line Shapewall
// added (or one that was last and no longer is) gets the file's usual one.
// Nothing follows the last line, as with split and join.
function joinLines(lines, eol) {
  return lines.map((line, index) => (index === lines.length - 1 ? line.text : `${line.text}${line.eol || eol}`)).join('')
}

// The file as lines, each marked: { text, eol, kind: 'header'|'key'|'cont'|'other', table, key?, header? }.
// `table` is the parts of the table the line belongs to ([] is the root).
export function scanToml(source) {
  const out = []
  let state = { depth: 0, multi: null }
  let table = []
  let open = null
  for (const { text, eol } of splitLines(source)) {
    if (state.multi || state.depth > 0) {
      state = walk(text, state)
      out.push({ text, eol, kind: 'cont', table, owner: open })
      continue
    }
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      out.push({ text, eol, kind: 'other', table })
      continue
    }
    const header = /^\[(\[)?([^\]]*)\](\])?\s*(#.*)?$/.exec(trimmed)
    if (header) {
      const parts = keyParts(header[2])
      if (!parts) throw new Error(`a table header Shapewall cannot read: ${trimmed}`)
      table = parts
      out.push({ text, eol, kind: 'header', table, arrayTable: Boolean(header[1]) })
      continue
    }
    const equals = findEquals(text)
    if (equals === -1) throw new Error(`a line Shapewall cannot read: ${trimmed}`)
    const key = keyParts(text.slice(0, equals))
    if (!key) throw new Error(`a key Shapewall cannot read: ${trimmed}`)
    const entry = { text, eol, kind: 'key', table, key, value: text.slice(equals + 1) }
    open = entry
    state = walk(entry.value, { depth: 0, multi: null })
    out.push(entry)
  }
  if (state.multi || state.depth > 0) throw new Error('the file ends inside a string or an array')
  return out
}

// The "=" of a key line, outside a quoted key.
function findEquals(text) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '=') return index
  }
  return -1
}

// A simple TOML value: string, number, boolean, or an array of those.
// undefined when it is anything else (Shapewall then treats it as differing).
export function parseValue(text) {
  let index = 0
  const src = text
  const space = () => {
    for (;;) {
      while (index < src.length && /\s/.test(src[index])) index += 1
      if (src[index] === '#') {
        while (index < src.length && src[index] !== '\n') index += 1
        continue
      }
      return
    }
  }
  const value = () => {
    space()
    const rest = src.slice(index)
    let match
    if (rest.startsWith('"""') || rest.startsWith("'''")) return undefined
    if ((match = /^"((?:[^"\\\n]|\\.)*)"/.exec(rest))) {
      index += match[0].length
      try {
        return JSON.parse(`"${match[1]}"`)
      } catch {
        return undefined
      }
    }
    if ((match = /^'([^'\n]*)'/.exec(rest))) {
      index += match[0].length
      return match[1]
    }
    if ((match = /^(true|false)\b/.exec(rest))) {
      index += match[0].length
      return match[1] === 'true'
    }
    if ((match = /^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?\b/.exec(rest))) {
      index += match[0].length
      return Number(match[0].replace(/_/g, ''))
    }
    if (rest[0] === '[') {
      index += 1
      const items = []
      for (;;) {
        space()
        if (src[index] === ']') {
          index += 1
          return items
        }
        const item = value()
        if (item === undefined) return undefined
        items.push(item)
        space()
        if (src[index] === ',') index += 1
        else if (src[index] !== ']') return undefined
      }
    }
    return undefined
  }
  const result = value()
  space()
  return index === src.length ? result : undefined
}

// A value as TOML: strings in double quotes (JSON's escapes are TOML's).
export function renderValue(value) {
  if (Array.isArray(value)) return `[${value.map(renderValue).join(', ')}]`
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error(`cannot write ${typeof value} to TOML`)
}

const same = (a, b) => a.length === b.length && a.every((part, index) => part === b[index])
const startsWith = (parts, prefix) => parts.length >= prefix.length && prefix.every((part, index) => parts[index] === part)
const OURS = ['mcp_servers', SERVER]

// Where our entry is: { lines, entries: { key: { value, raw, from, to } }, header, ranges }.
// header is the line index of [mcp_servers.shapewall] or -1; ranges are
// [from, to] line spans of it and its subtables. Throws when the entry is
// written in a form Shapewall does not edit.
export function findServer(source) {
  const lines = scanToml(source)
  let header = -1
  const ranges = []
  const entries = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.kind === 'header' && startsWith(line.table, OURS)) {
      if (line.arrayTable) throw new Error(`[[${line.table.join('.')}]] is an array of tables; edit it by hand`)
      if (same(line.table, OURS)) {
        if (header !== -1) throw new Error(`[mcp_servers.${SERVER}] appears twice; edit it by hand`)
        header = index
      }
      let end = index
      while (end + 1 < lines.length && lines[end + 1].kind !== 'header') end += 1
      // Comment lines right above the next table (no blank line between) are that table's, unless it is ours too.
      const next = lines[end + 1]
      if (next && !startsWith(next.table, OURS)) {
        while (end > index && lines[end].kind === 'other' && lines[end].text.trim().startsWith('#')) end -= 1
      }
      ranges.push([index, end])
    }
    if (line.kind === 'key') {
      const full = [...line.table, ...line.key]
      const inOurs = startsWith(line.table, OURS)
      if (!inOurs && startsWith(full, OURS))
        throw new Error(`the ${SERVER} entry is written as ${line.key.join('.')} = ... under [${line.table.join('.')}]; edit it by hand`)
      if (!inOurs && full.length < OURS.length + 1 && startsWith(OURS, full) && /^\s*\{/.test(line.value))
        throw new Error(`mcp_servers is written as an inline table; edit the ${SERVER} entry by hand`)
      if (same(line.table, OURS)) {
        if (line.key.length !== 1) continue
        let to = index
        while (to + 1 < lines.length && lines[to + 1].kind === 'cont') to += 1
        const raw = lines
          .slice(index, to + 1)
          .map((item, at) => (at === 0 ? item.value : item.text))
          .join('\n')
        entries[line.key[0]] = { value: parseValue(raw), raw: raw.trim(), from: index, to }
      }
    }
  }
  return { lines, header, ranges, entries }
}

// The plain values of our entry ({ command, args, ... }), or null when there is none.
export function readServer(source) {
  const found = findServer(source)
  if (found.header === -1) return null
  return Object.fromEntries(Object.entries(found.entries).map(([key, entry]) => [key, entry.value]))
}

const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n')

// The file with our entry set: `set` keys are written (replacing their old
// line, or added after the table's last key), every other key, comment and
// subtable of the entry is kept. A file without the entry gets the table at
// its end. Checked before it is returned (checkEdit).
export function setServer(source, set) {
  const eol = eolOf(source)
  const found = findServer(source)
  const rendered = (key) => `${key} = ${renderValue(set[key])}`
  let text
  if (found.header === -1) {
    const table = [`[mcp_servers.${SERVER}]`, ...Object.keys(set).map(rendered)].join(eol)
    text = source.trim() ? `${source.replace(/(\r?\n)*$/, '')}${eol}${eol}${table}${eol}` : `${table}${eol}`
  } else {
    const lines = found.lines
    const replace = new Map()
    const missing = []
    for (const key of Object.keys(set)) {
      const entry = found.entries[key]
      if (entry) replace.set(entry.from, { to: entry.to, text: rendered(key) })
      else missing.push({ text: rendered(key), eol: '' })
    }
    // After the last key line of the table (or right after its header).
    const keyEnds = Object.values(found.entries).map((entry) => entry.to)
    const insertAfter = keyEnds.length ? Math.max(...keyEnds) : found.header
    const result = []
    for (let index = 0; index < lines.length; index += 1) {
      const change = replace.get(index)
      if (change) {
        // The new line ends as the old value's last line did.
        result.push({ text: change.text, eol: lines[change.to].eol })
        index = change.to
      } else result.push(lines[index])
      if (index === insertAfter) result.push(...missing)
    }
    text = joinLines(result, eol)
  }
  checkEdit(source, text, set)
  return text
}

// The file without our entry (its table and subtables). Unchanged when there is none.
export function removeServer(source) {
  const eol = eolOf(source)
  const found = findServer(source)
  if (!found.ranges.length) return source
  const drop = new Set()
  for (const [from, to] of found.ranges) for (let index = from; index <= to; index += 1) drop.add(index)
  const lines = found.lines
  const blank = (line) => Boolean(line) && line.kind === 'other' && line.text === ''
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    if (drop.has(index)) continue
    // One blank line where the table was, not two.
    if (blank(lines[index]) && blank(kept[kept.length - 1]) && drop.has(index - 1)) continue
    kept.push(lines[index])
  }
  while (kept.length > 1 && blank(kept[kept.length - 1]) && blank(kept[kept.length - 2])) kept.pop()
  // Only blank lines left before the removed table at the very start.
  while (kept.length && blank(kept[0]) && drop.has(0)) kept.shift()
  const text = joinLines(kept, eol)
  checkEdit(source, text, null)
  return text
}

// The lines of a file that are not our entry, without blank lines between
// tables (an edit may add or drop those).
function linesOutside(found) {
  const drop = new Set()
  for (const [from, to] of found.ranges) for (let index = from; index <= to; index += 1) drop.add(index)
  return found.lines.filter((line, index) => !drop.has(index) && !(line.kind === 'other' && !line.text.trim()))
}

// The safety net under every edit: the result is read again, every line
// outside our entry must be the line that was there, its ending included
// (only the file's last line may gain one), and our entry must hold what was
// set, or be gone. Throws, so nothing is written, when it is not so.
export function checkEdit(source, text, set) {
  const refuse = (why) => {
    throw new Error(`Shapewall could not change [mcp_servers.${SERVER}] safely (${why}); edit it by hand`)
  }
  let after
  try {
    after = findServer(text)
  } catch (error) {
    refuse(`the result does not read back: ${error.message}`)
  }
  const before = linesOutside(findServer(source))
  const now = linesOutside(after)
  if (before.length !== now.length) refuse('other lines would change')
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index]
    const b = now[index]
    if (a.text !== b.text || (a.eol && b.eol && a.eol !== b.eol)) refuse(`it would change the line ${JSON.stringify(a.text.slice(0, 80))}`)
  }
  if (set === null) {
    if (after.ranges.length) refuse('the entry is still there')
    return
  }
  if (after.header === -1) refuse('the entry is missing')
  for (const [key, value] of Object.entries(set)) {
    if (JSON.stringify(after.entries[key]?.value) !== JSON.stringify(value)) refuse(`${key} does not read back`)
  }
}

// The [mcp_servers.shapewall] table's own lines (for showing what changes).
export function serverText(source) {
  const found = findServer(source)
  if (!found.ranges.length) return ''
  const lines = found.lines.map((line) => line.text)
  return found.ranges
    .map(([from, to]) =>
      lines
        .slice(from, to + 1)
        .join('\n')
        .replace(/\n+$/, ''),
    )
    .join('\n')
}
