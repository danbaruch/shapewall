// The permission cards of connected agents on a hosted board (migration
// 14): what an agent asked to do during a fix (edit a file, run a command),
// and what became of it. A row is written when the card arrives from the
// agent's machine, and is the server's own record from then on: who may
// answer is decided against it, an answer is compared with its hash, and
// what the board shows of a card comes from it, not from what the machine
// says later.
//
//   pending    waits for a person, until `expires_at` (2 minutes)
//   approved   a person allowed it (answered_by, answered_at)
//   denied     a person denied it, or the machine did
//   expired    nobody answered in time
//   cancelled  the turn was stopped or ended first
//   auto       the machine allowed it without asking (its own policy and the
//              agent's approval rule both said so)
//
// A card is answered once. Every query goes through the tenant handle `t`.

export const PERMISSION_STATES = ['pending', 'approved', 'denied', 'expired', 'cancelled', 'auto']
export const PERMISSION_LIMITS = {
  // Cards one turn may ask, answered or not: a fix does not ask forever.
  perTurn: 60,
  // Cards of one turn that wait at the same time.
  pendingPerTurn: 5,
}

const parse = (text) => {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export function createPermissionStore(t, { now = () => new Date() } = {}) {
  const iso = () => now().toISOString()
  const get = (turnId, id) =>
    t.get('SELECT * FROM chat_permissions WHERE workspace_id = :ws AND turn_id = :turn AND id = :id', {
      turn: String(turnId || ''),
      id: String(id || ''),
    }) || null
  const ofTurn = (turnId) =>
    t.all('SELECT * FROM chat_permissions WHERE workspace_id = :ws AND turn_id = :turn ORDER BY created_at, rowid', { turn: turnId })
  // A new card of a turn. `card`: its content as hashed (card-hash.js
  // cardContent). Returns the row, or null when the turn already has a card
  // with that id or has asked too much.
  function add(turn, { card, hash, state = 'pending', expiresAt }) {
    const all = ofTurn(turn.id)
    if (all.length >= PERMISSION_LIMITS.perTurn) return null
    if (state === 'pending' && all.filter((row) => row.state === 'pending').length >= PERMISSION_LIMITS.pendingPerTurn) return null
    const result = t.run(
      `INSERT INTO chat_permissions (workspace_id, project_id, id, turn_id, agent_id, board_id, thread_id, kind, card, card_hash, state,
         created_at, expires_at)
       VALUES (:ws, :project, :id, :turn, :agent, :board, :thread, :kind, :card, :hash, :state, :at, :expires)
       ON CONFLICT(workspace_id, turn_id, id) DO NOTHING`,
      {
        project: turn.project_id,
        id: card.id,
        turn: turn.id,
        agent: turn.agent_id,
        board: turn.board_id,
        thread: turn.thread_id,
        kind: card.name,
        card: JSON.stringify(card),
        hash,
        state,
        at: iso(),
        expires: expiresAt,
      },
    )
    return Number(result.changes) ? get(turn.id, card.id) : null
  }
  // A person's answer: only a card that still waits and has not expired, once.
  function answer(turnId, id, { state, userId }) {
    const at = iso()
    const result = t.run(
      `UPDATE chat_permissions SET state = :state, answered_by = :user, answered_at = :at
       WHERE workspace_id = :ws AND turn_id = :turn AND id = :id AND state = 'pending' AND expires_at > :at`,
      { turn: turnId, id, state, user: userId, at },
    )
    return Number(result.changes) > 0
  }
  // What the machine said became of a card nobody answered here: denied,
  // expired or cancelled. Never approved: only a person's answer does that.
  function settle(turnId, id, state) {
    if (!['denied', 'expired', 'cancelled'].includes(state)) return false
    const result = t.run(
      "UPDATE chat_permissions SET state = :state, answered_at = :at WHERE workspace_id = :ws AND turn_id = :turn AND id = :id AND state = 'pending'",
      { turn: turnId, id, state, at: iso() },
    )
    return Number(result.changes) > 0
  }
  // The machine did not take a person's "allow" (it came too late there, or
  // failed its own check): the card is what the machine says it is, and
  // nobody is named as having allowed it.
  function overrule(turnId, id, state) {
    if (!['denied', 'expired', 'cancelled'].includes(state)) return false
    const result = t.run(
      "UPDATE chat_permissions SET state = :state, answered_by = NULL WHERE workspace_id = :ws AND turn_id = :turn AND id = :id AND state = 'approved'",
      { turn: turnId, id, state },
    )
    return Number(result.changes) > 0
  }
  // Cards past their time: expired. Returns the rows that just expired.
  function expire(turnId) {
    const at = iso()
    const due = ofTurn(turnId).filter((row) => row.state === 'pending' && row.expires_at <= at)
    for (const row of due) settle(turnId, row.id, 'expired')
    return due.map((row) => get(turnId, row.id))
  }
  // The turn is over (finished, stopped, interrupted, its agent revoked):
  // whatever still waited is cancelled. Returns those rows.
  function cancelTurn(turnId) {
    const waiting = ofTurn(turnId).filter((row) => row.state === 'pending')
    for (const row of waiting) settle(turnId, row.id, 'cancelled')
    return waiting.map((row) => get(turnId, row.id))
  }
  // The cards of a board that wait for someone, newest first.
  const pendingOfBoard = (projectId, boardId) =>
    t.all(
      `SELECT * FROM chat_permissions WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND state = 'pending'
         AND expires_at > :at ORDER BY created_at DESC LIMIT 50`,
      { project: projectId, board: boardId, at: iso() },
    )
  // How the requests of a turn ended, for its usage record. `allowed` counts
  // every request that went ahead (a person's "allow" and the automatic
  // ones); `auto` is the part nobody was asked about; `by` says who answered
  // the rest (user id to how many they allowed and denied). Ids and counts only.
  const counts = (turnId) => {
    const all = ofTurn(turnId)
    const by = {}
    for (const row of all) {
      if (!row.answered_by || !['approved', 'denied'].includes(row.state)) continue
      by[row.answered_by] ||= { allowed: 0, denied: 0 }
      by[row.answered_by][row.state === 'approved' ? 'allowed' : 'denied'] += 1
    }
    return {
      asked: all.length,
      allowed: all.filter((row) => ['approved', 'auto'].includes(row.state)).length,
      denied: all.filter((row) => ['denied', 'expired', 'cancelled'].includes(row.state)).length,
      auto: all.filter((row) => row.state === 'auto').length,
      by,
    }
  }
  const removeThread = (projectId, boardId, threadId) =>
    t.run('DELETE FROM chat_permissions WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND thread_id = :thread', {
      project: projectId,
      board: boardId,
      thread: threadId,
    })
  const bytes = () => t.get('SELECT COALESCE(SUM(length(card)), 0) AS n FROM chat_permissions WHERE workspace_id = :ws').n
  return {
    get,
    ofTurn,
    add,
    answer,
    settle,
    overrule,
    expire,
    cancelTurn,
    pendingOfBoard,
    counts,
    removeThread,
    bytes,
    cardOf: (row) => parse(row.card),
  }
}

// A stored card as the board shows it. `name(userId)`: a person's display name.
// A waiting card carries its hash (an answer must send it back) and the two
// answers there are; a settled one says how it ended and, when a person
// answered, who.
export function permissionView(row, { name = () => null } = {}) {
  const card = parse(row.card)
  const pending = row.state === 'pending'
  const state = row.state === 'auto' ? 'approved' : row.state
  return {
    id: row.id,
    kind: 'permission',
    name: card.name,
    label: card.label,
    detail: card.detail,
    diff: card.diff || null,
    state,
    options: pending
      ? [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ]
      : [],
    chosen: row.state === 'auto' ? 'Allowed automatically' : null,
    answeredBy: null,
    // Who answered, by name (the board says "Allowed by ...").
    answeredName: row.answered_by ? name(row.answered_by) : null,
    auto: row.state === 'auto',
    // By this server's clock (the machine counts the same length of time on its own).
    expiresAt: pending ? row.expires_at : null,
    ...(pending ? { hash: row.card_hash } : {}),
    answerable: pending,
    hosted: true,
  }
}
