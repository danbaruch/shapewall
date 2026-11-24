// Freezes a live HTML snapshot to the preferences it was captured with. The
// board opens the snapshot in the viewer's browser, so a site's
// `@media (prefers-color-scheme: dark)` rules would follow the viewer, not
// the capture, and the live view would stop matching its own screenshot.
// Here media queries are rewritten at capture time: a condition on a
// resolved feature that matched becomes always true, one that did not
// becomes never true. Only `prefers-color-scheme` and (when the capture
// forced it) `prefers-reduced-motion` are resolved; every other feature, and
// any query that cannot be parsed safely, is left exactly as written.
//
// `env` is { colorScheme: 'light' | 'dark', reducedMotion?: 'reduce' |
// 'no-preference' }. A missing value is not resolved.

const TRUE = { kind: 'true' }
const FALSE = { kind: 'false' }
const expr = (text) => ({ kind: 'expr', text })
const MAX_PRELUDE = 4000

const RESOLVED = {
  'prefers-color-scheme': { key: 'colorScheme', values: ['light', 'dark'] },
  'prefers-reduced-motion': { key: 'reducedMotion', values: ['reduce', 'no-preference'] },
}

// `(name: value)` for a resolved feature: true or false; anything else
// (other features, range syntax, the boolean form, unknown values): null.
function featureTruth(inner, env) {
  const match = /^\s*([a-zA-Z-]+)\s*:\s*([a-zA-Z-]+)\s*$/.exec(inner)
  if (!match) return null
  const feature = RESOLVED[match[1].toLowerCase()]
  if (!feature) return null
  const want = env?.[feature.key]
  const value = match[2].toLowerCase()
  if (!feature.values.includes(want) || !feature.values.includes(value)) return null
  return value === want
}

// The index of the `)` closing the `(` at `open`, honouring nested parens and
// strings; -1 when it is not closed.
function closingParen(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, i + 1)
      if (end === -1) return -1
      i = end
    } else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

// Words and balanced (...) groups; null for anything else (a stray
// character, a comment, an unclosed paren), which leaves the query as is.
function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (/\s/.test(char)) i += 1
    else if (char === '(') {
      const close = closingParen(text, i)
      if (close === -1) return null
      tokens.push({ group: true, raw: text.slice(i, close + 1), inner: text.slice(i + 1, close) })
      i = close + 1
    } else {
      const word = /^[a-zA-Z_-][a-zA-Z0-9_-]*/.exec(text.slice(i, i + 200))
      if (!word) return null
      tokens.push({ word: word[0], lower: word[0].toLowerCase() })
      i += word[0].length
    }
  }
  return tokens
}

// <media-in-parens>: a nested condition or a feature (kept opaque).
function inParens(token, env, state) {
  const inner = token.inner.trim()
  if (inner.startsWith('(') || /^not\s*\(/i.test(inner)) {
    const tokens = tokenize(inner)
    const node = tokens && condition(tokens, env, state, true)
    if (!node) return null
    if (node.kind !== 'expr') return node
    return expr(`(${node.text})`)
  }
  const truth = featureTruth(inner, env)
  if (truth === null) return expr(token.raw)
  state.changed = true
  return truth ? TRUE : FALSE
}

// <media-condition> (allowOr) or <media-condition-without-or>, the whole of
// `tokens`. Returns TRUE, FALSE, an expr, or null when it does not parse.
function condition(tokens, env, state, allowOr) {
  if (!tokens.length) return null
  if (tokens[0].lower === 'not') {
    if (tokens.length !== 2 || !tokens[1].group) return null
    const child = inParens(tokens[1], env, state)
    if (!child) return null
    if (child.kind === 'true') return FALSE
    if (child.kind === 'false') return TRUE
    return expr(`not ${child.text}`)
  }
  if (!tokens[0].group || tokens.length % 2 === 0) return null
  const op = tokens.length > 1 ? tokens[1].lower : 'and'
  if (op !== 'and' && !(allowOr && op === 'or')) return null
  const parts = []
  for (let i = 0; i < tokens.length; i += 2) {
    if (!tokens[i].group || (i > 0 && tokens[i - 1].lower !== op)) return null
    const part = inParens(tokens[i], env, state)
    if (!part) return null
    parts.push(part)
  }
  const decisive = op === 'and' ? 'false' : 'true'
  if (parts.some((part) => part.kind === decisive)) return decisive === 'true' ? TRUE : FALSE
  const left = parts.filter((part) => part.kind === 'expr')
  if (!left.length) return op === 'and' ? TRUE : FALSE
  return expr(left.map((part) => part.text).join(` ${op} `))
}

// One <media-query> (no top-level commas): TRUE, FALSE, its new text, or
// null when it does not parse.
function query(text, env, state) {
  const tokens = tokenize(text)
  if (!tokens || !tokens.length) return null
  const first = tokens[0]
  if (first.group || (first.lower === 'not' && tokens[1]?.group)) {
    const node = condition(tokens, env, state, true)
    if (!node) return null
    return node.kind === 'expr' ? expr(node.text) : node
  }
  // [not | only] <media-type> [and <media-condition-without-or>]
  let index = 0
  let prefix = ''
  if (first.lower === 'not' || first.lower === 'only') {
    prefix = first.lower
    index = 1
  }
  const type = tokens[index]
  if (!type?.word || ['and', 'or', 'not', 'only'].includes(type.lower)) return null
  index += 1
  let rest = TRUE
  if (index < tokens.length) {
    if (tokens[index].lower !== 'and') return null
    rest = condition(tokens.slice(index + 1), env, state, false)
    if (!rest) return null
  }
  const negate = prefix === 'not'
  if (rest.kind === 'false') return negate ? TRUE : FALSE
  if (rest.kind === 'true' && type.lower === 'all') return negate ? FALSE : TRUE
  const head = `${prefix ? `${prefix} ` : ''}${type.word}`
  return expr(rest.kind === 'true' ? head : `${head} and ${rest.text}`)
}

// Top-level comma split (not inside parens or strings).
function splitList(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, i + 1)
      if (end === -1) return null
      i = end
    } else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

