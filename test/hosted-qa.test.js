// Fixes from the hosted end-to-end QA: `watch --remote` keeps running and
// stops non-zero on a dead token; the CLI says what to do about a revoked
// token; `shapewall login` gets a token through the browser and keeps it in
// a 0600 file; account deletion and workspace export; the account security
// log and the recovery-code notice; audit search and CSV; invite notes;
// "already a member" invite previews; guest labels; no capture base URL on
// hosted boards; the console's page for a board you cannot open; revoking a
// removed member's tokens; the workspace name at setup.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readZip } from '../src/hosted/zip.js'
import { login } from '../src/remote/login.js'
import { credentialsFile, readCredential } from '../src/remote/credentials.js'
import { createRemote, pushDefinition, pushFiles, remoteSettings } from '../src/remote/remote.js'
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
} from './hosted-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'
import { stopChild, waitForExit } from './child-process-helpers.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shapewall.js')
const CONSOLE_MARK = '<!-- shapewall console test page -->'

let hosted
let owner
let ws
let project
let token

const api = (user, method, url, body) => user.browser.call(method, url, body === undefined ? {} : { body })
const fresh = async (...users) => {
  hosted.rateLimiter.reset()
  for (const user of users) await reauth(user)
}

async function pushSample(pushToken, projectId = project.id) {
  const config = sampleConfig(`qa-${projectId}`)
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: pushToken })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  return remote.commitPush(started.id, { manifest, variants: [] })
}

async function memberComment(user, body) {
  const made = await user.browser.post(`/w/${ws}/p/${project.id}/api/boards/sample/comments`, {
    pageId: 'home',
    viewport: 'desktop',
    x: 5,
    y: 5,
    body,
  })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}

