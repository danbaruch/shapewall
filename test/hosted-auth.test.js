// Hosted accounts: passkey sign-up and sign-in (with a software
// authenticator), recovery codes, sessions, re-auth, invites, CSRF and rate
// limits.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '../src/hosted/crypto.js'
import { createAuthenticator, createBrowser, invite, signUp, startHostedServer, askAgain } from './hosted-helpers.js'

let hosted
let owner

before(async () => {
  hosted = await startHostedServer('hosted-auth')
  owner = await signUp(hosted, { handle: 'olive', displayName: 'Olive Owner' })
})
after(() => hosted?.close())

test('the setup link creates the first account, its workspace and ten recovery codes', async () => {
  assert.equal(owner.user.handle, 'olive')
  assert.match(owner.workspaceId, /^ws_[a-f0-9]{24}$/)
  assert.equal(owner.recoveryCodes.length, 10)
  assert.equal(new Set(owner.recoveryCodes).size, 10)
  for (const code of owner.recoveryCodes) assert.match(code, /^[a-z2-9]{6}(-[a-z2-9]{1,6}){4}$/)
  // Only hashes are stored.
  const rows = hosted.db.prepare('SELECT code_hash FROM recovery_codes').all()
  assert.equal(rows.length, 10)
  assert.ok(!rows.some((row) => owner.recoveryCodes.includes(row.code_hash)))
  const me = await owner.browser.get('/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.json.workspaces[0].role, 'owner')
  assert.equal(me.json.passkeys.length, 1)
  assert.equal(me.json.recoveryCodesLeft, 10)
  // A setup link works once and no new one is made once accounts exist.
  assert.equal(hosted.app.locals.setupLink(), null)
})

test('a sign-up ceremony stores only the hash of its invite token, and the invite still works', async () => {
  const token = await invite(owner, owner.workspaceId)
  const browser = createBrowser(hosted.port, hosted.origin)
  const authenticator = createAuthenticator({ origin: hosted.origin })
  const start = await browser.post('/auth/register/options', { handle: 'ivy-hash', displayName: 'Ivy', invite: token })
  assert.equal(start.status, 200, start.text)
  const stored = hosted.db.prepare("SELECT data FROM challenges WHERE data LIKE '%ivy-hash%'").get().data
  assert.ok(!stored.includes(token), 'no raw invite token at rest')
  assert.equal(JSON.parse(stored).inviteHash, sha256(token))
  const done = await browser.post('/auth/register/verify', { response: authenticator.register(start.json.options) })
  assert.equal(done.status, 201, done.text)
  assert.equal(done.json.workspaceId, owner.workspaceId)
  hosted.rateLimiter.reset() // later tests count their own ceremonies
})

test('the session cookie is HttpOnly, SameSite=Lax, and stored only as a hash', async () => {
  const browser = createBrowser(hosted.port, hosted.origin)
  const start = await browser.post('/auth/login/options', {})
  const done = await browser.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options) })
  assert.equal(done.status, 200)
  const cookie = [].concat(done.headers['set-cookie']).find((line) => line.startsWith('sw_session='))
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)
  const token = browser.jar.get('sw_session')
  assert.ok(token.length >= 40)
  assert.ok(hosted.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(token)))
  assert.equal(hosted.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token), undefined)
})

test('sign-up needs an invite or the setup link; handles are unique', async () => {
  const stranger = createBrowser(hosted.port, hosted.origin)
  const refused = await stranger.post('/auth/register/options', { handle: 'mallory', displayName: 'M' })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'invite_required')
  const used = await stranger.post('/auth/register/options', { handle: 'mallory', displayName: 'M', setup: 'not-a-real-setup-code-value' })
  assert.equal(used.status, 403)
  const token = await invite(owner, owner.workspaceId, 'member')
  const taken = await stranger.post('/auth/register/options', { handle: 'olive', displayName: 'Again', invite: token })
  assert.equal(taken.status, 409)
  const bad = await stranger.post('/auth/register/options', { handle: 'X!', displayName: 'Bad', invite: token })
  assert.equal(bad.json.error.code, 'invalid_handle')
})

