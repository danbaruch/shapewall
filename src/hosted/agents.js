// Agents on a hosted server. A project API token that may take work (the
// claim scope) is an agent: something a board lists by name, with a face,
// a state, and rules about who may send it work. The row in `agents`
// (migration 12) hangs that on the token; the token keeps the secret, the
// scopes, the name and revocation, exactly as before.
//
//   state     online (heard from in the last 90 seconds), busy (online and
//             holding a comment it took), offline, revoked (its token was
//             revoked, expired, or its maker is no longer an admin)
//   audience  who may send it work: "owner" (the person who connected it,
//             the default for a new agent), "members" (the owner and named
//             members) or "trusted" (everyone the project's agent policy
//             trusts; what tokens from before 0.4.0 keep). The agent policy
//             still decides who may send work to an agent at all: an
//             audience only narrows that.
//   routing   a comment is addressed to one agent or to none ("any agent").
//             Only the addressed agent's token may take it, and an agent
//             only takes comments sent by someone in its audience.
//
// One function per setting. setIdentity, setDefault, setAudience,
// setApprovalRule and revoke below are the only code that changes those
// settings: each checks the role (src/hosted/permissions.js), validates,
// writes, and records an audit event with before and after. The console
// routes (src/hosted/agent-routes.js) are thin callers, so a CLI command or
// an admin tool can call the same functions later. `actor` is who asks:
// { userId, role, audit(action, target, detail) }.
//
// Every query goes through the tenant handle `t` (src/hosted/tenancy.js).

import { logoForAgent } from '../agent/agent-logos.js'
import { cleanAgentName, isAgentTint, isBuiltInIcon } from '../agent/identity.js'
import { agentPolicy, trustedMember } from './agent-policy.js'
import { newId } from './crypto.js'
import { HttpError } from './http.js'
import {
  AGENT_AUDIENCES,
  APPROVAL_ROLES,
  APPROVAL_RULES,
  approvalAutoAvailable,
  canChangeApprovalRoles,
  canChangeApprovalRule,
  canManageAgents,
  effectiveApprovalRule,
  roleAtLeast,
  tokenCreatorOk,
} from './permissions.js'

// What runs behind an agent, as far as the server was told. "watcher" is a
// `shapewall watch --remote` (or MCP client) whose command is unknown; the
// known ones show their product mark (src/agent/agent-logos.js).
export const AGENT_KINDS = ['watcher', 'claude', 'codex', 'goose', 'gemini', 'custom']
export const AUDIENCE_USERS_MAX = 50
export const AGENT_ID_RE = /^ag_[a-f0-9]{24}$/
// On a comment as the server hands it around (src/hosted/app.js
// dispatchView): { agent_id, dispatch_by }, what claimCheck goes by. A
// symbol key, so it never reaches JSON.
export const COMMENT_ROUTING = Symbol('commentRouting')

const SELECT = `SELECT a.*, k.name AS name, k.prefix AS token_prefix, k.scopes AS token_scopes, k.revoked_at AS token_revoked_at,
    k.expires_at AS token_expires_at, k.created_by AS token_created_by, k.last_used_at AS token_last_used_at,
    p.name AS project_name, u.handle AS creator_handle, u.display_name AS creator_name, m.role AS creator_role
  FROM agents a JOIN api_tokens k ON k.id = a.token_id AND k.workspace_id = a.workspace_id
  JOIN projects p ON p.id = a.project_id AND p.workspace_id = a.workspace_id
  LEFT JOIN users u ON u.id = k.created_by
  LEFT JOIN memberships m ON m.user_id = k.created_by AND m.workspace_id = a.workspace_id
  WHERE a.workspace_id = :ws`

