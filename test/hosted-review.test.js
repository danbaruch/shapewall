// Regression tests for the security review of hosted v0: recovery-code
// takeover, setup-link expiry, owner changes, the recovery rate limit,
// session age, staging and quotas, the cleaning workers, upload caps, token
// reply authors, the remote watch environment, the tenancy guard and the
// proxy warning. Each test names the review item it covers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { createCleaner } from '../src/hosted/cleaner.js'
import { cleanPng, PUSH_LIMITS, sweepStaging } from '../src/hosted/push.js'
import { openDatabase } from '../src/hosted/db.js'
import { proxyWarning } from '../src/hosted/server.js'
import { TenancyError, tenant } from '../src/hosted/tenancy.js'
import { watchRemote } from '../src/remote/remote-watch.js'
import {
  createAuthenticator,
  createBrowser,
  createProject,
  createToken,
  invite,
  signUp,
  startHostedServer,
  tinyPng,
  tokenCall,
  askAgain,
} from './hosted-helpers.js'
import { tempDir } from './helpers.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function clock() {
  let offset = 0
  return { now: () => new Date(Date.now() + offset), advance: (ms) => (offset += ms) }
}

async function addPasskey(browser, authenticator) {
  const start = await browser.post('/auth/passkeys/options', {})
  if (start.status !== 200) return start
  return browser.post('/auth/passkeys/verify', { response: authenticator.register(start.json.options), nickname: 'Added' })
}

async function reauth(browser, authenticator) {
  const start = await browser.post('/auth/reauth/options', {})
  return browser.post('/auth/reauth/verify', { response: authenticator.assert(start.json.options) })
}

async function passkeyLogin(hosted, authenticator, credentialId) {
  const browser = createBrowser(hosted.port, hosted.origin)
  const start = await browser.post('/auth/login/options', {})
  const done = await browser.post('/auth/login/verify', { response: authenticator.assert(start.json.options, { credentialId }) })
  assert.equal(done.status, 200)
  return browser
}

// Item 3.
test('a recovery code cannot lock the owner out: no fresh session, a held passkey, other sessions end', async () => {
  const time = clock()
  const hosted = await startHostedServer('review-recovery', { now: time.now })
  try {
    const owner = await signUp(hosted, { handle: 'olive' })
    const ownerKey = (await owner.browser.get('/auth/me')).json.passkeys[0].id
    // Someone with one stolen code signs in.
    const attacker = createBrowser(hosted.port, hosted.origin)
    assert.equal((await attacker.post('/auth/recovery', { handle: 'olive', code: owner.recoveryCodes[0] })).status, 200)
    const me = (await attacker.get('/auth/me')).json
    assert.equal(me.fresh, false)
    assert.equal(me.viaRecovery, true)
    // Every other session ended, the owner's too (a stolen device loses its session).
    assert.equal((await owner.browser.get('/auth/me')).json.user, null)
    // Nothing sensitive from a recovery session.
    for (const [method, url] of [
      ['POST', '/auth/recovery-codes'],
      ['POST', '/auth/sessions/revoke-others'],
      ['DELETE', `/auth/passkeys/${encodeURIComponent(ownerKey)}`],
    ]) {
      const result = await attacker.call(method, url, { body: method === 'POST' ? {} : undefined })
      assert.equal(result.status, 403, `${method} ${url}`)
      assert.equal(result.json.error.code, 'reauth_required')
    }
    // It may add a passkey, which is on hold for 24 hours.
    const attackerKey = createAuthenticator({ origin: hosted.origin })
    const added = await addPasskey(attacker, attackerKey)
    assert.equal(added.status, 201)
    const held = added.json.passkeys.find((key) => key.id === added.json.id)
    assert.ok(held.onHoldUntil, 'a passkey added after recovery is on hold')
    const check = await reauth(attacker, attackerKey)
    assert.equal(check.status, 403)
    assert.equal(check.json.error.code, 'passkey_on_hold')
    assert.equal((await attacker.post('/auth/recovery-codes', {})).status, 403)
    // Signing in with the held passkey is not fresh either.
    const held2 = await passkeyLogin(hosted, attackerKey, added.json.id)
    assert.equal((await held2.get('/auth/me')).json.fresh, false)
    // The owner's own passkey still wins: it removes the attacker's passkey and
    // that ends every other session.
    const back = await passkeyLogin(hosted, owner.authenticator, ownerKey)
    assert.equal((await back.get('/auth/me')).json.fresh, true)
    assert.equal((await back.call('DELETE', `/auth/passkeys/${encodeURIComponent(added.json.id)}`)).status, 200)
    assert.equal((await attacker.get('/auth/me')).json.user, null)
    assert.equal((await held2.get('/auth/me')).json.user, null)
    // The recovery sign-in is in the audit log with the sessions it ended.
    const row = hosted.db.prepare("SELECT detail FROM audit_log WHERE action = 'signed_in' AND detail LIKE '%recovery_code%'").get()
    assert.equal(JSON.parse(row.detail).otherSessionsEnded, true)
  } finally {
    await hosted.close()
  }
})

