// The solo engine's machine tokens (1.5.0, experimental; plan R2, gap G15).
//
// The owner's own command line and the engine's own agent reach the engine
// the way they reach any hosted server: with a project token over the token
// API. Nobody approves these on /device, so the engine makes them itself at
// start, for the owner, and keeps each one in a 0600 file in its data folder
// (.shapewall/.engine/, 0700, never in git):
//
//   cli.token    `comments`, `mcp` and `export` in the project folder
//                (src/engine-target.js reads it): read, reply, status,
//                resolve, push. Not claim (see MACHINE_TOKENS).
//   watch.token  `watch` in the project folder: an agent that takes work.
//   agent.token  the board's own agent, `agent connect --as local`, started
//                by `serve --engine hosted` (R2). Scopes: exactly what an
//                approved agent connection gets (AGENT_LOGIN_SCOPES).
//
// Each start rotates them: the same token row (so its agent, its name, icon,
// audience and claims stay) gets a new secret, and the old one stops working
// at once. A token is made only when there is none (or it was revoked); a
// rotation never widens it again (scopes or an expiry the owner set stay).
// A stop rotates them again to a secret nobody holds and removes the files,
// so a copy of a file outlives the engine by nothing. A token revoked
// from the console is not brought back: a new one is made.
//
// The token values are never logged or printed. machine-tokens.json in the
// same folder keeps only the row ids.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createAgentStore } from '../agents.js'
import { newApiToken, newId } from '../crypto.js'
import { transaction } from '../db.js'
import { AGENT_LOGIN_SCOPES } from '../device-routes.js'
import { sha256 } from '../../shared/account-tokens.js'
import { audit, tenant } from '../tenancy.js'

export const CLI_TOKEN_FILE = 'cli.token'
export const AGENT_TOKEN_FILE = 'agent.token'
const IDS_FILE = 'machine-tokens.json'

export const WATCH_TOKEN_FILE = 'watch.token'

// No claim scope on the command line's token: a claim token is an agent, and
// an agent reads only the comments routed to it, where `comments list` must
// show the board's. `watch` takes work, so it is an agent (as `watch --remote`
// is on any hosted server): a token of its own, with claim.
export const MACHINE_TOKENS = {
  cli: { file: CLI_TOKEN_FILE, name: 'This machine (command line)', scopes: ['read', 'reply', 'status', 'resolve', 'push'] },
  watch: {
    file: WATCH_TOKEN_FILE,
    name: 'This machine (watch)',
    scopes: ['read', 'reply', 'status', 'claim', 'resolve'],
    kind: 'watcher',
  },
  agent: { file: AGENT_TOKEN_FILE, name: 'Local agent', scopes: AGENT_LOGIN_SCOPES, kind: 'custom' },
}

// The token row ids of this engine's machine tokens ({ cli, watch, agent }; only ids, never values): what the team
// listener refuses (src/hosted/solo/team.js), since those tokens are this machine's alone.
export const machineTokenIds = (dir) => Object.values(readIds(dir)).filter((id) => typeof id === 'string')

function readIds(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, IDS_FILE), 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

