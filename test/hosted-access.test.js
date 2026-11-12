// Hosted access (W6, migration 5): device logins that survive a restart,
// guest sessions that end one at a time, public projects, moving a server to
// a new origin (rebind tokens, recovery on the new origin, related origins),
// the setup link off the log, Turnstile hooks, admin idle expiry, and synced
// vs device-only passkey labels.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from '../src/hosted/db.js'
import { getState, readMove, recordMove } from '../src/hosted/rebind.js'
import { operatorCommand } from '../src/hosted/access-cli.js'
import { readSetupLink, setupFile } from '../src/hosted/setup-link.js'
import { startHosted } from '../src/hosted/server.js'
import { createTurnstile } from '../src/hosted/turnstile.js'
import {
  createAuthenticator,
  createBrowser,
  createProject,
  createToken,
  invite,
  reauth,
  signUp,
  startHostedServer,
  tokenCall,
  writeLocalCaptures,
  askAgain,
} from './hosted-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'

const servers = []
after(async () => {
  for (const server of servers) await server.close().catch(() => {})
})
async function serve(name, options) {
  const hosted = await startHostedServer(name, options)
  servers.push(hosted)
  return hosted
}
const HOUR = 3_600_000
const clock = (start = Date.now()) => {
  let offset = 0
  return { now: () => new Date(start + offset), advance: (ms) => (offset += ms) }
}

async function pushSample(hosted, token, name) {
  const config = sampleConfig(name)
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, file, full] of pushFiles(config, board)) await remote.pushFile(started.id, area, file, fs.readFileSync(full))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
  return board
}

// ---- Device logins in SQLite ----

test('a device login survives a restart, and the database never holds the token in the clear', async () => {
  const first = await serve('access-device-1')
  const owner = await signUp(first, { handle: 'dora' })
  const project = await createProject(owner, owner.workspaceId, 'Site')
  const started = await fetch(`${first.origin}/api/v1/device/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'laptop' }),
  }).then((response) => response.json())
  const { port, dataDir } = first
  await first.close()
  servers.splice(servers.indexOf(first), 1)

  const second = await serve('access-device-2', { dataDir, port })
  const poll = () =>
    fetch(`${second.origin}/api/v1/device/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: started.deviceCode }),
    })
  assert.equal((await poll()).status, 202, 'still pending after the restart')
  // The owner's cookie still works (sessions are in the database too).
  const browser = createBrowser(second.port, second.origin)
  browser.jar.clear()
  for (const [key, value] of owner.browser.jar) browser.jar.set(key, value)
  const user = { browser, authenticator: owner.authenticator }
  await reauth(user)
  const approved = await browser.post('/api/device/approve', {
    code: started.userCode,
    workspaceId: owner.workspaceId,
    projectId: project.id,
    scopes: ['read'],
  })
  assert.equal(approved.status, 200, approved.text)
  // Approving twice is refused, and leaves no second token.
  assert.equal(
    (await browser.post('/api/device/approve', { code: started.userCode, workspaceId: owner.workspaceId, projectId: project.id })).status,
    404,
  )
  const rows = second.db.prepare('SELECT * FROM device_logins').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'approved')
  assert.doesNotMatch(rows[0].result, /swp_/, 'the token is sealed to the device code')
  const tokens = second.db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE name LIKE '%shapewall login%'").get().n
  assert.equal(tokens, 1)
  const done = await poll()
  assert.equal(done.status, 200)
  const body = await done.json()
  assert.match(body.token, /^swp_/)
  assert.equal((await tokenCall(second, body.token, 'GET', '/api/v1/project')).status, 200)
  assert.equal((await poll()).status, 410, 'handed over once')
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM device_logins').get().n, 0)
})

// ---- Guest sessions ----

