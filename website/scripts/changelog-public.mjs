// The /changelog page shows CHANGELOG.md as it is, minus what only matters to the people who build and deploy
// shapewall.com itself: the marketing site's own changes, its deploy and telemetry settings, internal project stages and
// database migration numbers. CHANGELOG.md is not edited; this runs on each version's markdown at build time
// (scripts/markdown.mjs, renderChangelog). Plain functions, so test/changelog-public.test.js can check them.

// A whole bullet or paragraph is dropped when it starts with one of these.
const DROP_BLOCK = [
  /^(\*\*Website\b|Website( contact page)?:)/, // "Website: ...", "**Website privacy page ...**", "Website contact page: ..."
  /^Videos on the website\b/,
]

// A sentence is dropped wherever it appears when it matches one of these.
const DROP_SENTENCE = [
  /\bwebsite deployments?\b/i,
  /\bSSH destination\b/,
  /\btelemetry endpoint\b/i,
  /\bOur own deployments\b/,
  /\bThe website states\b/,
]

// Wording swapped in place.
const REWRITE = [
  [/^Fixes from a full code review:\s*/m, 'Fixes: '],
  [/^### After the security review$/m, '### Security fixes'],
  [/\bConnected agents, stage [A-Z]: (\w)/g, (all, first) => first.toUpperCase()],
  [/\s+and website deployment\b/g, ''],
  [/\[Migration \d+ and rollback\]/g, '[upgrade and rollback notes]'],
  [/\(migration \d+, /g, '('],
  [/\bMigration \d+\b/g, 'The upgrade'],
  [/\bmigration \d+\b/g, 'the upgrade'],
]

// Splits markdown into blocks: a top-level bullet with its indented continuation lines, a paragraph, a heading, a fenced
// code block, or blank lines.
function blocks(markdown) {
  const out = []
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const start = i
      while (++i < lines.length && !lines[i].startsWith('```'));
      out.push({ kind: 'code', text: lines.slice(start, i + 1).join('\n') })
    } else if (/^#{1,6} /.test(line)) out.push({ kind: 'heading', text: line })
    else if (!line.trim()) out.push({ kind: 'blank', text: line })
    else {
      const bullet = /^[-*] /.test(line)
      const body = [line]
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (!next.trim() || /^#{1,6} /.test(next) || next.startsWith('```')) break
        if (/^[-*] /.test(next)) break
        if (bullet && !/^\s/.test(next)) break
        body.push(next)
        i++
      }
      out.push({ kind: bullet ? 'bullet' : 'paragraph', text: body.join('\n') })
    }
  }
  return out
}

// "Hosted restore closes uploads. Website deployments read the SSH destination." -> "Hosted restore closes uploads."
// Sentences end at ". " or a final "."; inline code and links are not split inside (good enough for this changelog).
function dropSentences(text) {
  if (!DROP_SENTENCE.some((re) => re.test(text))) return text
  const prefix = /^[-*] /.exec(text)?.[0] || ''
  const body = text.slice(prefix.length)
  const sentences = body.split(/(?<=\.)\s+(?=[A-Z*`[])/)
  const kept = sentences.filter((sentence) => !DROP_SENTENCE.some((re) => re.test(sentence)))
  return kept.length ? prefix + kept.join(' ') : ''
}

export function publicChangelogEntry(markdown) {
  let text = markdown
  for (const [re, to] of REWRITE) text = text.replace(re, to)
  const kept = []
  for (const block of blocks(text)) {
    if (block.kind === 'bullet' || block.kind === 'paragraph') {
      const plain = block.text.replace(/^[-*] /, '')
      if (DROP_BLOCK.some((re) => re.test(plain))) continue
      const cleaned = dropSentences(block.text)
      if (!cleaned.trim()) continue
      kept.push({ ...block, text: cleaned })
    } else kept.push(block)
  }
  // A ### heading left with nothing under it goes too.
  const result = kept.filter((block, index) => {
    if (block.kind !== 'heading' || !block.text.startsWith('### ')) return true
    const rest = kept.slice(index + 1)
    const next = rest.find((item) => item.kind !== 'blank')
    return next && next.kind !== 'heading'
  })
  return result
    .map((block) => block.text)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
