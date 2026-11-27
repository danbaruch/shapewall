// Deep links into a board: one builder for every link Shapewall prints or
// sends (the CLI, MCP results, notifications, GitHub issues, usage rows,
// share and push answers), local and hosted alike.
//
//   boardLink({ base, board, page, comment, viewport, compare, follow, filter })
//
// The address keys are the ones the board's client reads (client/src/board/Board.jsx):
//   board   the board id
//   p       a page id: the board opens flown to that page
//   c       a comment number: the board opens on that comment (wins over p)
//   filter  the comment list filter ("all" so a resolved comment shows)
//   vp      the screen size ("desktop", "phone", any configured viewport, or "all")
//   cmp     environment compare, "a_b" (useCompare.js)
//   hist    page history: before and after of the page's captures (History.jsx)
//   hv      the viewport page history shows
//   follow  an agent to follow: an agent id, or "any" (the board's follow mode)
//
// Links carry ids only: never a token, a share secret or anything else that
// grants access. Values are URL-encoded; ids that do not exist on the board
// are ignored by the client.

import { DEFAULT_BOARD_URL, runningBoardUrl } from './serve-state.js'

// The order keys are written in, so the same link always reads the same.
export const LINK_KEYS = Object.freeze(['board', 'p', 'c', 'filter', 'vp', 'cmp', 'hist', 'hv', 'follow'])

const ID_MAX = 200
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const VIEWPORT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const ENV_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

function text(name, value, { max = ID_MAX } = {}) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw new TypeError(`board link: ${name} must be a non-empty id`)
  return value
}

function commentNumber(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('board link: comment must be a positive whole number')
  return n
}

// "a_b", "a,b" or ["a", "b"]: two different environment ids.
function environmentPair(value) {
  const pair = Array.isArray(value) ? value : String(value).split(/[_,]/)
  if (pair.length !== 2 || pair[0] === pair[1] || !pair.every((id) => typeof id === 'string' && ENV_RE.test(id)))
    throw new TypeError('board link: compare takes true (page history) or two different environment ids')
  return pair.join('_')
}

// A base the link is built on: an absolute http(s) URL, or a path from the
// server's root ("/w/<ws>/p/<project>/"). User names and passwords in it are
// refused, so a link never carries one.
function parseBase(base) {
  if (typeof base !== 'string' || !base) throw new TypeError('board link: base must be a URL or a path')
  const relative = base.startsWith('/') && !base.startsWith('//')
  const url = new URL(base, relative ? 'http://relative.invalid' : undefined)
  if (!/^https?:$/.test(url.protocol)) throw new TypeError('board link: base must be http or https')
  if (url.username || url.password) throw new TypeError('board link: base must not carry a user name or password')
  return { url, relative }
}

// The link. `compare`: true for the page's history (before and after of its
// latest recapture; needs `page`), or an environment pair for environment
// compare. `viewport` "all" shows every screen size. Unset options are left
// out; keys the base already has are replaced.
export function boardLink({ base, board, page, comment, viewport, compare, follow, filter } = {}) {
  const { url, relative } = parseBase(base)
  const set = (key, value) => url.searchParams.set(key, value)
  // Written in LINK_KEYS order: drop any of ours the base carries first.
  for (const key of LINK_KEYS) url.searchParams.delete(key)
  set('board', text('board', board))
  if (page != null) set('p', text('page', page))
  if (comment != null) set('c', String(commentNumber(comment)))
  if (filter != null) {
    if (!['open', 'resolved', 'all'].includes(filter)) throw new TypeError('board link: filter is open, resolved or all')
    set('filter', filter)
  }
  if (viewport != null) {
    if (typeof viewport !== 'string' || !VIEWPORT_RE.test(viewport)) throw new TypeError('board link: viewport must be a viewport name')
    set('vp', viewport)
  }
  if (compare === true) {
    if (page == null) throw new TypeError('board link: compare (page history) needs a page')
    set('hist', page)
    if (viewport != null && viewport !== 'all') set('hv', viewport)
  } else if (compare != null && compare !== false) {
    set('cmp', environmentPair(compare))
  }
  if (follow != null) {
    if (typeof follow !== 'string' || !AGENT_ID_RE.test(follow)) throw new TypeError('board link: follow must be an agent id')
    set('follow', follow)
  }
  url.hash = ''
  const out = url.toString()
  return relative ? out.slice('http://relative.invalid'.length) : out
}

// A hosted project's board address: <origin>/w/<workspace>/p/<project>/.
// `origin` '' gives the path alone (links shown inside the console).
// Built from ids, never from a URL a server sent.
export function hostedBoardBase(origin, workspaceId, projectId) {
  const root = origin ? new URL(origin).origin : ''
  return `${root}/w/${encodeURIComponent(text('workspace', workspaceId))}/p/${encodeURIComponent(text('project', projectId))}/`
}

// A local board's address: $SHAPEWALL_BOARD_URL, the config's boardUrl, the caller's own server address
// (`boardUrl`, a running server's), a `shapewall serve` running for this
// config (serve.json), and only then the default port.
// `running`: whether a server is known to answer there (false for the default guess).
export function localBoardBase(config, { boardUrl = null, env = process.env } = {}) {
  const set = env.SHAPEWALL_BOARD_URL || config?.boardUrl || boardUrl
  if (set) return { url: set, running: null, source: 'set' }
  const live = runningBoardUrl(config)
  if (live) return { url: live, running: true, source: 'serve' }
  return { url: DEFAULT_BOARD_URL, running: false, source: 'default' }
}

// What a link names, read back from one (the inverse of boardLink, for tests
// and tools that are handed a link): { board, page, comment, viewport,
// compare, follow, filter }, unset keys left out.
export function parseBoardLink(link) {
  const url = new URL(link, 'http://relative.invalid')
  const get = (key) => url.searchParams.get(key)
  const out = {}
  if (get('board')) out.board = get('board')
  if (get('p')) out.page = get('p')
  if (get('c') && /^\d+$/.test(get('c'))) out.comment = Number(get('c'))
  if (get('filter')) out.filter = get('filter')
  if (get('vp')) out.viewport = get('vp')
  if (get('hist')) out.compare = true
  else if (get('cmp')) out.compare = get('cmp')
  if (get('follow')) out.follow = get('follow')
  return out
}
