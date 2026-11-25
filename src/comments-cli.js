// `shapewall comments add`, `comments selectors`, `comments get` and
// `comments --since`: what a shell-only agent or a chat bot needs besides
// list, reply and status.
//
// add goes through the same store function the board uses (validation,
// events, mentions, capture version). Without --selector the pin sits near
// the page's top-left corner; with one, it is anchored to that element.
// When the selector finds exactly one element in the latest capture's
// element map (src/capture/element-map.js), the pin sits in the middle of
// that element, stored as a click there on the board would store it. A
// capture without a map (an older one) still gives the element's text, read
// from the live HTML.

import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'parse5'
import { matchSelectorAll, parseElementMap, resolveOnMap, selectorOf } from './capture/element-map.js'
import {
  boardRef,
  commentJson,
  feedbackContext,
  feedbackItem,
  formatFeedbackItem,
  formatFeedbackItemForAgent,
  untrustedJson,
} from './feedback.js'
import { ANCHOR_SELECTOR_RE, ANCHOR_TEXT_MAX, CommentError, createComment, getComment, resolveFile } from './store.js'
import { boardViewports, noPageMessage } from './config.js'
import { localUserName, runByAgent } from './server/local-user.js'

// Who a comment, reply or status change is from when --author is not given:
// the person at this machine (SHAPEWALL_USER_NAME, git user.name, else the OS
// user name), the name the board served to this machine offers too. Inside
// an agent's run (the command `watch --exec` starts, the board's own agent)
// it is "agent", so the starter agent never acts on an agent's own text
// (docs/starter-agent.md). "agent" too when there is no user name to read.
export const AGENT_AUTHOR = 'agent'
export const cliAuthor = (env = process.env, { dir = process.cwd(), user = localUserName } = {}) =>
  runByAgent(env) ? AGENT_AUTHOR : user(dir, env) || AGENT_AUTHOR
// Where a pin without --selector sits: near the top-left corner, in percent of the page.
export const DEFAULT_PIN = { x: 2, y: 2 }

export const authorFlag = (flags, { dir = process.cwd(), env = process.env } = {}) =>
  typeof flags.author === 'string' && flags.author.trim() ? flags.author : cliAuthor(env, { dir })

// --since: a comment id (newer comments) or a time (comments created or
// changed after it). Returns a filter for feedback items or store comments.
export function sinceFilter(value) {
  if (value === undefined) return null
  const text = String(value).trim()
  if (/^[0-9]+$/.test(text)) {
    const id = Number(text)
    return (comment) => comment.id > id
  }
  const time = /^\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : NaN
  if (!Number.isFinite(time)) throw new Error('--since needs a comment id (e.g. 12) or an ISO time (e.g. 2026-11-05T18:00:00Z)')
  // updatedAt moves with every change (a reply, a status), so it covers "created after" too.
  return (comment) => Date.parse(comment.updatedAt || comment.createdAt || '') > time
}

// ---- Anchor text from the live HTML ---------------------------------------------
// The anchor grammar (store.js ANCHOR_SELECTOR_RE): steps `#id`,
// `tag[data-testid="..."]`, `tag[aria-label="..."]`, `tag:nth-of-type(n)`,
// joined by ` > `. The first step may match anywhere, the rest are children.

const IDENT_CHAR = /[A-Za-z0-9_\u0080-￿-]/

function parseSteps(selector) {
  const steps = []
  let index = 0
  const fail = () => {
    throw new Error('not an anchor selector')
  }
  while (index < selector.length) {
    if (selector[index] === '#') {
      let id = ''
      index += 1
      while (index < selector.length) {
        const char = selector[index]
        if (char === '\\') {
          const hex = /^[0-9a-fA-F]{1,6} ?/.exec(selector.slice(index + 1))
          if (hex) {
            id += String.fromCodePoint(parseInt(hex[0].trim(), 16))
            index += 1 + hex[0].length
          } else {
            id += selector[index + 1] ?? ''
            index += 2
          }
        } else if (IDENT_CHAR.test(char)) {
          id += char
          index += 1
        } else break
      }
      if (!id) fail()
      steps.push({ id })
    } else {
      const tag = /^[a-z][a-z0-9-]{0,40}/.exec(selector.slice(index))
      if (!tag) fail()
      index += tag[0].length
      const rest = selector.slice(index)
      const nth = /^:nth-of-type\(([1-9][0-9]{0,4})\)/.exec(rest)
      const attr = /^\[(data-testid|aria-label)="((?:[^"\\\n]|\\.){0,200})"\]/.exec(rest)
      if (nth) {
        steps.push({ tag: tag[0], nth: Number(nth[1]) })
        index += nth[0].length
      } else if (attr) {
        steps.push({ tag: tag[0], attr: attr[1], value: attr[2].replace(/\\(.)/g, '$1') })
        index += attr[0].length
      } else fail()
    }
    if (index < selector.length) {
      if (selector.slice(index, index + 3) !== ' > ') fail()
      index += 3
    }
  }
  return steps
}

