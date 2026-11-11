// Element maps. At capture, after the live HTML is written, the same
// document is rendered once more in a plain (non-mobile) page at the
// capture's native size, which is exactly how the board's frame renders it,
// and every element in that frame is written to
// <page>.<viewport>.elements.json: where it is, what it says, how a selector
// reaches it, and which element a click on it means.
//
// The board then never reads the live frame's DOM: it hit-tests clicks on the
// map, places pins from it and re-resolves anchors on it after a recapture,
// so the frame can run with an opaque origin (sandbox="" without
// allow-same-origin). This file has no Node or DOM imports: the capture
// (Node), the hosted push validation (Node) and the board (browser) share it.
//
// Map format, version 1:
//   { v: 1, width, height, elements: [element, ...], truncated?: true }
// Elements are in document order, ancestors before descendants, starting at
// <body>. Each one:
//   t  tag name (lower case)            n  its :nth-of-type() index
//   p  parent's index (-1 for <body>)    b  [left, top, width, height] in CSS px
//   h  its selector step when a unique #id / data-testid / aria-label hook exists
//   i, d, r  its id, data-testid, aria-label (for matching stored selectors)
//   x  its text (whitespace collapsed, first 80 characters); l: 1 when longer
//   z  hit order (higher paints on top); absent when a click never lands on it
//   c  its box clipped by scrolling/hidden ancestors, when that differs from b
//   a  the element a click on it means (nearest link, button, ...); -1: none

export const ELEMENT_MAP_VERSION = 1
export const ELEMENT_MAP_LIMITS = {
  elements: 8000,
  bytes: 3 * 1024 * 1024,
  text: 80,
  attr: 200,
  selector: 600,
  size: 10000,
}
// Taps land on the element people mean: a button rather than its inner span.
export const PREFERRED =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], img'

// The only selectors an anchor may hold. Steps are `#id` (CSS-escaped),
// `tag[data-testid="..."]`, `tag[aria-label="..."]` or `tag:nth-of-type(n)`,
// joined by ` > `. The server (src/store.js) checks the same grammar.
const ID_BODY = String.raw`(?:[A-Za-z0-9_\u0080-\uffff-]|\\[0-9a-fA-F]{6} ?|\\[0-9a-fA-F]{1,5}(?![0-9a-fA-F]) ?|\\[^0-9a-fA-F\n\r\f])+`
const ATTR_VALUE = String.raw`(?:[^"\\\n]|\\.){0,200}`
const ANCHOR_STEP = String.raw`(?:#${ID_BODY}|[a-z][a-z0-9-]{0,40}(?:\[(?:data-testid|aria-label)="${ATTR_VALUE}"\]|:nth-of-type\([1-9][0-9]{0,4}\)))`
export const ANCHOR_SELECTOR_RE = new RegExp(`^${ANCHOR_STEP}(?: > ${ANCHOR_STEP}){0,79}$`)
const ONE_STEP_RE = new RegExp(`^${ANCHOR_STEP}$`)
const TAG_RE = /^[a-z][a-z0-9-]{0,40}$/

