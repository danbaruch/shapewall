// Live HTML sanitizer. A captured page's DOM snapshot becomes one
// self-contained document that Shapewall serves into a sandboxed iframe. This
// is the strict, allowlist sanitizer that runs in Node on every snapshot
// before it is written (the in-page snapshot already drops scripts; this pass
// does not trust it).
//
// - Parsed with parse5 (the HTML spec parser), so what we check is exactly
//   what a browser will build. Serialized back with parse5.
// - Elements: allowlist. Dangerous ones (script, noscript, iframe, object,
//   embed, base, link, template, audio/video, svg animate/set/foreignObject,
//   ...) are dropped with their content; unknown elements are unwrapped.
// - Attributes: allowlist per element; every `on*` handler, srcset, target,
//   formaction and friends are dropped. URLs: links keep http(s)/mailto/tel/#
//   only (absolute against the page URL); images keep data:image/* only.
// - Hidden inputs are dropped and password/hidden values are never kept, so
//   CSRF tokens and typed secrets do not leave the page.
// - CSS (<style> text and style attributes): @import, expression(),
//   -moz-binding and behavior are removed; url() keeps only data: images and
//   fonts and #fragments. Remote URLs are handed to `resolveUrl`, which the
//   capture uses to inline what it fetched (or to drop it).
// - meta: only charset and name=viewport survive (no refresh).
//
// The result is also served with a CSP that allows no script at all and is
// framed with sandbox="allow-same-origin" (no allow-scripts): three layers.

import { parse, serialize } from 'parse5'
import { CLOBBER_NAMES } from './dom-names.js'

const DROP_WITH_CONTENT = new Set([
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'link',
  'template',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'portal',
  'param',
  'math',
  'dialog',
  // SVG elements that can run or load things
  'foreignobject',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'discard',
  'handler',
  'listener',
])

const HTML_ELEMENTS = new Set([
  'html',
  'head',
  'body',
  'title',
  'meta',
  'style',
  'div',
  'span',
  'p',
  'a',
  'img',
  'br',
  'hr',
  'wbr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'section',
  'article',
  'address',
  'figure',
  'figcaption',
  'blockquote',
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'mark',
  'time',
  'abbr',
  'cite',
  'q',
  'dfn',
  'small',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'bdi',
  'bdo',
  'ruby',
  'rt',
  'rp',
  'data',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'menu',
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'form',
  'fieldset',
  'legend',
  'label',
  'button',
  'input',
  'select',
  'option',
  'optgroup',
  'textarea',
  'output',
  'progress',
  'meter',
  'details',
  'summary',
  'picture',
  'center',
  'font',
])

const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
  'text',
  'tspan',
  'textpath',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'marker',
  'filter',
  'fegaussianblur',
  'feoffset',
  'feblend',
  'fecolormatrix',
  'fecomposite',
  'feflood',
  'femerge',
  'femergenode',
  'femorphology',
  'fedropshadow',
  'image',
])

const GLOBAL_ATTRS = new Set([
  'class',
  'id',
  'style',
  'title',
  'lang',
  'dir',
  'role',
  'hidden',
  'tabindex',
  'translate',
  'width',
  'height',
  'align',
  'valign',
])

const ELEMENT_ATTRS = {
  a: ['href'],
  img: ['src', 'alt'],
  meta: ['charset', 'name', 'content'],
  td: ['colspan', 'rowspan', 'headers', 'scope'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  time: ['datetime'],
  data: ['value'],
  label: ['for'],
  button: ['type', 'value', 'disabled'],
  input: ['type', 'value', 'placeholder', 'checked', 'disabled', 'readonly', 'multiple', 'min', 'max', 'step', 'size', 'maxlength'],
  select: ['multiple', 'disabled', 'size'],
  option: ['value', 'selected', 'disabled', 'label'],
  optgroup: ['label', 'disabled'],
  textarea: ['placeholder', 'rows', 'cols', 'disabled', 'readonly', 'maxlength'],
  form: [],
  fieldset: ['disabled'],
  output: ['for'],
  progress: ['value', 'max'],
  meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
  details: ['open'],
  font: ['color', 'face', 'size'],
}

const SVG_ATTRS = new Set([
  'viewbox',
  'preserveaspectratio',
  'xmlns',
  'version',
  'd',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'stroke-miterlimit',
  'clip-rule',
  'clip-path',
  'clippathunits',
  'mask',
  'maskunits',
  'maskcontentunits',
  'opacity',
  'transform',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'points',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'markerwidth',
  'markerheight',
  'refx',
  'refy',
  'orient',
  'markerunits',
  'marker-start',
  'marker-mid',
  'marker-end',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
  'dx',
  'dy',
  'textlength',
  'lengthadjust',
  'vector-effect',
  'focusable',
  'aria-hidden',
  'color',
  'display',
  'visibility',
  'overflow',
  'filter',
  'stddeviation',
  'in',
  'in2',
  'result',
  'mode',
  'operator',
  'values',
  'flood-color',
  'flood-opacity',
  'k1',
  'k2',
  'k3',
  'k4',
  'radius',
  'filterunits',
  'primitiveunits',
  'href',
  'shape-rendering',
  'paint-order',
  'mix-blend-mode',
  'isolation',
])

const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i
const SAFE_DATA_FONT_RE =
  /^data:(font\/[a-z0-9.+-]+|application\/(font-woff2?|x-font-[a-z0-9]+|font-sfnt|vnd\.ms-fontobject|octet-stream))[;,]/i
const LINK_SCHEME_RE = /^(https?:|mailto:|tel:)/i
const MAX_ATTR_LENGTH = 4000
// Data URIs are long by nature; everything else is capped above.
const MAX_DATA_URI_LENGTH = 4 * 1024 * 1024

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).toString()
  } catch (_) {
    return null
  }
}

