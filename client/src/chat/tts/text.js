// Text for the natural voice: sentences to speak one at a time (so the first
// one plays while the rest are still being made), each short enough for the
// model, with file names and code-ish words made speakable.

// Kokoro reads at most 510 phoneme tokens per call; English runs a little
// over one phoneme per character, so chunks stay well under that.
export const CHUNK_MAX = 220
// The first piece is made before anything plays, so a long first sentence
// is cut at its first comma (or colon, semicolon, dash) once it has some
// words, which halves the wait for the first sound.
export const FIRST_MAX = 80

const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|Jr|Sr|No|approx|incl|Inc|Ltd|Co)\.$/i

// "word.ext" and "Node.js": how they are said.
const EXTENSIONS = {
  js: 'J S',
  jsx: 'J S X',
  mjs: 'M J S',
  cjs: 'C J S',
  ts: 'T S',
  tsx: 'T S X',
  json: 'JSON',
  md: 'M D',
  css: 'CSS',
  html: 'HTML',
  yml: 'YAML',
  yaml: 'YAML',
  py: 'P Y',
  sh: 'S H',
  txt: 'text',
  png: 'PNG',
  svg: 'SVG',
}

export function speakable(text) {
  return String(text || '')
    .replace(/\b(Node|Next|Nuxt|Vue|Deno|Express|Three|D3)\.js\b/g, '$1 J S')
    .replace(/\b([\p{L}\p{N}_-]+)\.([a-z]{2,4})\b/gu, (match, name, ext) => (EXTENSIONS[ext] ? `${name} dot ${EXTENSIONS[ext]}` : match))
    .replace(/[_/\\]+(?=\p{L})/gu, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .trim()
}

// Sentences, in order. A sentence ends at . ! ? or … followed by a space and
// not after a known abbreviation or a single initial; a line break always
// ends one (list items and headings rarely end with a full stop).
export function splitSentences(text) {
  const out = []
  for (const line of String(text || '').split(/\n+/)) {
    const value = line.replace(/\s+/g, ' ').trim()
    if (!value) continue
    let start = 0
    const re = /[.!?…]+["”’)\]]*(?=\s|$)/g
    let match
    while ((match = re.exec(value))) {
      const end = match.index + match[0].length
      const before = value.slice(start, end)
      if (ABBREVIATIONS.test(before) || /(?:^|\s)\p{Lu}\.$/u.test(before)) continue
      const sentence = before.trim()
      if (sentence) out.push(sentence)
      start = end
    }
    const rest = value.slice(start).trim()
    if (rest) out.push(rest)
  }
  const pieces = out.flatMap((sentence) => chunk(sentence))
  if (pieces[0]?.length > FIRST_MAX) {
    const cut = /^.{20,}?[,;:—–](?=\s)/.exec(pieces[0].slice(0, FIRST_MAX + 1))
    if (cut) pieces.splice(0, 1, cut[0], pieces[0].slice(cut[0].length).trim())
  }
  return pieces
}

// A sentence longer than CHUNK_MAX splits at a comma, semicolon, colon or
// dash near the middle, else at a space; never inside a word.
export function chunk(sentence, max = CHUNK_MAX) {
  const value = sentence.trim()
  if (value.length <= max) return value ? [value] : []
  const window = value.slice(0, max)
  let cut = -1
  for (const re of [/[;:—–]\s/g, /,\s/g, /\s-\s/g]) {
    let match
    while ((match = re.exec(window))) if (match.index > max * 0.3) cut = match.index + 1
    if (cut > 0) break
  }
  if (cut < 0) cut = window.lastIndexOf(' ')
  if (cut <= 0) cut = max
  return [value.slice(0, cut).trim(), ...chunk(value.slice(cut), max)].filter(Boolean)
}
