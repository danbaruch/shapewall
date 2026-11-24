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

// Whether a comment or reply carries something besides text: an image or a
// drawing with shapes. Takes what a client sends, a stored comment and the
// CLI's export item (where a drawing is { shapes: count }).
export function hasCommentMedia(item) {
  const shapes = item?.drawing?.shapes
  return (Array.isArray(item?.images) && item.images.length > 0) || (Array.isArray(shapes) ? shapes.length > 0 : shapes > 0)
}

// What stands in for the text of a comment or reply that has none:
// "(drawing)", "(image)", "(2 images)", "(image and drawing)". '' when it has
// neither, so callers keep their own fallback.
export function mediaLabel(item) {
  const images = Array.isArray(item?.images) ? item.images.length : 0
  const drawn = hasCommentMedia({ drawing: item?.drawing })
  const parts = [images === 1 ? 'image' : images ? `${images} images` : '', drawn ? 'drawing' : ''].filter(Boolean)
  return parts.length ? `(${parts.join(' and ')})` : ''
}

// The text to show where a comment or reply needs a line of it (lists,
// titles, notifications, the CLI): its own, or the stand-in above.
export function commentText(item) {
  const body = typeof item?.body === 'string' ? item.body : ''
  return body.trim() ? body : mediaLabel(item)
}

// The text of a comment or reply, cleaned. Empty text is refused unless
// `media` says an image or a drawing comes with it: a drawing or a
// screenshot can be the whole comment.
export function cleanCommentBody(value, { media = false } = {}) {
  const body = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
  if (!body && !media) throw new CommentError(400, 'empty_comment', 'Write something first.')
  if (body.length > COMMENT_BODY_MAX)
    throw new CommentError(400, 'comment_too_long', `Comments are limited to ${COMMENT_BODY_MAX} characters.`)
  return body
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
  // Optional: true when the selector found no element in the capture it was
  // pinned on (`comments add --selector`), so nothing names an element that
  // is not there. Kept only when true.
  if (anchor.unmatched !== undefined && typeof anchor.unmatched !== 'boolean') throw bad('The anchor unmatched flag must be true or false.')
  if (anchor.unmatched === true) clean.unmatched = true
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

// The agent status of a comment once it is resolved: work that was queued
// or under way counts as done (nobody is working on a resolved comment),
// and a question for a person is answered, so needs-human is cleared. done
// and branch-ready stay (a branch still waits to be applied).
export function agentStatusOnResolve(current) {
  if (current === 'queued' || current === 'working') return 'done'
  return current === 'needs-human' ? null : (current ?? null)
}

// ---- Agent status transitions ------------------------------------------------
//
// One rule set for every store: the local one (src/store.js), the hosted one
// (src/hosted/comments.js) and the demo's in-browser ones
// (client/src/demo/backend/comments.js, client/src/lib/browserComments.js).
// Each calls these on every write instead of re-stating the rules.
//
// - On an open comment any status may follow any other: agents and people
//   set the public statuses freely (the CLI, MCP, the API). Concurrency is
//   the callers' compare-and-set (`onlyFrom`) and, locally, the claim id.
// - On a resolved comment nothing new starts: queued, working, needs-human
//   and branch-ready are refused. done and null (clear) are always fine.
// - Except a fix waiting on a branch (branch-ready), which a resolve keeps:
//   Apply, Discard and Undo still move it to done, null or needs-human.
//
// The one deliberate difference between stores is permissions, not rules:
// who may set a status (hosted: board admins set one, other members only
// clear it, a token needs its scopes; locally whoever may write the board).

// The statuses that mean an agent holds the comment right now (a claim).
export const CLAIM_STATUSES = ['queued', 'working']
// What a new fix may start from: not a comment an agent holds, and not a fix
// still waiting on its branch (apply or discard that first).
export const FIXABLE_FROM = [null, 'done', 'needs-human']

const storedAgentStatus = (value) => (STORED_AGENT_STATUSES.includes(value) ? value : null)

// Why `comment` ({ status, agentStatus }) may not move to agent status
// `next`, or null when it may. Moving to the status it has is no move.
export function agentTransitionError(comment, next) {
  const current = storedAgentStatus(comment?.agentStatus)
  if ((next ?? null) === current) return null
  if (comment?.status !== 'resolved') return null
  if (next === null || next === undefined || next === 'done') return null
  if (current === BRANCH_READY && next === 'needs-human') return null
  return `Comment #${comment?.id ?? '?'} is resolved: it cannot be ${next}. Reopen it first.`
}

// Throws CommentError 409 invalid_transition when the move is refused.
export function checkAgentTransition(comment, next) {
  const message = agentTransitionError(comment, next)
  if (message) throw new CommentError(409, 'invalid_transition', message)
}

// The agent status a resolve leaves. `requested`: the status the resolver
// asked for with it (undefined: none). A waiting branch stays when the
// resolver asks for nothing or for done (an agent's resolve_comment says
// done): it still waits to be applied. A comment resolved again that still
// says queued or working (imported, or from before this rule) is repaired to done.
export function agentStatusForResolve(comment, requested) {
  const current = storedAgentStatus(comment?.agentStatus)
  if (current === BRANCH_READY && (requested === undefined || requested === 'done')) return BRANCH_READY
  if (requested !== undefined) {
    checkAgentTransition({ ...comment, status: 'resolved' }, requested)
    return requested
  }
  return agentStatusOnResolve(current)
}

// The fields a resolve changes, or null when the comment is resolved
// already and nothing needs repair. { status, resolvedAt, agentStatus }.
export function onResolve(comment, { requested, now = new Date() } = {}) {
  const agentStatus = agentStatusForResolve(comment, requested)
  const already = comment?.status === 'resolved'
  if (already && agentStatus === storedAgentStatus(comment?.agentStatus)) return null
  return {
    status: 'resolved',
    resolvedAt: already && comment.resolvedAt ? comment.resolvedAt : now.toISOString(),
    agentStatus,
  }
}

// The fields a reopen changes, or null when the comment is open already.
// A reopened comment is new work: the agent status clears (nobody holds it),
// except a fix waiting on its branch, which still waits. It counts the
// reopen. { status, resolvedAt, resolution, reopenCount, reopenedAt, agentStatus }.
export function onReopen(comment, { requested, now = new Date() } = {}) {
  if (comment?.status !== 'resolved') return null
  const current = storedAgentStatus(comment?.agentStatus)
  const count = Number(comment?.reopenCount)
  return {
    status: 'open',
    resolvedAt: null,
    resolution: null,
    reopenCount: (Number.isSafeInteger(count) && count > 0 ? count : 0) + 1,
    reopenedAt: now.toISOString(),
    agentStatus: requested !== undefined ? requested : current === BRANCH_READY ? BRANCH_READY : null,
  }
}

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
