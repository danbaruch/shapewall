// The setup link: the one-time link that creates the first account on an
// invite-only server. It is a secret (whoever opens it first owns the
// server), so it never goes to the start log, which journald keeps: the
// server writes it to <data>/setup-link (mode 0600, only the operator reads
// it) and the log says where it is. `shapewall hosted setup-link` prints it
// in the operator's own terminal (or makes a new one). Using it removes the
// file.

import fs from 'node:fs'
import path from 'node:path'
import { randomToken, sha256 } from './crypto.js'
import { accounts } from './tenancy.js'

export const SETUP_FILE = 'setup-link'
export const SETUP_TTL_MS = 86_400_000

export const setupFile = (dataDir) => path.join(dataDir, SETUP_FILE)

// A new code (unused older ones stop working); returns the URL.
export function mintSetupLink(db, origin, now = new Date()) {
  const q = accounts(db)
  const code = randomToken(24)
  q.run('DELETE FROM setup_codes WHERE used_at IS NULL')
  q.run('INSERT INTO setup_codes (code_hash, created_at, expires_at) VALUES (:hash, :at, :expires)', {
    hash: sha256(code),
    at: now.toISOString(),
    expires: new Date(now.getTime() + SETUP_TTL_MS).toISOString(),
  })
  return `${origin}/signup#setup=${code}`
}

// Uses a setup code: the one conditional UPDATE every sign-up path goes
// through (web sign-up, tailnet sign-up, `hosted access claim`). It works only
// while the server has no accounts: a code minted before an open sign-up (or
// left over from one) never creates an account once anyone has one. `self`:
// the account being created in this same transaction, when it already exists.
// Returns whether the code was used.
export function consumeSetupCode(db, hash, at, { self = null } = {}) {
  return (
    accounts(db).run(
      `UPDATE setup_codes SET used_at = :at
       WHERE code_hash = :hash AND used_at IS NULL AND expires_at > :at
         AND NOT EXISTS (SELECT 1 FROM users WHERE :self IS NULL OR id != :self)`,
      { at, hash, self },
    ).changes > 0
  )
}

// Codes nobody used, once the server has accounts (they can never work).
export function dropSetupCodes(db) {
  accounts(db).run('DELETE FROM setup_codes WHERE used_at IS NULL')
}

// Whether a setup URL's code still works (unused, not expired, no accounts yet).
export function setupLinkUsable(db, url, now = new Date()) {
  let code = ''
  try {
    code = new URLSearchParams(new URL(url).hash.slice(1)).get('setup') || ''
  } catch {
    return false
  }
  if (!code) return false
  const row = accounts(db).get('SELECT used_at, expires_at FROM setup_codes WHERE code_hash = :hash', { hash: sha256(code) })
  return Boolean(row && !row.used_at && row.expires_at > now.toISOString() && userCount(db) === 0)
}

// Written so that only the owner of the data folder can read it, even when
// the file existed before with looser permissions.
export function writeSetupLink(dataDir, url) {
  const file = setupFile(dataDir)
  fs.rmSync(file, { force: true })
  fs.writeFileSync(file, `${url}\n`, { mode: 0o600, flag: 'wx' })
  return file
}

export function readSetupLink(dataDir) {
  try {
    return fs.readFileSync(setupFile(dataDir), 'utf8').trim() || null
  } catch {
    return null
  }
}

export const removeSetupLink = (dataDir) => fs.rmSync(setupFile(dataDir), { force: true })

export const userCount = (db) => accounts(db).get('SELECT COUNT(*) AS n FROM users').n
