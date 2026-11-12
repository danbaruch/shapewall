// What the board's agents are doing right now, as one summary for the whole
// board: the toolbar's Agent control (and the phone's More button) shows it,
// so a person sees an agent at work with the comments closed or the canvas
// somewhere else. A pure function of what the board already knows (no
// polling of its own), unit-tested in test/agent-activity.test.js.
// On a hosted board the sentence ends with the project's agents by name:
// "Builder online, Fixer offline".
//
//   comments   the board's comments (agentStatus: queued, working, done,
//              needs-human, branch-ready)
//   focus      the chat turn in progress on this board (chat/agentFocus.js:
//              { commentId, state: working | waiting | done | stopped })
//   approvals  hosted boards: shell commands waiting for an admin's OK
//              ([{ comment_number }])
//   titleOf    (pageId) -> the page's title, for "#17 Home"
//   agents     hosted boards: the project's agents (GET
//              api/boards/:id/agents, hostedAgents.js), or null when the
//              board does not know (local boards run their own agent)
//   listening  hosted boards before 0.4.0: { online, name } of the agent
//              last heard from for this project; used when `agents` is null
//
// Returns { state, working, waiting, count, text, target }:
//   state   'waiting'  an agent is stopped until a person answers (a
//                      permission, an approval), or, with nothing running,
//                      a comment waits on a person (needs a person, a fix
//                      ready on a branch)
//           'working'  at least one agent is running
//           'idle'     neither
//   working, waiting   [{ id, name, why }] (why: approval | needs-human |
//                      branch-ready for the waiting ones)
//   count   how many the state is about
//   text    the whole of it in words, for the tooltip and screen readers
//   target  the one comment that needs the person: the only one an agent
//           is stopped on, else the only one waiting
import { agentsSummary, anyOnline } from './hostedAgents.js'

const open = (comment) => comment.status !== 'resolved'

export function agentActivity({ comments = [], focus = null, approvals = [], titleOf = () => '', listening = null, agents = null }) {
  const byId = new Map(comments.map((comment) => [Number(comment.id), comment]))
  const name = (id) => {
    const comment = byId.get(Number(id))
    const title = comment ? titleOf(comment.pageId) : ''
    return title ? `#${id} ${title}` : `#${id}`
  }
  const working = new Map()
  const blocked = new Map()
  const review = new Map()
  const add = (map, id, why) => {
    const key = Number(id)
    if (key > 0 && !map.has(key)) map.set(key, { id: key, name: name(key), why })
  }
  for (const row of approvals) add(blocked, row.comment_number ?? row.commentId, 'approval')
  if (focus?.state === 'waiting') add(blocked, focus.commentId, 'approval')
  if (focus?.state === 'working') add(working, focus.commentId, 'working')
  for (const comment of comments) {
    if (!open(comment)) continue
    if (comment.agentStatus === 'working') add(working, comment.id, 'working')
    else if (comment.agentStatus === 'needs-human') add(review, comment.id, 'needs-human')
    else if (comment.agentStatus === 'branch-ready') add(review, comment.id, 'branch-ready')
  }
  // A comment an agent is stopped on is not also "working".
  for (const id of blocked.keys()) working.delete(id)
  const list = (map) => [...map.values()]
  const waiting = [...list(blocked), ...list(review).filter((item) => !blocked.has(item.id))]
  const state = blocked.size ? 'waiting' : working.size ? 'working' : waiting.length ? 'waiting' : 'idle'
  const count = state === 'working' ? working.size : state === 'waiting' ? (blocked.size ? blocked.size : waiting.length) : 0
  const parts = []
  if (blocked.size === 1) parts.push(`Agent needs your OK on ${list(blocked)[0].name}`)
  else if (blocked.size) parts.push(`Agents need your OK on ${blocked.size} comments: ${names(list(blocked))}`)
  if (working.size === 1) parts.push(`Agent working on ${list(working)[0].name}`)
  else if (working.size) parts.push(`${working.size} agents working: ${names(list(working))}`)
  const passive = waiting.filter((item) => item.why !== 'approval')
  if (passive.length === 1)
    parts.push(
      passive[0].why === 'branch-ready'
        ? // Hosted: the fix is on a branch on the agent's machine; nothing is applied from the board.
          agents
          ? `Fix ready on a branch for ${passive[0].name}`
          : `Fix ready to apply on ${passive[0].name}`
        : `${passive[0].name} needs a person`,
    )
  else if (passive.length) parts.push(`${passive.length} comments wait for you: ${names(passive)}`)
  // Hosted: say which agents would act on a comment, if any.
  if (agents) parts.push(agentsSummary(agents))
  else if (listening) parts.push(listening.online ? `Agent online: ${listening.name || 'agent'}` : NO_LISTENER)
  return {
    state,
    listening: agents ? anyOnline(agents) : listening ? Boolean(listening.online) : null,
    working: list(working),
    waiting,
    count,
    text: parts.join('. '),
    // The one an agent is stopped on comes first; else the only one waiting.
    target: blocked.size === 1 ? list(blocked)[0].id : !blocked.size && waiting.length === 1 ? waiting[0].id : null,
  }
}

export const NO_LISTENER = 'No agent is listening: comments wait until one is'

// "#17 Home, #21 Settings and 2 more".
function names(items, max = 3) {
  const shown = items.slice(0, max).map((item) => item.name)
  return items.length > max ? `${shown.join(', ')} and ${items.length - max} more` : shown.join(', ')
}

// What the control shows a moment after the last agent finished: "done".
// `previous` and `next` are states; true when work just ended with nothing
// left that needs a person.
export const settles = (previous, next) => (previous === 'working' || previous === 'waiting') && next === 'idle'
