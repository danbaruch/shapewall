// Project API tokens (src/hosted/app.js): the scopes a token can have and
// making one, from the console or an approved `shapewall login`.

import { listTokens } from './admin.js'
import { expandScopes } from './agent-policy.js'
import { newApiToken, newId } from './crypto.js'
import { HttpError, cleanName } from './http.js'

export const TOKEN_SCOPES = ['read', 'reply', 'status', 'claim', 'resolve', 'push', 'import']
const DAY = 86_400_000

export function createApiTokens({ iso, auditOf }) {
  // A new project token for req.t / req.project, made by req.user. Returns
  // the token (shown once) and its listing. `via` marks how it was made
  // ("login" for `shapewall login`) in the audit log.
  function createApiToken(req, body, { via = null } = {}) {
    // A name too long is refused, not cut (as on a rename): it is what people will see.
    const name = cleanName(body.name, 61)
    if (!name || name.length > 60) throw new HttpError(400, 'invalid_name', 'Token name: 1 to 60 characters.')
    const scopes = Array.isArray(body.scopes) ? expandScopes(body.scopes) : ['read']
    if (!scopes.length || scopes.some((scope) => !TOKEN_SCOPES.includes(scope))) {
      throw new HttpError(400, 'invalid_scopes', `Scopes: ${TOKEN_SCOPES.join(', ')}.`)
    }
    if (scopes.includes('import') && via !== 'import')
      throw new HttpError(403, 'import_login_required', 'Import is a one-time grant from a moving-project device login.')
    const days = body.expiresInDays
    if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) {
      throw new HttpError(400, 'invalid_expiry', 'expiresInDays: 1 to 365, or leave it out.')
    }
    const count = req.t.get(
      'SELECT COUNT(*) AS n FROM api_tokens WHERE workspace_id = :ws AND project_id = :project AND revoked_at IS NULL',
      { project: req.project.id },
    ).n
    if (count >= 50) throw new HttpError(409, 'too_many_tokens', 'Revoke an old token first (50 per project).')
    const { token, hash, prefix } = newApiToken()
    const id = newId('tk')
    req.t.run(
      `INSERT INTO api_tokens (workspace_id, id, project_id, name, token_hash, prefix, scopes, created_by, created_at, expires_at)
       VALUES (:ws, :id, :project, :name, :hash, :prefix, :scopes, :user, :at, :expires)`,
      {
        id,
        project: req.project.id,
        name,
        hash,
        prefix,
        scopes: JSON.stringify(scopes.sort()),
        user: req.user.id,
        at: iso(),
        expires: days ? iso(days * DAY) : null,
      },
    )
    auditOf(req, 'token_created', id, { project: req.project.id, scopes, ...(days ? { days } : {}), ...(via ? { via } : {}) })
    const info = listTokens(req.t, { projectId: req.project.id, now: iso() }).find((item) => item.id === id)
    return { token, info }
  }

  return createApiToken
}