// The CLI as a child process; resolves lines as they arrive.
function runCli(args, env, { diagnostics = false } = {}) {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'watch-shutdown-diagnostics.mjs')
  const child = spawn(process.execPath, [...(diagnostics ? ['--import', preload] : []), CLI, ...args], {
    cwd: tempDir('qa-cli-cwd'),
    env: { ...process.env, SHAPEWALL_NO_BROWSER: '1', XDG_CONFIG_HOME: tempDir('qa-cli-xdg'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => (state.stdout += chunk))
  child.stderr.on('data', (chunk) => (state.stderr += chunk))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const waitFor = async (check, label, ms = 15_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (check(state)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${label}\nstdout: ${state.stdout}\nstderr: ${state.stderr}`)
  }
  return {
    child,
    state,
    waitFor,
    exitWithin: () => waitForExit(exited),
    close: () => stopChild(child, exited),
    diagnostics: () =>
      state.stderr
        .split('\n')
        .filter((line) => line.startsWith('[watch-diag] '))
        .join('\n'),
  }
}

before(async () => {
  const consoleDir = tempDir('qa-console')
  fs.writeFileSync(path.join(consoleDir, 'console.html'), `<!DOCTYPE html><html><body>${CONSOLE_MARK}</body></html>`)
  hosted = await startHostedServer('hosted-qa', { consoleDir })
  owner = await signUp(hosted, { handle: 'olga', displayName: 'Olga Owner' })
  ws = owner.workspaceId
  project = await createProject(owner, ws, 'Site')
  token = await createToken(owner, ws, project.id, ['read', 'reply', 'status', 'claim', 'resolve', 'push'])
  await pushSample(token)
})
after(() => hosted?.close())

test('watch --remote keeps running, picks up a comment posted after it started, and Ctrl+C stops it cleanly', async (t) => {
  const run = runCli(
    ['watch', '--remote', hosted.origin, '--board', 'sample', '--new-only'],
    { SHAPEWALL_TOKEN: token },
    { diagnostics: true },
  )
  try {
    await run.waitFor((state) => /Watching hosted board/.test(state.stderr), 'the watch to start')
    // Longer than one poll: the first version exited after it.
    await new Promise((resolve) => setTimeout(resolve, 3500))
    assert.equal(run.child.exitCode, null, `still running\n${run.state.stderr}`)
    const comment = await memberComment(owner, 'Posted after the watch started')
    await run.waitFor((state) => state.stdout.includes(comment.id), 'the new comment')
    run.child.kill('SIGINT')
    const { code, signal } = await run.exitWithin()
    assert.equal(code, 0, run.state.stderr)
    assert.equal(signal, null, 'Ctrl+C exits normally through the shutdown handler')
  } finally {
    try {
      await run.close()
    } finally {
      const diagnostic = run.diagnostics()
      assert.ok(!diagnostic.includes(token) && !diagnostic.includes(hosted.origin), 'diagnostics exclude credentials and URLs')
      for (const line of diagnostic.split('\n')) t.diagnostic(line)
    }
  }
})

test('watch --remote stops non-zero when its token is revoked, with what to do', async () => {
  const short = await createToken(owner, ws, project.id, ['read', 'comment'])
  const run = runCli(['watch', '--remote', hosted.origin, '--board', 'sample'], { SHAPEWALL_TOKEN: short })
  try {
    await run.waitFor((state) => /Watching hosted board/.test(state.stderr), 'the watch to start')
    const list = await owner.browser.get(`/api/workspaces/${ws}/tokens`)
    const id = list.json.tokens.find((item) => item.prefix && short.startsWith(item.prefix) && item.status === 'active').id
    assert.equal((await api(owner, 'DELETE', `/api/workspaces/${ws}/projects/${project.id}/tokens/${id}`)).status, 200)
    const { code } = await run.exitWithin()
    assert.notEqual(code, 0)
    assert.match(
      run.state.stderr,
      /This token was revoked, has expired or its maker is no longer an admin there \(or it is wrong\)\. Create a new one in the console:/,
    )
    assert.ok(!run.state.stderr.includes(short), 'the token is never printed')
  } finally {
    await run.close()
  }
})

test('a wrong token gets the plain message from any --remote command', async () => {
  const run = runCli(['comments', 'list', '--remote', hosted.origin], { SHAPEWALL_TOKEN: `swp_${'x'.repeat(43)}` })
  try {
    const { code } = await run.exitWithin()
    assert.equal(code, 1)
    assert.match(
      run.state.stderr,
      /This token was revoked, has expired or its maker is no longer an admin there \(or it is wrong\)\. Create a new one in the console: http:\/\/localhost:\d+\//,
    )
  } finally {
    await run.close()
  }
})

test('shapewall login: a code, approval in the console, a 0600 credentials file, and the token never printed', async () => {
  const env = { XDG_CONFIG_HOME: tempDir('qa-login-xdg'), SHAPEWALL_NO_BROWSER: '1' }
  const lines = []
  let approved = null
  const sleep = async () => {
    if (approved) return
    const code = lines.map((line) => line.trim()).find((line) => /^[A-Z]{4}-[A-Z]{4}$/.test(line))
    assert.ok(code, lines.join('\n'))
    // The console side: look the code up, then approve with a fresh passkey check.
    const found = await owner.browser.post('/api/device/lookup', { code })
    assert.equal(found.status, 200, found.text)
    assert.equal(found.json.login.code, code)
    assert.ok(found.json.workspaces.some((item) => item.id === ws && item.projects.some((p) => p.id === project.id)))
    hosted.rateLimiter.reset()
    await reauth(owner)
    approved = await owner.browser.post('/api/device/approve', {
      code,
      workspaceId: ws,
      projectId: project.id,
      scopes: ['read', 'comment'],
      expiresInDays: 30,
    })
    assert.equal(approved.status, 200, approved.text)
  }
  const result = await login({ remote: hosted.origin }, (line) => lines.push(line), { env, sleep, open: () => false })
  assert.equal(result.file, credentialsFile(env))
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600)
  const saved = readCredential(hosted.origin, env)
  assert.match(saved.token, /^swp_/)
  assert.ok(!lines.join('\n').includes(saved.token), 'the token is not printed')
  assert.deepEqual([...saved.scopes].sort(), ['read', 'reply', 'status'])
  // The --remote commands use it without SHAPEWALL_TOKEN.
  const settings = remoteSettings({ remote: hosted.origin }, env)
  assert.equal(settings.source, 'login')
  const info = await tokenCall(hosted, settings.token, 'GET', '/api/v1/project')
  assert.equal(info.status, 200, info.text)
  // The console lists it, named after the machine, made by the login.
  const tokens = await owner.browser.get(`/api/workspaces/${ws}/tokens`)
  assert.ok(tokens.json.tokens.some((item) => item.name.endsWith('(shapewall login)') && item.status === 'active'))
  const audit = await owner.browser.get(`/api/workspaces/${ws}/audit?action=token_created`)
  assert.ok(audit.json.entries.some((entry) => entry.detail.via === 'login'))
  // A code works once.
  assert.equal((await owner.browser.post('/api/device/lookup', { code: 'BCDF-GHJK' })).status, 404)
})

test('a denied login: the CLI stops with a message and saves nothing', async () => {
  const env = { XDG_CONFIG_HOME: tempDir('qa-login-deny'), SHAPEWALL_NO_BROWSER: '1' }
  const lines = []
  let denied = false
  const sleep = async () => {
    if (denied) return
    const code = lines.map((line) => line.trim()).find((line) => /^[A-Z]{4}-[A-Z]{4}$/.test(line))
    assert.equal((await owner.browser.post('/api/device/deny', { code })).status, 200)
    denied = true
  }
  await assert.rejects(
    login({ remote: hosted.origin }, (line) => lines.push(line), { env, sleep, open: () => false }),
    /denied/i,
  )
  assert.equal(readCredential(hosted.origin, env), null)
})

test('the security log lists sign-ins and passkey changes; a recovery-code sign-in is flagged once on the next passkey sign-in', async () => {
  const hana = await signUp(hosted, { handle: 'hana', displayName: 'Hana', invite: await invite(owner, ws, 'member') })
  // Someone uses a recovery code (other sessions end).
  const other = createBrowser(hosted.port, hosted.origin)
  hosted.rateLimiter.reset()
  assert.equal((await other.post('/auth/recovery', { handle: 'hana', code: hana.recoveryCodes[0] })).status, 200)
  const recoveryMe = await other.get('/auth/me')
  assert.equal(recoveryMe.json.viaRecovery, true)
  assert.equal(recoveryMe.json.securityNotice, null, 'the recovery session has its own banner')
  // Hana signs in with her passkey: told once.
  const browser = createBrowser(hosted.port, hosted.origin)
  const start = await browser.post('/auth/login/options', {})
  assert.equal((await browser.post('/auth/login/verify', { response: hana.authenticator.assert(start.json.options) })).status, 200)
  const me = await browser.get('/auth/me')
  assert.equal(me.json.securityNotice?.kind, 'recovery_code_used')
  const log = await browser.get('/auth/security-log')
  const actions = log.json.events.map((event) => `${event.action}:${event.detail.via || ''}`)
  assert.ok(actions.includes('signed_in:recovery_code'), actions.join(' '))
  assert.ok(actions.includes('signed_in:passkey'))
  assert.ok(actions.includes('account_created:invite'))
  assert.equal((await browser.post('/auth/security-notice/seen', {})).status, 200)
  assert.equal((await browser.get('/auth/me')).json.securityNotice, null)
  // Only her own events.
  assert.ok(log.json.events.every((event) => !JSON.stringify(event).includes('olga')))
})

test('account deletion: refused for the only owner of a shared workspace; otherwise leaves or deletes, and revokes tokens', async () => {
  // Olga owns a workspace with others in it: blocked.
  const plan = await owner.browser.post('/auth/delete-account/preview', {})
  assert.deepEqual(
    plan.json.blocked.map((item) => item.id),
    [ws],
  )
  await fresh(owner)
  const refused = await api(owner, 'DELETE', '/auth/me', { confirm: 'olga' })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'sole_owner')

  // Ivy: an admin here with a token, and the only member of her own workspace.
  const ivy = await signUp(hosted, { handle: 'ivy', displayName: 'Ivy', invite: await invite(owner, ws, 'admin') })
  await fresh(ivy)
  const own = await ivy.browser.post('/api/workspaces', { name: 'Ivy solo' })
  assert.equal(own.status, 201, own.text)
  const ivyToken = await createToken(ivy, ws, project.id, ['read'])
  const ivyPlan = (await ivy.browser.post('/auth/delete-account/preview', {})).json
  assert.deepEqual(
    ivyPlan.left.map((item) => item.id),
    [ws],
  )
  assert.equal(ivyPlan.deleted.length, 1)
  assert.equal(ivyPlan.blocked.length, 0)
  // The handle has to be typed back, and a fresh passkey check is needed.
  assert.equal((await api(ivy, 'DELETE', '/auth/me', { confirm: 'nope' })).json.error.code, 'confirm_handle')
  const deleted = await api(ivy, 'DELETE', '/auth/me', { confirm: '@ivy' })
  assert.equal(deleted.status, 200, deleted.text)
  assert.deepEqual({ deleted: deleted.json.deleted, left: deleted.json.left }, { deleted: 1, left: 1 })
  assert.equal((await ivy.browser.get('/auth/me')).json.user, null)
  assert.equal((await tokenCall(hosted, ivyToken, 'GET', '/api/v1/project')).status, 401)
  const members = (await owner.browser.get(`/api/workspaces/${ws}`)).json.members
  assert.ok(!members.some((item) => item.handle === 'ivy'))
  const audit = await owner.browser.get(`/api/workspaces/${ws}/audit?action=member_left`)
  assert.ok(audit.json.entries.some((entry) => entry.detail.accountDeleted))
})

test('workspace export: a zip of the workspace, boards and comments, without secrets; admins only, with a fresh check', async () => {
  await memberComment(owner, 'In the export')
  hosted.rateLimiter.reset()
  await reauth(owner)
  const made = await owner.browser.call('POST', `/api/workspaces/${ws}/export`, { body: {} })
  assert.equal(made.status, 200, made.text)
  assert.match(made.headers['content-type'], /zip/)
  assert.match(made.headers['content-disposition'], /attachment; filename=".+-export-\d{4}-\d{2}-\d{2}\.zip"/)
  const files = readZip(made.body)
  const names = Object.keys(files)
  const root = names[0].split('/')[0]
  const workspace = JSON.parse(files[`${root}/workspace.json`])
  assert.equal(workspace.workspace.id, ws)
  assert.ok(workspace.members.some((item) => item.handle === 'olga'))
  const comments = names.find((name) => name.endsWith('/boards/sample/comments.json'))
  assert.ok(comments, names.join('\n'))
  assert.ok(files[comments].toString().includes('In the export'))
  assert.ok(names.some((name) => name.includes('/boards/sample/files/') && name.endsWith('.png')))
  assert.ok(files[`${root}/audit.json`])
  const all = Buffer.concat(Object.values(files)).toString('latin1')
  assert.ok(!all.includes(token), 'no token secrets')
  assert.ok(!/token_hash|swp_[A-Za-z0-9_-]{43}/.test(all))
  // A member cannot.
  const max = await signUp(hosted, { handle: 'max', displayName: 'Max', invite: await invite(owner, ws, 'member') })
  await reauth(max)
  assert.equal((await api(max, 'POST', `/api/workspaces/${ws}/export`, {})).status, 403)
})

test('audit: search, CSV export, rename shows old and new, member grants say who and what', async () => {
  await fresh(owner)
  assert.equal((await api(owner, 'PATCH', `/api/workspaces/${ws}`, { name: 'Olga Co' })).status, 200)
  const renamed = await owner.browser.get(`/api/workspaces/${ws}/audit?action=workspace_renamed`)
  assert.deepEqual(
    { from: renamed.json.entries[0].detail.from, to: renamed.json.entries[0].detail.to },
    { from: "Olga Owner's workspace", to: 'Olga Co' },
  )
  const search = await owner.browser.get(`/api/workspaces/${ws}/audit?q=${encodeURIComponent('Olga Co')}`)
  assert.ok(search.json.entries.length >= 1)
  assert.ok(search.json.entries.every((entry) => JSON.stringify(entry).includes('Olga Co')))
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}/audit?q=zzzz-nothing`)).json.entries.length, 0)
  // LIKE wildcards are literal.
  assert.equal((await owner.browser.get(`/api/workspaces/${ws}/audit?q=%25`)).json.entries.length, 0)
  const csv = await owner.browser.get(`/api/workspaces/${ws}/audit/export?action=workspace_renamed`)
  assert.equal(csv.status, 200)
  assert.match(csv.headers['content-type'], /text\/csv/)
  const [header, ...rows] = csv.text.trim().split(/\r?\n/)
  assert.match(header, /^"time","actor_type","actor"/)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].includes('workspace_renamed'))
})