const elementsOf = (node) => (node.childNodes || []).filter((child) => child.tagName)
const attrOf = (node, name) => node.attrs?.find((item) => item.name === name)?.value

function matches(node, step, parent) {
  if (step.id !== undefined) return attrOf(node, 'id') === step.id
  if (node.tagName !== step.tag) return false
  if (step.attr) return attrOf(node, step.attr) === step.value
  const same = elementsOf(parent).filter((item) => item.tagName === step.tag)
  return same.indexOf(node) + 1 === step.nth
}

function textOf(node) {
  let text = ''
  const walk = (item) => {
    if (item.nodeName === '#text') text += item.value
    else if (!['style', 'script', 'template'].includes(item.tagName)) for (const child of item.childNodes || []) walk(child)
  }
  walk(node)
  const value = text.replace(/\s+/g, ' ').trim() || attrOf(node, 'aria-label') || attrOf(node, 'alt') || attrOf(node, 'placeholder') || ''
  return value.replace(/\s+/g, ' ').trim()
}

// The text of the one element `selector` finds in `html`; null when it finds
// none or several.
export function anchorText(html, selector) {
  let steps
  try {
    steps = parseSteps(selector)
  } catch {
    return null
  }
  const root = parse(html)
  let found = []
  const walk = (node) => {
    for (const child of elementsOf(node)) {
      if (matches(child, steps[0], node)) found.push(child)
      walk(child)
    }
  }
  walk(root)
  for (const step of steps.slice(1)) {
    found = found.flatMap((node) => elementsOf(node).filter((child) => matches(child, step, node)))
  }
  if (found.length !== 1) return null
  const text = textOf(found[0])
  return text.length > ANCHOR_TEXT_MAX ? `${text.slice(0, ANCHOR_TEXT_MAX - 3).trimEnd()}...` : text
}

// ---- The element map ------------------------------------------------------------

// The latest capture's element map of a page, as { file, map }, or null
// when there is none (never captured, or captured before maps) or it does
// not read.
function latestElementMap(config, board, pageId, viewport) {
  const file = resolveFile(config, board.id, 'captures', `${pageId}.${viewport}.elements.json`)
  if (!file) return null
  try {
    return { file, map: parseElementMap(fs.readFileSync(file, 'utf8')) }
  } catch {
    return null
  }
}

// A click in the middle of element `position`, as the board stores it:
// { anchor, pin } with the pin in percent of the page, or null when the
// element has no size to sit on.
function middleOf(map, position, selector) {
  const native = { width: map.width, height: map.height }
  const [, , width, height] = map.elements[position].b
  if (!width || !height || !native.width || !native.height) return null
  const anchor = { selector, text: map.elements[position].x || '', dx: 0.5, dy: 0.5 }
  const spot = resolveOnMap(map, anchor, native)
  if (!spot) return null
  const share = (value) => Math.round(Math.min(1, value) * 10000) / 10000
  const size = { w: share(width / native.width), h: share(height / native.height) }
  return { anchor: size.w > 0 && size.h > 0 ? { ...anchor, ...size } : anchor, pin: { x: spot.x, y: spot.y } }
}

export const SELECTORS_MAX = 200

// How sturdy a selector is: one #id step, then one data-testid step, then
// one aria-label step (the element's accessible name), then paths, shorter
// first. A path of nth-of-type steps breaks when the page around it changes.
function selectorRank(selector) {
  const steps = selector.split(' > ')
  if (steps.length === 1) {
    if (selector.startsWith('#')) return [0, 1]
    if (selector.includes('[data-testid=')) return [1, 1]
    if (selector.includes('[aria-label=')) return [2, 1]
  }
  return [3, steps.length]
}