// Item 3: the hold ends, and the add window after recovery is short.
test('a held passkey confirms actions after 24 hours; a recovery session adds passkeys only at first', async () => {
  const time = clock()
  const hosted = await startHostedServer('review-hold', { now: time.now })
  try {
    const owner = await signUp(hosted, { handle: 'hana' })
    const browser = createBrowser(hosted.port, hosted.origin)
    assert.equal((await browser.post('/auth/recovery', { handle: 'hana', code: owner.recoveryCodes[0] })).status, 200)
    const key = createAuthenticator({ origin: hosted.origin })
    assert.equal((await addPasskey(browser, key)).status, 201)
    time.advance(DAY + 60_000)
    assert.equal((await reauth(browser, key)).status, 200)
    const me = (await browser.get('/auth/me')).json
    assert.equal(me.fresh, true)
    assert.equal(me.viaRecovery, false)
    assert.equal((await browser.post('/auth/recovery-codes', {})).status, 200)
    // A second recovery session past its first 30 minutes cannot add a passkey.
    const late = createBrowser(hosted.port, hosted.origin)
    assert.equal(
      (await late.post('/auth/recovery', { handle: 'hana', code: owner.recoveryCodes[1] })).status,
      401,
      'old codes were replaced',
    )
    const fresh = (await browser.post('/auth/recovery-codes', {})).json.recoveryCodes
    assert.equal((await late.post('/auth/recovery', { handle: 'hana', code: fresh[0] })).status, 200)
    time.advance(31 * 60_000)
    assert.equal((await late.post('/auth/passkeys/options', {})).json.error.code, 'reauth_required')
  } finally {
    await hosted.close()
  }
})

// Item 5.
test('the setup link is refused at verify once it has expired', async () => {
  const time = clock()
  const hosted = await startHostedServer('review-setup', { now: time.now })
  try {
    const setup = new URLSearchParams(new URL(hosted.app.locals.setupLink()).hash.slice(1)).get('setup')
    time.advance(DAY - 60_000)
    const browser = createBrowser(hosted.port, hosted.origin)
    const options = await browser.post('/auth/register/options', { handle: 'late', displayName: 'Late', setup })
    assert.equal(options.status, 200)
    time.advance(2 * 60_000)
    const authenticator = createAuthenticator({ origin: hosted.origin })
    const done = await browser.post('/auth/register/verify', { response: authenticator.register(options.json.options) })
    assert.equal(done.status, 403)
    assert.equal(done.json.error.code, 'invalid_setup')
    assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0)
  } finally {
    await hosted.close()
  }
})

// Item 9.
test('making or inviting an admin or owner needs a recent passkey check', async () => {
  const time = clock()
  const hosted = await startHostedServer('review-owner', { now: time.now })
  try {
    const owner = await signUp(hosted, { handle: 'oona' })
    // An owner is always asked; an admin when the workspace says so.
    askAgain(hosted, owner.workspaceId)
    const member = await signUp(hosted, { handle: 'mia', invite: await invite(owner, owner.workspaceId, 'member') })
    time.advance(11 * 60_000)
    const invites = `/api/workspaces/${owner.workspaceId}/invites`
    assert.equal((await owner.browser.post(invites, { role: 'member' })).status, 201)
    assert.equal((await owner.browser.post(invites, { role: 'owner' })).json.error.code, 'reauth_required')
    assert.equal((await owner.browser.post(invites, { role: 'admin' })).json.error.code, 'reauth_required')
    const role = `/api/workspaces/${owner.workspaceId}/members/${member.user.id}`
    assert.equal((await owner.browser.call('PATCH', role, { body: { role: 'viewer' } })).status, 200)
    assert.equal((await owner.browser.call('PATCH', role, { body: { role: 'admin' } })).json.error.code, 'reauth_required')
    assert.equal((await owner.browser.call('PATCH', role, { body: { role: 'owner' } })).json.error.code, 'reauth_required')
    assert.equal((await reauth(owner.browser, owner.authenticator)).status, 200)
    assert.equal((await owner.browser.post(invites, { role: 'owner' })).status, 201)
    assert.equal((await owner.browser.post(invites, { role: 'admin' })).status, 201)
    assert.equal((await owner.browser.call('PATCH', role, { body: { role: 'admin' } })).status, 200)
    assert.equal((await owner.browser.call('PATCH', role, { body: { role: 'owner' } })).status, 200)
  } finally {
    await hosted.close()
  }
})

