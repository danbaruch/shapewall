// Comments brought in from a 1.x board (or a hosted import) that wait for the
// owner's OK before agents get them (2.0 B-20).
//
// 1.x never recorded who wrote a comment: on a board without accounts it may
// have been the owner, a visitor on the LAN (1.1.0 `serve --host 0.0.0.0` has
// no sign-in), an agent's `shapewall comments add`, or a comments.json that
// came with a cloned repository. So `shapewall migrate` imports them (the
// owner's, on a board without accounts) but never vouches for them: no
// dispatch hash, not approved to run. Here the owner sends them in one step,
// each with the dispatch hash of the text they were shown (`expect`), the
// same vouch as "Send to agent" on one comment: a comment edited since is
// skipped, never sent unread.

import { AgentPolicyError, isWaitingImported } from './agent-policy.js'

export { isWaitingImported }

// The open comments of `board` that came in by an import, are not vouched
// for, and could be (not an agent's or a guest's), oldest first.
const WAITING = `imported_at IS NOT NULL AND dispatch_hash IS NULL AND status = 'open'
  AND import_author_kind NOT IN ('agent', 'guest') AND author_share_id IS NULL AND author_token_id IS NULL
  AND COALESCE(author_user_id, imported_by, NULLIF(imported, 0)) IS NOT NULL`

export function waitingImported(t, project, board) {
  return t.all(
    `SELECT * FROM comments WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND ${WAITING} ORDER BY number`,
    { project, board },
  )
}

// How many wait, on every board of the project (what `serve` says at start).
export function countWaitingImported(t, project) {
  return t.get(`SELECT COUNT(*) AS n FROM comments WHERE workspace_id = :ws AND project_id = :project AND ${WAITING}`, { project }).n
}

// The line `serve` prints at start while any wait (null when none).
export function waitingOkLine(count) {
  if (!count) return null
  return `${count} comment${count === 1 ? '' : 's'} from 1.x wait${count === 1 ? 's' : ''} for your OK before agents get ${count === 1 ? 'it' : 'them'}: read and send ${count === 1 ? 'it' : 'them'} with "Send to agents" on the board, or shapewall comments approve --imported.`
}

// Vouches for each of `items` ({ number, dispatchHash }) as `user`, approved
// to run, and addresses it as a person's send does. Inside the caller's
// transaction. Returns { sent, changed, skipped } (comment numbers): changed,
// edited since the owner saw it (left as it is); skipped, no longer waiting.
export function sendImported({ t, policy, agents, project, board, user, role, items }) {
  if (!Array.isArray(items) || !items.length || items.length > 500)
    throw new AgentPolicyError(400, 'invalid_items', 'Send a list of { number, dispatchHash } for the comments you read (1 to 500).')
  const sent = []
  const changed = []
  const skipped = []
  const seen = new Set()
  for (const item of items) {
    const number = Number(item?.number)
    if (!Number.isSafeInteger(number) || number < 1 || seen.has(number))
      throw new AgentPolicyError(400, 'invalid_items', 'Each item needs a comment number, once.')
    seen.add(number)
    const row = t.get(
      'SELECT * FROM comments WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number',
      {
        project,
        board,
        number,
      },
    )
    if (!isWaitingImported(row)) {
      skipped.push(number)
      continue
    }
    try {
      policy.vouch(project, board, row, user, {
        approve: true,
        role,
        expect: typeof item.dispatchHash === 'string' ? item.dispatchHash : '',
      })
    } catch (error) {
      if (error.code === 'comment_changed' || error.code === 'dispatch_hash_required') {
        changed.push(number)
        continue
      }
      throw error
    }
    agents.address(project, board, row, { userId: user, role })
    sent.push(number)
  }
  return { sent, changed, skipped }
}