test('an invite link adds the new account to the workspace once, with its role', async () => {
  const token = await invite(owner, owner.workspaceId, 'viewer')
  const preview = await createBrowser(hosted.port, hosted.origin).post('/api/invites/preview', { token })
  assert.equal(preview.json.role, 'viewer')
  const vera = await signUp(hosted, { handle: 'vera', invite: token })
  assert.equal(vera.workspaceId, owner.workspaceId)
  const me = await vera.browser.get('/auth/me')
  assert.deepEqual(
    me.json.workspaces.map((item) => [item.id, item.role]),
    [[owner.workspaceId, 'viewer']],
  )
  // Used: nobody else can sign up with it.
  const again = await createBrowser(hosted.port, hosted.origin).post('/auth/register/options', {
    handle: 'victor',
    displayName: 'V',
    invite: token,
  })
  assert.equal(again.status, 403)
  assert.equal((await createBrowser(hosted.port, hosted.origin).post('/api/invites/preview', { token })).status, 404)
})

test('sign-in rejects a wrong origin, a reused challenge, a bad signature and a foreign user handle', async () => {
  const browser = createBrowser(hosted.port, hosted.origin)
  let start = await browser.post('/auth/login/options', {})
  let result = await browser.post('/auth/login/verify', {
    response: owner.authenticator.assert(start.json.options, { badOrigin: 'https://evil.example' }),
  })
  assert.equal(result.status, 401)
  // The challenge was used up by that attempt.
  result = await browser.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options) })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'no_ceremony')

  start = await browser.post('/auth/login/options', {})
  result = await browser.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options, { tamper: true }) })
  assert.equal(result.status, 401)

  start = await browser.post('/auth/login/options', {})
  result = await browser.post('/auth/login/verify', {
    response: owner.authenticator.assert(start.json.options, { userHandle: 'c29tZW9uZS1lbHNl' }),
  })
  assert.equal(result.status, 401)

  // A credential the server never saw.
  const unknown = createAuthenticator({ origin: hosted.origin })
  unknown.register({ challenge: 'x', user: { id: 'eA' } })
  start = await browser.post('/auth/login/options', {})
  result = await browser.post('/auth/login/verify', { response: unknown.assert(start.json.options) })
  assert.equal(result.status, 401)
  assert.equal(browser.jar.has('sw_session'), false)

  start = await browser.post('/auth/login/options', {})
  result = await browser.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options) })
  assert.equal(result.status, 200)
  assert.equal(result.json.user.handle, 'olive')
})

test('registration rejects a response for another origin and one without user verification', async () => {
  const token = await invite(owner, owner.workspaceId, 'member')
  const browser = createBrowser(hosted.port, hosted.origin)
  const authenticator = createAuthenticator({ origin: hosted.origin })
  let start = await browser.post('/auth/register/options', { handle: 'quinn', displayName: 'Q', invite: token })
  let done = await browser.post('/auth/register/verify', {
    response: authenticator.register(start.json.options, { badOrigin: 'https://evil.example' }),
  })
  assert.equal(done.status, 400)
  start = await browser.post('/auth/register/options', { handle: 'quinn', displayName: 'Q', invite: token })
  done = await browser.post('/auth/register/verify', { response: authenticator.register(start.json.options, { userVerified: false }) })
  assert.equal(done.status, 400)
  assert.equal(hosted.db.prepare("SELECT COUNT(*) AS n FROM users WHERE handle = 'quinn'").get().n, 0)
})