const parseList = (text) => {
  try {
    const value = JSON.parse(text || '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}
const personName = (person) => person?.displayName || person?.handle || 'someone who left'
const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

export function createAgentStore(t, { now = () => new Date(), presence = null, handleFor = () => null } = {}) {
  const iso = () => now().toISOString()
  // Reads repeat within one request (a list of comments asks per comment);
  // every write starts over.
  let memo = new Map()
  const forget = () => {
    memo = new Map()
  }
  const once = (key, make) => {
    if (!memo.has(key)) memo.set(key, make())
    return memo.get(key)
  }

  // ---- Rows ----

  // A token with the claim scope that has no agent row yet was made while an
  // older build ran on this database: it becomes an agent the first time it
  // is looked for, with the audience such tokens had (the agent policy's).
  function ensure(projectId) {
    const missing = t.all(
      `SELECT k.id, k.created_by, k.created_at, k.last_used_at FROM api_tokens k WHERE k.workspace_id = :ws AND k.project_id = :project
       AND k.scopes LIKE '%"claim"%' AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.token_id = k.id)`,
      { project: projectId },
    )
    for (const token of missing) insert({ projectId, tokenId: token.id, userId: token.created_by, at: token.created_at, inherited: true })
    if (missing.length) forget()
    return missing.length
  }
  function insert({ projectId, tokenId, userId, at = iso(), inherited = false, machine = null, kind = 'watcher', lastSeenAt = null }) {
    const id = newId('ag')
    t.run(
      `INSERT INTO agents (workspace_id, project_id, id, token_id, kind, machine, audience, audience_inherited, created_by, created_at,
         approved_by, approved_at, last_seen_at)
       VALUES (:ws, :project, :id, :token, :kind, :machine, :audience, :inherited, :user, :at, :user, :at, :seen)`,
      {
        project: projectId,
        id,
        token: tokenId,
        kind,
        machine,
        audience: inherited ? 'trusted' : 'owner',
        inherited: inherited ? 1 : 0,
        user: userId || null,
        at,
        seen: lastSeenAt,
      },
    )
    forget()
    return id
  }
  // A new token with the claim scope: its agent, for the person who made it
  // only until they say otherwise. `machine`: the label `shapewall login` sent.
  function create(actor, { projectId, tokenId, machine = null, kind = 'watcher' }) {
    const id = insert({ projectId, tokenId, userId: actor.userId, machine: cleanMachine(machine), kind })
    actor.audit('agent_created', id, { project: projectId, token: tokenId, kind, audience: 'owner', ...(machine ? { machine } : {}) })
    return id
  }
  const rows = (projectId = null) =>
    once(`rows:${projectId || ''}`, () =>
      projectId
        ? t.all(`${SELECT} AND a.project_id = :project ORDER BY a.created_at, a.id`, { project: projectId })
        : t.all(`${SELECT} ORDER BY a.created_at, a.id`),
    )
  const live = (row, at = iso()) =>
    Boolean(row) &&
    !row.token_revoked_at &&
    !(row.token_expires_at && row.token_expires_at <= at) &&
    Boolean(row.token_created_by) &&
    tokenCreatorOk(row.creator_role)
  const get = (projectId, agentId) =>
    (AGENT_ID_RE.test(String(agentId || '')) ? rows(projectId).find((row) => row.id === agentId) : null) || null
  function need(projectId, agentId) {
    const row = get(projectId, agentId)
    if (!row) throw new HttpError(404, 'unknown_agent', 'No such agent.')
    return row
  }
  // The agent of a token, or null. A claim-scoped token from an older build
  // becomes an agent here, on first sight (`onFirstSight(row)` hears of it).
  function forToken(projectId, tokenId, { onFirstSight = null } = {}) {
    const find = () => rows(projectId).find((row) => row.token_id === tokenId) || null
    const found = find()
    if (found || !ensure(projectId)) return found
    const made = find()
    if (made) onFirstSight?.(made)
    return made
  }
  // Which agent a token is, for the face on a reply it wrote (revoked or not).
  const idForToken = (projectId, tokenId) => (tokenId ? rows(projectId).find((row) => row.token_id === tokenId)?.id || null : null)
  const defaultId = (projectId) =>
    once(
      `default:${projectId}`,
      () =>
        t.get('SELECT default_agent_id FROM projects WHERE workspace_id = :ws AND id = :project', { project: projectId })
          ?.default_agent_id || null,
    )
  // The project's default agent while it can still take work, else null
  // (a revoked default falls back to "any agent").
  function defaultAgent(projectId) {
    const row = get(projectId, defaultId(projectId))
    return live(row) ? row : null
  }

  // ---- State ----

  // Which comments each agent holds right now: token id -> [{ board, number }].
  const held = (projectId) =>
    once(`held:${projectId}`, () => {
      const out = new Map()
      for (const claim of t.all(
        `SELECT c.token_id, c.board_id, c.comment_number FROM agent_claims c
         JOIN comments m ON m.workspace_id = c.workspace_id AND m.project_id = c.project_id AND m.board_id = c.board_id AND m.number = c.comment_number
         WHERE c.workspace_id = :ws AND c.project_id = :project AND c.ended_at IS NULL AND m.status = 'open' AND m.agent_status IN ('queued', 'working')
         ORDER BY c.created_at`,
        { project: projectId },
      )) {
        if (!out.has(claim.token_id)) out.set(claim.token_id, [])
        out.get(claim.token_id).push({ board: claim.board_id, number: claim.comment_number })
      }
      return out
    })
  // Comments sent to an agent (or to any, under '') that nothing took yet:
  // agent id -> [{ board, number }]. Open, vouched for, the run approved.
  const waiting = (projectId) =>
    once(`waiting:${projectId}`, () => {
      const out = new Map()
      const liveIds = new Set(
        rows(projectId)
          .filter((row) => live(row))
          .map((row) => row.id),
      )
      for (const comment of t.all(
        `SELECT board_id, number, agent_id FROM comments WHERE workspace_id = :ws AND project_id = :project AND status = 'open'
         AND agent_status IS NULL AND dispatch_hash IS NOT NULL AND run_approved = 1 ORDER BY dispatch_at, number`,
        { project: projectId },
      )) {
        const key = comment.agent_id && liveIds.has(comment.agent_id) ? comment.agent_id : ''
        if (!out.has(key)) out.set(key, [])
        out.get(key).push({ board: comment.board_id, number: comment.number })
      }
      return out
    })
  function stateOf(row) {
    if (!live(row)) return { state: 'revoked', lastSeenAt: latestOf(row.last_seen_at, row.token_last_used_at) }
    const heard = presence?.ofAgent(t.workspaceId, row.id) || { online: false, lastSeenAt: null }
    const lastSeenAt = latestOf(heard.lastSeenAt, row.last_seen_at, row.token_last_used_at)
    if (!heard.online) return { state: 'offline', lastSeenAt }
    return { state: held(row.project_id).get(row.token_id)?.length ? 'busy' : 'online', lastSeenAt }
  }
  // A claim-scoped token was heard from: its agent is online, and its
  // last-seen time is written down at most once a minute.
  function seen(row) {
    if (!row || !presence) return
    const { save } = presence.seen(t.workspaceId, row.project_id, row.id, row.name)
    if (save) t.run('UPDATE agents SET last_seen_at = :at WHERE workspace_id = :ws AND id = :id', { at: iso(), id: row.id })
  }

  // ---- Audience ----

  const people = () =>
    once('people', () => {
      const out = new Map()
      for (const row of t.all(
        'SELECT m.user_id, m.role, u.handle, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = :ws',
      ))
        out.set(row.user_id, { userId: row.user_id, role: row.role, handle: row.handle, displayName: row.display_name })
      return out
    })
  // The named members of a "members" audience who are still in the workspace.
  const namedUsers = (row) => parseList(row.audience_users).filter((id) => id !== row.created_by && people().has(id))
  // Whether this person is in the agent's audience. (Whether the agent
  // policy lets them send work to an agent at all is `trusted` below: both
  // must hold.)
  function inAudience(row, userId) {
    if (!row || !userId) return false
    if (row.audience === 'trusted') return true
    if (row.created_by && row.created_by === userId) return true
    return row.audience === 'members' && namedUsers(row).includes(userId)
  }
  const trusted = (projectId, boardId, userId) => trustedMember({ ...t, handleFor }, agentPolicy(t, projectId, boardId), userId)
  // The audience in words and names, for whoever looks at the agent.
  function audienceOf(row) {
    const owner = people().get(row.created_by) || null
    const named = row.audience === 'members' ? namedUsers(row).map((id) => people().get(id)) : []
    const names = [personName(owner), ...named.map(personName)]
    return {
      kind: row.audience,
      // Kept from before 0.4.0, never chosen.
      inherited: Boolean(row.audience_inherited) && row.audience === 'trusted',
      text:
        row.audience === 'trusted'
          ? "Everyone this project's agent policy trusts"
          : row.audience === 'owner'
            ? `Only ${personName(owner)}`
            : listNames(names),
      people: (row.audience === 'trusted' ? [] : [owner, ...named]).filter(Boolean).map((person) => ({
        handle: person.handle,
        displayName: person.displayName,
      })),
    }
  }
  // May this person send the agent work, and if not, why (said on the board).
  function sendCheck(row, { userId, role, boardId = null }) {
    if (!roleAtLeast(role, 'member')) return { ok: false, reason: 'Viewers cannot send work to an agent.' }
    if (!live(row)) return { ok: false, reason: `${row.name} was revoked.` }
    if (!trusted(row.project_id, boardId, userId))
      return { ok: false, reason: "This project's agent policy does not let you send work to an agent. Ask an admin." }
    if (inAudience(row, userId)) return { ok: true, reason: null }
    const audience = audienceOf(row)
    return {
      ok: false,
      reason:
        row.audience === 'owner'
          ? `${audience.text} can send work to ${row.name}. Ask them, or an admin, to share it.`
          : `${row.name} takes work from ${audience.text} only. Ask an admin to add you.`,
    }
  }

  // ---- Routing ----

  // The agent a comment is addressed to, while that agent can still take
  // work; null means any agent. A comment addressed to a revoked agent is
  // never stuck: any agent may take it.
  function addressOf(projectId, row) {
    const agent = row?.agent_id ? get(projectId, row.agent_id) : null
    return live(agent) ? agent.id : null
  }
  // Addresses a comment a person just sent (or that was vouched for when it
  // was written). `wanted`: an agent id, null for any agent, or undefined
  // for the project's default agent when this person may use it (any agent
  // otherwise). Throws when the named agent is not theirs to use.
  function address(projectId, boardId, row, { userId, role }, wanted = undefined) {
    let agent = null
    if (wanted === undefined) {
      const candidate = defaultAgent(projectId)
      agent = candidate && inAudience(candidate, userId) ? candidate : null
    } else if (wanted !== null) {
      agent = get(projectId, wanted)
      if (!live(agent)) throw new HttpError(404, 'unknown_agent', 'No such agent in this project. It may have been revoked.')
      const check = sendCheck(agent, { userId, role, boardId })
      if (!check.ok) throw new HttpError(403, 'agent_audience', check.reason)
    }
    t.run(
      'UPDATE comments SET agent_id = :agent WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number',
      { project: projectId, board: boardId, number: row.number, agent: agent?.id || null },
    )
    forget()
    return agent?.id || null
  }
  // "Let any agent take it": a comment that waits for one agent goes to
  // whichever agent takes it first. Returns the agent it was waiting for.
  function release(actor, projectId, boardId, row) {
    const from = addressOf(projectId, row)
    if (row.agent_id)
      t.run(
        'UPDATE comments SET agent_id = NULL WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number',
        { project: projectId, board: boardId, number: row.number },
      )
    forget()
    if (from) actor.audit('agent_queue_released', `${boardId}#${row.number}`, { project: projectId, from, to: null })
    return from
  }
  // May this agent take this comment? The two rules a token cannot get
  // around: a comment sent to another agent is not its to take, and it only
  // takes work from people in its audience (the person whose vouch stands on
  // the comment, `dispatch_by`).
  function claimCheck(agent, projectId, row) {
    if (!agent) return { ok: false, code: 'not_an_agent', message: 'This token is not an agent.' }
    const addressed = addressOf(projectId, row)
    if (addressed && addressed !== agent.id)
      return { ok: false, code: 'addressed_elsewhere', message: 'This comment was sent to another agent.' }
    if (!inAudience(agent, row.dispatch_by))
      return { ok: false, code: 'agent_audience', message: "This comment was sent by someone outside this agent's audience." }
    return { ok: true, code: null, message: null }
  }

  // ---- Usage records (the groundwork of the usage dashboard) ----

  // One row per comment an agent took: who asked, which agent, where, when.
  // No comment text, no answer. The model, effort and token columns stay
  // NULL: a watcher reports none of them.
  function startRun({ projectId, boardId, number, agentId, claimId, askedBy }) {
    t.run(
      `INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, claim_id, board_id, comment_number, asked_by, started_at)
       VALUES (:ws, :project, :id, 'fix', :agent, :claim, :board, :number, :asked, :at)`,
      {
        project: projectId,
        id: newId('run'),
        agent: agentId || null,
        claim: claimId,
        board: boardId,
        number,
        asked: askedBy || null,
        at: iso(),
      },
    )
  }
  // Closes the record of every run whose claim ended, with how it ended:
  // the status the agent left (done, needs-human, branch-ready), "resolved"
  // when the comment was resolved meanwhile, "released" when the claim was
  // dropped with nothing to show, "removed" when the comment is gone.
  function closeRuns(projectId) {
    const ended = t.all(
      `SELECT r.id, r.board_id, r.comment_number, c.ended_at FROM agent_runs r
       JOIN agent_claims c ON c.id = r.claim_id AND c.workspace_id = r.workspace_id
       WHERE r.workspace_id = :ws AND r.project_id = :project AND r.ended_at IS NULL AND c.ended_at IS NOT NULL`,
      { project: projectId },
    )
    for (const run of ended) {
      const comment = t.get(
        'SELECT status, agent_status, resolved_at FROM comments WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND number = :number',
        { project: projectId, board: run.board_id, number: run.comment_number },
      )
      const outcome = !comment
        ? 'removed'
        : comment.status === 'resolved'
          ? 'resolved'
          : ['done', 'needs-human', 'branch-ready'].includes(comment.agent_status)
            ? comment.agent_status
            : 'released'
      const at =
        comment?.status === 'resolved' && comment.resolved_at && comment.resolved_at < run.ended_at ? comment.resolved_at : run.ended_at
      t.run('UPDATE agent_runs SET ended_at = :at, outcome = :outcome WHERE workspace_id = :ws AND id = :id', { id: run.id, at, outcome })
    }
    return ended.length
  }

  // ---- Views ----

  const face = (row) => ({
    icon: isBuiltInIcon(row.icon) ? row.icon : null,
    tint: isAgentTint(row.tint) ? row.tint : null,
    logo: logoForAgent(row.kind),
  })
  // An agent as a board member sees it. No token id, prefix or scope, and
  // no account id: names, a face, a state, and what this viewer may do.
  function boardView(row, viewer, { boardId = null } = {}) {
    const check = sendCheck(row, { ...viewer, boardId })
    const mine = (list) => (list || []).filter((item) => !boardId || item.board === boardId).map((item) => item.number)
    const working = held(row.project_id).get(row.token_id) || []
    const queued = waiting(row.project_id).get(row.id) || []
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      ...face(row),
      machine: row.machine || null,
      ...stateOf(row),
      isDefault: defaultId(row.project_id) === row.id,
      audience: audienceOf(row),
      canSend: check.ok,
      reason: check.reason,
      working: mine(working),
      queued: mine(queued),
      // What it holds on the project's other boards, as counts.
      elsewhere: { working: working.length - mine(working).length, queued: queued.length - mine(queued).length },
    }
  }
  // The agents of a project for its board: the ones that can take work.
  function boardList(projectId, viewer, { boardId = null } = {}) {
    ensure(projectId)
    const agents = rows(projectId)
      .filter((row) => live(row))
      .map((row) => boardView(row, viewer, { boardId }))
    return {
      agents,
      defaultAgentId: defaultAgent(projectId)?.id || null,
      // Whether this person may send work to an agent at all (the agent policy).
      canSend: roleAtLeast(viewer.role, 'member') && trusted(projectId, boardId, viewer.userId),
      // Sent to any agent and not taken yet, on this board.
      unassigned: (waiting(projectId).get('') || []).filter((item) => !boardId || item.board === boardId).map((item) => item.number),
    }
  }
  // An agent as the console shows it to an admin: everything above plus its
  // settings, its token (what the Tokens page shows of it) and who made it.
  function consoleView(row) {
    const working = held(row.project_id).get(row.token_id) || []
    const queued = waiting(row.project_id).get(row.id) || []
    const audience = audienceOf(row)
    const approval = {
      approvalRule: row.approval_rule,
      approvalChangeRole: row.approval_change_role,
      approvalAnswerRole: row.approval_answer_role,
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      ...face(row),
      machine: row.machine || null,
      ...stateOf(row),
      projectId: row.project_id,
      projectName: row.project_name,
      isDefault: defaultId(row.project_id) === row.id,
      audience: {
        ...audience,
        users: row.audience === 'members' ? namedUsers(row).map((id) => ({ userId: id, ...pick(people().get(id)) })) : [],
      },
      approval: {
        rule: row.approval_rule,
        effectiveRule: effectiveApprovalRule(approval),
        autoAvailable: approvalAutoAvailable(approval),
        changeRole: row.approval_change_role,
        answerRole: row.approval_answer_role,
      },
      counts: { working: working.length, queued: queued.length },
      createdAt: row.created_at,
      createdBy: row.created_by
        ? { userId: row.created_by, ...pick(people().get(row.created_by)), left: !people().has(row.created_by) }
        : null,
      token: {
        id: row.token_id,
        prefix: row.token_prefix,
        scopes: parseList(row.token_scopes),
        expiresAt: row.token_expires_at,
        revokedAt: row.token_revoked_at,
      },
    }
  }
  // Every agent of the project (or, without one, of the workspace), live
  // ones first.
  function consoleList(projectId = null) {
    if (projectId) ensure(projectId)
    else for (const project of t.all('SELECT id FROM projects WHERE workspace_id = :ws')) ensure(project.id)
    const all = rows(projectId).map(consoleView)
    return [...all.filter((agent) => agent.state !== 'revoked'), ...all.filter((agent) => agent.state === 'revoked')]
  }

  // ---- Settings: one function each ----

  const mayManage = (actor) => {
    if (!canManageAgents(actor.role)) throw new HttpError(403, 'forbidden', 'Managing agents needs the admin role or higher.')
  }
  const after = (projectId, agentId) => {
    forget()
    return consoleView(need(projectId, agentId))
  }

  // Name, icon, tint and kind: how the agent looks on the board. `changes`
  // holds only what changes. The name is the token's name (what the agent's
  // replies are signed with from now on).
  function setIdentity(actor, projectId, agentId, changes = {}) {
    mayManage(actor)
    const row = need(projectId, agentId)
    if (!live(row)) throw new HttpError(409, 'agent_revoked', 'This agent was revoked.')
    const before = { name: row.name, icon: row.icon || null, tint: row.tint || null, kind: row.kind }
    const next = { ...before }
    if (changes.name !== undefined) {
      const { name, problem } = cleanAgentName(changes.name)
      if (problem || !name) throw new HttpError(400, 'invalid_name', problem ? `Agent ${problem}.` : 'Agent name: 1 to 40 characters.')
      next.name = name
    }
    if (changes.icon !== undefined) {
      if (changes.icon !== null && !isBuiltInIcon(changes.icon))
        throw new HttpError(400, 'invalid_icon', 'Choose one of the built-in icons.')
      next.icon = changes.icon
    }
    if (changes.tint !== undefined) {
      if (changes.tint !== null && !isAgentTint(changes.tint)) throw new HttpError(400, 'invalid_tint', 'Choose one of the tints.')
      next.tint = changes.tint
    }
    if (changes.kind !== undefined) {
      if (!AGENT_KINDS.includes(changes.kind)) throw new HttpError(400, 'invalid_kind', `Kind: ${AGENT_KINDS.join(', ')}.`)
      next.kind = changes.kind
    }
    if (next.name !== before.name) {
      t.run('UPDATE api_tokens SET name = :name WHERE workspace_id = :ws AND project_id = :project AND id = :id', {
        name: next.name,
        project: projectId,
        id: row.token_id,
      })
      actor.audit('agent_renamed', row.id, { project: projectId, from: before.name, to: next.name })
    }
    const look = (value) => ({ icon: value.icon, tint: value.tint, kind: value.kind })
    if (JSON.stringify(look(next)) !== JSON.stringify(look(before))) {
      t.run('UPDATE agents SET icon = :icon, tint = :tint, kind = :kind WHERE workspace_id = :ws AND id = :id', {
        ...look(next),
        id: row.id,
      })
      actor.audit('agent_identity_changed', row.id, { project: projectId, before: look(before), after: look(next) })
    }
    return after(projectId, agentId)
  }

  // The project's default agent: the one "Send to agent" names, and where a
  // trusted member's new comment goes. null: any agent.
  function setDefault(actor, projectId, agentId) {
    mayManage(actor)
    const row = agentId === null ? null : need(projectId, agentId)
    if (row && !live(row)) throw new HttpError(409, 'agent_revoked', 'A revoked agent cannot be the default.')
    const before = defaultId(projectId)
    if (before !== (row?.id || null)) {
      t.run('UPDATE projects SET default_agent_id = :agent WHERE workspace_id = :ws AND id = :project', {
        project: projectId,
        agent: row?.id || null,
      })
      actor.audit('agent_default_changed', projectId, { before, after: row?.id || null })
      forget()
    }
    return row?.id || null
  }

  // Who may send the agent work: { audience, users }. `users` (account ids
  // of workspace members) only with "members"; the person who connected the
  // agent is always in.
  function setAudience(actor, projectId, agentId, { audience, users = [] } = {}) {
    mayManage(actor)
    const row = need(projectId, agentId)
    if (!live(row)) throw new HttpError(409, 'agent_revoked', 'This agent was revoked.')
    if (!AGENT_AUDIENCES.includes(audience)) throw new HttpError(400, 'invalid_audience', `Audience: ${AGENT_AUDIENCES.join(', ')}.`)
    let named = []
    if (audience === 'members') {
      if (!Array.isArray(users) || users.length > AUDIENCE_USERS_MAX || users.some((id) => typeof id !== 'string'))
        throw new HttpError(400, 'invalid_audience', `Named members: at most ${AUDIENCE_USERS_MAX} people.`)
      named = [...new Set(users)].filter((id) => id !== row.created_by)
      const unknown = named.filter((id) => !roleAtLeast(people().get(id)?.role, 'member'))
      if (unknown.length)
        throw new HttpError(400, 'invalid_audience', 'Named members must be members of this workspace (viewers cannot send work).')
    }
    const shape = (kind, list) => ({ audience: kind, users: [...list].sort() })
    const before = shape(row.audience, row.audience === 'members' ? namedUsers(row) : [])
    const next = shape(audience, named)
    // Saving the same audience still counts as choosing it.
    if (JSON.stringify(before) !== JSON.stringify(next) || row.audience_inherited) {
      t.run(
        'UPDATE agents SET audience = :audience, audience_users = :users, audience_inherited = 0 WHERE workspace_id = :ws AND id = :id',
        {
          audience,
          users: JSON.stringify(next.users),
          id: row.id,
        },
      )
      actor.audit('agent_audience_changed', row.id, { project: projectId, before, after: next })
    }
    return after(projectId, agentId)
  }

  // The approval rule and who may change or answer it: { rule, changeRole,
  // answerRole }, only what changes. "auto" is refused until the agent's
  // machine can opt in (permissions.js approvalAutoAvailable).
  function setApprovalRule(actor, projectId, agentId, changes = {}) {
    mayManage(actor)
    const row = need(projectId, agentId)
    if (!live(row)) throw new HttpError(409, 'agent_revoked', 'This agent was revoked.')
    const before = { rule: row.approval_rule, changeRole: row.approval_change_role, answerRole: row.approval_answer_role }
    const next = { ...before }
    const current = { approvalRule: before.rule, approvalChangeRole: before.changeRole, approvalAnswerRole: before.answerRole }
    if (changes.rule !== undefined && changes.rule !== before.rule) {
      if (!APPROVAL_RULES.includes(changes.rule))
        throw new HttpError(400, 'invalid_approval_rule', `Approval rule: ${APPROVAL_RULES.join(', ')}.`)
      if (!canChangeApprovalRule(actor.role, current))
        throw new HttpError(403, 'forbidden', `Changing this agent's approval rule needs the ${before.changeRole} role.`)
      if (changes.rule === 'auto' && !approvalAutoAvailable(current))
        throw new HttpError(
          409,
          'approval_auto_unavailable',
          "Automatic approval needs the agent's own machine to allow approvals from the board. No connected agent can do that yet.",
        )
      next.rule = changes.rule
    }
    for (const key of ['changeRole', 'answerRole']) {
      if (changes[key] === undefined || changes[key] === before[key]) continue
      if (!APPROVAL_ROLES.includes(changes[key])) throw new HttpError(400, 'invalid_approval_role', `Role: ${APPROVAL_ROLES.join(', ')}.`)
      if (!canChangeApprovalRoles(actor.role)) throw new HttpError(403, 'forbidden', 'Only an owner changes which role decides approvals.')
      next[key] = changes[key]
    }
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      t.run(
        'UPDATE agents SET approval_rule = :rule, approval_change_role = :changeRole, approval_answer_role = :answerRole WHERE workspace_id = :ws AND id = :id',
        { ...next, id: row.id },
      )
      actor.audit('agent_approval_rule_changed', row.id, { project: projectId, before, after: next })
    }
    return after(projectId, agentId)
  }

  // Revokes the agent's token. What waited for it goes to any agent; it
  // stops being the default.
  function revoke(actor, projectId, agentId) {
    mayManage(actor)
    const row = need(projectId, agentId)
    const result = t.run(
      'UPDATE api_tokens SET revoked_at = :at WHERE workspace_id = :ws AND project_id = :project AND id = :id AND revoked_at IS NULL',
      { at: iso(), project: projectId, id: row.token_id },
    )
    if (!result.changes) throw new HttpError(404, 'unknown_agent', 'This agent was already revoked.')
    const released = afterRevoke(projectId, row.id)
    actor.audit('token_revoked', row.token_id)
    actor.audit('agent_revoked', row.id, {
      project: projectId,
      name: row.name,
      released: released.comments,
      wasDefault: released.wasDefault,
    })
    return { ok: true, ...released }
  }
  // What follows a token's revocation, from here or the Tokens page: its
  // open comments nobody took go to any agent, and the project loses it as
  // default.
  function afterRevoke(projectId, agentId) {
    const comments = t.run(
      "UPDATE comments SET agent_id = NULL WHERE workspace_id = :ws AND project_id = :project AND agent_id = :agent AND status = 'open' AND agent_status IS NULL",
      { project: projectId, agent: agentId },
    ).changes
    const wasDefault = defaultId(projectId) === agentId
    if (wasDefault) t.run('UPDATE projects SET default_agent_id = NULL WHERE workspace_id = :ws AND id = :project', { project: projectId })
    presence?.forgetAgent(t.workspaceId, agentId)
    forget()
    return { comments: Number(comments), wasDefault }
  }

  return {
    ensure,
    create,
    get,
    forToken,
    idForToken,
    live,
    defaultAgent,
    stateOf,
    seen,
    inAudience,
    audienceOf,
    sendCheck,
    trusted,
    addressOf,
    address,
    release,
    claimCheck,
    startRun,
    closeRuns,
    boardView,
    boardList,
    consoleView,
    consoleList,
    setIdentity,
    setDefault,
    setAudience,
    setApprovalRule,
    revoke,
    afterRevoke,
    forget,
  }
}

const pick = (person) => ({ handle: person?.handle || null, displayName: person?.displayName || null })
// The later of some ISO times (null when there is none).
const latestOf = (...times) => times.filter(Boolean).sort().at(-1) || null
// A machine label as `shapewall login` sent it: one short line.
function cleanMachine(value) {
  const text =
    typeof value === 'string'
      ? value
          .replace(/[^\w .-]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40)
      : ''
  return text || null
}