// ---- In the page --------------------------------------------------------------
// Runs inside the rendered live document (sent as source text, so it must be
// self-contained). Mirrors client/src/board/anchors.js, which is what the board
// did on the frame's DOM before maps: the same text, the same selector steps,
// the same "nearest interactive ancestor".
export function buildElementMap(limits) {
  const doc = document
  const root = doc.documentElement
  const body = doc.body
  const width = Math.round(innerWidth)
  const height = Math.round(innerHeight)
  if (!body) return { v: 1, width, height, elements: [] }
  const textOf = (element) => {
    const text =
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.getAttribute('alt') ||
      element.getAttribute('placeholder') ||
      ''
    return String(text).replace(/\s+/g, ' ').trim()
  }
  const escapeAttr = (value) => String(value).replace(/["\\]/g, '\\$&')
  const unique = (selector) => {
    try {
      return doc.querySelectorAll(selector).length === 1
    } catch (error) {
      return false
    }
  }
  const round = (value) => Math.round(value * 10) / 10
  const sized = (rect) => Boolean(rect && rect.width && rect.height)

  // Elements in the frame, plus their ancestors (selectors walk through them).
  const nodes = [body, ...Array.from(body.querySelectorAll('*'))]
  const rects = new Map()
  const keep = new Set()
  for (const element of nodes) {
    const rect = element.getBoundingClientRect()
    rects.set(element, rect)
    if (!sized(rect) || rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) continue
    for (let node = element; node && node !== root && !keep.has(node); node = node.parentElement) keep.add(node)
  }
  // Document order keeps ancestors first, so a cut keeps every parent.
  const all = nodes.filter((element) => keep.has(element))
  const list = all.slice(0, limits.elements)
  const index = new Map(list.map((element, position) => [element, position]))
  const styles = new Map()
  const style = (element) => {
    let value = styles.get(element)
    if (!value) {
      value = getComputedStyle(element)
      styles.set(element, value)
    }
    return value
  }

  // Paint order, approximated: the root-level z-index of the outermost
  // positioned ancestor, then positioned above in-flow, then document order.
  const layer = (element) => {
    let z = 0
    let positioned = 0
    for (let node = element; node && node !== root; node = node.parentElement) {
      const value = style(node)
      if (value.position !== 'static') {
        positioned = 1
        const zIndex = parseInt(value.zIndex, 10)
        if (Number.isFinite(zIndex)) z = zIndex
      }
    }
    return [z, positioned]
  }
  // A click only lands on the part of an element its clipping ancestors show.
  const clipOf = (element, rect) => {
    let left = rect.left
    let top = rect.top
    let right = rect.right
    let bottom = rect.bottom
    if (style(element).position === 'fixed') return null
    for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
      const value = style(node)
      if (value.overflowX !== 'visible' || value.overflowY !== 'visible') {
        const box = rects.get(node) || node.getBoundingClientRect()
        left = Math.max(left, box.left)
        top = Math.max(top, box.top)
        right = Math.min(right, box.right)
        bottom = Math.min(bottom, box.bottom)
      }
      if (value.position === 'fixed') break
    }
    if (left === rect.left && top === rect.top && right === rect.right && bottom === rect.bottom) return null
    return [round(left), round(top), round(Math.max(0, right - left)), round(Math.max(0, bottom - top))]
  }

  const elements = []
  const hittable = []
  list.forEach((element, position) => {
    const tag = element.tagName.toLowerCase()
    const rect = rects.get(element)
    let nth = 1
    let sibling = element
    while ((sibling = sibling.previousElementSibling)) if (sibling.tagName === element.tagName) nth += 1
    const item = {
      t: tag,
      n: nth,
      p: element === body ? -1 : index.get(element.parentElement),
      b: [round(rect.left), round(rect.top), round(rect.width), round(rect.height)],
    }
    const id = element.id
    const testId = element.getAttribute('data-testid')
    const label = element.getAttribute('aria-label')
    if (id && unique(`#${CSS.escape(id)}`)) item.h = `#${CSS.escape(id)}`
    else if (testId && unique(`${tag}[data-testid="${escapeAttr(testId)}"]`)) item.h = `${tag}[data-testid="${escapeAttr(testId)}"]`
    else if (label && label.length <= 80 && unique(`${tag}[aria-label="${escapeAttr(label)}"]`))
      item.h = `${tag}[aria-label="${escapeAttr(label)}"]`
    if (id && id.length <= limits.attr) item.i = id
    if (testId && testId.length <= limits.attr) item.d = testId
    if (label && label.length <= limits.attr) item.r = label
    const text = textOf(element)
    if (text) {
      item.x = text.slice(0, limits.text)
      if (text.length > limits.text) item.l = 1
    }
    const value = style(element)
    if (element !== body && sized(rect) && value.visibility === 'visible' && value.pointerEvents !== 'none') {
      hittable.push({ position, key: layer(element) })
      const clip = clipOf(element, rect)
      if (clip) item.c = clip
      const target = element.closest(limits.preferred) || element
      if (target !== element) item.a = index.has(target) && sized(rects.get(target)) ? index.get(target) : -1
    }
    elements.push(item)
  })
  hittable.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.position - b.position)
  hittable.forEach((entry, rank) => {
    elements[entry.position].z = rank
  })
  const map = { v: 1, width, height, elements }
  if (all.length > list.length) map.truncated = true
  return map
}

export const ELEMENT_MAP_EXPRESSION = `(${buildElementMap.toString()})(${JSON.stringify({
  elements: ELEMENT_MAP_LIMITS.elements,
  text: ELEMENT_MAP_LIMITS.text,
  attr: ELEMENT_MAP_LIMITS.attr,
  preferred: PREFERRED,
})})`

// ---- Validation -----------------------------------------------------------------
// A map is data from the capture, or from a push (untrusted): rebuilt field by
// field, anything unexpected refused. Returns the clean map or throws.

export class ElementMapError extends Error {}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const COORD_MAX = 100000