test('cookie-authenticated writes need this origin and JSON', async () => {
  const crossSite = await owner.browser.call('POST', '/api/workspaces', {
    body: { name: 'Evil' },
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.error.code, 'bad_origin')
  const noOrigin = await owner.browser.call('POST', '/api/workspaces', { body: { name: 'No origin' }, sendOrigin: false })
  assert.equal(noOrigin.status, 403)
  const form = await owner.browser.call('POST', '/api/workspaces', {
    body: 'name=Form',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '9' },
  })
  assert.equal(form.status, 415)
  const ok = await owner.browser.post('/api/workspaces', { name: 'Second' })
  assert.equal(ok.status, 201)
})

test('recovery codes sign in once each; wrong handles and codes do not', async () => {
  const user = await signUp(hosted, { handle: 'rhea', invite: await invite(owner, owner.workspaceId, 'member') })
  const browser = createBrowser(hosted.port, hosted.origin)
  const code = user.recoveryCodes[0]
  assert.equal((await browser.post('/auth/recovery', { handle: 'olive', code })).status, 401, 'a code of another account')
  const ok = await browser.post('/auth/recovery', { handle: 'rhea', code: code.toUpperCase().replace(/-/g, ' ') })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.recoveryCodesLeft, 9)
  // The recovery session can add a passkey right away (and nothing sensitive).
  const options = await browser.post('/auth/passkeys/options', {})
  assert.equal(options.status, 200)
  const again = await createBrowser(hosted.port, hosted.origin).post('/auth/recovery', { handle: 'rhea', code })
  assert.equal(again.status, 401)
})

test('only wrong recovery codes count toward the limit, per handle and address', async () => {
  hosted.rateLimiter.reset()
  const browser = createBrowser(hosted.port, hosted.origin)
  const statuses = []
  for (let index = 0; index < 7; index += 1) {
    statuses.push((await browser.post('/auth/recovery', { handle: 'olive', code: 'aaaaaa-aaaaaa-aaaaaa-aaaaaa-aa' })).status)
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401])
  assert.equal(statuses[5], 429)
  // Another handle from the same address has its own count.
  assert.equal((await browser.post('/auth/recovery', { handle: 'rhea', code: 'aaaaaa-aaaaaa-aaaaaa-aaaaaa-aa' })).status, 401)
  hosted.rateLimiter.reset()
  // Right codes do not count: ten good sign-ins in a row are never limited.
  const user = await signUp(hosted, { handle: 'reed', invite: await invite(owner, owner.workspaceId, 'member') })
  for (const code of user.recoveryCodes) {
    assert.equal((await createBrowser(hosted.port, hosted.origin).post('/auth/recovery', { handle: 'reed', code })).status, 200)
  }
  hosted.rateLimiter.reset()
})

test('passkey ceremonies are rate limited per client', async () => {
  hosted.rateLimiter.reset()
  const browser = createBrowser(hosted.port, hosted.origin)
  let last = null
  for (let index = 0; index < 31; index += 1) last = await browser.post('/auth/login/options', {})
  assert.equal(last.status, 429)
  assert.ok(Number(last.headers['retry-after']) > 0)
  hosted.rateLimiter.reset()
})

test('sensitive actions need a fresh passkey check, which re-auth gives', async () => {
  let now = Date.now()
  const timed = await startHostedServer('hosted-auth-fresh', { now: () => new Date(now) })
  try {
    const user = await signUp(timed, { handle: 'fresh' })
    // New tokens ask for the passkey only when the workspace says so.
    askAgain(timed, user.workspaceId)
    const project = await user.browser.post(`/api/workspaces/${user.workspaceId}/projects`, { name: 'Site' })
    assert.equal(project.status, 201)
    const tokens = `/api/workspaces/${user.workspaceId}/projects/${project.json.project.id}/tokens`
    assert.equal((await user.browser.post(tokens, { name: 'ci', scopes: ['read'] })).status, 201, 'just signed in counts as fresh')
    now += 11 * 60_000
    const stale = await user.browser.post(tokens, { name: 'ci', scopes: ['read'] })
    assert.equal(stale.status, 403)
    assert.equal(stale.json.error.code, 'reauth_required')
    assert.equal((await user.browser.post('/auth/recovery-codes', {})).json.error.code, 'reauth_required')
    const start = await user.browser.post('/auth/reauth/options', {})
    assert.equal(start.json.options.allowCredentials.length, 1)
    const done = await user.browser.post('/auth/reauth/verify', { response: user.authenticator.assert(start.json.options) })
    assert.equal(done.status, 200)
    assert.equal((await user.browser.post(tokens, { name: 'ci', scopes: ['read'] })).status, 201)
    // Sessions slide but end after 30 idle days.
    now += 31 * 86_400_000
    assert.equal((await user.browser.get('/auth/me')).json.user, null)
  } finally {
    await timed.close()
  }
})

