// Fixes from the security review of the hosted QA work (PR #31): API tokens
// die with their maker's admin role, removal and demotion revoke them, account
// deletion always does; the /device page shows where a login came from;
// `shapewall login` opens only a URL it builds; exports one at a time and
// rate-limited, with the audit log streamed; capture hosts scrubbed from
// broken links and errors; control characters out of names and CLI output;
// pending logins capped per address.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { publicBoardView } from '../src/hosted/app.js'
import { createDeviceLogins } from '../src/hosted/device.js'
import { openDatabase } from '../src/hosted/db.js'
import { projectDir } from '../src/hosted/projects.js'
import { readZip } from '../src/hosted/zip.js'
import { deviceLoginUrl, login, openerFor } from '../src/remote/login.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { terminalSafe } from '../src/remote/terminal.js'
import { createProject, createToken, invite, reauth, signUp, startHostedServer, tokenCall, writeLocalCaptures } from './hosted-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'

let hosted
let deviceLogins
let owner
let ws
let project

const api = (user, method, url, body) => user.browser.call(method, url, body === undefined ? {} : { body })
const fresh = async (...users) => {
  hosted.rateLimiter.reset()
  for (const user of users) await reauth(user)
}
const tokenStatus = async (id) =>
  (await owner.browser.get(`/api/workspaces/${ws}/tokens`)).json.tokens.find((item) => item.id === id)?.status

async function namedToken(user, name) {
  const made = await user.browser.post(`/api/workspaces/${ws}/projects/${project.id}/tokens`, { name, scopes: ['read'] })
  assert.equal(made.status, 201, made.text)
  return { token: made.json.token, id: made.json.info.id }
}

async function adminWithToken(handle, name = `${handle}-ci`) {
  await fresh(owner)
  const person = await signUp(hosted, { handle, displayName: handle, invite: await invite(owner, ws, 'admin') })
  await fresh(person)
  return { person, ...(await namedToken(person, name)) }
}

before(async () => {
  hosted = await startHostedServer('hosted-security-review')
  deviceLogins = hosted.app.locals.deviceLogins
  owner = await signUp(hosted, { handle: 'oona', displayName: 'Oona Owner' })
  ws = owner.workspaceId
  project = await createProject(owner, ws, 'Site')
  await reauth(owner)
  const token = await createToken(owner, ws, project.id)
  const config = sampleConfig('sec-review-push')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  // A failed shot whose error names the capture host.
  const [pageId] = Object.keys(manifest.pages)
  const [viewport] = Object.keys(manifest.pages[pageId])
  manifest.pages[pageId][viewport] = { status: 'failed', error: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/about' }
  await remote.commitPush(started.id, { manifest, variants: [] })
})
after(() => hosted?.close())

// ---- H1: tokens outlive membership ----

test('a token works only while its maker is an admin or owner here, checked on every request', async () => {
  const { person, token, id } = await adminWithToken('tara')
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 200)
  // Behind the console's back (no revocation): the role alone decides.
  const setRole = (role) =>
    hosted.db.prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, ws, person.user.id)
  setRole('member')
  const refused = await tokenCall(hosted, token, 'GET', '/api/v1/project')
  assert.equal(refused.status, 401)
  assert.match(refused.json.error.message, /no longer an admin/)
  assert.equal(await tokenStatus(id), 'inactive')
  setRole('owner')
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 200)
  hosted.db.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').run(ws, person.user.id)
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 401)
})

test('removing a member revokes their tokens by default; an admin may keep them, and kept ones are inactive', async () => {
  const first = await adminWithToken('rhea')
  await fresh(owner)
  const removed = await api(owner, 'DELETE', `/api/workspaces/${ws}/members/${first.person.user.id}`)
  assert.equal(removed.status, 200, removed.text)
  assert.equal(removed.json.revoked.tokens, 1)
  assert.equal(await tokenStatus(first.id), 'revoked')
  assert.equal((await tokenCall(hosted, first.token, 'GET', '/api/v1/project')).status, 401)

  const second = await adminWithToken('kept')
  await fresh(owner)
  const keptRemoval = await api(owner, 'DELETE', `/api/workspaces/${ws}/members/${second.person.user.id}`, { revokeTokens: false })
  assert.equal(keptRemoval.status, 200, keptRemoval.text)
  assert.equal(keptRemoval.json.revoked.tokens, 0)
  assert.equal(await tokenStatus(second.id), 'inactive')
  assert.equal((await tokenCall(hosted, second.token, 'GET', '/api/v1/project')).status, 401)
})

