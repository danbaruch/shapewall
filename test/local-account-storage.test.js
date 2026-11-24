import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createAuth } from '../src/accounts/auth.js'
import { openAccountDatabase } from '../src/accounts/db.js'
import { accountEvents, auditAccount } from '../src/accounts/events.js'
import { openDatabase as openLegacySidecar } from '../src/hosted/db.js'
import { tempDir } from './helpers.js'

test('an existing account sidecar keeps its session, passkey, recovery codes, activity and migration ledger', async () => {
  const file = path.join(tempDir('account-storage'), 'accounts.sqlite')
  const old = await openLegacySidecar(file)
  const at = new Date().toISOString()
  const user = 'fixture-user'
  const auth = (db) => createAuth({ db, origin: 'https://fixture.localhost', rpId: 'fixture.localhost' })
  old
    .prepare('INSERT INTO users (id, handle, display_name, webauthn_user_id, created_at) VALUES (?,?,?,?,?)')
    .run(user, 'fixture', 'Fixture', 'fixture', at)
  old
    .prepare('INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES (?,?,?,?,?)')
    .run('fixture-key', user, Buffer.of(1), 2, at)
  const session = auth(old).createSession(user)
  const [code] = auth(old).newRecoveryCodes(user)
  auditAccount(old, { userId: user, action: 'signed_in', at })
  const ledger = old.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
  old.close()
  const db = await openAccountDatabase(file)
  try {
    assert.equal(auth(db).readSession(session).user.id, user)
    assert.equal(auth(db).listPasskeys(user)[0].id, 'fixture-key')
    assert.equal(auth(db).useRecoveryCode('fixture', code).id, user)
    assert.equal(auth(db).useRecoveryCode('fixture', code), null)
    assert.equal(accountEvents(db, user)[0].action, 'signed_in')
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), ledger)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})