// The browser's own whitespace/control trimming on URL attributes, so
// "java\nscript:" style tricks are judged after normalization.
function normalizeUrlValue(value) {
  // URL parsers delete tabs and newlines anywhere and trim C0 controls and
  // spaces at both ends; do the same before judging the scheme.
  return (
    String(value || '')
      .replace(/[\t\n\r]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
  )
}

export function isSafeHref(raw, base) {
  const value = normalizeUrlValue(raw)
  if (!value) return null
  if (value.startsWith('#')) return value
  const absolute = absoluteUrl(value, base)
  if (!absolute) return null
  return LINK_SCHEME_RE.test(absolute) ? absolute : null
}

// CSS: drop @import and legacy script-in-CSS hooks; route every url() through
// `resolveUrl(absoluteUrl, kind)` which returns a data: URI or null.
// CSS escapes can spell any identifier: `\75rl(` is `url(`, `@\69mport` is
// `@import`. Escapes that stand for letters, `-` or `_` (all those keywords
// are made of) are decoded in place first, with the same meaning to a CSS
// parser, so the matching below sees what the browser will see.
// Everything else stays escaped, because decoding it would change the meaning:
// an escaped `(`, `:`, `@`, `.`, `/` or digit is part of an identifier, never
// a function call, declaration, at-rule or number (`url\28 x)` is one ident,
// not url()), and Tailwind class selectors depend on them staying escaped
// (`.lg\:translate-x-0`, `.w-1\/2`, `.\32xl\:grid`, `.w-\[min\(85vw\2c 20rem\)\]`).
// Quotes, backslashes and newlines stay escaped so strings keep their shape.
const CSS_DECODABLE_RE = /[A-Za-z\-_]/
function decodeCssEscapes(text) {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^0-9a-fA-F\n\r\f]))/g, (whole, hex, literal) => {
    const char = hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : literal
    return CSS_DECODABLE_RE.test(char) && char.length === 1 ? char : whole
  })
}

// image-set() and src() take plain strings as URLs, not only url(): any of
// them with a string that is not a data: image (or an in-document #ref) goes.
function stripStringUrlFunctions(text) {
  return text.replace(/(?:-webkit-)?image-set\((?:[^()]|\([^()]*\))*\)|\bsrc\((?:[^()]|\([^()]*\))*\)/gi, (whole) => {
    const strings = whole.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) || []
    const safe = strings.every((quoted) => {
      const value = quoted.slice(1, -1).trim()
      return value.startsWith('#') || SAFE_DATA_IMAGE_RE.test(value)
    })
    return safe ? whole : 'none'
  })
}

// The scans below run in linear time on any input (a run of unterminated
// `url(` or `@font-face{` must not make each one rescan the rest of the
// text). `nextOf(text, chars)` answers "the next index at or after `start`
// holding one of `chars`" and remembers its last answer, so callers that ask
// with increasing starts walk the text once.
function nextOf(text, chars) {
  let from = Infinity
  let found = -1
  return (start) => {
    if (start >= from && (found === -1 || start <= found)) return found
    from = start
    found = -1
    for (let i = start; i < text.length; i += 1) {
      if (chars.includes(text[i])) {
        found = i
        break
      }
    }
    return found
  }
}

function skipSpace(text, index) {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i += 1
  return i
}