test('demoting an admin below admin revokes their tokens; owner to admin and back keeps them', async () => {
  const { person, token, id } = await adminWithToken('dana')
  await fresh(owner)
  const promoted = await api(owner, 'PATCH', `/api/workspaces/${ws}/members/${person.user.id}`, { role: 'owner' })
  assert.equal(promoted.status, 200, promoted.text)
  assert.equal(promoted.json.revoked.tokens, 0)
  await fresh(owner)
  const back = await api(owner, 'PATCH', `/api/workspaces/${ws}/members/${person.user.id}`, { role: 'admin' })
  assert.equal(back.json.revoked.tokens, 0)
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 200)
  await fresh(owner)
  const demoted = await api(owner, 'PATCH', `/api/workspaces/${ws}/members/${person.user.id}`, { role: 'member' })
  assert.equal(demoted.status, 200, demoted.text)
  assert.equal(demoted.json.revoked.tokens, 1)
  assert.equal(await tokenStatus(id), 'revoked')
  assert.equal((await tokenCall(hosted, token, 'GET', '/api/v1/project')).status, 401)
  const audit = await owner.browser.get(`/api/workspaces/${ws}/audit?action=member_grants_revoked`)
  assert.ok(audit.json.entries.some((entry) => entry.target === person.user.id && entry.detail.tokens === 1))
})

test('deleting an account always revokes its tokens (no opt-out), planned inside its transaction', async () => {
  const { person, id } = await adminWithToken('dex')
  await fresh(person)
  const deleted = await api(person, 'DELETE', '/auth/me', { confirm: 'dex', revokeTokens: false })
  assert.equal(deleted.status, 200, deleted.text)
  assert.equal(deleted.json.left, 1)
  assert.equal(await tokenStatus(id), 'revoked')
  // A blocked deletion changes nothing.
  await fresh(owner)
  const other = await signUp(hosted, { handle: 'stay', invite: await invite(owner, ws, 'member') })
  assert.ok(other.user.id)
  await fresh(owner)
  const refused = await api(owner, 'DELETE', '/auth/me', { confirm: 'oona' })
  assert.equal(refused.status, 409)
  assert.equal((await owner.browser.get('/auth/me')).json.user.handle, 'oona')
})

// ---- M1: the device approval page ----

test('the device lookup shows the requesting address, the age, and whether it is the approver’s address', async () => {
  const far = deviceLogins.start({ name: 'build-box', ip: '203.0.113.9' })
  hosted.rateLimiter.reset()
  const found = await owner.browser.post('/api/device/lookup', { code: far.userCode })
  assert.equal(found.status, 200, found.text)
  assert.equal(found.json.login.ip, '203.0.113.9')
  assert.equal(found.json.login.sameIp, false)
  assert.equal(found.json.login.name, 'build-box')
  assert.ok(Number.isInteger(found.json.login.ageSeconds) && found.json.login.ageSeconds >= 0)
  assert.ok(found.json.login.approverIp)

  const started = await fetch(`${hosted.origin}/api/v1/device/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'laptop' }),
  }).then((response) => response.json())
  const near = await owner.browser.post('/api/device/lookup', { code: started.userCode })
  assert.equal(near.json.login.sameIp, true, JSON.stringify(near.json.login))
})

// ---- L4: pending logins ----

test('pending logins: at most 5 per address (429), and a full server drops the oldest instead of refusing everyone', async () => {
  const logins = createDeviceLogins({ db: await openDatabase(':memory:'), maxPending: 3, maxPerIp: 2 })
  const first = logins.start({ name: 'a', ip: '198.51.100.1' })
  assert.ok(logins.start({ name: 'b', ip: '198.51.100.1' }).deviceCode)
  assert.deepEqual(logins.start({ name: 'c', ip: '198.51.100.1' }), { refused: 'per_ip' })
  const third = logins.start({ name: 'd', ip: '198.51.100.2' })
  assert.equal(logins.size(), 3)
  const fourth = logins.start({ name: 'e', ip: '198.51.100.3' })
  assert.ok(fourth.deviceCode, 'room was made')
  assert.equal(logins.size(), 3)
  assert.equal(logins.lookup(first.userCode), null, 'the oldest went')
  assert.ok(logins.lookup(third.userCode))
  assert.ok(logins.lookup(fourth.userCode))
  assert.equal(logins.poll(first.deviceCode).status, 'expired')

  // Over HTTP, the sixth from one address is a 429 with a message.
  const statuses = []
  for (let index = 0; index < 6; index += 1) {
    hosted.rateLimiter.reset()
    const response = await fetch(`${hosted.origin}/api/v1/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `m${index}` }),
    })
    statuses.push(response.status)
    if (response.status === 429) assert.equal((await response.json()).error.code, 'too_many_logins')
  }
  // One pending from the test above may still count: at least one refusal, never a 503.
  assert.ok(statuses.includes(429), statuses.join(' '))
  assert.ok(!statuses.includes(503))
})

