// Local accounts and paired devices, read for `shapewall migrate`.
//
// `serve --accounts` keeps one owner with passkeys in
// <outputDir>/.accounts/accounts.sqlite (docs/local-accounts.md). That owner
// becomes the engine's owner with the same user id, passkeys, recovery codes
// and picture; sign-in sessions stay behind. The file itself is left where
// it is (an older `serve --accounts` keeps working, and a rollback has
// nothing to put back).
//
// Paired devices (devices.json beside the agent settings) are not migrated:
// the engine signs other devices in through the tailnet or an invite, so
// they pair again. The migration lists them.

import fs from 'node:fs'
import path from 'node:path'
import { DEVICE_MAX_MS, Devices } from '../server/devices.js'

export const accountsFile = (outputDir) => path.join(outputDir, '.accounts', 'accounts.sqlite')

// The local account database, read only, or null when there is none.
// { user, passkeys, recoveryCodes, avatar, sessions, problem }.
export async function readAccounts(outputDir) {
  const file = accountsFile(outputDir)
  if (!fs.existsSync(file)) return null
  // Read-only, and never through the account module's opener (which would
  // create tables in a file it did not make, or switch its journal mode).
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const table = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
    if (!table('users')) return null
    const users = db.prepare('SELECT * FROM users ORDER BY created_at').all()
    if (!users.length) return null
    if (users.length > 1)
      return { problem: `The local account file holds ${users.length} accounts; a solo engine has one owner.`, users: users.length }
    const user = users[0]
    const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key] ?? null]))
    const passkeys = table('passkeys')
      ? db
          .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at')
          .all(user.id)
          .map((row) => ({
            ...pick(row, [
              'id',
              'counter',
              'transports',
              'device_type',
              'nickname',
              'created_at',
              'last_used_at',
              'recovery_added_at',
              'rp_id',
            ]),
            public_key: Buffer.from(row.public_key),
            backed_up: row.backed_up ? 1 : 0,
          }))
      : []
    const recoveryCodes = table('recovery_codes')
      ? db.prepare('SELECT code_hash, created_at, used_at FROM recovery_codes WHERE user_id = ? ORDER BY id').all(user.id)
      : []
    const avatarRow = table('user_avatars')
      ? db.prepare('SELECT png, digest, updated_at FROM user_avatars WHERE user_id = ?').get(user.id)
      : null
    const sessions = table('sessions') ? db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n : 0
    return {
      user: pick(user, ['id', 'handle', 'display_name', 'webauthn_user_id', 'created_at', 'security_seen_at']),
      passkeys,
      recoveryCodes: recoveryCodes.map((row) => ({ ...row })),
      avatar: avatarRow ? { png: Buffer.from(avatarRow.png), digest: avatarRow.digest, updated_at: avatarRow.updated_at } : null,
      sessions,
    }
  } finally {
    db.close()
  }
}

// The devices paired with this project's local board, by name and when
// they were last seen. [] when there are none or the file cannot be read
// (the reason in `problem`).
// Read only: Devices.list() would also prune and rewrite the file.
export function readDevices(projectDir, { env = process.env, now = Date.now() } = {}) {
  try {
    const store = new Devices(projectDir, { env })
    const state = store.read().projects[store.key] || { devices: [] }
    const live = (state.devices || []).filter((item) => item.expiresAt > now && item.createdAt + DEVICE_MAX_MS > now)
    return { devices: live.map(({ name, lastSeenAt }) => ({ name: String(name || 'device'), lastSeenAt: lastSeenAt || null })) }
  } catch (error) {
    return { devices: [], problem: error.message }
  }
}