// [start, end) of every complete `@font-face { ... }` block, in order.
function fontFaceRanges(text) {
  const ranges = []
  const closeBrace = nextOf(text, '}')
  const re = /@font-face\s*\{/gi
  let match
  while ((match = re.exec(text))) {
    const close = closeBrace(match.index + match[0].length)
    if (close === -1) break
    ranges.push([match.index, close + 1])
    re.lastIndex = close + 1
  }
  return ranges
}

// Replaces each `url( "x" )`, `url('x')` or `url(x)` (the forms a browser
// reads as one URL token or a url() with a string) with `replace(dq, sq,
// bare, offset)`. Unterminated forms stay for the sweep after.
function replaceUrlTokens(text, replace) {
  const closeQuote = { '"': nextOf(text, '"'), "'": nextOf(text, "'") }
  const bareEnd = nextOf(text, ')\'"')
  const re = /url\(/gi
  let out = ''
  let last = 0
  let match
  while ((match = re.exec(text))) {
    const start = match.index
    const open = skipSpace(text, start + 4)
    const quote = text[open]
    let end = -1
    let parts = null
    if (quote === '"' || quote === "'") {
      const close = closeQuote[quote](open + 1)
      if (close === -1) continue
      const paren = skipSpace(text, close + 1)
      if (text[paren] !== ')') continue
      const value = text.slice(open + 1, close)
      parts = quote === '"' ? [value, undefined, undefined] : [undefined, value, undefined]
      end = paren + 1
    } else {
      const stop = bareEnd(open)
      if (stop === -1 || text[stop] !== ')') continue
      parts = [undefined, undefined, text.slice(open, stop)]
      end = stop + 1
    }
    out += text.slice(last, start) + replace(...parts, start)
    last = end
    re.lastIndex = end
  }
  return out + text.slice(last)
}

// Any url( left that is not one sanitizeCss wrote: a quoted url("...") goes
// whole unless it is a kept data: or #ref, anything else goes up to the end
// of its value (the next `;` or `}`).
function sweepUrls(text) {
  const valueEnd = nextOf(text, ';}')
  const re = /url\(/gi
  let out = ''
  let last = 0
  let match
  while ((match = re.exec(text))) {
    const start = match.index
    let end = -1
    if (text[start + 4] === '"') {
      // The string, escapes included. Scans never overlap: a string that
      // reaches the next `url("` stops at its quote.
      let i = start + 5
      while (i < text.length && text[i] !== '"') {
        if (text[i] !== '\\') i += 1
        else if (i + 1 < text.length && !/[\n\r\u2028\u2029]/.test(text[i + 1])) i += 2
        else break
      }
      if (text[i] === '"' && text[i + 1] === ')') end = i + 2
    }
    let replacement = 'none'
    if (end !== -1) {
      const whole = text.slice(start, end)
      if (/^url\("(data:|#)/i.test(whole)) replacement = whole
    } else {
      const stop = valueEnd(start + 4)
      end = stop === -1 ? text.length : stop
    }
    out += text.slice(last, start) + replacement
    last = end
    re.lastIndex = Math.max(end, start + 1)
  }
  return out + text.slice(last)
}

export function sanitizeCss(css, { base, resolveUrl = () => null, inFontFace = false } = {}) {
  let text = decodeCssEscapes(String(css || ''))
  text = text.replace(/@import\b[^;{}]*;?/gi, '').replace(/@import/gi, '')
  text = text
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/-moz-binding/gi, 'x-binding')
    .replace(/(^|[^-\w])behavior\s*:/gi, '$1x-behavior:')
  text = text.replace(/javascript\s*:/gi, 'x:').replace(/vbscript\s*:/gi, 'x:')
  // Mark which url()s sit inside @font-face blocks (fonts), the rest are images.
  // url()s come in order, so one pointer walks the font ranges.
  const fontRanges = inFontFace ? [] : fontFaceRanges(text)
  let fontIndex = 0
  const inFont = (offset) => {
    while (fontIndex < fontRanges.length && fontRanges[fontIndex][1] <= offset) fontIndex += 1
    return fontIndex < fontRanges.length && offset >= fontRanges[fontIndex][0]
  }
  text = replaceUrlTokens(text, (dq, sq, bare, offset) => {
    const value = normalizeUrlValue(dq ?? sq ?? bare ?? '')
    const kind = inFontFace || inFont(offset) ? 'font' : 'image'
    if (value.startsWith('#')) return `url("${value.replace(/["\\\n]/g, '')}")`
    if (/^data:/i.test(value)) {
      const ok =
        value.length <= MAX_DATA_URI_LENGTH &&
        (kind === 'font' ? SAFE_DATA_FONT_RE.test(value) || SAFE_DATA_IMAGE_RE.test(value) : SAFE_DATA_IMAGE_RE.test(value))
      return ok ? `url("${value.replace(/["\\\n]/g, (c) => encodeURIComponent(c))}")` : 'none'
    }
    const absolute = absoluteUrl(value, base)
    if (!absolute || !/^https?:/i.test(absolute)) return 'none'
    const inlined = resolveUrl(absolute, kind)
    return inlined &&
      (kind === 'font' ? SAFE_DATA_FONT_RE.test(inlined) || SAFE_DATA_IMAGE_RE.test(inlined) : SAFE_DATA_IMAGE_RE.test(inlined))
      ? `url("${inlined.replace(/["\\\n]/g, (c) => encodeURIComponent(c))}")`
      : 'none'
  })
  text = stripStringUrlFunctions(text)
  // Any url( left that is not one we just wrote (an odd or unterminated form
  // the pattern above did not take) is replaced, up to the end of its value.
  text = sweepUrls(text)
  // A literal end tag inside CSS would close the style element.
  return text.replace(/<\/(style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

export function placeholderSvg(width, height) {
  const w = Math.max(1, Math.min(4000, Math.round(Number(width) || 0))) || 1
  const h = Math.max(1, Math.min(8000, Math.round(Number(height) || 0))) || 1
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#e5e7eb"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

// data-* attributes can carry ids, tokens and state. Kept: data-testid
// (comment anchors use it) and short keyword values such as
// data-state="open" or data-side="left", which component libraries style
// with; nothing that could hold a token (digits, punctuation, length) survives.
function isKeptDataAttribute(name, value) {
  if (!/^data-[a-z0-9-]{1,40}$/.test(name)) return false
  if (name === 'data-testid') return value.length <= 120
  return /^[a-zA-Z][a-zA-Z-]{0,23}$/.test(value) || value === ''
}

function inputType(node) {
  const attr = (node.attrs || []).find((item) => attrName(item) === 'type')
  return String(attr?.value || 'text').trim()
}

function attrName(attr) {
  return (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase()
}

function sanitizeAttributes(node, tag, isSvg, options) {
  const allowedForTag = new Set(ELEMENT_ATTRS[tag] || [])
  const out = []
  let width = null
  let height = null
  for (const attr of node.attrs || []) {
    const name = attrName(attr)
    const value = String(attr.value ?? '')
    if (name === 'data-sw-w') {
      width = value
      continue
    }
    if (name === 'data-sw-h') {
      height = value
      continue
    }
    if (name.startsWith('on')) continue
    // DOM clobbering: no id may shadow a document or form method the board
    // calls (name attributes, which name document properties, are not kept).
    if (name === 'id' && CLOBBER_NAMES.has(value.trim())) continue
    const allowed =
      GLOBAL_ATTRS.has(name) ||
      allowedForTag.has(name) ||
      name.startsWith('aria-') ||
      isKeptDataAttribute(name, value) ||
      (isSvg && (SVG_ATTRS.has(name) || name === 'xlink:href'))
    if (!allowed) continue
    // Secrets that ride in form fields (CSRF tokens, typed passwords) never leave.
    if (tag === 'input' && name === 'value' && /^(password|hidden)$/i.test(inputType(node))) continue
    if (name === 'style') {
      countCss(options, value)
      const css = sanitizeCss(value, { base: options.base, resolveUrl: options.resolveUrl })
      if (css.trim()) out.push({ name: 'style', value: css })
      continue
    }
    if (name === 'href' || name === 'xlink:href') {
      if (isSvg) {
        // SVG references stay inside the document.
        const ref = normalizeUrlValue(value)
        if (ref.startsWith('#') && ref.length < 200)
          out.push({ name: attr.name, prefix: attr.prefix, namespace: attr.namespace, value: ref })
        continue
      }
      let href = isSafeHref(value, options.base)
      // Links to the capture base can be rewritten to a public URL; links to other private hosts go.
      if (href && !href.startsWith('#') && options.rewriteHref) href = options.rewriteHref(href)
      if (href) out.push({ name: 'href', value: href.slice(0, MAX_ATTR_LENGTH) })
      continue
    }
    if (name === 'src') continue // handled by the img branch below
    if (value.length > MAX_ATTR_LENGTH) continue
    out.push({ name: attr.name, prefix: attr.prefix, namespace: attr.namespace, value })
  }
  if (tag === 'img' || (isSvg && tag === 'image')) {
    const raw = (node.attrs || []).find(
      (attr) => attrName(attr) === 'src' || (isSvg && (attrName(attr) === 'href' || attrName(attr) === 'xlink:href')),
    )
    const value = normalizeUrlValue(raw?.value)
    let src = null
    if (/^data:/i.test(value)) src = SAFE_DATA_IMAGE_RE.test(value) && value.length <= MAX_DATA_URI_LENGTH ? value : null
    else if (value) {
      const absolute = absoluteUrl(value, options.base)
      const inlined = absolute && /^https?:/i.test(absolute) ? options.resolveUrl(absolute, 'image') : null
      src = inlined && SAFE_DATA_IMAGE_RE.test(inlined) ? inlined : null
    }
    if (!src) src = placeholderSvg(width, height)
    if (isSvg) {
      const filtered = out.filter((attr) => !['href', 'xlink:href'].includes(attrName(attr)))
      filtered.push({ name: 'href', value: src })
      return filtered
    }
    out.push({ name: 'src', value: src })
  }
  if (tag === 'meta') {
    const names = new Set(out.map((attr) => attr.name.toLowerCase()))
    const nameAttr = out.find((attr) => attr.name.toLowerCase() === 'name')
    if (!names.has('charset') && !(nameAttr && nameAttr.value.toLowerCase() === 'viewport')) return null
  }
  return out
}

function sanitizeChildren(parent, options, inSvg) {
  const kept = []
  for (const child of parent.childNodes || []) {
    const result = sanitizeNode(child, options, inSvg)
    if (!result) continue
    if (Array.isArray(result)) kept.push(...result)
    else kept.push(result)
  }
  kept.forEach((child) => {
    child.parentNode = parent
  })
  parent.childNodes = kept
}

// Returns the node (cleaned), an array of nodes (unwrapped children), or null.
function sanitizeNode(node, options, inSvg = false) {
  if (node.nodeName === '#text') return node
  if (node.nodeName === '#comment' || node.nodeName === '#documentType') return null
  if (!node.tagName) return null
  const tag = node.tagName.toLowerCase()
  const isSvg = inSvg || tag === 'svg' || node.namespaceURI === 'http://www.w3.org/2000/svg'
  if (DROP_WITH_CONTENT.has(tag)) return null
  // Hidden inputs render nothing and usually hold tokens: drop them.
  if (tag === 'input' && /^hidden$/i.test(inputType(node))) return null
  if (node.namespaceURI && !['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg'].includes(node.namespaceURI)) return null
  const known = isSvg ? SVG_ELEMENTS.has(tag) : HTML_ELEMENTS.has(tag)
  if (!known) {
    // Unknown and custom elements: keep the content, lose the wrapper.
    sanitizeChildren(node, options, isSvg)
    return node.childNodes
  }
  if (tag === 'style') {
    const css = (node.childNodes || [])
      .filter((child) => child.nodeName === '#text')
      .map((child) => child.value)
      .join('')
    countCss(options, css)
    const clean = sanitizeCss(css, { base: options.base, resolveUrl: options.resolveUrl })
    node.attrs = []
    node.childNodes = clean ? [{ nodeName: '#text', value: clean, parentNode: node }] : []
    return node
  }
  const attrs = sanitizeAttributes(node, tag, isSvg, options)
  if (attrs === null) return null
  node.attrs = attrs
  if (tag === 'form') node.attrs = node.attrs.filter((attr) => attr.name !== 'action' && attr.name !== 'method')
  sanitizeChildren(node, options, isSvg)
  return node
}

// `maxCss` caps the CSS text of one document (style elements and style
// attributes together); over it, sanitizeDocument throws a CssTooLargeError.
export class CssTooLargeError extends Error {}
function countCss(options, text) {
  options.cssBytes += text.length
  if (options.cssBytes > options.maxCss) throw new CssTooLargeError('the page CSS is over the cap')
}

// Sanitizes a whole document. `base` resolves relative links; `resolveUrl`
// turns a remote URL into a data: URI (or null to drop it).
export function sanitizeDocument(html, { base, resolveUrl = () => null, rewriteHref = null, maxCss = Infinity } = {}) {
  const document = parse(String(html || ''))
  const options = { base, resolveUrl, rewriteHref, maxCss, cssBytes: 0 }
  const htmlNode = (document.childNodes || []).find((child) => child.tagName === 'html')
  if (htmlNode) {
    const cleaned = sanitizeNode(htmlNode, options)
    document.childNodes = [
      { nodeName: '#documentType', name: 'html', publicId: '', systemId: '', parentNode: document },
      ...(cleaned && !Array.isArray(cleaned) ? [cleaned] : []),
    ]
  }
  return serialize(document)
}
