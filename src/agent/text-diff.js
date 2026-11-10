// A small line diff for approval cards: when an agent asks to edit or write
// a file, the card shows what changes, not just the file name. Computed on
// the server from the old and the new text, and bounded both ways: a short
// preview the card shows at once, and a longer (still bounded) full diff
// behind "Show the whole diff".
//
// (src/diff.js is the pixel diff between captures; this is plain text.)
//
// Every line goes through showableLine(): control, zero-width and
// bidirectional characters are shown as escapes, so the card shows what the
// file will hold. A line too long for the preview is cut with a visible
// marker that gives its length, and the whole diff shows it in full (up to
// LINE_FULL_MAX, marked the same way beyond that). Nothing is cut silently.

import { showable, showableLine } from './showable.js'

export const DIFF_PREVIEW_LINES = 80
export const DIFF_PREVIEW_BYTES = 8 * 1024
export const DIFF_FULL_LINES = 1500
export const DIFF_FULL_BYTES = 64 * 1024
const CONTEXT = 3
// The LCS table is (old lines x new lines) after the common start and end
// are cut; beyond this the changed block is shown as removed then added.
const LCS_CELLS_MAX = 4_000_000
export const LINE_PREVIEW_MAX = 400
export const LINE_FULL_MAX = 16 * 1024

const splitLines = (text) => {
  const value = String(text ?? '')
  if (!value) return []
  const lines = value.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// The edit script between two lists of lines: [{ op: ' ' | '-' | '+', text }].
function editScript(a, b) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const out = a.slice(0, start).map((text) => ({ op: ' ', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > LCS_CELLS_MAX) {
    for (const text of midA) out.push({ op: '-', text })
    for (const text of midB) out.push({ op: '+', text })
  } else {
    // Longest common subsequence, filled from the end so the walk goes forward.
    const n = midA.length
    const m = midB.length
    const width = m + 1
    const table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ op: ' ', text: midA[i] })
        i += 1
        j += 1
      } else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        // Removed lines first, then the added ones, like `diff -u`.
        out.push({ op: '-', text: midA[i] })
        i += 1
      } else {
        out.push({ op: '+', text: midB[j] })
        j += 1
      }
    }
  }
  for (const text of a.slice(endA)) out.push({ op: ' ', text })
  return out
}

// Unified diff lines (hunks with CONTEXT lines around each change), and the counts.
export function lineDiff(oldText, newText) {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const script = editScript(a, b)
  const added = script.filter((item) => item.op === '+').length
  const removed = script.filter((item) => item.op === '-').length
  const keep = new Uint8Array(script.length)
  script.forEach((item, index) => {
    if (item.op === ' ') return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(script.length - 1, index + CONTEXT); k += 1) keep[k] = 1
  })
  const lines = []
  let lineA = 1
  let lineB = 1
  let inHunk = false
  script.forEach((item, index) => {
    if (keep[index]) {
      if (!inHunk) {
        // The hunk header: where it starts in the old and the new file.
        lines.push(`@@ -${lineA} +${lineB} @@`)
        inHunk = true
      }
      lines.push(`${item.op}${showableLine(item.text)}`)
    } else inHunk = false
    if (item.op !== '+') lineA += 1
    if (item.op !== '-') lineB += 1
  })
  return { lines, added, removed }
}

// A line cut to `max` characters, with a marker that says so and how long it is.
export function clipLine(line, max) {
  if (line.length <= max) return { line, clipped: false }
  return { line: `${line.slice(0, max)}… [line cut: ${line.length} characters in all]`, clipped: true }
}

// Joins lines until either bound is reached. { text, cut }
function bounded(lines, maxLines, maxBytes) {
  const out = []
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1
    if (out.length >= maxLines || bytes + size > maxBytes) return { text: out.join('\n'), cut: true }
    out.push(line)
    bytes += size
  }
  return { text: out.join('\n'), cut: false }
}

// What an approval card carries: { path, added, removed, preview, full,
// truncated, created, outside }. `outside`: a file outside the project. `full` is null when the preview is already all of
// it; `truncated` says even the full diff was cut. `oldText` null: a new file.
export function diffForCard(file, oldText, newText) {
  return diffForFiles([{ path: file, oldText, newText }])
}

// The same for several files (an edit that touches more than one): each
// file's hunks under a "--- path" line. null when there is nothing to show.
export function diffForFiles(files) {
  const list = files.filter((item) => item && (typeof item.newText === 'string' || typeof item.oldText === 'string'))
  if (!list.length) return null
  const lines = []
  let added = 0
  let removed = 0
  for (const item of list) {
    const result = lineDiff(item.oldText ?? '', item.newText ?? '')
    if (list.length > 1) lines.push(`--- ${showable(item.path || 'file')}${item.outside ? ' (outside the project)' : ''}`)
    lines.push(...result.lines)
    added += result.added
    removed += result.removed
  }
  const file = list.length === 1 ? list[0].path : `${list.length} files`
  const created = list.length === 1 && (list[0].oldText === null || list[0].oldText === undefined)
  const outside = list.some((item) => item.outside === true)
  return cardShape(file, lines, added, removed, created, outside)
}

function cardShape(file, lines, added, removed, created, outside) {
  const short = lines.map((line) => clipLine(line, LINE_PREVIEW_MAX))
  const preview = bounded(
    short.map((item) => item.line),
    DIFF_PREVIEW_LINES,
    DIFF_PREVIEW_BYTES,
  )
  // A line cut in the preview is shown whole behind "Show the whole diff".
  const shown = preview.text ? preview.text.split('\n').length : 0
  const clipped = short.slice(0, shown).some((item) => item.clipped)
  const full =
    preview.cut || clipped
      ? bounded(
          lines.map((line) => clipLine(line, LINE_FULL_MAX).line),
          DIFF_FULL_LINES,
          DIFF_FULL_BYTES,
        )
      : null
  return {
    path: file ? showable(String(file)).slice(0, 300) : null,
    added,
    removed,
    created,
    outside,
    preview: preview.text,
    full: full ? full.text : null,
    truncated: Boolean(full?.cut),
  }
}

// A diff from a card event, checked and bounded again (it is stored in the thread).
export function cleanCardDiff(diff) {
  if (!diff || typeof diff !== 'object' || typeof diff.preview !== 'string') return null
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
  // Escaping again changes nothing in a diff made here (an escape is plain
  // text); the +60 leaves room for the cut marker.
  const lines = (text, max) => text.split('\n').map((line) => clipLine(showableLine(line), max + 60).line)
  return {
    path: typeof diff.path === 'string' ? showable(diff.path).slice(0, 300) : null,
    added: count(diff.added),
    removed: count(diff.removed),
    created: diff.created === true,
    outside: diff.outside === true,
    preview: bounded(lines(diff.preview, LINE_PREVIEW_MAX), DIFF_PREVIEW_LINES, DIFF_PREVIEW_BYTES).text,
    full: typeof diff.full === 'string' ? bounded(lines(diff.full, LINE_FULL_MAX), DIFF_FULL_LINES, DIFF_FULL_BYTES).text : null,
    truncated: diff.truncated === true,
  }
}