test('guest sessions: one row per opened link, listed for admins, and an ended guest is refused at once', async () => {
  const hosted = await serve('access-guests')
  const owner = await signUp(hosted, { handle: 'gwen' })
  const ws = owner.workspaceId
  const project = await createProject(owner, ws, 'Site')
  await reauth(owner)
  await owner.browser.call('PATCH', `/api/workspaces/${ws}/settings`, { body: { shareLinks: true } })
  const made = await owner.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, { mode: 'comment' })
  assert.equal(made.status, 201, made.text)
  const token = new URL(made.json.url).hash.slice(1)
  const sid = made.json.share.id
  const open = async (name, browser = createBrowser(hosted.port, hosted.origin)) => {
    const opened = await browser.post(
      `/s/${sid}/open`,
      { token, name },
      { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/605.1.15' } },
    )
    assert.equal(opened.status, 200, opened.text)
    return browser
  }
  const ada = await open('Ada')
  const bo = await open('Bo')
  const cookie = [...ada.jar].find(([key]) => key === 'sw_guest')[1]
  assert.match(cookie, /^[A-Za-z0-9_-]{43}$/, 'a random token, not a signed payload')
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions WHERE token_hash = ?').get(cookie).n, 0, 'stored hashed')
  assert.equal((await ada.get(`/s/${sid}/api/info`)).json.user.name, 'Ada (guest)')

  const base = `/api/workspaces/${ws}/projects/${project.id}/shares/${sid}/guests`
  const list = await owner.browser.get(base)
  assert.equal(list.status, 200, list.text)
  assert.deepEqual(list.json.guests.map((item) => item.name).sort(), ['Ada', 'Bo'])
  const adaRow = list.json.guests.find((item) => item.name === 'Ada')
  assert.equal(adaRow.status, 'active')
  assert.equal(adaRow.device, 'Safari on iOS')
  assert.ok(!('token_hash' in adaRow) && !('tokenHash' in adaRow))

  const ended = await owner.browser.call('DELETE', `${base}/${adaRow.id}`)
  assert.equal(ended.status, 200, ended.text)
  assert.equal(ended.json.guest.status, 'ended')
  assert.equal((await ada.get(`/s/${sid}/api/info`)).status, 401, 'ended at once')
  assert.equal((await ada.post(`/s/${sid}/api/boards/sample/comments`, { body: 'hi' })).status, 401)
  assert.equal((await ada.get(`/s/${sid}/`)).headers.location, '/share?ended=1')
  assert.equal((await bo.get(`/s/${sid}/api/info`)).status, 200, 'the other guest and the link keep working')
  const audit = await owner.browser.get(`/api/workspaces/${ws}/audit?action=guest_ended`)
  assert.equal(audit.json.entries.length, 1)

  // Opening again in the same browser replaces that browser's guest.
  await open('Bo again', bo)
  const after = (await owner.browser.get(base)).json.guests
  assert.equal(after.filter((item) => item.status === 'active').length, 1)

  const mismatch = await bo.post(`/s/${'sh_' + '0'.repeat(24)}/open`, { token, name: 'Bo' })
  assert.equal(mismatch.status, 404, 'a scoped opener cannot replace a different link session')
  const crossOrigin = await bo.post(`/s/${sid}/open`, { token, name: 'Bo' }, { headers: { Origin: 'https://elsewhere.example' } })
  assert.equal(crossOrigin.status, 403, 'the scoped opener keeps CSRF protection')

  // Another workspace's admin cannot see or end them.
  const other = await signUp(hosted, { handle: 'olaf', invite: await invite(owner, ws, 'member') })
  assert.equal((await other.browser.get(base)).status, 403)
})

// ---- Public projects ----