test('invites carry a note; a signed-in member opening a used invite is told they are in already', async () => {
  await fresh(owner)
  const made = await owner.browser.post(`/api/workspaces/${ws}/invites`, { role: 'member', note: 'Ada (design)' })
  assert.equal(made.status, 201, made.text)
  const listed = await owner.browser.get(`/api/workspaces/${ws}/invites`)
  assert.equal(listed.json.pending.find((item) => item.id === made.json.invite.id).note, 'Ada (design)')
  assert.equal(
    (await owner.browser.get(`/api/workspaces/${ws}`)).json.invites.find((item) => item.id === made.json.invite.id).note,
    'Ada (design)',
  )
  const tokenOfInvite = new URL(made.json.url).hash.slice(1)
  const ada = await signUp(hosted, { handle: 'adaq', displayName: 'Ada', invite: tokenOfInvite })
  const preview = await ada.browser.post('/api/invites/preview', { token: tokenOfInvite })
  assert.equal(preview.status, 200, preview.text)
  assert.equal(preview.json.alreadyMember, true)
  assert.equal(preview.json.workspace.id, ws)
  assert.equal(preview.json.role, 'member')
  // Signed out, a used invite is just used.
  assert.equal((await createBrowser(hosted.port, hosted.origin).post('/api/invites/preview', { token: tokenOfInvite })).status, 404)
  // Control characters are dropped; the length is capped.
  const odd = await owner.browser.post(`/api/workspaces/${ws}/invites`, { role: 'member', note: 'a\u0007b' })
  assert.equal(odd.json.invite?.note ?? (await owner.browser.get(`/api/workspaces/${ws}/invites`)).json.pending[0].note, 'ab')
  assert.equal((await owner.browser.post(`/api/workspaces/${ws}/invites`, { role: 'member', note: 'x'.repeat(81) })).status, 400)
})

