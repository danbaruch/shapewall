// Element anchors for comments made on live HTML. The board reads the
// sandboxed iframe's document (same origin, scripts off) to turn a tap into a
// robust reference to an element, and later to find that element again, so
// a pin follows its element when the page is recaptured.

import { plainLabel } from '../../../src/capture/element-map.js'
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
// its nearest interactive ancestor. Null on the page background.
export function elementAt(doc, x, y) {
  const hit = frameDom.elementFromPoint(doc, x, y)
  if (!hit || hit === frameDom.documentElement(doc) || hit === frameDom.body(doc)) return null
  const element = hit.closest?.(PREFERRED) || hit
  const rect = element.getBoundingClientRect()
  return rect.width && rect.height ? element : null
}

// What hovering shows for the element a comment would pin to: `name`, a
// plain label ("Button: Start free"); `label`, the last step of its selector
// and its text ('a[data-testid="cta"] "Start free"'); and `large` when it
// covers a big part of the page, so the board can say the pin goes on a
// whole section.
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 3)}...` : value)

export function describeElement(doc, element, native) {
  const selector = selectorFor(doc, element)
  const step = selector ? selector.split(' > ').pop() : element.tagName.toLowerCase()
  const text = textOf(element)
  const rect = element.getBoundingClientRect()
  const area = native?.width && native?.height ? (rect.width * rect.height) / (native.width * native.height) : 0
  const large = area > 0.2
  return {
    name: plainLabel(element.tagName.toLowerCase(), text, { large }),
    label: `${clip(step, 48)}${text ? ` "${clip(text, 28)}"` : ''}`,
    large,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  }
}

// Turns a tap at document coordinates into an anchor, or null. `native` (the
// page size) adds the element's size as a share of the page (w, h), so the
// pin can sit on the element's corner in screenshot mode too.
export function anchorAt(doc, x, y, native = null) {
  const element = elementAt(doc, x, y)
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