test('public projects: owner-only with a passkey check, view-only, every write refused, and the kill switches work', async () => {
  const clientDir = tempDir('access-public-client')
  fs.writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Public board test</title>')
  const hosted = await serve('access-public', { reportEmail: 'abuse@example.com', usercontent: true, clientDir })
  const owner = await signUp(hosted, { handle: 'pia' })
  const ws = owner.workspaceId
  askAgain(hosted, ws)
  const project = await createProject(owner, ws, 'Site')
  await reauth(owner)
  const board = await pushSample(hosted, await createToken(owner, ws, project.id), 'access-public')
  const admin = await signUp(hosted, { handle: 'adam', invite: await invite(owner, ws, 'admin') })
  // A comment from a member and one from a guest, to see how they show.
  const page = board.pages[0]
  const posted = await owner.browser.post(`/w/${ws}/p/${project.id}/api/boards/sample/comments`, {
    body: 'Bigger button',
    pageId: page.id,
    viewport: page.viewports[0],
    x: 0.5,
    y: 0.5,
  })
  assert.equal(posted.status, 201, posted.text)

  const makePublic = (user, value) =>
    user.browser.call('PUT', `/api/workspaces/${ws}/projects/${project.id}/public`, { body: { public: value } })
  const workspaceSwitch = (user, value) => user.browser.call('PATCH', `/api/workspaces/${ws}/public-projects`, { body: { enabled: value } })
  assert.equal((await makePublic(owner, true)).json.error.code, 'public_off')
  await reauth(admin)
  assert.equal((await workspaceSwitch(admin, true)).status, 403, 'not an admin')
  hosted.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(owner.user.id)
  assert.equal((await workspaceSwitch(owner, true)).json.error.code, 'reauth_required')
  await reauth(owner)
  assert.equal((await workspaceSwitch(owner, true)).status, 200)
  assert.equal((await makePublic(admin, true)).status, 403, 'only the owner makes a project public')
  const made = await makePublic(owner, true)
  assert.equal(made.status, 200, made.text)
  const { id: publicId, url } = made.json.public
  assert.match(publicId, /^pb_[a-f0-9]{32}$/)
  assert.equal(url, `/p/${publicId}/`)
  const listed = (await owner.browser.get(`/api/workspaces/${ws}`)).json
  assert.equal(listed.workspace.settings.publicProjects, true)
  assert.equal(listed.projects[0].public.id, publicId)

  const memberShell = await owner.browser.get(`/w/${ws}/p/${project.id}/`)
  assert.match(memberShell.headers['permissions-policy'], /microphone=\(self\)/)
  const visitor = createBrowser(hosted.port, hosted.origin)
  const info = await visitor.get(`/p/${publicId}/api/info`)
  assert.equal(info.status, 200)
  assert.equal(info.json.public, true)
  assert.equal(info.json.readOnly, true)
  assert.deepEqual(Object.values(info.json.permissions), [false, false, false, false, false, false])
  assert.match(info.json.reportUrl, /^mailto:abuse@example\.com\?subject=/)
  assert.equal(info.headers['set-cookie'], undefined, 'no cookie is set')
  assert.equal((await visitor.get(`/p/${publicId}/api/boards`)).json.boards.length, 1)
  const view = await visitor.get(`/p/${publicId}/api/boards/sample`)
  assert.equal(view.status, 200)
  assert.equal(view.json.board.siteUrl, null, 'no capture host')
  const comments = (await visitor.get(`/p/${publicId}/api/boards/sample/comments`)).json.comments
  assert.equal(comments.length, 1)
  assert.equal(comments[0].author, owner.user.displayName)
  assert.equal(comments[0].authorHandle, undefined, 'no handles')
  assert.equal(comments[0].resolution, null)
  const live = await visitor.get(`/p/${publicId}/api/boards/sample/live/${page.id}.${page.viewports[0]}.html`)
  assert.equal(live.status, 302)
  assert.ok(live.headers.location.startsWith(`${hosted.usercontentOrigin}/uc/`))
  const publicShell = await visitor.get(`/p/${publicId}/`)
  assert.match(publicShell.headers['permissions-policy'], /microphone=\(\)/)
  assert.equal(publicShell.headers['x-robots-tag'], 'noindex, nofollow')
  assert.ok(
    publicShell.headers['content-security-policy'].includes(`frame-src 'self' ${hosted.usercontentOrigin}`),
    'anonymous public boards must permit the separate live-HTML origin, like member and share boards',
  )

  // Every write is refused, whatever the route.
  const id = comments[0].id
  for (const [method, route, body] of [
    ['POST', '/boards/sample/comments', { body: 'x', pageId: page.id, viewport: page.viewports[0], x: 0, y: 0 }],
    ['POST', `/boards/sample/comments/${id}/replies`, { body: 'x' }],
    ['PATCH', `/boards/sample/comments/${id}`, { body: 'x' }],
    ['POST', `/boards/sample/comments/${id}/resolve`, {}],
    ['POST', `/boards/sample/comments/${id}/reopen`, {}],
    ['POST', `/boards/sample/comments/${id}/reactions`, { emoji: '👍' }],
    ['DELETE', `/boards/sample/comments/${id}`, undefined],
    ['POST', '/boards/sample/capture', {}],
    ['PUT', '/boards/sample/journeys/x', {}],
  ]) {
    for (const sendOrigin of [true, false]) {
      const response = await visitor.call(method, `/p/${publicId}/api${route}`, { body, sendOrigin })
      assert.equal(response.status, 403, `${method} ${route}`)
      assert.equal(response.json.error.code, 'public_read_only')
    }
  }
  // A member's session cookie changes nothing on the public API.
  assert.equal((await owner.browser.post(`/p/${publicId}/api/boards/sample/comments/${id}/resolve`, {})).status, 403)
  assert.equal(hosted.db.prepare('SELECT status FROM comments').get().status, 'open')

  // Kill switches: the admin may turn either off, at once; a new id each time.
  assert.equal((await makePublic(admin, false)).status, 200)
  assert.equal((await visitor.get(`/p/${publicId}/api/info`)).status, 404)
  assert.equal((await visitor.get(`/p/${publicId}/`)).status, 404)
  await reauth(owner)
  const again = (await makePublic(owner, true)).json.public.id
  assert.notEqual(again, publicId)
  assert.equal((await visitor.get(`/p/${again}/api/info`)).status, 200)
  assert.equal((await workspaceSwitch(admin, false)).status, 200)
  assert.equal((await visitor.get(`/p/${again}/api/info`)).status, 404, 'the workspace switch stops every public project')
  assert.equal((await visitor.get('/p/pb_00000000000000000000000000000000/api/info')).status, 404)
  // Off made the project private for good: on again publishes nothing, and the old URL stays dead.
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}`)).json.projects[0].public, null)
  await reauth(owner)
  assert.equal((await workspaceSwitch(owner, true)).status, 200)
  assert.equal((await visitor.get(`/p/${again}/api/info`)).status, 404, 'turning public projects on again revives no old URL')
  assert.equal((await visitor.get(`/p/${again}/`)).status, 404)
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}`)).json.projects[0].public, null)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE public_id IS NOT NULL OR public_at IS NOT NULL').get().n, 0)
  const actions = (await owner.browser.get(`/api/workspaces/${ws}/audit?limit=50`)).json.entries.map((entry) => entry.action)
  for (const action of ['public_projects_enabled', 'project_made_public', 'project_made_private', 'public_projects_disabled'])
    assert.ok(actions.includes(action), action)
})

// ---- Moving to a new origin ----