test('a second passkey can be added; the last one stays unless recovery codes remain', async () => {
  const user = await signUp(hosted, { handle: 'pat', invite: await invite(owner, owner.workspaceId, 'member') })
  const start = await user.browser.post('/auth/passkeys/options', {})
  assert.equal(start.json.options.excludeCredentials.length, 1)
  const added = await user.browser.post('/auth/passkeys/verify', {
    response: user.authenticator.register(start.json.options),
    nickname: 'Phone',
  })
  assert.equal(added.status, 201)
  assert.equal(added.json.passkeys.length, 2)
  const [first, second] = added.json.passkeys
  assert.equal((await user.browser.call('DELETE', `/auth/passkeys/${encodeURIComponent(first.id)}`)).status, 200)
  // Use up every recovery code, then the last passkey cannot go.
  for (const code of user.recoveryCodes) {
    assert.equal((await createBrowser(hosted.port, hosted.origin).post('/auth/recovery', { handle: 'pat', code })).status, 200)
  }
  hosted.rateLimiter.reset()
  // Recovery sign-ins ended the other sessions: sign in again with the passkey.
  assert.equal((await user.browser.get('/auth/me')).json.user, null)
  const login = await user.browser.post('/auth/login/options', {})
  await user.browser.post('/auth/login/verify', { response: user.authenticator.assert(login.json.options, { credentialId: second.id }) })
  const last = await user.browser.call('DELETE', `/auth/passkeys/${encodeURIComponent(second.id)}`)
  assert.equal(last.status, 409)
  assert.equal(last.json.error.code, 'last_passkey')
})

test('sign out ends the session; other sessions can be revoked', async () => {
  const second = createBrowser(hosted.port, hosted.origin)
  const start = await second.post('/auth/login/options', {})
  await second.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options) })
  assert.ok((await second.get('/auth/me')).json.user)
  const third = createBrowser(hosted.port, hosted.origin)
  const s3 = await third.post('/auth/login/options', {})
  await third.post('/auth/login/verify', { response: owner.authenticator.assert(s3.json.options) })
  assert.equal((await third.post('/auth/sessions/revoke-others', {})).status, 200)
  assert.equal((await second.get('/auth/me')).json.user, null)
  assert.ok((await third.get('/auth/me')).json.user)
  await third.post('/auth/logout', {})
  assert.equal((await third.get('/auth/me')).json.user, null)
})

test('account events land in the audit log', async () => {
  const actions = hosted.db
    .prepare('SELECT action FROM audit_log')
    .all()
    .map((row) => row.action)
  for (const action of [
    'account_created',
    'workspace_created',
    'signed_in',
    'sign_in_failed',
    'invite_created',
    'invite_accepted',
    'recovery_failed',
  ]) {
    assert.ok(actions.includes(action), action)
  }
})

test('signing in again ends the session the browser had', async () => {
  const browser = createBrowser(hosted.port, hosted.origin)
  let start = await browser.post('/auth/login/options', {})
  await browser.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options) })
  const first = browser.jar.get('sw_session')
  start = await browser.post('/auth/login/options', {})
  await browser.post('/auth/login/verify', { response: owner.authenticator.assert(start.json.options) })
  assert.notEqual(browser.jar.get('sw_session'), first)
  assert.equal(hosted.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(first)), undefined)
})