function box(value, where) {
  if (!Array.isArray(value) || value.length !== 4) throw new ElementMapError(`${where}: a box is four numbers`)
  const out = value.map((number) => {
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > COORD_MAX)
      throw new ElementMapError(`${where}: a box is four numbers`)
    return Math.round(number * 10) / 10
  })
  if (out[2] < 0 || out[3] < 0) throw new ElementMapError(`${where}: a box has no negative size`)
  return out
}

function plain(value, max, where) {
  if (typeof value !== 'string' || !value || value.length > max || CONTROL_RE.test(value))
    throw new ElementMapError(`${where}: up to ${max} printable characters`)
  return value
}

export function cleanElementMap(raw) {
  const limits = ELEMENT_MAP_LIMITS
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ElementMapError('an element map is an object')
  if (raw.v !== ELEMENT_MAP_VERSION) throw new ElementMapError('unknown element map version')
  const size = (value, name) => {
    if (!Number.isInteger(value) || value < 1 || value > limits.size) throw new ElementMapError(`${name}: 1 to ${limits.size}`)
    return value
  }
  const width = size(raw.width, 'width')
  const height = size(raw.height, 'height')
  if (!Array.isArray(raw.elements) || raw.elements.length > limits.elements)
    throw new ElementMapError(`elements: a list of at most ${limits.elements}`)
  const count = raw.elements.length
  const ranks = new Set()
  const elements = raw.elements.map((item, position) => {
    const where = `elements[${position}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ElementMapError(`${where}: an object`)
    if (typeof item.t !== 'string' || !TAG_RE.test(item.t)) throw new ElementMapError(`${where}.t: a tag name`)
    if (!Number.isInteger(item.n) || item.n < 1 || item.n > 99999) throw new ElementMapError(`${where}.n: 1 to 99999`)
    // Parents come first; only the first element (<body>) has none.
    if (!Number.isInteger(item.p) || item.p >= position || item.p < -1 || (item.p === -1) !== (position === 0))
      throw new ElementMapError(`${where}.p: an earlier element`)
    const clean = { t: item.t, n: item.n, p: item.p, b: box(item.b, `${where}.b`) }
    if (item.h !== undefined) {
      if (typeof item.h !== 'string' || item.h.length > limits.selector || !ONE_STEP_RE.test(item.h))
        throw new ElementMapError(`${where}.h: one selector step`)
      clean.h = item.h
    }
    for (const key of ['i', 'd', 'r']) if (item[key] !== undefined) clean[key] = plain(item[key], limits.attr, `${where}.${key}`)
    if (item.x !== undefined) clean.x = plain(item.x, limits.text, `${where}.x`)
    if (item.l !== undefined) {
      if (item.l !== 1 || clean.x === undefined) throw new ElementMapError(`${where}.l: 1 with a text`)
      clean.l = 1
    }
    if (item.z !== undefined) {
      if (!Number.isInteger(item.z) || item.z < 0 || item.z >= count || ranks.has(item.z))
        throw new ElementMapError(`${where}.z: a distinct rank`)
      ranks.add(item.z)
      clean.z = item.z
    }
    if (item.c !== undefined) clean.c = box(item.c, `${where}.c`)
    if (item.a !== undefined) {
      if (!Number.isInteger(item.a) || item.a < -1 || item.a >= count) throw new ElementMapError(`${where}.a: an element or -1`)
      clean.a = item.a
    }
    return clean
  })
  const map = { v: ELEMENT_MAP_VERSION, width, height, elements }
  if (raw.truncated === true) map.truncated = true
  return map
}

// From the bytes of a file (a push): JSON, size-capped, then cleanElementMap.
export function parseElementMap(text) {
  if (typeof text !== 'string' || text.length > ELEMENT_MAP_LIMITS.bytes) throw new ElementMapError('the element map is too large')
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ElementMapError('the element map is not JSON')
  }
  return cleanElementMap(raw)
}

// ---- On the board -------------------------------------------------------------------

const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 3)}...` : value)

// The selector a comment on element `position` stores: the same steps as
// anchors.js selectorFor() on the DOM, from the closest stable hook down.
export function selectorOf(map, position) {
  const parts = []
  let node = position
  let guard = 0
  while (node >= 0 && guard < 10000) {
    const item = map.elements[node]
    if (!item) break
    if (item.h) {
      parts.unshift(item.h)
      break
    }
    parts.unshift(`${item.t}:nth-of-type(${item.n})`)
    node = item.p
    guard += 1
  }
  let selector = parts.join(' > ')
  while (selector.length > ELEMENT_MAP_LIMITS.selector && parts.length > 1) {
    parts.shift()
    selector = parts.join(' > ')
  }
  return selector.length > ELEMENT_MAP_LIMITS.selector ? '' : selector
}

// The element a click at page coordinates (x, y) means, or -1 on the page
// background: the topmost element under it, then its nearest interactive
// ancestor (as elementAt() did on the DOM).
export function hitTest(map, x, y) {
  let best = -1
  let bestRank = -1
  const elements = map?.elements || []
  for (let position = 0; position < elements.length; position += 1) {
    const item = elements[position]
    if (item.z === undefined || item.z <= bestRank) continue
    const [left, top, width, height] = item.c || item.b
    if (x >= left && x < left + width && y >= top && y < top + height) {
      best = position
      bestRank = item.z
    }
  }
  if (best < 0) return -1
  const target = elements[best].a
  return target === undefined ? best : target
}

// What a reviewer would call an element, from its tag: "Heading", "Button",
// "Image". Containers are a "Section"; other tags with words in them are "Text".
const KINDS = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  a: 'Link',
  button: 'Button',
  summary: 'Button',
  img: 'Image',
  picture: 'Image',
  svg: 'Image',
  video: 'Video',
  input: 'Field',
  textarea: 'Field',
  select: 'Field',
  label: 'Label',
  li: 'List item',
  ul: 'List',
  ol: 'List',
  table: 'Table',
  form: 'Form',
  nav: 'Navigation',
  header: 'Header',
  footer: 'Footer',
  section: 'Section',
  article: 'Section',
  main: 'Section',
  aside: 'Section',
  div: 'Section',
}

// The tag a selector ends on ('' when its last step is an #id).
export function selectorTag(selector) {
  const last = String(selector || '')
    .split(' > ')
    .pop()
  const match = /^([a-z][a-z0-9-]*)/.exec(last)
  return match ? match[1] : ''
}

// A plain name for an element: its kind and its text ("Heading: Notes that
// keep up...", "Button: Start free", "Section"). `large`: it covers a big
// part of the page, so a section says it is the whole of it.
export function plainLabel(tag, text = '', { large = false, max = 32 } = {}) {
  const words = String(text || '').trim()
  let kind = KINDS[tag] || (words ? 'Text' : 'Element')
  if (large && kind === 'Section') kind = 'Whole section'
  return words ? `${kind}: ${clip(words, max)}` : kind
}

// What hovering shows for the element a comment would pin to (as
// anchors.js describeElement): `name`, its plain label; `label`, the last
// selector step and its text (for people who read selectors); and `large`
// when it covers a fifth of the page or more.
export function describeAt(map, position, native) {
  const item = map.elements[position]
  const selector = selectorOf(map, position)
  const step = selector ? selector.split(' > ').pop() : item.t
  const text = item.x || ''
  const [left, top, width, height] = item.b
  const area = native?.width && native?.height ? (width * height) / (native.width * native.height) : 0
  const large = area > 0.2
  return {
    name: plainLabel(item.t, text, { large }),
    label: `${clip(step, 48)}${text ? ` "${clip(text, 28)}"` : ''}`,
    large,
    rect: { left, top, width, height },
  }
}

// A click at page coordinates as an anchor, or null (as anchors.js anchorAt).
export function anchorFromMap(map, x, y, native = null) {
  const position = hitTest(map, x, y)
  if (position < 0) return null
  const item = map.elements[position]
  const [left, top, width, height] = item.b
  if (!width || !height) return null
  const selector = selectorOf(map, position)
  if (!selector || !ANCHOR_SELECTOR_RE.test(selector)) return null
  const clamp = (value) => Math.max(0, Math.min(1, value))
  const round = (value) => Math.round(clamp(value) * 10000) / 10000
  return {
    selector,
    text: item.x || '',
    dx: round((x - left) / width),
    dy: round((y - top) / height),
    ...(native?.width && native?.height ? { w: round(width / native.width), h: round(height / native.height) } : {}),
  }
}

// CSS escapes in an identifier or a quoted string: \41 (hex, one optional
// space after it) or \x (that character).
function cssUnescape(value) {
  return value.replace(/\\(?:([0-9a-fA-F]{1,6}) ?|([^\n\r\f]))/g, (match, hex, char) => {
    if (hex === undefined) return char
    const code = parseInt(hex, 16)
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code)
  })
}

