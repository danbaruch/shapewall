// The letters an avatar shows for a name. Only letters and digits count (any
// script): "Scout (workbench)" is Scout + workbench, and a word with none of
// them, such as an emoji or "-", is skipped.
const LETTER = /[\p{L}\p{N}]/gu

// The name's words, each cut down to its letters and digits; words with none
// are dropped.
export function nameWords(name) {
  return String(name || '')
    .split(/\s+/)
    .map((word) => (word.match(LETTER) || []).join(''))
    .filter(Boolean)
}

// A person's initials: the first letter of the first and last word ("Ada
// Lovelace" AL, "Mary Ann Smith" MS), one letter for one word, "?" for none.
export function initials(name) {
  const words = nameWords(String(name || '').replace(/\(guest\)/i, ''))
  if (!words.length) return '?'
  const first = Array.from(words[0])[0]
  const last = words.length > 1 ? Array.from(words.at(-1))[0] : ''
  return (first + last).toUpperCase()
}

// Two letters for an agent without an icon: the initials of its first two
// words ("Claude Code" CC, "Scout (workbench)" SW), else its first two
// letters ("Codex" Co, "goose" Go).
export function monogram(label) {
  const words = nameWords(label)
  if (!words.length) return '?'
  if (words.length > 1) return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase()
  const [first, second = ''] = Array.from(words[0])
  return first.toUpperCase() + second.toLowerCase()
}
