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

// A comment's agent status: queued (handed to an agent), working, done (the
// agent thinks it is fixed; a person still resolves) or needs-human (the
// agent stopped and asked). These are the ones agents and people set (CLI,
// MCP, the API). Shapewall also stores branch-ready: an agent in branch mode
// committed its fix on a branch, waiting to be applied to the checkout
// (src/agent/branch-mode.js). Every reader and validator takes all five.
export const AGENT_STATUSES = ['queued', 'working', 'done', 'needs-human']
export const BRANCH_READY = 'branch-ready'
export const STORED_AGENT_STATUSES = [...AGENT_STATUSES, BRANCH_READY]

// Images on comments and replies: the chat's attachment limits
// (src/agent/threads.js ATTACHMENTS_MAX, ATTACHMENT_BYTES_MAX), checked on
// the server by src/comment-media.js and in the demo's backend.
export const COMMENT_IMAGES_MAX = 4
export const COMMENT_IMAGE_BYTES_MAX = 5 * 1024 * 1024
export const COMMENT_IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
// A stored image's file name: 24 hex characters and its type's extension.
export const COMMENT_FILE_RE = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/
const IMAGE_NAME_MAX = 120

// An image's display name: one line, no markup characters.
export const cleanImageName = (value, fallback) =>
  String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>"'`\\/]/g, '')
    .trim()
    .slice(0, IMAGE_NAME_MAX) || fallback

// A stored image record as everyone reads it ({ id, file, name, mediaType,
// bytes, width, height }); anything else (a hand-edited file) is dropped.
export function readImages(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((item) => item && typeof item === 'object' && COMMENT_FILE_RE.test(String(item.file || '')))
    .slice(0, COMMENT_IMAGES_MAX)
    .map((item) => {
      const ext = item.file.split('.').pop()
      const mediaType = Object.keys(COMMENT_IMAGE_TYPES).find((type) => COMMENT_IMAGE_TYPES[type] === ext)
      const size = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null)
      return {
        id: item.file.split('.')[0],
        file: item.file,
        name: cleanImageName(item.name, `image.${ext}`),
        mediaType,
        bytes: size(item.bytes),
        width: size(item.width),
        height: size(item.height),
      }
    })
}