test('moving origins: rebind tokens are single-use and bound to the account; the old host serves only the move', async () => {
  const oldOrigin = (port) => `http://old.localhost:${port}`
  const first = await serve('access-move-1', { origin: oldOrigin })
  const owner = await signUp(first, { handle: 'mona' })
  const other = await signUp(first, { handle: 'milo', invite: await invite(owner, owner.workspaceId, 'member') })
  const { port, dataDir } = first
  const OLD = first.origin
  await first.close()
  servers.splice(servers.indexOf(first), 1)

  const time = clock()
  const hosted = await serve('access-move-2', {
    dataDir,
    port,
    origin: (p) => `http://new.localhost:${p}`,
    previousOrigin: () => OLD,
    now: time.now,
  })
  const NEW = hosted.origin
  assert.equal(readMove(hosted.db).from, OLD)
  assert.equal(getState(hosted.db, 'origin').origin, NEW)
  // Passkeys made before carry the old host name.
  assert.deepEqual(
    [
      ...new Set(
        hosted.db
          .prepare('SELECT rp_id FROM passkeys')
          .all()
          .map((row) => row.rp_id),
      ),
    ],
    ['old.localhost'],
  )

  // The old host: sign-in, me, the related-origins file; the rest redirects.
  const oldBrowser = owner.browser
  const legal = await oldBrowser.get('/api/legal')
  assert.equal(legal.status, 200, 'the old console footer does not fetch across origins')
  assert.equal(legal.headers.location, undefined)
  assert.equal(legal.json.report, '/report')
  const me = await oldBrowser.get('/auth/me')
  assert.equal(me.json.moving.to, NEW)
  const wellKnown = await oldBrowser.get('/.well-known/webauthn')
  assert.deepEqual(wellKnown.json, { origins: [NEW] })
  const redirected = await oldBrowser.get(`/w/${owner.workspaceId}`)
  assert.equal(redirected.status, 308)
  assert.equal(redirected.headers.location, `${NEW}/w/${owner.workspaceId}`)
  assert.equal((await oldBrowser.get('/share')).headers.location, `${NEW}/share`)
  assert.equal((await oldBrowser.post('/auth/register/options', {})).json.error.code, 'server_moved')
  assert.equal((await oldBrowser.post(`/api/workspaces/${owner.workspaceId}/projects`, { name: 'x' })).json.error.code, 'server_moved')
  const onNew = createBrowser(port, NEW)
  assert.equal((await onNew.get('/.well-known/webauthn')).status, 404)
  assert.equal((await onNew.get('/auth/me')).json.movedFrom.origin, OLD)

  // Starting a rebind needs a fresh passkey check, on the old host only.
  time.advance(11 * 60_000)
  assert.equal((await oldBrowser.post('/auth/rebind/start', {})).json.error.code, 'reauth_required')
  await reauth(owner)
  assert.equal((await onNew.post('/auth/rebind/start', {})).status, 404, 'not on the new host')
  const started = await oldBrowser.post('/auth/rebind/start', {})
  assert.equal(started.status, 200, started.text)
  const url = new URL(started.json.url)
  assert.equal(url.origin, NEW)
  assert.equal(url.pathname, '/rebind')
  assert.equal(url.search, '')
  const token = url.hash.slice(1)
  const stored = hosted.db.prepare('SELECT * FROM rebind_tokens').get()
  assert.notEqual(stored.token_hash, token, 'stored hashed')

  // A newer token voids an older one.
  const second = await oldBrowser.post('/auth/rebind/start', {})
  const token2 = new URL(second.json.url).hash.slice(1)
  const newAuthenticator = createAuthenticator({ origin: NEW })
  const browser = createBrowser(port, NEW)
  assert.equal((await browser.post('/auth/rebind/preview', { token })).status, 404, 'voided by the newer one')
  const preview = await browser.post('/auth/rebind/preview', { token: token2 })
  assert.equal(preview.json.user.handle, 'mona')

  // Milo cannot take Mona's token into his own session: the token names the account.
  const options = await browser.post('/auth/rebind/options', { token: token2, userId: other.user.id })
  assert.equal(options.status, 200, options.text)
  assert.equal(Buffer.from(options.json.options.user.id, 'base64url').length > 0, true)
  assert.equal(options.json.options.user.name, 'mona')
  assert.equal(options.json.options.rp.id, 'new.localhost')
  const verified = await browser.post('/auth/rebind/verify', { response: newAuthenticator.register(options.json.options) })
  assert.equal(verified.status, 201, verified.text)
  assert.equal(verified.json.user.handle, 'mona')
  const meNew = await browser.get('/auth/me')
  assert.equal(meNew.json.user.handle, 'mona')
  assert.equal(meNew.json.fresh, true)
  const added = meNew.json.passkeys.find((key) => key.rpId === 'new.localhost')
  assert.ok(added)
  assert.equal(added.onHoldUntil, null, 'made from a fresh passkey session: no hold')

  // Single use: the same token again does nothing.
  const replay = createBrowser(port, NEW)
  assert.equal((await replay.post('/auth/rebind/options', { token: token2 })).status, 404)
  // And a second ceremony started before the first finished cannot use it either.
  const t3 = new URL((await (async () => (await reauth(owner), oldBrowser.post('/auth/rebind/start', {})))()).json.url).hash.slice(1)
  const racerA = createBrowser(port, NEW)
  const racerB = createBrowser(port, NEW)
  const optsA = await racerA.post('/auth/rebind/options', { token: t3 })
  const optsB = await racerB.post('/auth/rebind/options', { token: t3 })
  const authA = createAuthenticator({ origin: NEW })
  const authB = createAuthenticator({ origin: NEW })
  assert.equal((await racerA.post('/auth/rebind/verify', { response: authA.register(optsA.json.options) })).status, 201)
  const lost = await racerB.post('/auth/rebind/verify', { response: authB.register(optsB.json.options) })
  assert.equal(lost.status, 403)
  assert.equal(lost.json.error.code, 'invalid_rebind')
  assert.equal(
    hosted.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(owner.user.id).n,
    3,
    'the loser stored nothing',
  )

  // The new passkey signs in on the new origin.
  const fresh = createBrowser(port, NEW)
  const login = await fresh.post('/auth/login/options', {})
  assert.equal(login.json.options.rpId, 'new.localhost')
  const done = await fresh.post('/auth/login/verify', { response: newAuthenticator.assert(login.json.options) })
  assert.equal(done.status, 200, done.text)

  // Related origins: an old passkey on the new origin, verified for the old host name.
  const related = createBrowser(port, NEW)
  const relOptions = await related.post('/auth/login/options', { related: true })
  assert.equal(relOptions.json.options.rpId, 'old.localhost')
  const relDone = await related.post('/auth/login/verify', {
    related: true,
    response: other.authenticator.assert(relOptions.json.options, { badOrigin: NEW }),
  })
  assert.equal(relDone.status, 200, relDone.text)
  assert.equal(relDone.json.user.handle, 'milo')
  // The same assertion through the normal (new host name) check fails.
  const plain = await related.post('/auth/login/options', {})
  assert.equal(
    (await related.post('/auth/login/verify', { response: other.authenticator.assert(plain.json.options, { badOrigin: NEW }) })).status,
    401,
  )

  // Audit: the account log has the move.
  const log = (await browser.get('/auth/security-log')).json.events.map((event) => `${event.action}:${event.detail.via || ''}`)
  assert.ok(log.includes('rebind_started:'))
  assert.ok(log.includes('passkey_added:rebind'))

  // After the window, the old host only redirects, and tokens are refused.
  time.advance(31 * 24 * HOUR)
  assert.equal((await oldBrowser.get('/auth/me')).status, 308)
  assert.equal((await browser.post('/auth/rebind/preview', { token: t3 })).status, 404)
  assert.equal((await onNew.get('/auth/me')).json.movedFrom, undefined, 'the move banner expires without a restart')
  const expiredRelated = await onNew.post('/auth/login/options', { related: true })
  assert.equal(expiredRelated.json.options.rpId, 'new.localhost', 'related-origin sign-in ends with the move window')
  const refusedRelated = await onNew.post('/auth/login/verify', {
    related: true,
    response: other.authenticator.assert(expiredRelated.json.options, { badOrigin: NEW }),
  })
  assert.equal(refusedRelated.status, 401, 'an old-RP assertion is refused after the window')
})

