// An agent's answer as text a person reads: reference tokens ([[comment:16]],
// [[page:home]], client/src/chat/refs.js) become words, and for one-line
// previews (search snippets, the Console's feedback list) the Markdown marks
// go too. Shared by the server (search snippets) and the board (Copy, Copy as
// Markdown, Download .md, previews). Pure, no DOM.

const TOKEN_ANY = /\[\[([a-z]+):([^\]\n]{1,120})\]\]/g

// The default words for a token when the board's own name for it is not at
// hand: "comment #16", "home page", "checks for pricing", or the id.
export function tokenWords(kind, id) {
  const value = String(id || '').trim()
  if (kind === 'comment') return /^#?\d{1,9}$/.test(value) ? `comment #${value.replace(/^#/, '')}` : `comment ${value}`
  if (kind === 'page') return `${value} page`
  if (kind === 'journey') return `${value} journey`
  if (kind === 'check') return `checks for ${value}`
  return value
}

// Every token as words. `label(kind, id)` may give a better name (the page's
// title, from the board); null falls back to tokenWords. Other Markdown stays.
export function tokensToText(text, label = null) {
  return String(text || '').replace(TOKEN_ANY, (_, kind, id) => (label && label(kind, id)) || tokenWords(kind, id))
}

// Markdown to plain text for a preview: tokens as words, then no emphasis,
// code marks, headings, quotes, list bullets, link targets or table pipes.
// Keeps the words; good enough for a snippet, not a renderer.
export function markdownToPlain(text, label = null) {
  return (
    tokensToText(text, label)
      // Half a token cut off at a snippet's edge.
      .replace(/^[^[\]]{0,120}\]\]/, '')
      .replace(/\[\[[^\]]{0,120}$/, '')
      .replace(/```[^\n]*\n?/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/`/g, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/\*\*|__/g, '')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/^[ \t]*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, '')
      .replace(/[ \t]*\|[ \t]*/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
  )
}