test('hosted boards: no capture base URL for anyone; guests are labelled once; /info links the project', async () => {
  const board = await owner.browser.get(`/w/${ws}/p/${project.id}/api/boards/sample`)
  assert.equal(board.status, 200, board.text)
  assert.ok(!board.text.includes('127.0.0.1:9'), 'the local capture address stays off the hosted board')
  assert.equal(board.json.siteUrl ?? null, null)
  const info = await owner.browser.get(`/w/${ws}/p/${project.id}/api/info`)
  assert.equal(info.json.project.url, `/w/${ws}/projects/${project.id}`)
  // Guests.
  await fresh(owner)
  assert.equal((await api(owner, 'PATCH', `/api/workspaces/${ws}/settings`, { shareLinks: true })).status, 200)
  const shared = await owner.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, { mode: 'comment' })
  const linkToken = new URL(shared.json.url).hash.slice(1)
  const guest = createBrowser(hosted.port, hosted.origin)
  assert.equal((await guest.post('/api/shares/open', { token: linkToken, name: 'Gwen' })).status, 200)
  const guestInfo = await guest.get(`/s/${shared.json.share.id}/api/info`)
  assert.equal(guestInfo.json.user.name, 'Gwen (guest)')
  const guestBoard = await guest.get(`/s/${shared.json.share.id}/api/boards/sample`)
  assert.ok(!guestBoard.text.includes('127.0.0.1:9'))
  // A view link opened without a name: just "Guest".
  const viewOnly = await owner.browser.post(`/api/workspaces/${ws}/projects/${project.id}/shares`, { mode: 'view' })
  const anonymous = createBrowser(hosted.port, hosted.origin)
  const opened = await anonymous.post('/api/shares/open', { token: new URL(viewOnly.json.url).hash.slice(1) })
  assert.equal(opened.status, 200, opened.text)
  assert.equal((await anonymous.get(`/s/${viewOnly.json.share.id}/api/info`)).json.user.name, 'Guest')
})

