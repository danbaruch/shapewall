// Follow an agent: the board flies to the pin an agent takes, and after it
// recaptures, shows before and after of that comment's screen. Pure: the
// reducer (the one writer of the follow state) and the functions that turn
// two snapshots of what the board already knows into follow events. No
// React, no fetching; unit-tested in test/follow-agent.test.js. The board
// wires it in hooks/useFollowAgent.js.
//
// Where the events come from: nothing new on the wire. A viewer follows only
// what it may already see: the board's comments (the server filters them by
// audience), their agent status and when it was set, the capture manifest,
// and on a hosted board the project's agents as this member sees them
// (`working`: the comment ids each one holds). A local board's events stream
// and a hosted board's presence invalidate refetch those; the snapshots are
// diffed here.
//
// State: { mode, agentId, comment, compare, others, tookAt, capturedAt, notice }
//   mode       'off' | 'following' | 'comparing'
//   agentId    the agent followed: an agent id (hosted), or ANY_AGENT
//   comment    the comment the agent took last: { id, pageId, viewport }
//   compare    'comparing': the screen whose before and after is open,
//              { pageId, viewport }
//   others     screens the same recaptures changed that did not open
//              (the quiet "2 more screens changed"): [{ pageId, viewport }]
//   tookAt     the newest "took" applied (ms), so a late one is dropped
//   capturedAt the newest recapture applied (a capture version string)
//   notice     why following stopped, for a toast, or null
//
// Transitions:
//   off        start                      following  (the hook then sends the agent's current focus as took)
//   following  took comment N             following  fly to N's pin, select it
//   following  recaptured, N's screen      comparing  open before and after of N's screen (its page at its size only); other screens to `others`
//   following  recaptured, other screens   following  `others` only
//   comparing  took another comment        following  close compare, fly to the new pin
//   comparing  the person closes compare   following
//   following  the person moves the canvas, opens another comment, or presses Stop   off
//   comparing  (same)                                                                off
//   any        the agent goes offline, is removed, or is no longer visible           off, notice
// Events older than the last applied of their kind are dropped (a slow
// refetch that lands after a newer one).

export const ANY_AGENT = 'any'
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

export const FOLLOW_OFF = Object.freeze({
  mode: 'off',
  agentId: null,
  comment: null,
  compare: null,
  others: [],
  tookAt: 0,
  capturedAt: '',
  notice: null,
})

// A follow request from the address (`follow=<agentId>`) or a button: the id,
// or null for one that is not an agent id.
export function followTarget(value) {
  if (value === true) return ANY_AGENT
  return typeof value === 'string' && AGENT_RE.test(value) ? value : null
}

const screenKey = (item) => `${item.pageId}|${item.viewport}`
const sameScreen = (a, b) => Boolean(a && b) && a.pageId === b.pageId && a.viewport === b.viewport

