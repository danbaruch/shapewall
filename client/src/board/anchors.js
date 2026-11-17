// Element anchors for comments made on live HTML. The board reads the
// sandboxed iframe's document (same origin, scripts off) to turn a tap into a
// robust reference to an element, and later to find that element again, so
// a pin follows its element when the page is recaptured.

import { INLINE_TAGS, elementName, headingLevel, ownHeading } from '../../../src/capture/element-name.js'
import { frameDom } from './frameDom'

const SELECTOR_MAX = 600
const TEXT_SCAN_MAX = 2000
// The only selectors an anchor may hold: what selectorFor() below emits.
// Steps are `#id` (CSS-escaped), `tag[data-testid="..."]`,
// `tag[aria-label="..."]` or `tag:nth-of-type(n)`, joined by ` > `.
// The server (src/store.js) checks the same grammar.
const ANCHOR_STEP = String.raw`(?:#(?:[A-Za-z0-9_\u0080-￿-]|\\[0-9a-fA-F]{6} ?|\\[0-9a-fA-F]{1,5}(?![0-9a-fA-F]) ?|\\[^0-9a-fA-F\n\r\f])+|[a-z][a-z0-9-]{0,40}(?:\[(?:data-testid|aria-label)="(?:[^"\\\n]|\\.){0,200}"\]|:nth-of-type\([1-9][0-9]{0,4}\)))`
export const ANCHOR_SELECTOR_RE = new RegExp(`^${ANCHOR_STEP}(?: > ${ANCHOR_STEP}){0,79}$`)
const TEXT_MAX = 80
// Taps land on the element people mean: a button rather than its inner span.
const PREFERRED = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], img'

function textOf(element) {
  if (!element) return ''
  const text =
    element.innerText ||
    element.textContent ||
    element.getAttribute?.('aria-label') ||
    element.getAttribute?.('alt') ||
    element.getAttribute?.('placeholder') ||
    ''
  return String(text).replace(/\s+/g, ' ').trim()
}

function escapeIdent(doc, value) {
  // The board's own CSS.escape: the frame's window is the page's.
  const css = typeof CSS !== 'undefined' ? CSS : null
  return css?.escape ? css.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
}

