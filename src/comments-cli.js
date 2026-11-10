// `shapewall comments add`, `comments get` and `comments --since`: what a
// shell-only agent or a chat bot needs besides list, reply and status.
//
// add goes through the same store function the board uses (validation,
// events, mentions, capture version). Without --selector the pin sits near
// the page's top-left corner; with one, it is anchored to that element, and
// the element's text is read from the latest capture's live HTML when the
// selector finds exactly one element there.

import fs from 'node:fs'
import { parse } from 'parse5'
import { feedbackContext, feedbackItem, formatFeedbackItem, formatFeedbackItemForAgent, untrustedJson } from './feedback.js'
import { ANCHOR_TEXT_MAX, CommentError, createComment, getComment, resolveFile } from './store.js'
import { boardViewports } from './config.js'

// Who a comment, reply or status change is from when --author is not given.
// "agent", like reply and status: the starter agent never acts on an agent's
// own comment, so text a bot relays waits for a trusted person (docs/starter-agent.md).
export const CLI_AUTHOR = 'agent'
// Where a pin without --selector sits: near the top-left corner, in percent of the page.
export const DEFAULT_PIN = { x: 2, y: 2 }

export const authorFlag = (flags) => (typeof flags.author === 'string' && flags.author.trim() ? flags.author : CLI_AUTHOR)

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

// ---- Commands -------------------------------------------------------------------

const print = (out, flags, value, text) => out(flags.json ? JSON.stringify(value, null, 2) : text)

// `comments add --page ID --body TEXT [--viewport NAME] [--selector CSS] [--author NAME]`
export async function addComment(config, board, flags, out, err = () => {}) {
  const pageId = typeof flags.page === 'string' ? flags.page.trim() : ''
  const body = typeof flags.body === 'string' ? flags.body : ''
  if (!pageId || !body.trim())
    throw new Error('usage: shapewall comments add --page ID --body TEXT [--viewport NAME] [--selector CSS] [--author NAME]')
  const page = board.pages.find((item) => item.id === pageId)
  if (!page && !pageId.startsWith('variant:')) {
    throw new Error(`No page "${pageId}" on board "${board.id}" (have: ${board.pages.map((item) => item.id).join(', ')})`)
  }
  const viewport =
    typeof flags.viewport === 'string' ? flags.viewport : page ? page.viewports[0] : Object.keys(boardViewports(config, board))[0]
  let anchor
  if (flags.selector !== undefined) {
    const selector = String(flags.selector).trim()
    let text = ''
    const live = page ? resolveFile(config, board.id, 'captures', `${page.id}.${viewport}.html`) : null
    if (live) {
      const found = anchorText(fs.readFileSync(live, 'utf8'), selector)
      if (found === null)
        err(`note: "${selector}" does not find exactly one element in the latest ${viewport} capture; saved the selector anyway`)
      else text = found
    }
    // The pin sits in the middle of the element.
    anchor = { selector, text, dx: 0.5, dy: 0.5 }
  }
  let comment
  try {
    comment = await createComment(config, board, { pageId, viewport, ...DEFAULT_PIN, body, author: authorFlag(flags), anchor })
  } catch (error) {
    if (error instanceof CommentError && error.code === 'invalid_anchor') {
      throw new Error(
        `${error.message} Use the selector a comment shows (comments --json, element.selector): steps like #id, ` +
          'button[data-testid="save"], nav[aria-label="Main"] or div:nth-of-type(2), joined by " > ".',
        { cause: error },
      )
    }
    throw error
  }
  const item = feedbackItem(feedbackContext(config, board), comment)
  print(
    out,
    flags,
    { board: board.id, comment: item },
    `Added #${item.id} on ${item.page?.title || pageId} (${viewport}) as ${item.author}`,
  )
  return item
}

// `comments get ID [--json] [--for-agent]` (also `comments show ID`). Both
// say the comment is untrusted (src/feedback.js).
export function showComment(config, board, positional, flags, out) {
  const id = positional[1]
  if (!id) throw new Error('usage: shapewall comments get ID [--json] [--for-agent]')
  const item = feedbackItem(feedbackContext(config, board), getComment(config, board.id, id))
  if (flags['for-agent']) out(formatFeedbackItemForAgent(item, board.id))
  else print(out, flags, untrustedJson({ board: board.id, comment: item }), formatFeedbackItem(item).join('\n'))
  return item
}