function uniqueScreens(list) {
  const seen = new Set()
  return list.filter((item) => {
    const key = screenKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Of the screens a recapture changed, the one to compare for comment
// `comment`: its own page at its own screen size, or null. Only that screen
// opens by itself (one capture run lands screen by screen; a dialog that
// jumped from one to the next would be hard to watch).
export function primaryScreen(changes, comment) {
  if (!comment) return null
  return changes.find((item) => sameScreen(item, comment)) || null
}

export function followReducer(state, event) {
  if (!event || typeof event !== 'object') return state
  switch (event.type) {
    case 'start': {
      const agentId = followTarget(event.agentId)
      if (!agentId) return state
      if (state.mode !== 'off' && state.agentId === agentId) return state
      return { ...FOLLOW_OFF, mode: 'following', agentId }
    }
    case 'took': {
      if (state.mode === 'off') return state
      const at = Number(event.at) || 0
      if (at < state.tookAt) return state
      const comment = { id: event.commentId, pageId: event.pageId, viewport: event.viewport }
      if (state.comment?.id === comment.id) return at === state.tookAt ? state : { ...state, tookAt: at }
      return { ...state, mode: 'following', comment, compare: null, others: [], tookAt: at }
    }
    case 'recaptured': {
      if (state.mode === 'off') return state
      const at = String(event.at || '')
      if (at && at < state.capturedAt) return state
      const changes = uniqueScreens((event.changes || []).filter((item) => item?.pageId && item?.viewport))
      if (!changes.length) return state
      const primary = primaryScreen(changes, state.comment)
      const capturedAt = at > state.capturedAt ? at : state.capturedAt
      const compare = primary || state.compare
      // Every other changed screen joins the quiet count, never the one compared.
      const others = uniqueScreens([...state.others, ...changes]).filter((item) => !sameScreen(item, compare))
      if (!primary) return { ...state, others, capturedAt }
      return { ...state, mode: 'comparing', compare: primary, others, capturedAt }
    }
    case 'compare-closed':
      return state.mode === 'comparing' ? { ...state, mode: 'following', compare: null } : state
    // The person: a canvas move, another comment, Stop following.
    case 'interrupt':
      return state.mode === 'off' ? state : { ...FOLLOW_OFF }
    // A screen from `others` was looked at: it leaves the chip.
    case 'seen':
      return { ...state, others: state.others.filter((item) => !sameScreen(item, event)) }
    case 'gone':
      return state.mode === 'off' ? state : { ...FOLLOW_OFF, notice: event.notice || 'Stopped following the agent.' }
    case 'notice-shown':
      return state.notice ? { ...state, notice: null } : state
    default:
      return state
  }
}

const time = (value) => {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : 0
}

// The comments the followed agent holds right now, that this viewer can see:
// Map id -> { id, pageId, viewport, at }.
//   comments  the board's comments (agentStatus, agentStatusAt)
//   agents    hosted: the project's agents as this member sees them, or null
//   agentId   the agent followed (ANY_AGENT: whichever)
//   focus     local: the chat turn on this board ({ commentId, state, since })
export function heldComments({ comments = [], agents = null, agentId = ANY_AGENT, focus = null }) {
  const visible = new Map()
  for (const comment of comments) if (comment && comment.status !== 'resolved') visible.set(Number(comment.id), comment)
  let ids = null
  if (agentId !== ANY_AGENT && Array.isArray(agents)) {
    const agent = agents.find((item) => item.id === agentId)
    ids = new Set((agent?.working || []).map(Number))
  }
  const out = new Map()
  const add = (comment, at) => {
    if (!comment || String(comment.pageId || '').startsWith('variant:')) return
    out.set(Number(comment.id), { id: Number(comment.id), pageId: comment.pageId, viewport: comment.viewport, at })
  }
  for (const comment of visible.values()) {
    if (comment.agentStatus !== 'working') continue
    if (ids && !ids.has(Number(comment.id))) continue
    add(comment, time(comment.agentStatusAt))
  }
  if (!ids && focus?.state === 'working') add(visible.get(Number(focus.commentId)), Number(focus.since) || 0)
  return out
}

// The newest of the held comments: where the agent is now. null: none.
export function currentFocus(held) {
  let best = null
  for (const item of held.values()) if (!best || item.at > best.at || (item.at === best.at && item.id > best.id)) best = item
  return best
}

// Each screen's current capture version: Map "page|viewport" -> version
// (sortable strings, src/store.js), from the board view's manifest.
export function captureStamps(manifest) {
  const out = new Map()
  const pages = manifest?.pages
  if (!pages || typeof pages !== 'object') return out
  for (const [pageId, byViewport] of Object.entries(pages)) {
    if (!byViewport || typeof byViewport !== 'object') continue
    for (const [viewport, entry] of Object.entries(byViewport)) {
      if (entry?.status !== 'ok') continue
      const stamp = typeof entry.version === 'string' ? entry.version : String(entry.capturedAt || manifest.capturedAt || '')
      if (stamp) out.set(`${pageId}|${viewport}`, stamp)
    }
  }
  return out
}

// The follow events between two snapshots ({ held, stamps }), oldest first.
// `seen`: the newest capture version seen per screen so far (kept by the
// caller across snapshots and updated here), so a stale view that comes back
// with an older capture never reads as a recapture.
// A first snapshot (`before` null) only records what is there.
export function followEvents(before, after, seen = new Map()) {
  const events = []
  if (!after) return events
  const changes = []
  let newest = ''
  for (const [key, stamp] of after.stamps) {
    const known = seen.get(key)
    if (known !== undefined && stamp <= known) continue
    seen.set(key, stamp)
    if (!before || known === undefined) continue
    const cut = key.lastIndexOf('|')
    changes.push({ pageId: key.slice(0, cut), viewport: key.slice(cut + 1) })
    if (stamp > newest) newest = stamp
  }
  if (!before) return events
  // A comment newly held: the newest of them is where the agent went.
  let took = null
  for (const item of after.held.values()) {
    if (before.held.has(item.id)) continue
    if (!took || item.at > took.at || (item.at === took.at && item.id > took.id)) took = item
  }
  if (took) events.push({ type: 'took', commentId: took.id, pageId: took.pageId, viewport: took.viewport, at: took.at })
  if (changes.length) events.push({ type: 'recaptured', changes, at: newest })
  return events
}

// The followed agent's state on a hosted board, for "gone": 'present',
// 'offline', 'missing', or 'unknown' (any agent, a local board, or the list
// not loaded yet).
export function agentPresence(agents, agentId) {
  if (agentId === ANY_AGENT || !Array.isArray(agents)) return 'unknown'
  const agent = agents.find((item) => item.id === agentId)
  if (!agent) return 'missing'
  return agent.state === 'offline' ? 'offline' : 'present'
}

// The name to show for the agent followed.
export function followName(agents, agentId) {
  if (agentId === ANY_AGENT || !Array.isArray(agents)) return 'the agent'
  return agents.find((item) => item.id === agentId)?.name || 'the agent'
}

// The line under "Following": what the agent is doing as far as this viewer can see.
export function followLine(state, { name = 'the agent', titleOf = () => '' } = {}) {
  if (state.mode === 'off') return ''
  const who = name === 'the agent' ? 'The agent' : name
  if (state.mode === 'comparing' && state.compare) {
    const title = titleOf(state.compare.pageId) || state.compare.pageId
    return `${who} recaptured ${title}`
  }
  if (state.comment) return `${who} is on #${state.comment.id}`
  return `Waiting for ${name} to take a comment`
}

// "2 more screens changed".
export function othersText(others) {
  const count = others?.length || 0
  if (!count) return ''
  return count === 1 ? '1 more screen changed' : `${count} more screens changed`
}
