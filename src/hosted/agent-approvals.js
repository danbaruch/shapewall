// Command approval belongs to a live claim, exact comment text, exact
// command, and token. The runner cannot approve its own request.
import { randomBytes } from 'node:crypto'
import { sha256 } from './crypto.js'
import { dispatchHash, AgentPolicyError, agentPolicy } from './agent-policy.js'
import { findApiToken } from './tenancy.js'
import { roleAtLeast } from './permissions.js'

export function mountHostedApprovals({ v1, boardApi, handle, scope, db, transaction, policyFor, boardContext, needFresh, auditOf, now }) {
  const error = (statusCode, code, message) => new AgentPolicyError(statusCode, code, message)
  const keyOf = (req) => ({ project: req.project.id, board: req.params.bid })
  function validate(req, row) {
    if (!row) throw error(404, 'unknown_approval', 'No such approval.')
    const token = req.t.get('SELECT token_hash FROM api_tokens WHERE workspace_id = :ws AND project_id = :project AND id = :id', {
      project: req.project.id,
      id: row.token_id,
    })
    if (!token || !findApiToken(db, token.token_hash, now().toISOString()))
      throw error(409, 'approval_expired', 'The requesting token is no longer active.')
    const ctx = boardContext(req.t, req.project, row.board_id)
    const comment = ctx.comments.get(row.comment_number)
    const claim = req.t.get(
      'SELECT id, token_id FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND comment_number = :number AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1',
      { project: req.project.id, board: row.board_id, number: row.comment_number },
    )
    if (
      row.expires_at <= now().toISOString() ||
      comment.status !== 'open' ||
      comment.agent_status !== 'working' ||
      row.comment_hash !== dispatchHash(comment) ||
      !policyFor(req.t).state(req.project.id, row.board_id, comment).dispatchable ||
      claim?.token_id !== row.token_id ||
      claim?.id !== row.claim_id
    )
      throw error(409, 'approval_expired', 'This approval no longer matches a live run.')
    return row
  }
  const byId = (req) =>
    req.t.get('SELECT * FROM agent_approvals WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND id = :id', {
      ...keyOf(req),
      id: req.params.aid,
    })
  v1.post(
    '/boards/:bid/comments/:cid/approvals',
    scope('claim'),
    handle((req, res) => {
      const command = req.body?.command
      if (typeof command !== 'string' || !command.trim() || command.length > 8000)
        throw error(400, 'invalid_command', 'Command: 1 to 8000 characters.')
      const ctx = boardContext(req.t, req.project, req.params.bid)
      const comment = ctx.comments.get(req.params.cid)
      const at = now().toISOString()
      const id = `sa_${randomBytes(10).toString('hex')}`
      const claim = req.t.get(
        'SELECT id FROM agent_claims WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND comment_number = :number AND token_id = :token AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1',
        { project: req.project.id, board: req.params.bid, number: comment.number, token: req.token.id },
      )
      const record = {
        claim_id: claim?.id || null,
        workspace_id: req.t.workspaceId,
        project_id: req.project.id,
        id,
        board_id: req.params.bid,
        comment_number: comment.number,
        token_id: req.token.id,
        comment_hash: dispatchHash(comment),
        command,
        command_hash: sha256(command),
        reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : '',
        state: 'pending',
        created_at: at,
        expires_at: new Date(now().getTime() + 120000).toISOString(),
      }
      validate(req, record)
      const count = req.t.get(
        'SELECT COUNT(*) AS n FROM agent_approvals WHERE workspace_id = :ws AND project_id = :project AND token_id = :token AND expires_at > :at',
        { project: req.project.id, token: req.token.id, at },
      ).n
      if (count >= 20) throw error(429, 'approval_budget', 'Too many approval requests.')
      req.t.run(
        `INSERT INTO agent_approvals (workspace_id,project_id,id,board_id,comment_number,token_id,comment_hash,claim_id,command,command_hash,reason,state,created_at,expires_at) VALUES (:ws,:project,:id,:board,:number,:token,:hash,:claim,:command,:commandHash,:reason,'pending',:at,:expires)`,
        {
          ...keyOf(req),
          id,
          number: comment.number,
          token: req.token.id,
          hash: record.comment_hash,
          claim: record.claim_id,
          command,
          commandHash: record.command_hash,
          reason: record.reason,
          at,
          expires: record.expires_at,
        },
      )
      res.status(201).json({ approval: record })
    }),
  )
  v1.get(
    '/boards/:bid/approvals/:aid',
    scope('claim'),
    handle((req, res) => {
      const row = byId(req)
      if (!row || row.token_id !== req.token.id) throw error(404, 'unknown_approval', 'No such approval.')
      validate(req, row)
      res.json({ approval: row })
    }),
  )
  boardApi.get(
    '/boards/:bid/approvals',
    handle((req, res) => {
      if (!roleAtLeast(req.role, 'admin') || !policyFor(req.t).trusted(agentPolicy(req.t, req.project.id, req.params.bid), req.user.id))
        throw error(403, 'forbidden', 'Only trusted admins review shell commands.')
      const rows = req.t.all(
        "SELECT * FROM agent_approvals WHERE workspace_id = :ws AND project_id = :project AND board_id = :board AND state = 'pending' AND expires_at > :at",
        { ...keyOf(req), at: now().toISOString() },
      )
      res.json({
        approvals: rows.filter((row) => {
          try {
            validate(req, row)
            return true
          } catch {
            return false
          }
        }),
      })
    }),
  )
  boardApi.post(
    '/boards/:bid/approvals/:aid',
    needFresh,
    handle((req, res) => {
      if (!roleAtLeast(req.role, 'admin') || !policyFor(req.t).trusted(agentPolicy(req.t, req.project.id, req.params.bid), req.user.id))
        throw error(403, 'forbidden', 'Only trusted admins approve shell commands.')
      if (!['approved', 'denied'].includes(req.body?.state)) throw error(400, 'invalid_approval', 'Choose approved or denied.')
      const row = transaction(db, () => {
        const row = validate(req, byId(req))
        if (row.state !== 'pending' || req.body?.hash !== row.command_hash)
          throw error(409, 'approval_changed', 'This exact command is no longer pending.')
        req.t.run(
          'UPDATE agent_approvals SET state = :state, answered_by = :user, answered_at = :at WHERE workspace_id = :ws AND project_id = :project AND id = :id',
          { project: req.project.id, id: row.id, state: req.body.state, user: req.user.id, at: now().toISOString() },
        )
        // In the workspace's audit log: who let which command run (its hash;
        // the command itself stays on the approval).
        auditOf(
          req,
          req.body.state === 'approved' ? 'agent_command_approved' : 'agent_command_denied',
          `${row.board_id}#${row.comment_number}`,
          {
            project: req.project.id,
            approval: row.id,
            token: row.token_id,
            commandHash: row.command_hash,
          },
        )
        return byId(req)
      })
      res.json({ approval: row })
    }),
  )
}