test('a board you cannot open is the console page with a 404, not a bare "Not found"', async () => {
  const stranger = await signUp(hosted, { handle: 'stan', displayName: 'Stan', invite: await invite(owner, ws, 'viewer') })
  await fresh(owner)
  assert.equal((await api(owner, 'DELETE', `/api/workspaces/${ws}/members/${stranger.user.id}`)).status, 200)
  const page = await stranger.browser.get(`/w/${ws}/p/${project.id}/`)
  assert.equal(page.status, 404)
  assert.match(page.headers['content-type'], /html/)
  assert.ok(page.text.includes(CONSOLE_MARK))
})

test('removing a member can revoke the API tokens they made (the console asks, checked)', async () => {
  const amy = await signUp(hosted, { handle: 'amyq', displayName: 'Amy', invite: await invite(owner, ws, 'admin') })
  await reauth(amy)
  const amyToken = await createToken(amy, ws, project.id, ['read'])
  await fresh(owner)
  const removed = await api(owner, 'DELETE', `/api/workspaces/${ws}/members/${amy.user.id}`, { revokeTokens: true })
  assert.equal(removed.status, 200, removed.text)
  assert.equal(removed.json.revoked.tokens, 1)
  assert.equal((await tokenCall(hosted, amyToken, 'GET', '/api/v1/project')).status, 401)
  const audit = await owner.browser.get(`/api/workspaces/${ws}/audit?action=member_grants_revoked`)
  assert.ok(audit.json.entries.some((entry) => entry.detail.tokens === 1))
})

test('setup: the first owner names their workspace', async () => {
  const other = await startHostedServer('hosted-qa-setup')
  try {
    const browser = createBrowser(other.port, other.origin)
    const authenticator = createAuthenticator({ origin: other.origin })
    const setup = new URLSearchParams(new URL(other.app.locals.setupLink()).hash.slice(1)).get('setup')
    const start = await browser.post('/auth/register/options', { handle: 'root', displayName: 'Root', setup, workspaceName: 'Acme design' })
    assert.equal(start.status, 200, start.text)
    const done = await browser.post('/auth/register/verify', { response: authenticator.register(start.json.options) })
    assert.equal(done.status, 201, done.text)
    const me = await browser.get('/auth/me')
    assert.equal(me.json.workspaces[0].name, 'Acme design')
  } finally {
    await other.close()
  }
})