const STEP_RES = {
  id: new RegExp(`#(${ID_BODY})`, 'y'),
  tag: /([a-z][a-z0-9-]{0,40})/y,
  attr: new RegExp(`\\[(data-testid|aria-label)="(${ATTR_VALUE})"\\]`, 'y'),
  nth: /:nth-of-type\(([1-9][0-9]{0,4})\)/y,
  join: / > /y,
}

// A stored selector as steps, or null when it is not in the anchor grammar.
export function parseSelector(selector) {
  if (typeof selector !== 'string' || !ANCHOR_SELECTOR_RE.test(selector)) return null
  const steps = []
  let at = 0
  const take = (re) => {
    re.lastIndex = at
    const match = re.exec(selector)
    if (match) at = re.lastIndex
    return match
  }
  while (at < selector.length) {
    if (steps.length && !take(STEP_RES.join)) return null
    let match = take(STEP_RES.id)
    if (match) {
      steps.push({ id: cssUnescape(match[1]) })
      continue
    }
    match = take(STEP_RES.tag)
    if (!match) return null
    const tag = match[1]
    match = take(STEP_RES.attr)
    if (match) {
      steps.push({ tag, [match[1] === 'data-testid' ? 'testId' : 'label']: cssUnescape(match[2]) })
      continue
    }
    match = take(STEP_RES.nth)
    if (!match) return null
    steps.push({ tag, nth: Number(match[1]) })
  }
  return steps
}