// The selectors on an element map, best first, as { rows, more }: each row
// { selector, text }. With `text`, only elements whose text has those words,
// and the ones that hold the words themselves (a button, a heading) before
// the containers around them; an element whose text is exactly the words
// comes first of all. Never <body> (a pin is never the whole page).
export function selectorsOnMap(map, { text = '', max = SELECTORS_MAX } = {}) {
  const wanted = String(text || '')
    .trim()
    .toLowerCase()
  const elements = map.elements
  const candidates = elements
    .map((item, position) => ({ position, selector: selectorOf(map, position), text: item.x || '', sized: item.b[2] > 0 && item.b[3] > 0 }))
    .filter(
      (row) => elements[row.position].p !== -1 && row.selector && row.sized && (wanted ? row.text.toLowerCase().includes(wanted) : true),
    )
  // A match with a matching element inside it is a container of the words,
  // unless that inner one is only part of what a click on it means (a span
  // in a button: the button is the direct match).
  const matching = new Set(candidates.map((row) => row.position))
  const holds = new Set()
  if (wanted)
    for (const row of candidates) {
      const target = elements[row.position].a
      if (target >= 0 && matching.has(target)) continue
      for (let node = elements[row.position].p, guard = 0; node >= 0 && guard < 10000; node = elements[node].p, guard += 1) holds.add(node)
    }
  const key = (row) => {
    const exact = wanted && row.text.trim().toLowerCase() === wanted ? 0 : 1
    const direct = wanted && holds.has(row.position) ? 1 : 0
    return [exact, direct, ...selectorRank(row.selector), row.position]
  }
  const sorted = candidates
    .map((row) => ({ row, key: key(row) }))
    .sort((a, b) => {
      for (let index = 0; index < a.key.length; index += 1) if (a.key[index] !== b.key[index]) return a.key[index] - b.key[index]
      return 0
    })
    .map(({ row }) => ({ selector: row.selector, text: row.text }))
  return { rows: sorted.slice(0, max), more: Math.max(0, sorted.length - max) }
}

// The selectors of a page on a local board, as `comments selectors --json`
// and the MCP tool list_selectors give them.
export function selectorsReport(config, board, { page: pageId, viewport: wantedViewport = null, text = '' }) {
  const page = board.pages.find((item) => item.id === pageId)
  if (!page) throw new Error(noPageMessage(board, pageId))
  const viewport = wantedViewport || page.viewports[0]
  const found = latestElementMap(config, board, page.id, viewport)
  if (!found) throw new Error(`No element map for "${page.id}" (${viewport}) yet. Capture it first: shapewall capture --only ${page.id}`)
  const { rows, more } = selectorsOnMap(found.map, { text })
  return untrustedJson({ board: boardRef(board), page: page.id, viewport, selectors: rows, more })
}

// `comments selectors --page ID [--viewport NAME] [--text WORDS] [--json]`:
// the selectors `comments add --selector` takes, each with its element's
// text, from the latest capture's element map, sturdiest first.
export function listSelectors(config, board, flags, out) {
  const pageId = typeof flags.page === 'string' ? flags.page.trim() : ''
  if (!pageId) throw new Error('usage: shapewall comments selectors --page ID [--viewport NAME] [--text WORDS] [--json]')
  const wanted = typeof flags.text === 'string' ? flags.text.trim() : ''
  const report = selectorsReport(config, board, {
    page: pageId,
    viewport: typeof flags.viewport === 'string' ? flags.viewport : null,
    text: wanted,
  })
  const rows = report.selectors
  const lines = rows.map((row) => `${row.selector}${row.text ? `  ("${row.text}")` : ''}`)
  if (!rows.length) lines.push(wanted ? `No element on "${report.page}" (${report.viewport}) has text with "${wanted}".` : 'No elements.')
  if (report.more > 0) lines.push(`... and ${report.more} more: narrow it with --text WORDS`)
  print(out, flags, report, lines.join('\n'))
  return rows
}

// ---- Commands -------------------------------------------------------------------

const print = (out, flags, value, text) => out(flags.json ? JSON.stringify(value, null, 2) : text)

// What a selector must look like, and where to find one.
const selectorHelp = (pageId) =>
  'It takes steps like #id, button[data-testid="save"], nav[aria-label="Main"] or div:nth-of-type(2), joined by " > " ' +
  `(no classes or other CSS). List the ones on the page: shapewall comments selectors --page ${pageId} --text "words on the element"`

// The note when --selector does not find exactly one element: what it
// found, and where the pin goes meanwhile.
export function unmatchedNote({ selector, viewport, pageId, none, mapFile = null }) {
  const what = none
    ? `finds no element in the latest ${viewport} capture`
    : mapFile
      ? `finds more than one element in the latest ${viewport} capture`
      : `does not find exactly one element in the latest ${viewport} capture`
  const where = `The comment is saved with the selector, and its pin sits near the top-left corner of the page (${DEFAULT_PIN.x}% across, ${DEFAULT_PIN.y}% down) until the board finds the element.`
  const look = mapFile ? ` To pick another: shapewall comments selectors --page ${pageId} (or read ${mapFile}).` : ''
  return `note: "${selector}" ${what}. ${where}${look}`
}