// ---- M2: what `shapewall login` opens ----

test('shapewall login builds the /device URL itself and opens it without a shell', async () => {
  assert.equal(deviceLoginUrl('https://app.example.com'), 'https://app.example.com/device')
  assert.equal(deviceLoginUrl('http://localhost:4700'), 'http://localhost:4700/device')
  assert.equal(deviceLoginUrl('http://[::1]:4700'), 'http://[::1]:4700/device')
  assert.equal(deviceLoginUrl('https://a&calc.example'), null, 'shell characters in the host')
  assert.equal(deviceLoginUrl('https://a^b.example'), null)
  assert.equal(deviceLoginUrl('https://user:pw@app.example.com'), null)
  assert.equal(deviceLoginUrl('https://app.example.com/path'), null)
  assert.equal(deviceLoginUrl('javascript:alert(1)'), null)
  assert.equal(deviceLoginUrl('not a url'), null)
  const [command, args] = openerFor('https://app.example.com/device', 'win32')
  assert.equal(command, 'rundll32')
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', 'https://app.example.com/device'])
  assert.deepEqual(openerFor('https://x.example/device', 'darwin'), ['open', ['https://x.example/device']])

  // The server's verificationUrl (and control characters in what it says) are ignored.
  const opened = []
  const lines = []
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/start'))
      return new Response(
        JSON.stringify({
          deviceCode: 'd'.repeat(43),
          userCode: 'BCDF-GHJK',
          verificationUrl: 'https://evil.example/device?x=1&calc',
          interval: 1,
          expiresIn: 600,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    return new Response(JSON.stringify({ error: { code: 'login_denied', message: 'Denied\u001b[2J\u001b]0;pwned\u0007 here' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }
  await assert.rejects(
    login({ remote: 'https://app.example.com' }, (line) => lines.push(line), {
      env: { XDG_CONFIG_HOME: tempDir('sec-login') },
      fetchImpl,
      sleep: async () => {},
      open: (url) => opened.push(url),
    }),
    (error) => {
      assert.equal(error.message, terminalSafe(error.message))
      assert.ok(!error.message.includes('\u001b') && !error.message.includes('\u0007'), JSON.stringify(error.message))
      return true
    },
  )
  assert.deepEqual(opened, ['https://app.example.com/device'])
  assert.ok(lines.some((line) => line.includes('https://app.example.com/device')))
  assert.ok(!lines.join('\n').includes('evil.example'))
})

test('terminalSafe drops control characters and bidi overrides, keeps newlines and tabs', () => {
  assert.equal(terminalSafe('a\u001b[31mb\u009bc‮d\te\nf\u0007'), 'a[31mbcd\te\nf')
  assert.equal(terminalSafe(null), '')
})

// ---- M3: exports ----

function rawExport(user) {
  const cookie = [...user.browser.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: hosted.port,
        method: 'POST',
        path: `/api/workspaces/${ws}/export`,
        headers: { Cookie: cookie, Origin: hosted.origin, 'Content-Type': 'application/json', 'Content-Length': 2 },
      },
      (res) => {
        res.pause() // read nothing: the server waits on backpressure
        resolve({ req, res })
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
}

test('exports: one at a time per workspace (409 while one runs), rate-limited per person, audit.json streamed and whole', async () => {
  // A big file so the first export blocks on a client that does not read.
  const boardDir = path.join(projectDir(hosted.dataDir, ws, project.id), 'sample', 'captures')
  fs.mkdirSync(boardDir, { recursive: true })
  const big = path.join(boardDir, 'zz-big.png')
  fs.writeFileSync(big, Buffer.alloc(40 * 1024 * 1024, 7))
  try {
    await fresh(owner)
    const first = await rawExport(owner)
    assert.equal(first.res.statusCode, 200)
    const second = await api(owner, 'POST', `/api/workspaces/${ws}/export`, {})
    assert.equal(second.status, 409, second.text)
    assert.equal(second.json.error.code, 'export_running')
    first.req.destroy()
    first.res.destroy()
    await new Promise((resolve) => setTimeout(resolve, 200))
  } finally {
    fs.rmSync(big, { force: true })
  }
  // Released: the next one runs, and its audit.json parses.
  const done = await api(owner, 'POST', `/api/workspaces/${ws}/export`, {})
  assert.equal(done.status, 200, done.text)
  const files = readZip(done.body)
  const auditName = Object.keys(files).find((name) => name.endsWith('/audit.json'))
  const audit = JSON.parse(files[auditName])
  assert.ok(Array.isArray(audit) && audit.length > 10)
  assert.ok(
    audit.every((entry, index) => index === 0 || entry.id < audit[index - 1].id),
    'newest first',
  )
  // The rate limit: 5 an hour per person.
  const statuses = []
  for (let index = 0; index < 5; index += 1) statuses.push((await api(owner, 'POST', `/api/workspaces/${ws}/export`, {})).status)
  assert.equal(statuses.at(-1), 429, statuses.join(' '))
})

// ---- L1: capture hosts on hosted boards ----

test('hosted boards: failed-shot errors lose the capture host (members and guests get the same view)', async () => {
  const board = await owner.browser.get(`/w/${ws}/p/${project.id}/api/boards/sample`)
  assert.equal(board.status, 200, board.text)
  assert.ok(board.text.includes('ERR_CONNECTION_REFUSED'), 'the error is still there')
  assert.ok(!board.text.includes('127.0.0.1:9'), board.text.slice(0, 400))
})

test('publicBoardView scrubs broken links and errors of the capture host', () => {
  const board = {
    baseUrl: 'http://127.0.0.1:9/app',
    publicUrl: null,
    pages: [{ id: 'home', path: '/' }],
    environments: [{ id: 'staging', baseUrl: 'https://staging.internal.example' }],
  }
  const view = {
    board: { pages: [{ id: 'home', path: '/' }] },
    manifest: {
      pages: { home: { desktop: { status: 'failed', error: 'HTTP 500 at http://127.0.0.1:9/app/', html: { error: 'see 127.0.0.1:9' } } } },
      brokenLinks: [{ url: 'http://127.0.0.1:9/app/gone', path: '/gone', kind: 'site', error: 'HTTP 404', from: ['home'] }],
    },
    brokenLinks: [
      { url: 'http://127.0.0.1:9/app/gone', path: '/gone', kind: 'site', status: 404, error: null, from: ['home'] },
      {
        url: 'https://other.example/x',
        path: null,
        kind: 'external',
        error: 'refused by https://staging.internal.example',
        from: ['home'],
      },
    ],
  }
  const out = JSON.stringify(publicBoardView(view, board))
  assert.ok(!out.includes('127.0.0.1'), out)
  assert.ok(!out.includes('staging.internal.example'), out)
  const scrubbed = publicBoardView(view, board)
  assert.equal(scrubbed.brokenLinks[0].url, '/gone')
  assert.equal(scrubbed.brokenLinks[1].url, 'https://other.example/x')
  // With a public URL, site links point there.
  const withPublic = publicBoardView(view, { ...board, publicUrl: 'https://www.example.com' })
  assert.equal(withPublic.brokenLinks[0].url, 'https://www.example.com/gone')
  assert.match(withPublic.manifest.pages.home.desktop.error, /https:\/\/www\.example\.com/)
})

// ---- L3: control characters in names ----

test('workspace, project and token names lose control characters', async () => {
  await fresh(owner)
  assert.equal((await api(owner, 'PATCH', `/api/workspaces/${ws}`, { name: 'Oona\u001b[2J Co\u0007' })).status, 200)
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}`)).json.workspace.name, 'Oona[2J Co')
  const made = await owner.browser.post(`/api/workspaces/${ws}/projects`, { name: 'Docs\u001b]0;x\u0007' })
  assert.equal(made.status, 201, made.text)
  assert.equal(made.json.project.name, 'Docs]0;x')
  await fresh(owner)
  const { id } = await namedToken(owner, 'ci\u001b[1A\u0000')
  const tokens = (await owner.browser.get(`/api/workspaces/${ws}/tokens`)).json.tokens
  assert.equal(tokens.find((item) => item.id === id).name, 'ci[1A')
})