// Written whole through a new 0600 file, never through an existing one (or a link put in its place).
function writePrivate(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
    if (process.platform !== 'win32') fs.chmodSync(temp, 0o600)
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

// One machine token for the owner: rotated in place when its row is still
// live, else made new (with its agent row). -> { token, tokenId, agentId, file }.
// `agent`: { name, kind, icon, tint, machine } for a new agent row (agent token only).
export function mintMachineToken(db, { dataDir, owner, which, now = () => new Date(), agent = null }) {
  const spec = MACHINE_TOKENS[which]
  if (!spec) throw new Error(`solo machine token: unknown kind ${which}`)
  const t = tenant(db, owner.workspaceId)
  const at = now().toISOString()
  const ids = readIds(dataDir)
  const { token, hash, prefix } = newApiToken()
  const scopes = JSON.stringify([...spec.scopes].sort())
  const made = transaction(db, () => {
    const id = typeof ids[which] === 'string' ? ids[which] : null
    const row = id
      ? t.get(
          `SELECT id, scopes FROM api_tokens WHERE workspace_id = :ws AND project_id = :project AND id = :id AND revoked_at IS NULL
           AND created_by = :user`,
          { project: owner.projectId, id, user: owner.userId },
        )
      : null
    const agents = createAgentStore(t, { now })
    const actor = {
      userId: owner.userId,
      role: 'owner',
      audit: (action, target, detail) => audit(t, { userId: owner.userId, action, target, ip: null, at, detail }),
    }
    // What this machine's settings say the agent looks like (G13). Put on the agent when it is made, and again only
    // when those settings changed since the last start: a rename on the board stays until the settings change.
    const look = agent ? JSON.stringify([agent.name || null, agent.kind || null, agent.icon || null, agent.tint || null]) : null
    if (row) {
      // The same row, a new secret: what the old file held stops working now. Never wider than it is: a scope or an
      // expiry the owner took away stays away (rev57 R57-3); only what this release no longer gives is dropped.
      let kept = []
      try {
        kept = JSON.parse(row.scopes || '[]')
      } catch {
        kept = []
      }
      const narrowed = JSON.stringify([...new Set(Array.isArray(kept) ? kept : [])].filter((scope) => spec.scopes.includes(scope)).sort())
      t.run('UPDATE api_tokens SET token_hash = :hash, prefix = :prefix, scopes = :scopes WHERE workspace_id = :ws AND id = :id', {
        hash,
        prefix,
        scopes: narrowed,
        id: row.id,
      })
      audit(t, { userId: owner.userId, action: 'token_rotated', target: row.id, ip: null, at, detail: { solo: which } })
      const agentId = spec.scopes.includes('claim') ? agents.forToken(owner.projectId, row.id)?.id || null : null
      if (agentId && look && look !== ids[`${which}Look`]) {
        const changes = { kind: agent.kind || spec.kind, icon: agent.icon || null, tint: agent.tint || null }
        try {
          agents.setIdentity(actor, owner.projectId, agentId, agent.name ? { ...changes, name: agent.name } : changes)
        } catch {
          // A name another agent has: the look still follows the settings, the name stays.
          try {
            agents.setIdentity(actor, owner.projectId, agentId, changes)
          } catch {
            /* an icon or tint this release does not know: left as it is */
          }
        }
      }
      return { tokenId: row.id, agentId, created: false, look }
    }
    const tokenId = newId('tk')
    t.run(
      `INSERT INTO api_tokens (workspace_id, id, project_id, name, token_hash, prefix, scopes, created_by, created_at, expires_at)
       VALUES (:ws, :id, :project, :name, :hash, :prefix, :scopes, :user, :at, NULL)`,
      { id: tokenId, project: owner.projectId, name: agent?.name || spec.name, hash, prefix, scopes, user: owner.userId, at },
    )
    audit(t, { userId: owner.userId, action: 'token_created', target: tokenId, ip: null, at, detail: { solo: which } })
    // Only a token that takes work is an agent (as createApiToken does).
    if (!spec.scopes.includes('claim')) return { tokenId, agentId: null, created: true }
    const agentId = agents.create(actor, {
      projectId: owner.projectId,
      tokenId,
      name: agent?.name || spec.name,
      machine: agent?.machine || null,
      kind: agent?.kind || spec.kind,
      icon: agent?.icon || null,
      tint: agent?.tint || null,
    })
    // The board's own agent is the project's default, as the local chat agent is on a 1.x board: "Send to agent"
    // and the chat panel name it. Only when nothing else is the default yet; the owner can change it.
    if (agent && !agents.defaultAgent(owner.projectId)) agents.setDefault(actor, owner.projectId, agentId)
    return { tokenId, agentId, created: true, look }
  })
  const file = path.join(dataDir, spec.file)
  writePrivate(file, `${token}\n`)
  const next = { ...readIds(dataDir), [which]: made.tokenId }
  if (made.look) next[`${which}Look`] = made.look
  writePrivate(path.join(dataDir, IDS_FILE), `${JSON.stringify(next, null, 2)}\n`)
  delete made.look
  return { token, file, ...made }
}

// At stop: every machine token this folder names gets a secret nobody holds, and its file goes.
export function retireMachineTokens(db, { dataDir, owner }) {
  const ids = readIds(dataDir)
  const t = tenant(db, owner.workspaceId)
  for (const [which, spec] of Object.entries(MACHINE_TOKENS)) {
    fs.rmSync(path.join(dataDir, spec.file), { force: true })
    if (typeof ids[which] !== 'string') continue
    try {
      t.run('UPDATE api_tokens SET token_hash = :hash WHERE workspace_id = :ws AND id = :id', {
        hash: sha256(`retired:${randomBytes(32).toString('hex')}`),
        id: ids[which],
      })
    } catch {
      /* the database is already closed: the next start rotates it anyway */
    }
  }
}