function escapeAttr(value) {
  return String(value).replace(/["\\]/g, '\\$&')
}

function unique(doc, selector) {
  try {
    return frameDom.querySelectorAll(doc, selector).length === 1
  } catch {
    return false
  }
}

// A selector path from the closest stable hook (id, data-testid, aria-label)
// down to the element, with :nth-of-type steps where nothing better exists.
export function selectorFor(doc, element) {
  const parts = []
  let node = element
  const root = frameDom.documentElement(doc)
  while (node && node.nodeType === 1 && node !== root) {
    const tag = node.tagName.toLowerCase()
    if (node.id && unique(doc, `#${escapeIdent(doc, node.id)}`)) {
      parts.unshift(`#${escapeIdent(doc, node.id)}`)
      break
    }
    const testId = node.getAttribute('data-testid')
    if (testId && unique(doc, `${tag}[data-testid="${escapeAttr(testId)}"]`)) {
      parts.unshift(`${tag}[data-testid="${escapeAttr(testId)}"]`)
      break
    }
    const label = node.getAttribute('aria-label')
    if (label && label.length <= 80 && unique(doc, `${tag}[aria-label="${escapeAttr(label)}"]`)) {
      parts.unshift(`${tag}[aria-label="${escapeAttr(label)}"]`)
      break
    }
    let index = 1
    let sibling = node
    while ((sibling = sibling.previousElementSibling)) if (sibling.tagName === node.tagName) index += 1
    parts.unshift(`${tag}:nth-of-type(${index})`)
    node = node.parentElement
  }
  let selector = parts.join(' > ')
  // Very deep paths keep their most specific end.
  while (selector.length > SELECTOR_MAX && parts.length > 1) {
    parts.shift()
    selector = parts.join(' > ')
  }
  // Never cut a selector mid-step; no anchor is better than a broken one.
  return selector.length > SELECTOR_MAX ? '' : selector
}

// The element a tap at document coordinates means: the element under it, or
// its nearest interactive ancestor, and the block a run of inline words is
// in. Null on the page background, a few pixels, or a page-sized wrapper
// (as hitTest() on an element map). `up`: that many containers out.
export function elementAt(doc, x, y, up = 0) {
  const hit = frameDom.elementFromPoint(doc, x, y)
  const root = frameDom.documentElement(doc)
  const body = frameDom.body(doc)
  if (!hit || hit === root || hit === body) return null
  let element = hit.closest?.(PREFERRED) || blockOf(hit, body)
  if (!pointable(doc, element)) return null
  for (let step = 0; step < up; step += 1) {
    const outer = outerOf(doc, element)
    if (!outer) break
    element = outer
  }
  return element
}

const TEXT_BLOCK = 'p, h1, h2, h3, h4, h5, h6, li, dd, dt, td, th, blockquote, figcaption, label, summary, caption, legend'

// As pointable() on an element map: the page is the frame's viewport (the
// capture's native size).
function pointable(doc, element) {
  const rect = element.getBoundingClientRect()
  if (rect.width < 3 || rect.height < 3) return false
  const view = frameDom.defaultView(doc)
  const pageWidth = view?.innerWidth || rect.width
  const pageHeight = view?.innerHeight || rect.height
  const shownWidth = Math.max(0, Math.min(rect.right, pageWidth) - Math.max(rect.left, 0))
  const shownHeight = Math.max(0, Math.min(rect.bottom, pageHeight) - Math.max(rect.top, 0))
  if ((shownWidth * shownHeight) / (rect.width * rect.height) < 0.4) return false
  return !(rect.width >= pageWidth * 0.98 && rect.height >= pageHeight * 0.95)
}

const isLeaf = (element) => Array.from(element.children).every((child) => INLINE_TAGS.has(child.tagName.toLowerCase()))

function blockOf(element, body) {
  if (!INLINE_TAGS.has(element.tagName.toLowerCase())) return element
  let node = element
  for (let guard = 0; guard < 4; guard += 1) {
    const parent = node.parentElement
    if (!parent || parent === body) return element
    const tag = parent.tagName.toLowerCase()
    if (parent.matches(TEXT_BLOCK) || ((tag === 'div' || tag.includes('-')) && isLeaf(parent))) return parent
    if (!INLINE_TAGS.has(tag)) return element
    node = parent
  }
  return element
}

function outerOf(doc, element) {
  const body = frameDom.body(doc)
  const { width, height } = element.getBoundingClientRect()
  for (let node = element.parentElement; node && node !== body; node = node.parentElement) {
    const rect = node.getBoundingClientRect()
    if (rect.width > width + 1 || rect.height > height + 1) return pointable(doc, node) ? node : null
  }
  return null
}

// The facts elementName() needs, read from the element.
function factsOf(element) {
  const tag = element.tagName.toLowerCase()
  const attr = (name) => element.getAttribute?.(name) || ''
  const headings = []
  for (const heading of Array.from(element.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).slice(0, 60)) {
    const level = Number(heading.getAttribute('aria-level')) || headingLevel(heading.tagName.toLowerCase()) || 2
    headings.push({ level, text: textOf(heading) })
  }
  const own = ownHeading(headings)
  let label = attr('aria-label')
  if (!label && attr('aria-labelledby')) {
    const doc = element.ownerDocument
    label = attr('aria-labelledby')
      .split(/\s+/)
      .map((id) => textOf(doc?.getElementById(id)))
      .join(' ')
  }
  return {
    tag,
    role: attr('role'),
    type: attr('type'),
    label,
    alt: attr('alt'),
    title: attr('title'),
    placeholder: attr('placeholder'),
    field: element.labels?.[0] ? textOf(element.labels[0]) : '',
    value: tag === 'input' ? attr('value') : '',
    text: textOf(element),
    heading: own?.text || '',
    headingLevel: own?.level || 0,
    leaf: isLeaf(element),
  }
}

// What a person calls the element ({ kind, name, text }), as nameOnMap(): a
// wrapper with no name of its own is called what it wraps.
export function nameOf(element, depth = 0) {
  const result = elementName(factsOf(element))
  const parent = element.parentElement
  const body = element.ownerDocument?.body
  if (depth < 4 && result.kind === 'Group' && !result.name && parent && parent !== body) {
    const blocks = Array.from(parent.children).filter((child) => !INLINE_TAGS.has(child.tagName.toLowerCase()))
    const own = element.getBoundingClientRect()
    const outer = parent.getBoundingClientRect()
    if (blocks.length === 1 || own.width * own.height >= outer.width * outer.height * 0.85) return nameOf(parent, depth + 1)
  }
  return result
}

// What hovering shows for the element a comment would pin to: `kind`,
// `name` and `text` ("Button · Start free"); `label`, the last step of its
// selector and its text ('a[data-testid="cta"] "Start free"'); and `large`
// when it covers a big part of the page, so the outline says it is a whole
// block.
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 3)}...` : value)

export function describeElement(doc, element, native) {
  const selector = selectorFor(doc, element)
  const step = selector ? selector.split(' > ').pop() : element.tagName.toLowerCase()
  const text = textOf(element)
  const rect = element.getBoundingClientRect()
  const area = native?.width && native?.height ? (rect.width * rect.height) / (native.width * native.height) : 0
  const named = nameOf(element)
  return {
    id: element,
    kind: named.kind,
    name: named.name,
    text: named.text,
    label: `${clip(step, 48)}${text ? ` "${clip(text, 28)}"` : ''}`,
    large: area > 0.2,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  }
}

// Turns a tap at document coordinates into an anchor, or null. `native` (the
// page size) adds the element's size as a share of the page (w, h), so the
// pin can sit on the element's corner in screenshot mode too.
export function anchorAt(doc, x, y, native = null, up = 0) {
  const element = elementAt(doc, x, y, up)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  const clamp = (value) => Math.max(0, Math.min(1, value))
  const selector = selectorFor(doc, element)
  // The server accepts only this grammar; anything else falls back to the x/y pin.
  if (!selector || !ANCHOR_SELECTOR_RE.test(selector)) return null
  const round = (value) => Math.round(clamp(value) * 10000) / 10000
  return {
    selector,
    text: textOf(element).slice(0, TEXT_MAX),
    dx: round((x - rect.left) / rect.width),
    dy: round((y - rect.top) / rect.height),
    ...(native?.width && native?.height ? { w: round(rect.width / native.width), h: round(rect.height / native.height) } : {}),
  }
}

function lastTag(selector) {
  const last = String(selector).split('>').pop().trim()
  const match = /^([a-z][a-z0-9-]*)/i.exec(last)
  return match ? match[1].toLowerCase() : null
}

// Finds the anchored element again: by selector (checked against the saved
// text), then by its text alone. Returns { x, y, box } in percent of the
// native page (box: the element's edges, for pins on its corner), or null
// when it is gone (the caller falls back to the stored x/y).
export function resolveAnchor(doc, anchor, native) {
  const body = frameDom.body(doc)
  if (!body || !anchor?.selector || !native || !ANCHOR_SELECTOR_RE.test(anchor.selector)) return null
  const wanted = String(anchor.text || '')
  const textMatches = (element) => {
    if (!wanted) return true
    const text = textOf(element)
    return text === wanted || text.startsWith(wanted)
  }
  let element = null
  try {
    element = frameDom.querySelector(doc, anchor.selector)
  } catch {
    element = null
  }
  if (element && !textMatches(element)) element = null
  // Text fallback: only elements of the anchored tag, and only the first
  // TEXT_SCAN_MAX of them, so a huge page cannot stall the board.
  const tag = lastTag(anchor.selector)
  if (!element && wanted && tag) {
    let best = null
    let bestArea = Infinity
    const candidates = Element.prototype.getElementsByTagName.call(body, tag)
    for (let index = 0; index < candidates.length && index < TEXT_SCAN_MAX; index += 1) {
      const candidate = candidates[index]
      if (textOf(candidate) !== wanted) continue
      const rect = candidate.getBoundingClientRect()
      const area = rect.width * rect.height
      if (area > 0 && area < bestArea) {
        best = candidate
        bestArea = area
      }
    }
    element = best
  }
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (!rect.width && !rect.height) return null
  const percent = (value, size) => Math.max(0, Math.min(100, (value / size) * 100))
  return {
    x: percent(rect.left + anchor.dx * rect.width, native.width),
    y: percent(rect.top + anchor.dy * rect.height, native.height),
    box: {
      left: percent(rect.left, native.width),
      top: percent(rect.top, native.height),
      right: percent(rect.right, native.width),
      bottom: percent(rect.bottom, native.height),
    },
  }
}