test('moving origins: someone who missed the window signs in on the new origin with a recovery code (with the hold)', async () => {
  const first = await serve('access-recover-1', { origin: (port) => `http://old.localhost:${port}` })
  const owner = await signUp(first, { handle: 'rita' })
  const { port, dataDir } = first
  const OLD = first.origin
  await first.close()
  servers.splice(servers.indexOf(first), 1)
  // Moved and the window is over: no previous origin any more.
  const hosted = await serve('access-recover-2', { dataDir, port, origin: (p) => `http://new.localhost:${p}` })
  const browser = createBrowser(port, hosted.origin)
  // The old passkey does not work for the new host name.
  const options = await browser.post('/auth/login/options', {})
  assert.equal(
    (await browser.post('/auth/login/verify', { response: owner.authenticator.assert(options.json.options, { badOrigin: hosted.origin }) }))
      .status,
    401,
  )
  const recovered = await browser.post('/auth/recovery', { handle: 'rita', code: owner.recoveryCodes[0] })
  assert.equal(recovered.status, 200, recovered.text)
  const add = await browser.post('/auth/passkeys/options', {})
  assert.equal(add.status, 200, add.text)
  assert.equal(add.json.options.rp.id, 'new.localhost')
  const auth = createAuthenticator({ origin: hosted.origin })
  const added = await browser.post('/auth/passkeys/verify', { response: auth.register(add.json.options) })
  assert.equal(added.status, 201, added.text)
  const key = added.json.passkeys.find((item) => item.rpId === 'new.localhost')
  assert.ok(key.onHoldUntil, 'the normal 24-hour hold applies')
  assert.ok(OLD)
})