// Where a comment pinned by `selector` goes on a page's capture: { anchor,
// pin }. In the middle of the element when the element map (`map`, or null)
// has exactly one; otherwise the selector is kept and the pin stays near the
// corner until the board finds the element (a note goes to `err`). `html` is
// a function giving the capture's live HTML (or null), read only then. Used by
// `comments add` and the add_comment MCP tools (local and --remote).
export function selectorPin({ selector: raw, map, mapFile = null, html, pageId, viewport, err = () => {} }) {
  const selector = String(raw).trim()
  if (!ANCHOR_SELECTOR_RE.test(selector))
    throw new Error(`--selector "${selector.slice(0, 80)}" is not one Shapewall can use. ${selectorHelp(pageId)}`)
  const hits = map ? matchSelectorAll(map, selector, 2) : []
  const middle = hits.length === 1 ? middleOf(map, hits[0], selector) : null
  // The pin sits in the middle of the element, where the map has it.
  if (middle) return middle
  // No map, or the map does not have exactly one such element: the selector
  // is kept, and the pin stays near the corner until the board finds it.
  const source = html()
  const found = source ? anchorText(source, selector) : ''
  // None at all (the map says so): the anchor says it, so the board does not
  // name an element from the selector's words.
  const none = Boolean(map && hits.length === 0)
  if (found === null || (map && hits.length !== 1)) err(unmatchedNote({ selector, viewport, pageId, none, mapFile }))
  return { anchor: { selector, text: found || '', dx: 0.5, dy: 0.5, ...(none ? { unmatched: true } : {}) }, pin: DEFAULT_PIN }
}

// `comments add --page ID --body TEXT [--viewport NAME] [--selector CSS] [--author NAME]`
// `agent`: the MCP add_comment tool is calling (the comment is an agent's).
export async function addComment(config, board, flags, out, err = () => {}, { agent = false } = {}) {
  const pageId = typeof flags.page === 'string' ? flags.page.trim() : ''
  const body = typeof flags.body === 'string' ? flags.body : ''
  if (!pageId || !body.trim())
    throw new Error('usage: shapewall comments add --page ID --body TEXT [--viewport NAME] [--selector CSS] [--author NAME]')
  const page = board.pages.find((item) => item.id === pageId)
  if (!page && !pageId.startsWith('variant:')) {
    throw new Error(noPageMessage(board, pageId))
  }
  const viewport =
    typeof flags.viewport === 'string' ? flags.viewport : page ? page.viewports[0] : Object.keys(boardViewports(config, board))[0]
  let anchor
  let pin = DEFAULT_PIN
  if (flags.selector !== undefined) {
    const mapped = page ? latestElementMap(config, board, page.id, viewport) : null
    const live = page ? resolveFile(config, board.id, 'captures', `${page.id}.${viewport}.html`) : null
    ;({ anchor, pin } = selectorPin({
      selector: flags.selector,
      map: mapped?.map || null,
      mapFile: mapped ? path.relative(process.cwd(), mapped.file) || mapped.file : null,
      html: () => (live ? fs.readFileSync(live, 'utf8') : null),
      pageId,
      viewport,
      err,
    }))
  }
  let comment
  try {
    comment = await createComment(
      config,
      board,
      { pageId, viewport, ...pin, body, author: authorFlag(flags, { dir: config.dir }), anchor },
      // The person at this machine, unless an agent's run is calling.
      { owner: !agent && !runByAgent(process.env), agent: agent === true || runByAgent(process.env) },
    )
  } catch (error) {
    if (error instanceof CommentError && error.code === 'invalid_anchor') {
      throw new Error(`${error.message} ${selectorHelp(pageId)}`, { cause: error })
    }
    throw error
  }
  const item = feedbackItem(feedbackContext(config, board), comment)
  print(out, flags, commentJson(board, item), `Added #${item.id} on ${item.page?.title || pageId} (${viewport}) as ${item.author}`)
  return item
}

// `comments get ID [--json] [--for-agent]` (also `comments show ID`). Both
// say the comment is untrusted (src/feedback.js).
export function showComment(config, board, positional, flags, out) {
  const id = positional[1]
  if (!id) throw new Error('usage: shapewall comments get ID [--json] [--for-agent]')
  const item = feedbackItem(feedbackContext(config, board), getComment(config, board.id, id))
  if (flags['for-agent']) out(formatFeedbackItemForAgent(item, board.id))
  else print(out, flags, commentJson(board, item), formatFeedbackItem(item).join('\n'))
  return item
}