// Nit: absolute session age.
test('sessions end after 90 days even when used every day', async () => {
  const time = clock()
  const hosted = await startHostedServer('review-session-age', { now: time.now })
  try {
    const owner = await signUp(hosted, { handle: 'sage' })
    for (let day = 0; day < 89; day += 2) {
      time.advance(2 * DAY)
      if (day < 86) assert.ok((await owner.browser.get('/auth/me')).json.user, `day ${day + 2}`)
    }
    time.advance(2 * DAY)
    assert.equal((await owner.browser.get('/auth/me')).json.user, null)
  } finally {
    await hosted.close()
  }
})

// Item 2: PNG pixel ceiling, checked before any decoding.
test('PNGs over 16 megapixels are refused from the header alone', () => {
  const png = tinyPng()
  png.writeUInt32BE(3840, 16)
  png.writeUInt32BE(4200, 20)
  assert.throws(
    () => cleanPng(png),
    (error) => error.code === 'invalid_png' && /megapixels/.test(error.message),
  )
  assert.equal(PUSH_LIMITS.pixels, 16_000_000)
})

// A valid RGBA PNG of width x height (for the worker tests).
function bigPng(width, height) {
  const row = width * 4 + 1
  const raw = Buffer.alloc(row * height, 0x55)
  for (let y = 0; y < height; y += 1) raw[y * row] = 0
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])))
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Item 2: cleaning runs off the event loop, capped and with a timeout.
test('the cleaner decodes PNGs in a worker: the event loop stays free, the queue and time are capped', async () => {
  const cleaner = createCleaner({ size: 1, maxQueue: 2 })
  try {
    const png = bigPng(2000, 2000)
    let ticks = 0
    let worst = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const at = performance.now()
      worst = Math.max(worst, at - last)
      last = at
      ticks += 1
    }, 5)
    const started = performance.now()
    const out = await cleaner.clean('png', png)
    const took = performance.now() - started
    clearInterval(timer)
    assert.ok(out.length > 0)
    assert.ok(ticks > 0)
    // The decode took a while, but the loop kept ticking.
    if (took > 100) assert.ok(worst < Math.max(80, took / 2), `event loop stalled ${Math.round(worst)} ms of ${Math.round(took)} ms`)
    // A queue that is full answers busy instead of growing.
    const jobs = [cleaner.clean('png', png), cleaner.clean('png', png), cleaner.clean('png', png)]
    const results = await Promise.allSettled(jobs.concat(cleaner.clean('png', png)))
    assert.ok(results.some((item) => item.status === 'rejected' && item.reason.code === 'busy'))
    // Errors from the worker come back as push errors.
    await assert.rejects(cleaner.clean('png', Buffer.from('not a png')), (error) => error.code === 'invalid_png')
  } finally {
    await cleaner.close()
  }
  const slow = createCleaner({ size: 1, timeoutMs: 1 })
  try {
    await assert.rejects(slow.clean('png', bigPng(2000, 2000)), (error) => error.code === 'clean_timeout')
    // The pool replaces the worker it terminated.
    const ok = createCleaner({ size: 1 })
    assert.ok((await ok.clean('png', tinyPng())).length > 0)
    await ok.close()
  } finally {
    await slow.close()
  }
})

function startPush(hosted, token, boardId = 'sample') {
  return tokenCall(hosted, token, 'POST', '/api/v1/pushes', {
    body: { title: 'x', board: { id: boardId, baseUrl: 'http://127.0.0.1:9', pages: [{ id: 'home', path: '/' }] } },
  })
}
const put = (hosted, token, pushId, name, body) =>
  tokenCall(hosted, token, 'PUT', `/api/v1/pushes/${pushId}/files/captures/${name}`, { body, headers: { 'Content-Type': 'image/png' } })

