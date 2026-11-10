// A comment's fields, checked the same way everywhere: the anchor a pin
// sits on, the fix reference, the body's limit, and the error they throw.
// Pure, with no imports, so the server (src/store.js re-exports all of it)
// and the demo's in-browser backend (client/src/demo) share one set of rules.

export const COMMENT_BODY_MAX = 2000
export const ANCHOR_SELECTOR_MAX = 600
export const ANCHOR_TEXT_MAX = 80

// The only selectors an anchor may hold: what the client's selectorFor()
// emits. Steps are `#id` (CSS-escaped), `tag[data-testid="..."]`,
// `tag[aria-label="..."]` or `tag:nth-of-type(n)`, joined by ` > `.
// Keep in sync with client/src/board/anchors.js.
const ANCHOR_STEP = String.raw`(?:#(?:[A-Za-z0-9_\u0080-￿-]|\\[0-9a-fA-F]{6} ?|\\[0-9a-fA-F]{1,5}(?![0-9a-fA-F]) ?|\\[^0-9a-fA-F\n\r\f])+|[a-z][a-z0-9-]{0,40}(?:\[(?:data-testid|aria-label)="(?:[^"\\\n]|\\.){0,200}"\]|:nth-of-type\([1-9][0-9]{0,4}\)))`
export const ANCHOR_SELECTOR_RE = new RegExp(`^${ANCHOR_STEP}(?: > ${ANCHOR_STEP}){0,79}$`)

export class CommentError extends Error {
  constructor(statusCode, code, message, options) {
    super(message, options)
    this.statusCode = statusCode
    this.code = code
  }
}

export function validateAnchor(anchor) {
  if (anchor === undefined || anchor === null) return null
  const bad = (message) => new CommentError(400, 'invalid_anchor', message)
  if (typeof anchor !== 'object' || Array.isArray(anchor)) throw bad('The anchor must be an object.')
  const selector = typeof anchor.selector === 'string' ? anchor.selector.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (!selector || selector.length > ANCHOR_SELECTOR_MAX || /[\u0000-\u001f\u007f]/.test(selector)) {
    throw bad(`The anchor selector must be 1 to ${ANCHOR_SELECTOR_MAX} printable characters.`)
  }
  if (!ANCHOR_SELECTOR_RE.test(selector)) throw bad('The anchor selector is not one Shapewall writes.')
  if (anchor.text !== undefined && typeof anchor.text !== 'string') throw bad('The anchor text must be a string.')
  const text = typeof anchor.text === 'string' ? anchor.text.replace(/\s+/g, ' ').trim() : ''
  if (text.length > ANCHOR_TEXT_MAX) throw bad(`The anchor text is limited to ${ANCHOR_TEXT_MAX} characters.`)
  const { dx, dy } = anchor
  if (
    typeof dx !== 'number' ||
    typeof dy !== 'number' ||
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    dx < 0 ||
    dx > 1 ||
    dy < 0 ||
    dy > 1
  ) {
    throw bad('The anchor offset must be two numbers from 0 to 1.')
  }
  const round = (value) => Math.round(value * 10000) / 10000
  const clean = { selector, text, dx: round(dx), dy: round(dy) }
  // Optional: the element's size as a share of the page, so a pin can sit on
  // the element's corner without the live HTML. Both or neither.
  const share = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
  if (anchor.w !== undefined || anchor.h !== undefined) {
    if (!share(anchor.w) || !share(anchor.h)) throw bad('The anchor size must be two numbers above 0, up to 1.')
    clean.w = round(anchor.w)
    clean.h = round(anchor.h)
  }
  return clean
}

// What fixed a comment: a pull request URL, a commit, a ticket. Plain text;
// the board links it only when it is an http(s) URL. null or '' clears it.
export const FIX_REF_MAX = 300
export function cleanFixRef(value) {
  if (value === null || value === '') return null
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CommentError(400, 'invalid_fix_ref', 'The fix reference must be one line of text (a URL or a commit).')
  }
  const ref = value.trim()
  if (ref.length > FIX_REF_MAX) throw new CommentError(400, 'invalid_fix_ref', `The fix reference is limited to ${FIX_REF_MAX} characters.`)
  return ref || null
}
