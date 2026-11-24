import { prepareSql } from '../shared/sqlite.js'

export function auditRow({ userId = null, tokenId = null, shareId = null, action, target = null, ip = null, detail = {}, at }) {
  return { user: userId, token: tokenId, share: shareId, action, target, ip, detail: JSON.stringify(detail), at }
}

// Account events that belong to no workspace (sign-in, sign-up, recovery).
export function auditAccount(db, entry) {
  prepareSql(
    db,
    'INSERT INTO audit_log (workspace_id, user_id, token_id, share_id, action, target, ip, detail, at) VALUES (NULL, :user, :token, :share, :action, :target, :ip, :detail, :at)',
  ).run(auditRow(entry))
}

// The account-level events of one user (no workspace): sign-ins, recovery
// codes, passkeys, sessions. Newest first, `before` an entry id for paging.
export function accountEvents(db, userId, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
  return prepareSql(
    db,
    'SELECT id, action, target, ip, detail, at FROM audit_log WHERE workspace_id IS NULL AND user_id = :user AND id < :before ORDER BY id DESC LIMIT :limit',
  ).all({ user: userId, before, limit })
}

// The newest sign-in with a recovery code after `since` (null: ever).
export function lastRecoverySignIn(db, userId, since) {
  return (
    prepareSql(
      db,
      `SELECT id, ip, at FROM audit_log WHERE workspace_id IS NULL AND user_id = :user AND action = 'signed_in'
       AND json_extract(detail, '$.via') = 'recovery_code' AND at > :since ORDER BY id DESC LIMIT 1`,
    ).get({ user: userId, since: since || '' }) || null
  )
}

// Whether this account signed in before from a device with this label
// ("Chrome on macOS"), for the "new device" mark in Account activity.
export function seenDevice(db, userId, device) {
  if (!device) return true
  return Boolean(
    prepareSql(
      db,
      `SELECT id FROM audit_log WHERE workspace_id IS NULL AND user_id = :user AND action IN ('signed_in', 'account_created')
       AND json_extract(detail, '$.device') = :device LIMIT 1`,
    ).get({ user: userId, device }),
  )
}