test('move-origin records a move from the recorded origin and checks its input', async () => {
  const hosted = await serve('access-move-cli', { origin: () => 'https://old.example.com' })
  const lines = []
  const out = (line) => lines.push(line)
  await assert.rejects(
    () => operatorCommand('move-origin', { dataDir: hosted.dataDir, flags: { to: 'http://new.example.com' }, out }),
    /https/,
  )
  await assert.rejects(
    () => operatorCommand('move-origin', { dataDir: hosted.dataDir, flags: { to: 'https://old.example.com' }, out }),
    /already/,
  )
  await assert.rejects(
    () => operatorCommand('move-origin', { dataDir: hosted.dataDir, flags: { to: 'https://new.example.com', days: '45' }, out }),
    /--days/,
  )
  await operatorCommand('move-origin', { dataDir: hosted.dataDir, flags: { to: 'https://new.example.com/', days: '7' }, out })
  const move = readMove(hosted.db)
  assert.equal(move.from, 'https://old.example.com')
  assert.equal(move.to, 'https://new.example.com')
  assert.ok(Date.parse(move.endsAt) - Date.parse(move.startedAt) === 7 * 24 * HOUR)
  assert.ok(lines.some((line) => line.includes('--previous-origin https://old.example.com')))
  assert.throws(() => recordMove(hosted.db, { from: 'https://a.example', to: 'https://b.example/path' }), /without a path/)
})

// ---- Setup link ----

test('the setup link goes to a 0600 file, not the log; setup-link prints it; using it removes the file', async () => {
  const dataDir = tempDir('access-setup')
  const lines = []
  const env = {}
  const started = await startHosted({ dataDir, port: 0, origin: 'http://localhost:4799', out: (line) => lines.push(line), env })
  try {
    const file = setupFile(path.resolve(dataDir))
    assert.ok(fs.existsSync(file))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const url = readSetupLink(path.resolve(dataDir))
    assert.match(url, /^http:\/\/localhost:4799\/signup#setup=/)
    const code = new URL(url).hash.slice('#setup='.length)
    assert.ok(!lines.join('\n').includes(code), 'the code is not in the log')
    assert.ok(lines.some((line) => line.includes(file) && line.includes('setup-link')))

    // The CLI prints the same link while it works, a new one with --new.
    const printed = []
    await operatorCommand('setup-link', { dataDir, flags: {}, env, out: (line) => printed.push(line) })
    assert.equal(printed[0], url)
    const renewed = []
    await operatorCommand('setup-link', { dataDir, flags: { new: true }, env, out: (line) => renewed.push(line) })
    assert.notEqual(renewed[0], url)
    assert.equal(readSetupLink(path.resolve(dataDir)), renewed[0])

    // Signing up with it removes the file; afterwards there is no setup link.
    const port = started.server.address().port
    const browser = createBrowser(port, 'http://localhost:4799')
    const authenticator = createAuthenticator({ origin: 'http://localhost:4799' })
    const setup = new URL(renewed[0]).hash.slice('#setup='.length)
    const options = await browser.post('/auth/register/options', { handle: 'sam', displayName: 'Sam', setup })
    assert.equal(options.status, 200, options.text)
    assert.equal((await browser.post('/auth/register/verify', { response: authenticator.register(options.json.options) })).status, 201)
    assert.equal(fs.existsSync(file), false)
    await assert.rejects(() => operatorCommand('setup-link', { dataDir, flags: {}, env, out: () => {} }), /accounts already/)
  } finally {
    await new Promise((resolve) => started.server.close(resolve))
    await started.app.locals.close()
    started.db.close()
  }
})

// ---- Turnstile ----

test('Turnstile, when configured: a failed check blocks open sign-up and comment-link guests; invites need none', async () => {
  const checks = []
  const turnstile = createTurnstile({
    siteKey: 'site-key',
    secret: 'secret-key',
    fetchImpl: async (url, init) => {
      checks.push({ url, body: String(init.body) })
      return new Response(
        JSON.stringify({ success: new URLSearchParams(String(init.body)).get('response') === 'good', hostname: 'localhost' }),
      )
    },
  })
  const hosted = await serve('access-turnstile', { signup: 'open', turnstile })
  const browser = createBrowser(hosted.port, hosted.origin)
  assert.equal((await browser.get('/auth/me')).json.turnstile, 'site-key')
  const refused = await browser.post('/auth/register/options', { handle: 'tina', displayName: 'Tina' })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.error.code, 'turnstile_failed')
  assert.equal((await browser.post('/auth/register/options', { handle: 'tina', displayName: 'Tina', turnstileToken: 'bad' })).status, 403)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM challenges').get().n, 0, 'nothing stored before the check')
  const ok = await browser.post('/auth/register/options', { handle: 'tina', displayName: 'Tina', turnstileToken: 'good' })
  assert.equal(ok.status, 200)
  assert.equal(checks.at(-1).url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  assert.match(checks.at(-1).body, /secret=secret-key/)
  const authenticator = createAuthenticator({ origin: hosted.origin })
  const made = await browser.post('/auth/register/verify', { response: authenticator.register(ok.json.options) })
  assert.equal(made.status, 201)
  const owner = { browser, authenticator, workspaceId: made.json.workspaceId }

  // Invites skip it.
  const before = checks.length
  const invited = await signUp(hosted, { handle: 'ivan', invite: await invite(owner, owner.workspaceId, 'member') })
  assert.ok(invited.user)
  assert.equal(checks.length, before)

  // A comment link asks for it; a view link does not.
  const project = await createProject(owner, owner.workspaceId, 'Site')
  await reauth(owner)
  await browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/settings`, { body: { shareLinks: true } })
  const linkOf = async (mode) =>
    new URL((await browser.post(`/api/workspaces/${owner.workspaceId}/projects/${project.id}/shares`, { mode })).json.url).hash.slice(1)
  const comment = await linkOf('comment')
  const view = await linkOf('view')
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal((await guest.post('/api/shares/preview', { token: comment })).json.turnstile, 'site-key')
  assert.equal((await guest.post('/api/shares/preview', { token: view })).json.turnstile, undefined)
  assert.equal((await guest.post('/api/shares/open', { token: comment, name: 'Gus' })).json.error.code, 'turnstile_failed')
  assert.equal((await guest.post('/api/shares/open', { token: comment, name: 'Gus', turnstileToken: 'good' })).status, 200)
  assert.equal((await createBrowser(hosted.port, hosted.origin).post('/api/shares/open', { token: view })).status, 200)

  // Errors and timeouts fail closed.
  const broken = createTurnstile({ siteKey: 'k', secret: 's', fetchImpl: async () => Promise.reject(new Error('network down')) })
  assert.equal(await broken.verify('good', '1.2.3.4'), false)
  assert.equal(createTurnstile({ siteKey: 'k' }), null, 'off without both keys')
  // A token solved on another site is refused when the server says where its pages are.
  const elsewhere = createTurnstile({
    siteKey: 'k',
    secret: 's',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, hostname: 'evil.example' })),
  })
  assert.equal(await elsewhere.verify('good', '1.2.3.4', { hostnames: ['localhost'] }), false)
  assert.equal(await elsewhere.verify('good', '1.2.3.4', { hostnames: ['evil.example'] }), true)
})

test('a share link revoked during the bot check opens no guest session', async () => {
  let during = () => {}
  const turnstile = { siteKey: 'site-key', verify: async () => (during(), true) }
  const hosted = await serve('access-share-race', { turnstile })
  const owner = await signUp(hosted, { handle: 'rita' })
  const project = await createProject(owner, owner.workspaceId, 'Site')
  await reauth(owner)
  await owner.browser.call('PATCH', `/api/workspaces/${owner.workspaceId}/settings`, { body: { shareLinks: true } })
  const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${project.id}/shares`, { mode: 'comment' })
  const link = new URL(made.json.url).hash.slice(1)
  during = () => hosted.db.prepare('UPDATE shares SET revoked_at = ?').run(new Date().toISOString())
  const opened = await createBrowser(hosted.port, hosted.origin).post('/api/shares/open', { token: link, name: 'Gus', turnstileToken: 'x' })
  assert.equal(opened.status, 404, opened.text)
  assert.equal(opened.json.error.code, 'invalid_share')
  assert.equal(opened.headers['set-cookie'], undefined)
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions').get().n, 0)
})

