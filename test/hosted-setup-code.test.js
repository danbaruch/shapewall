// The setup link creates the first account only: a code minted while the
// server had no accounts never creates one after anyone has signed up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumeSetupCode, setupLinkUsable } from '../src/hosted/setup-link.js'
import { sha256 } from '../src/hosted/crypto.js'
import { createAuthenticator, createBrowser, startHostedServer } from './hosted-helpers.js'
import { tempDir } from './helpers.js'

const codeOf = (url) => new URLSearchParams(new URL(url).hash.slice(1)).get('setup')

test('open sign-up, then invite-only: the setup link minted before the first account no longer works', async () => {
  const dataDir = tempDir('setup-code-open-then-invite')
  const open = await startHostedServer('setup-code-open', { dataDir, signup: 'open' })
  let link
  try {
    // Started with no accounts: the setup link is minted (and written to <data>/setup-link).
    link = open.app.locals.setupLink()
    assert.ok(link)
    // Someone signs up openly, without the link.
    const browser = createBrowser(open.port, open.origin)
    const authenticator = createAuthenticator({ origin: open.origin })
    const start = await browser.post('/auth/register/options', { handle: 'olga', displayName: 'Olga' })
    assert.equal(start.status, 200)
    assert.equal((await browser.post('/auth/register/verify', { response: authenticator.register(start.json.options) })).status, 201)
    assert.equal(setupLinkUsable(open.db, link), false, 'not usable once an account exists')
  } finally {
    await open.close()
  }
  // The operator turns sign-up to invite-only and restarts; the old code is still in the table.
  const invite = await startHostedServer('setup-code-invite', { dataDir, signup: 'invite' })
  try {
    assert.equal(invite.app.locals.setupLink(), null, 'no new link: accounts exist')
    const browser = createBrowser(invite.port, invite.origin)
    const refused = await browser.post('/auth/register/options', { handle: 'mallory', displayName: 'Mallory', setup: codeOf(link) })
    assert.equal(refused.status, 403)
    assert.equal(refused.json.error.code, 'invalid_setup')
    assert.equal(invite.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  } finally {
    await invite.close()
  }
})

test('a setup code checked before the first account is still refused at the final step once one exists', async () => {
  const hosted = await startHostedServer('setup-code-race', { signup: 'open' })
  try {
    const code = codeOf(hosted.app.locals.setupLink())
    // Both start with the server empty: one with the setup link, one openly.
    const late = createBrowser(hosted.port, hosted.origin)
    const lateKey = createAuthenticator({ origin: hosted.origin })
    const options = await late.post('/auth/register/options', { handle: 'late', displayName: 'Late', setup: code })
    assert.equal(options.status, 200)
    const first = createBrowser(hosted.port, hosted.origin)
    const firstKey = createAuthenticator({ origin: hosted.origin })
    const start = await first.post('/auth/register/options', { handle: 'first', displayName: 'First' })
    assert.equal((await first.post('/auth/register/verify', { response: firstKey.register(start.json.options) })).status, 201)
    // The setup holder finishes second: the code no longer creates an account plus workspace.
    const done = await late.post('/auth/register/verify', { response: lateKey.register(options.json.options) })
    assert.equal(done.status, 403)
    assert.equal(done.json.error.code, 'invalid_setup')
    assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
    // The same guard serves tailnet sign-up and `hosted access claim` (both use consumeSetupCode).
    assert.equal(consumeSetupCode(hosted.db, sha256(code), new Date().toISOString()), false)
  } finally {
    await hosted.close()
  }
})