// Item 2: concurrent uploads per token.
test('a token has at most four uploads in flight', async () => {
  const hosted = await startHostedServer('review-uploads')
  try {
    const owner = await signUp(hosted, { handle: 'ula' })
    const project = await createProject(owner, owner.workspaceId, 'Site')
    const token = await createToken(owner, owner.workspaceId, project.id)
    const push = (await startPush(hosted, token)).json
    // Four uploads that send their headers and then wait.
    const held = []
    for (let index = 0; index < 4; index += 1) {
      const req = http.request({
        host: '127.0.0.1',
        port: hosted.port,
        method: 'PUT',
        path: `/api/v1/pushes/${push.id}/files/captures/home.desktop.png`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'Content-Length': tinyPng().length },
      })
      const done = new Promise((resolve) => req.on('response', (res) => res.resume().on('end', () => resolve(res.statusCode))))
      req.flushHeaders()
      held.push({ req, done })
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const fifth = await put(hosted, token, push.id, 'home.desktop.png', tinyPng())
    assert.equal(fifth.status, 429)
    for (const item of held) item.req.end(tinyPng())
    assert.deepEqual(await Promise.all(held.map((item) => item.done)), [200, 200, 200, 200])
    assert.equal((await put(hosted, token, push.id, 'home.desktop.png', tinyPng())).status, 200)
  } finally {
    await hosted.close()
  }
})