// A media query list, as in `@media <list> {`, `<link media="<list>">` or a
// CSSOM mediaText. Returns the rewritten list ('all' when it always matches,
// 'not all' when it never does), or the text unchanged when nothing in it
// is resolved or it cannot be parsed safely.
export function resolveMediaList(text, env) {
  const source = String(text ?? '')
  if (!source.trim() || source.length > MAX_PRELUDE || !/prefers-/i.test(source)) return source
  const parts = splitList(source)
  if (!parts) return source
  const state = { changed: false }
  const results = []
  for (const part of parts) {
    // An unparsable query stays as written (browsers treat it as not all).
    results.push(query(part, env, state) || expr(part.trim()))
  }
  if (!state.changed) return source
  if (results.some((result) => result.kind === 'true')) return 'all'
  const left = results.filter((result) => result.kind === 'expr')
  return left.length ? left.map((result) => result.text).join(', ') : 'not all'
}

// Every `@media` prelude and `@import ... <media>` in a stylesheet, nested
// ones included (inside @supports, @layer, other @media). One pass; strings
// and comments are skipped.
export function resolveMediaInCss(css, env) {
  const text = String(css ?? '')
  if (!/prefers-/i.test(text)) return text
  let out = ''
  let last = 0
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (char === '"' || char === "'") {
      i = skipString(text, i)
      continue
    }
    if (char === '@') {
      const name = /^@(media|import)(?![a-zA-Z0-9_-])/i.exec(text.slice(i, i + 8))
      if (name) {
        const start = i + name[0].length
        const end = preludeEnd(text, start)
        if (end === -1) break
        const prelude = text.slice(start, end)
        const rewritten = name[1].toLowerCase() === 'media' ? rewriteMediaPrelude(prelude, env) : rewriteImportPrelude(prelude, env)
        if (rewritten !== prelude) {
          out += text.slice(last, start) + rewritten
          last = end
        }
        i = end
        continue
      }
    }
    i += 1
  }
  return out + text.slice(last)
}

function skipString(text, open) {
  const quote = text[open]
  let i = open + 1
  while (i < text.length && text[i] !== quote && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
  return i + 1
}

// The `{` or `;` that ends an at-rule prelude starting at `start`, or -1.
function preludeEnd(text, start) {
  let depth = 0
  let i = start
  while (i < text.length) {
    const char = text[i]
    if (char === '"' || char === "'") {
      i = skipString(text, i)
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 2
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if ((char === '{' || char === ';' || char === '}') && depth === 0) return i
    i += 1
  }
  return -1
}

function rewriteMediaPrelude(prelude, env) {
  if (prelude.includes('/*')) return prelude
  const resolved = resolveMediaList(prelude, env)
  return resolved === prelude ? prelude : ` ${resolved} `
}

// `@import <url> [layer[(...)]] [supports(...)] <media-list>`.
function rewriteImportPrelude(prelude, env) {
  if (prelude.includes('/*')) return prelude
  const head = /^\s*(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)'"\s]*)\s*\)|"[^"]*"|'[^']*')\s*/i.exec(prelude)
  if (!head) return prelude
  let index = head[0].length
  const layer = /^layer(?![a-zA-Z0-9_-])\s*/i.exec(prelude.slice(index))
  if (layer) {
    index += layer[0].length
    if (prelude[index] === '(') {
      const close = closingParen(prelude, index)
      if (close === -1) return prelude
      index = close + 1
    }
    index += /^\s*/.exec(prelude.slice(index))[0].length
  }
  if (/^supports\(/i.test(prelude.slice(index))) {
    const close = closingParen(prelude, index + 'supports'.length)
    if (close === -1) return prelude
    index = close + 1
    index += /^\s*/.exec(prelude.slice(index))[0].length
  }
  const media = prelude.slice(index)
  if (!media.trim()) return prelude
  const resolved = resolveMediaList(media, env)
  return resolved === media ? prelude : `${prelude.slice(0, index)}${resolved}`
}

// The `color-scheme` the snapshot root is pinned to, so form controls,
// scrollbars and the canvas match the capture: the captured scheme when the
// root supports it ('normal' supports only light), else the one it declared.
export function pinnedColorScheme(rootValue, captured = 'light') {
  const words = String(rootValue || 'normal')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word === 'light' || word === 'dark')
  if (!words.length) return 'light'
  return words.includes(captured) ? captured : words[0]
}
