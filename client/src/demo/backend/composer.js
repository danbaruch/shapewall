// The demo's side of the chat composer: "@" mentions and text files checked
// like the server does (src/agent/composer.js), and the scripted agent's
// model and effort pickers. Fictional choices; nothing leaves the browser.

import { fail } from './util.js'

const TEXT_TYPES = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
}
const clip = (value, max) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function demoFiles(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > 3) fail(400, 'too_many_files', 'Attach at most 3 text files to a message.')
  return raw.map((item, index) => {
    const name = String(item?.name || `file-${index + 1}.txt`)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>/\\]/g, '')
      .slice(0, 120)
    const mediaType = TEXT_TYPES[/\.([a-z]{2,8})$/i.exec(name)?.[1]?.toLowerCase()]
    if (!mediaType || typeof item?.text !== 'string') fail(400, 'bad_file', 'Attach text files: .txt, .log, .md, .json or .csv.')
    if (item.text.includes('\u0000')) fail(400, 'bad_file', `${name} is not a text file.`)
    if (item.text.length > 100000) fail(413, 'file_too_big', 'A text file is at most 100 KB.')
    return { name, mediaType, bytes: new TextEncoder().encode(item.text).length, text: item.text }
  })
}

export function demoMentions(raw, { comments, pages, journeys }) {
  const seen = new Set()
  const out = []
  for (const item of raw) {
    let entry = null
    if (item?.kind === 'page') {
      const page = pages.find((value) => value.id === item.id)
      if (page) entry = { kind: 'page', id: page.id, label: clip(page.title, 80) }
    } else if (item?.kind === 'comment' || item?.kind === 'element') {
      const comment = comments.find((value) => value.id === Number(item.id))
      if (comment && (item.kind === 'comment' || comment.anchor)) {
        const text = item.kind === 'element' ? comment.anchor?.text || comment.anchor?.selector : comment.body
        entry = { kind: item.kind, id: comment.id, label: clip(`#${comment.id} ${text}`, 80) }
      }
    } else if (item?.kind === 'journey') {
      const journey = journeys.find((value) => value.id === item.id)
      if (journey) entry = { kind: 'journey', id: journey.id, label: clip(journey.name || journey.id, 80) }
    } else if (item?.kind === 'person') {
      const handle = String(item.id || '').toLowerCase()
      if (/^[a-z][\w.-]{0,39}$/.test(handle)) entry = { kind: 'person', id: handle, label: `@${handle}` }
    }
    if (!entry) fail(400, 'bad_mention', 'That mention is not on this board any more. Remove it and send again.')
    if (seen.has(`${entry.kind}:${entry.id}`)) continue
    seen.add(`${entry.kind}:${entry.id}`)
    out.push(entry)
  }
  return out
}

// What the demo agent's session offers, like an ACP agent's config options.
export const DEMO_OPTIONS = [
  {
    id: 'model',
    category: 'model',
    name: 'Model',
    currentValue: 'scripted',
    values: [
      { value: 'scripted', name: 'Scripted' },
      { value: 'scripted-thorough', name: 'Thorough' },
    ],
  },
  {
    id: 'effort',
    category: 'thought_level',
    name: 'Effort',
    currentValue: 'medium',
    values: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]