function stepMatches(item, step) {
  if (step.id !== undefined) return item.i === step.id
  if (item.t !== step.tag) return false
  if (step.testId !== undefined) return item.d === step.testId
  if (step.label !== undefined) return item.r === step.label
  return item.n === step.nth
}

// Every element (document order) a stored selector names: the map's answer
// to querySelectorAll() for the anchor grammar (child combinators). `max`
// stops the search early.
export function matchSelectorAll(map, selector, max = Infinity) {
  const found = []
  const steps = parseSelector(selector)
  if (!steps?.length) return found
  const elements = map?.elements || []
  const last = steps[steps.length - 1]
  for (let position = 0; position < elements.length && found.length < max; position += 1) {
    if (!stepMatches(elements[position], last)) continue
    let node = elements[position].p
    let ok = true
    for (let step = steps.length - 2; step >= 0; step -= 1) {
      if (node < 0 || !stepMatches(elements[node], steps[step])) {
        ok = false
        break
      }
      node = elements[node].p
    }
    if (ok) found.push(position)
  }
  return found
}

// The first element a stored selector names, or -1 (querySelector()).
export const matchSelector = (map, selector) => matchSelectorAll(map, selector, 1)[0] ?? -1

function lastTag(selector) {
  const last = String(selector).split('>').pop().trim()
  const match = /^([a-z][a-z0-9-]*)/i.exec(last)
  return match ? match[1].toLowerCase() : null
}

// Finds the anchored element on the map (as anchors.js resolveAnchor did on
// the DOM): by selector, checked against the saved text, then by its text
// alone among elements of the same tag. { x, y, box } in percent of the
// native page, or null when it is gone.
export function resolveOnMap(map, anchor, native) {
  if (!map?.elements?.length || !anchor?.selector || !native || !ANCHOR_SELECTOR_RE.test(anchor.selector)) return null
  const wanted = String(anchor.text || '')
  const elements = map.elements
  let found = matchSelector(map, anchor.selector)
  // The map keeps the first 80 characters: a match on those is a match on
  // the whole text (the stored anchor text is at most 80 characters).
  if (found >= 0 && wanted && !(elements[found].x || '').startsWith(wanted)) found = -1
  const tag = lastTag(anchor.selector)
  if (found < 0 && wanted && tag) {
    let bestArea = Infinity
    for (let position = 0; position < elements.length; position += 1) {
      const item = elements[position]
      if (item.t !== tag || item.l || item.x !== wanted) continue
      const area = item.b[2] * item.b[3]
      if (area > 0 && area < bestArea) {
        found = position
        bestArea = area
      }
    }
  }
  if (found < 0) return null
  const [left, top, width, height] = elements[found].b
  if (!width && !height) return null
  const percent = (value, size) => Math.max(0, Math.min(100, (value / size) * 100))
  const dx = Number.isFinite(anchor.dx) ? anchor.dx : 0.5
  const dy = Number.isFinite(anchor.dy) ? anchor.dy : 0.5
  return {
    x: percent(left + dx * width, native.width),
    y: percent(top + dy * height, native.height),
    box: {
      left: percent(left, native.width),
      top: percent(top, native.height),
      right: percent(left + width, native.width),
      bottom: percent(top + height, native.height),
    },
  }
}

// The file name of the map that goes with a live HTML file.
export const elementMapName = (liveFile) => String(liveFile).replace(/\.html$/, '.elements.json')
