// Streaming prose, without the flicker. Pure helpers for the chat's live
// reply (no React, no DOM), so node tests can import them:
//
// - streamingMarkdown(text): what to render while an answer is still being
//   written. A half-typed "**bold" would show its asterisks until the closing
//   pair arrived and then jump to bold; a half table row would render as a
//   paragraph and then turn into a table. This closes open inline markers and
//   holds back a trailing line that is not a block yet, so each frame shows a
//   prefix of what the finished answer will look like.
// - revealLength(shown, target, ms): how much of the received text to show
//   after `ms` more milliseconds, so bursty providers still read smoothly.
// - createFrameBatcher(flush): coalesces many stream events into one update
//   per animation frame.

const FENCE = /^\s*(```|~~~)/
const isTableRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
const startsRow = (line) => /^\s*\|/.test(line)

// The open inline markers of a paragraph, outermost first: [{ marker, index }].
function openMarkers(tail) {
  const open = []
  // Code spans hold no markup; take them out of the count (same length, so indexes stay).
  const plain = tail.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
  const tick = plain.indexOf('`')
  if (tick >= 0) return [{ marker: '`', index: tick }]
  const re = /\*\*|~~|\*/g
  let match
  while ((match = re.exec(plain))) {
    const marker = match[0]
    // A list bullet ("* item") at a line start is not emphasis.
    if (marker === '*' && /(^|\n)\s*$/.test(plain.slice(0, match.index)) && plain[match.index + 1] === ' ') continue
    const last = open.findLastIndex((item) => item.marker === marker)
    if (last >= 0) open.splice(last, 1)
    else open.push({ marker, index: match.index })
  }
  return open
}

export function streamingMarkdown(source) {
  const lines = String(source || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  let fence = null
  for (const line of lines) {
    const match = FENCE.exec(line)
    if (!match) continue
    if (!fence) fence = match[1]
    else if (line.trim().startsWith(fence)) fence = null
  }
  // Inside an open code fence: it renders as code already (Markdown.jsx).
  // Only a half-typed closing fence is held back.
  if (fence) {
    if (/^\s*[`~]{1,2}\s*$/.test(lines.at(-1)) && lines.length > 1) lines.pop()
    return lines.join('\n')
  }
  // A trailing line that is only the start of a block: a bullet, a number, a
  // heading's hashes, a quote mark, or the first backticks of a fence.
  if (/^\s*([-*+]|\d{1,9}[.)]|#{1,6}|>|`{1,3}|~{1,3})\s*$/.test(lines.at(-1)) && lines.at(-1).trim()) lines.pop()
  // A bare number on a new line may be the start of "1." (alone, it is just a number).
  else if (lines.length > 1 && /^\s*\d{1,9}$/.test(lines.at(-1))) lines.pop()
  // A table: rows wait for the rule under the header, and a row for its closing bar.
  // (A row just finished leaves an empty line after it.)
  const end = lines.length > 1 && !lines.at(-1) ? lines.length - 1 : lines.length
  let start = end
  while (start > 0 && startsRow(lines[start - 1])) start -= 1
  if (start < end) {
    const confirmed = end - start >= 2 && isTableRule(lines[start + 1])
    if (!confirmed) lines.splice(start)
    // A half body row waits; the rule line already makes the table.
    else if (end - 1 > start + 1 && !/\|\s*$/.test(lines[end - 1])) lines.splice(end - 1)
  }
  let text = lines.join('\n')
  // Inline markers: only within the last paragraph.
  const cut = text.lastIndexOf('\n\n') + 1
  let tail = text.slice(cut)
  // A link still being typed shows its label only.
  tail = tail.replace(/\[([^\]\n]*)\]\([^)\s]*$/, '$1').replace(/\[([^\]\n[]*)$/, '$1')
  const open = openMarkers(tail)
  let closers = ''
  // Close the innermost first; a marker with nothing after it yet is dropped.
  for (const { marker, index } of open.reverse()) {
    if (!tail.slice(index + marker.length).trim()) tail = tail.slice(0, index) + tail.slice(index + marker.length)
    else closers += marker
  }
  // Emphasis cannot end on a space ("*word *" is not italic): close before it.
  const trailing = /\s*$/.exec(tail)[0]
  text = text.slice(0, cut) + tail.slice(0, tail.length - trailing.length) + closers + (closers ? '' : trailing)
  return text
}

// Shows the backlog in about a quarter of a second, at least two characters a
// frame, never splitting a surrogate pair. Restarts when the text is replaced.
export const REVEAL_MS = 240
export function revealLength(shown, target, ms) {
  if (shown >= target.length) return target.length
  const backlog = target.length - shown
  let next = shown + Math.max(2, Math.ceil((backlog * Math.max(ms, 0)) / REVEAL_MS))
  if (next >= target.length) return target.length
  const code = target.charCodeAt(next - 1)
  if (code >= 0xd800 && code <= 0xdbff) next += 1
  return next
}

// One flush per frame for `queue()`, at once for `now()`. `schedule` and
// `cancel` default to requestAnimationFrame (tests pass their own).
export function createFrameBatcher(flush, { schedule, cancel } = {}) {
  const raf = schedule || globalThis.requestAnimationFrame?.bind(globalThis) || ((fn) => setTimeout(fn, 16))
  const unraf = cancel || globalThis.cancelAnimationFrame?.bind(globalThis) || clearTimeout
  let handle = null
  const run = () => {
    handle = null
    flush()
  }
  return {
    queue() {
      if (handle === null) handle = raf(run)
    },
    now() {
      if (handle !== null) unraf(handle)
      run()
    },
    cancel() {
      if (handle !== null) unraf(handle)
      handle = null
    },
  }
}
