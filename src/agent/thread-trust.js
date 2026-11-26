// Thread trust: whether a chat thread may still get an agent's extensions
// (skills and MCP servers from its agent config folder, plan 3.7). One
// transition table and one guard, used by every writer: the hosted server's
// chat store (src/hosted/chat-store.js), a local board's thread files
// (src/agent/threads.js) and the agent's own session when a tool result
// brings other people's text into a running turn (src/agent/backends/acp.js).
//
// A thread's state is { tainted, authors }:
//   authors  the person ids whose text the thread ever carried (hosted: user
//            ids; a local board has no such ids, so its threads only ever
//            hold the owner's text or are tainted). Kept, never pruned: a
//            message that scrolled out of the history still counts.
//   tainted  it carried text no trust block can vouch for. Never cleared.
//
// States (named by what the thread carried, ever):
//
//   clean    only the text of the person who connected the agent (or none)
//   shared   also text by named workspace members (`authors`). Extensions
//            only when every one of them is in the machine's extension set
//            (--extensions-for), checked on the machine every turn
//   tainted  text nobody can vouch for: a share-link guest, someone who is
//            not a member, another agent's answer, a token that is not this
//            agent's, a tool result that returned board text (comments and
//            replies, which anyone who can comment may have written), a
//            thread moved to another agent, or history from before this
//            state was kept (migration 23). Extensions never again
//
// Transitions (`next(state, event)`; `event.kind`):
//
//   | From            | Event                                   | To       |
//   | --------------- | --------------------------------------- | -------- |
//   | clean           | `person` by the owner                   | clean    |
//   | clean, shared   | `person` by a member (user id)          | shared   |
//   | shared          | `person` by the owner or a known author | shared   |
//   | clean, shared   | `person` with more than AUTHORS_MAX ids | tainted  |
//   | clean, shared   | `outside` (guest, non-member, unknown)  | tainted  |
//   | clean, shared   | `agent` answer by another agent         | tainted  |
//   | clean, shared   | `moved` to another agent                | tainted  |
//   | clean, shared   | `tool` result with board text           | tainted  |
//   | clean, shared   | `legacy` (no state was kept)            | tainted  |
//   | any             | `agent` answer by the thread's own agent| same     |
//   | tainted         | anything                                | tainted  |
//   | any             | the thread is deleted                   | (gone; a new thread starts clean) |
//
// The guard is next() itself: no writer sets `tainted` or `authors` any
// other way, and a value next() does not understand (a malformed state, an
// unknown event) moves to tainted. The machine never trusts a clean state
// it cannot read: a trust block without the thread's state reads as
// tainted (capabilities.js cleanTrust).

export const THREAD_STATES = ['clean', 'shared', 'tainted']
export const AUTHORS_MAX = 50
export const TAINT_EVENTS = ['outside', 'agent', 'moved', 'tool', 'legacy']

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

// A stored state, read: anything not of the shape reads as tainted.
export function readThreadTrust(raw) {
  if (raw === undefined || raw === null) return { tainted: false, authors: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { tainted: true, authors: [] }
  if (raw.tainted !== undefined && typeof raw.tainted !== 'boolean') return { tainted: true, authors: [] }
  const authors = raw.authors === undefined || raw.authors === null ? [] : raw.authors
  if (!Array.isArray(authors) || authors.length > AUTHORS_MAX || authors.some((id) => typeof id !== 'string' || !ID_RE.test(id)))
    return { tainted: true, authors: [] }
  return { tainted: raw.tainted === true, authors: [...new Set(authors)] }
}

// The state's name, for the table above.
export function threadStateOf(state, ownerId = null) {
  const read = readThreadTrust(state)
  if (read.tainted) return 'tainted'
  return read.authors.some((id) => id !== ownerId) ? 'shared' : 'clean'
}

// The one guard: the state after `event`. Pure.
//   { kind: 'person', id }   text by a person with this id (owner or member);
//                            no id: read as `outside`
//   { kind: 'agent', own }   an agent's answer; own: the thread's own agent
//   { kind: 'outside' | 'moved' | 'tool' | 'legacy' }
export function nextThreadTrust(state, event) {
  const now = readThreadTrust(state)
  if (now.tainted) return now
  const tainted = { tainted: true, authors: now.authors }
  if (!event || typeof event !== 'object') return tainted
  switch (event.kind) {
    case 'person': {
      if (typeof event.id !== 'string' || !ID_RE.test(event.id)) return tainted
      if (now.authors.includes(event.id)) return now
      if (now.authors.length >= AUTHORS_MAX) return tainted
      return { tainted: false, authors: [...now.authors, event.id] }
    }
    case 'agent':
      return event.own === true ? now : tainted
    default:
      return tainted
  }
}

// Several events in order.
export const applyThreadTrust = (state, events) => events.reduce(nextThreadTrust, readThreadTrust(state))

// The board tools whose results carry other people's text (comments and
// their replies): a turn that called one is tainted from then on. Captured
// page text (list_pages, compare_captures) stays quoted as untrusted data
// and does not taint: it is the app's, not a person's on the board
// (docs/agent-hardening.md, residual risk).
export const TAINTING_BOARD_TOOLS = ['list_comments', 'get_comment']
// The same tools as the owner MCP server's (owner-mcp.js, server "shapewall")
// names reach an ACP agent: mcp__shapewall__list_comments.
export const taintingToolName = (name) => {
  if (typeof name !== 'string') return false
  const bare = name.startsWith('mcp__shapewall__') ? name.slice('mcp__shapewall__'.length) : name
  return TAINTING_BOARD_TOOLS.includes(bare)
}