// Items 1 and 2 end to end: a pathological live HTML upload neither stalls
// the server nor takes long.
test('a 4 MB pathological HTML upload is cleaned quickly while the server keeps answering', async () => {
  const hosted = await startHostedServer('review-redos')
  try {
    const owner = await signUp(hosted, { handle: 'reda' })
    const project = await createProject(owner, owner.workspaceId, 'Site')
    const token = await createToken(owner, owner.workspaceId, project.id)
    const push = (await startPush(hosted, token)).json
    const html = Buffer.from(`<!DOCTYPE html><html><head><style>${'url( '.repeat(700_000)}</style></head><body>x</body></html>`)
    const started = performance.now()
    const upload = tokenCall(hosted, token, 'PUT', `/api/v1/pushes/${push.id}/files/captures/home.desktop.html`, {
      body: html,
      headers: { 'Content-Type': 'text/html' },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const pinged = performance.now()
    assert.equal((await fetch(`http://127.0.0.1:${hosted.port}/api/health`)).status, 200)
    const health = performance.now() - pinged
    const result = await upload
    assert.equal(result.status, 200)
    assert.ok(performance.now() - started < 5000, 'the upload is cleaned in seconds, not minutes')
    assert.ok(health < 1000, `health answered in ${Math.round(health)} ms during the upload`)
  } finally {
    await hosted.close()
  }
})

// Item 4: push age, the workspace quota, the board count at commit, the sweep.
test('stale pushes expire, the workspace quota holds, the board count is checked again at commit', async () => {
  const time = clock()
  const hosted = await startHostedServer('review-staging', { now: time.now, workspaceQuota: 300 })
  try {
    const owner = await signUp(hosted, { handle: 'stan' })
    const project = await createProject(owner, owner.workspaceId, 'Site')
    const token = await createToken(owner, owner.workspaceId, project.id)
    // A push older than an hour takes no more files.
    const old = (await startPush(hosted, token)).json
    assert.equal((await put(hosted, token, old.id, 'home.desktop.png', tinyPng())).status, 200)
    time.advance(PUSH_LIMITS.openMs + 1000)
    const late = await put(hosted, token, old.id, 'home.phone.png', tinyPng())
    assert.equal(late.status, 409)
    assert.equal(late.json.error.code, 'push_expired')
    assert.ok(!fs.existsSync(path.join(hosted.dataDir, 'staging', old.id)), 'its staging folder is gone')
    // The quota counts open pushes too: a 300 byte workspace takes three 88 byte PNGs.
    const push = (await startPush(hosted, token)).json
    const statuses = []
    for (const name of ['home.desktop.png', 'home.phone.png', 'home.desktop.thumb.png', 'home.phone.thumb.png']) {
      statuses.push((await put(hosted, token, push.id, name, tinyPng())).json?.error?.code || 'ok')
    }
    assert.deepEqual(statuses, ['ok', 'ok', 'ok', 'quota_exceeded'])
    // Board count: two pushes start while there is room for one more board.
    const insert = hosted.db.prepare(
      "INSERT INTO boards (workspace_id, project_id, board_id, definition, created_at) VALUES (?, ?, ?, '{}', '2026-11-01T00:00:00Z')",
    )
    for (let index = 0; index < PUSH_LIMITS.boardsPerProject - 1; index += 1) insert.run(owner.workspaceId, project.id, `filler-${index}`)
    const first = (await startPush(hosted, token, 'one')).json
    const second = (await startPush(hosted, token, 'two')).json
    assert.equal((await tokenCall(hosted, token, 'POST', `/api/v1/pushes/${first.id}/commit`, { body: {} })).status, 200)
    const refused = await tokenCall(hosted, token, 'POST', `/api/v1/pushes/${second.id}/commit`, { body: {} })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error.code, 'too_many_boards')
  } finally {
    await hosted.close()
  }
})

test('the staging sweep clears expired pushes, orphan folders and leftover board folders', async () => {
  const time = clock()
  const hosted = await startHostedServer('review-sweep', { now: time.now })
  try {
    const owner = await signUp(hosted, { handle: 'swee' })
    const project = await createProject(owner, owner.workspaceId, 'Site')
    const token = await createToken(owner, owner.workspaceId, project.id)
    const open = (await startPush(hosted, token)).json
    const stale = (await startPush(hosted, token)).json
    hosted.db.prepare('UPDATE pushes SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * HOUR).toISOString(), stale.id)
    const orphan = path.join(hosted.dataDir, 'staging', 'ps_000000000000000000000000')
    fs.mkdirSync(orphan, { recursive: true })
    const leftover = path.join(hosted.dataDir, 'files', owner.workspaceId, project.id, 'sample.old-ps_111111111111111111111111')
    fs.mkdirSync(leftover, { recursive: true })
    assert.equal(sweepStaging({ db: hosted.db, dataDir: hosted.dataDir, now: time.now() }), 3)
    assert.ok(fs.existsSync(path.join(hosted.dataDir, 'staging', open.id)), 'a live push keeps its folder')
    assert.ok(!fs.existsSync(path.join(hosted.dataDir, 'staging', stale.id)))
    assert.ok(!fs.existsSync(orphan))
    assert.ok(!fs.existsSync(leftover))
    assert.equal(hosted.db.prepare('SELECT status FROM pushes WHERE id = ?').get(stale.id).status, 'failed')
  } finally {
    await hosted.close()
  }
})

// Item 8.
test('token replies are signed with the token name and an agent flag; people show their handle', async () => {
  const hosted = await startHostedServer('review-authors')
  try {
    const owner = await signUp(hosted, { handle: 'ora', displayName: 'Ora' })
    const project = await createProject(owner, owner.workspaceId, 'Site')
    const made = await owner.browser.post(`/api/workspaces/${owner.workspaceId}/projects/${project.id}/tokens`, {
      name: 'ci-bot',
      scopes: ['read', 'comment', 'push'],
    })
    const token = made.json.token
    const push = (await startPush(hosted, token)).json
    assert.equal((await tokenCall(hosted, token, 'POST', `/api/v1/pushes/${push.id}/commit`, { body: {} })).status, 200)
    const base = `/w/${owner.workspaceId}/p/${project.id}/api/boards/sample/comments`
    const comment = (await owner.browser.post(base, { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'Hi' })).json.comment
    assert.equal(comment.author, 'Ora')
    assert.equal(comment.authorHandle, 'ora')
    const reply = await tokenCall(hosted, token, 'POST', `/api/v1/boards/sample/comments/${comment.id}/replies`, {
      body: { body: 'Done', author: 'Ora' },
    })
    assert.equal(reply.status, 201)
    assert.equal(reply.json.reply.author, 'ci-bot', 'a token cannot sign as a person')
    assert.equal(reply.json.reply.agent, true)
    const person = await owner.browser.post(`${base}/${comment.id}/replies`, { body: 'Thanks' })
    assert.equal(person.json.reply.handle, 'ora')
    assert.equal(person.json.reply.agent, undefined)
  } finally {
    await hosted.close()
  }
})

// Item 10.
test('watch --remote keeps the token from --exec commands and checks ids before using them as paths', async () => {
  const item = (id) => ({ id, agentStatus: null, viewport: { name: 'desktop' }, files: {}, page: { id: 'home', url: 'http://x/' } })
  // A remote that remembers agent statuses, like the server.
  const fake = (comments) => {
    const status = new Map()
    const current = (comment) => ({ ...comment, agentStatus: status.get(comment.id) ?? null })
    return {
      origin: 'http://localhost:1',
      comments: async () => ({ comments: comments.map(current) }),
      comment: async (board, id) => ({ comment: { ...current(comments.find((c) => c.id === id)), status: 'open' } }),
      setAgentStatus: async (board, id, value) => {
        status.set(id, value)
        return { changed: true, comment: current(comments.find((c) => c.id === id)) }
      },
      reply: async () => ({}),
      download: async () => Buffer.alloc(0),
    }
  }
  const outDir = tempDir('review-watch-out')
  const agent = path.join(outDir, 'agent.mjs')
  fs.writeFileSync(
    agent,
    "import fs from 'node:fs'\nfs.writeFileSync(process.argv[2] + '/env-' + process.env.SHAPEWALL_COMMENT_ID + '.json', JSON.stringify({ token: process.env.SHAPEWALL_TOKEN ?? null }))\n",
  )
  const run = (passToken, comments) =>
    watchRemote({
      remote: fake(comments),
      boardId: 'sample',
      projectId: 'pr_000000000000000000000000',
      exec: `${process.execPath} ${agent} ${outDir}`,
      once: true,
      cwd: tempDir('review-watch'),
      env: { ...process.env, SHAPEWALL_TOKEN: 'swp_secret_for_the_test' },
      passToken,
      log: () => {},
    })
  await run(false, [item(1)])
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'env-1.json'), 'utf8')).token, null)
  await run(true, [item(2)])
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'env-2.json'), 'utf8')).token, 'swp_secret_for_the_test')
  // Ids that would be paths are skipped or refused.
  await run(false, [item('../../x'), item(-1), item(1.5)])
  assert.deepEqual(
    fs.readdirSync(outDir).filter((name) => name.startsWith('env-')),
    ['env-1.json', 'env-2.json'],
  )
  await assert.rejects(
    watchRemote({ remote: fake([]), boardId: '../up', projectId: 'pr_000000000000000000000000', once: true, log: () => {} }),
    /invalid board id/,
  )
  await assert.rejects(
    watchRemote({ remote: fake([]), boardId: 'sample', projectId: '../../etc', once: true, log: () => {} }),
    /invalid project id/,
  )
})