// ---- Admin idle expiry ----

test('admin pages idle-expire after 12 hours; member pages keep working; a passkey check brings them back', async () => {
  const time = clock()
  const hosted = await serve('access-idle', { now: time.now })
  const owner = await signUp(hosted, { handle: 'ida' })
  const ws = owner.workspaceId
  // Off by default: the workspace asks for it.
  askAgain(hosted, ws)
  await createProject(owner, ws, 'Site')
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}/tokens`)).status, 200)
  // Busy admins stay in: each admin request restarts the clock.
  time.advance(11 * HOUR)
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}/tokens`)).status, 200)
  time.advance(11 * HOUR)
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}/audit`)).status, 200)
  time.advance(12 * HOUR + 60_000)
  const idle = await owner.browser.get(`/api/workspaces/${ws}/tokens`)
  assert.equal(idle.status, 403)
  assert.equal(idle.json.error.code, 'reauth_required')
  // The session itself is fine: the workspace and boards still load.
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}`)).status, 200)
  assert.equal((await owner.browser.get('/auth/me')).json.user.handle, 'ida')
  hosted.rateLimiter.reset()
  await reauth(owner)
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}/tokens`)).status, 200)
})

// ---- Passkey labels and Account activity ----

test('passkeys say whether they sync; sign-ins from a new device are marked', async () => {
  const hosted = await serve('access-labels')
  const owner = await signUp(hosted, { handle: 'lena' })
  await reauth(owner)
  const synced = createAuthenticator({ origin: hosted.origin })
  const options = await owner.browser.post('/auth/passkeys/options', {})
  // BE (0x08) and BS (0x10): backup eligible and backed up.
  const added = await owner.browser.post('/auth/passkeys/verify', { response: synced.register(options.json.options, { flags: 0x5d }) })
  assert.equal(added.status, 201, added.text)
  const keys = added.json.passkeys
  const first = keys.find((key) => key.nickname === 'First passkey')
  const second = keys.find((key) => key.nickname !== 'First passkey')
  assert.equal(first.storage, 'device')
  assert.equal(first.synced, false)
  assert.deepEqual(first.transports, ['internal'])
  assert.equal(first.rpId, 'localhost')
  assert.equal(second.storage, 'synced')
  assert.equal(second.synced, true)

  const phone = createBrowser(hosted.port, hosted.origin)
  const ua = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36' }
  for (let index = 0; index < 2; index += 1) {
    const start = await phone.post('/auth/login/options', {}, { headers: ua })
    assert.equal((await phone.post('/auth/login/verify', { response: synced.assert(start.json.options) }, { headers: ua })).status, 200)
  }
  const events = (await phone.get('/auth/security-log')).json.events.filter((event) => event.action === 'signed_in')
  assert.equal(events[1].detail.newDevice, true, 'the first sign-in on the phone')
  assert.equal(events[0].detail.newDevice, undefined, 'the second is not new')
})

// ---- Migration 5 ----

test('migration 5 adds its tables and columns on top of a version 4 database', async () => {
  const seeded = await serve('access-migration')
  const owner = await signUp(seeded, { handle: 'mira' })
  const project = await createProject(owner, owner.workspaceId, 'Existing site')
  const { dataDir } = seeded
  await seeded.close()
  servers.splice(servers.indexOf(seeded), 1)
  // Reproduce the pre-upgrade schema with real existing account/project data.
  // This is also the documented full rollback of migration 5.
  const old = await openDatabase(path.join(dataDir, 'shapewall.db'))
  old.exec(`
    DROP TABLE device_logins; DROP TABLE guest_sessions; DROP TABLE rebind_tokens; DROP TABLE server_state;
    DROP INDEX projects_public_id;
    ALTER TABLE projects DROP COLUMN public_id; ALTER TABLE projects DROP COLUMN public_at;
    ALTER TABLE projects DROP COLUMN public_by; ALTER TABLE workspaces DROP COLUMN public_projects;
    ALTER TABLE passkeys DROP COLUMN rp_id; ALTER TABLE sessions DROP COLUMN admin_seen_at;
    DROP TABLE reports; DROP TABLE operator_log;
    ALTER TABLE workspaces DROP COLUMN suspended_at;
    ALTER TABLE workspaces DROP COLUMN suspended_reason;
    ALTER TABLE workspaces DROP COLUMN retention_versions;
    DROP TABLE agent_claims; DROP TABLE agent_approvals;
    ALTER TABLE projects DROP COLUMN agent_policy;
    ALTER TABLE comments DROP COLUMN dispatch_hash; ALTER TABLE comments DROP COLUMN dispatch_by;
    ALTER TABLE comments DROP COLUMN dispatch_at; ALTER TABLE comments DROP COLUMN imported;
    ALTER TABLE comments DROP COLUMN run_approved;
    DROP TABLE import_batches; DROP TABLE import_sessions; DROP TABLE comment_imports;
    DROP TABLE user_avatars;
    ALTER TABLE shares DROP COLUMN include_checks;
    DROP TABLE comment_files; ALTER TABLE comments DROP COLUMN images; ALTER TABLE comments DROP COLUMN drawing;
    ALTER TABLE comments DROP COLUMN import_author_kind; ALTER TABLE comments DROP COLUMN imported_by; ALTER TABLE comments DROP COLUMN imported_at;
    ALTER TABLE comments DROP COLUMN import_orphan; ALTER TABLE comments DROP COLUMN imported_reactions;
    DROP TABLE chat_permissions; DROP TABLE chat_turns; DROP TABLE chat_messages; DROP TABLE chat_threads;
    DROP TABLE agent_runs; DROP TABLE agents;
    ALTER TABLE projects DROP COLUMN default_agent_id; ALTER TABLE comments DROP COLUMN agent_id;
    DROP TABLE saved_views; ALTER TABLE workspaces DROP COLUMN retention_usage_days;
    DROP INDEX audit_workspace_at; DROP INDEX audit_workspace_user; DROP INDEX audit_account_user;
    ALTER TABLE workspaces DROP COLUMN step_up;
    DROP INDEX users_tailnet_login; ALTER TABLE users DROP COLUMN tailnet_login; ALTER TABLE users DROP COLUMN tailnet_linked_at;
    ALTER TABLE users DROP COLUMN tailnet_user_id; ALTER TABLE passkeys DROP COLUMN tailnet_added_from;
    ALTER TABLE sessions DROP COLUMN tailnet_login; ALTER TABLE invites DROP COLUMN tailnet_login; DROP TABLE tailnet_visitors; DROP TABLE server_settings;
    DROP TABLE schema_migrations;
    PRAGMA user_version = 4;
  `)
  old.close()
  const db = await openDatabase(path.join(dataDir, 'shapewall.db'))
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17)
  assert.deepEqual(
    db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version),
    // 16 is reserved for a migration from another branch: absent here, never marked applied.
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17],
  )
  assert.equal(db.prepare('SELECT handle FROM users WHERE id = ?').get(owner.user.id).handle, 'mira')
  assert.equal(db.prepare('SELECT name FROM projects WHERE id = ?').get(project.id).name, 'Existing site')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1)
  for (const table of ['device_logins', 'guest_sessions', 'rebind_tokens', 'server_state'])
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table)
  const columns = (table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  assert.ok(columns('workspaces').includes('public_projects'))
  assert.ok(columns('projects').includes('public_id'))
  assert.ok(columns('passkeys').includes('rp_id'))
  assert.ok(columns('sessions').includes('admin_seen_at'))
  db.close()
})