// Nit: the tenancy guard is anchored to the WHERE clause.
test('tenant() needs workspace_id = :ws first in the WHERE, with no OR or UNION', async () => {
  const db = await openDatabase(':memory:')
  const t = tenant(db, 'ws_000000000000000000000000')
  for (const sql of [
    'SELECT * FROM comments WHERE workspace_id = :ws OR 1 = 1',
    'SELECT * FROM comments WHERE 1 = 1 OR workspace_id = :ws',
    "SELECT * FROM comments WHERE body = 'workspace_id = :ws'",
    'SELECT * FROM comments WHERE workspace_id = :ws UNION SELECT * FROM comments',
    'SELECT * FROM comments WHERE workspace_id = :ws; DELETE FROM comments',
    'SELECT * FROM comments WHERE x.workspace_id_other = :ws',
  ]) {
    assert.throws(() => t.all(sql), TenancyError, sql)
  }
  assert.deepEqual(t.all('SELECT * FROM comments WHERE workspace_id = :ws ORDER BY number'), [])
  assert.deepEqual(t.all('SELECT c.number FROM comments c WHERE c.workspace_id = :ws AND c.number > 0'), [])
  db.close()
})

// Nit: --origin https on loopback without --trust-proxy.
test('an https origin on loopback without --trust-proxy warns', () => {
  assert.match(proxyWarning({ origin: 'https://app.example.com', host: '127.0.0.1', trustProxy: false }), /--trust-proxy/)
  assert.equal(proxyWarning({ origin: 'https://app.example.com', host: '127.0.0.1', trustProxy: true }), null)
  assert.equal(proxyWarning({ origin: 'http://localhost:4700', host: '127.0.0.1', trustProxy: false }), null)
  assert.equal(proxyWarning({ origin: 'https://app.example.com', host: '0.0.0.0', trustProxy: false }), null)
})
