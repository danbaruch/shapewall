// The public demo's in-browser backend (client/src/demo): its console and
// board flows, the guest view, the scripted chat, and parity with the real
// hosted server: for every role, the same requests get the same answers.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { demoChecks } from '../client/src/demo/checks.js'
import { validateReport } from '../src/checks/schema.js'
import { compareReports } from '../src/checks/comparison.js'
import {
  INVITE_DAYS,
  NOTES_PROJECT,
  REVIEW_SHARE,
  SHARE_DAYS,
  TOKEN_SCOPES,
  USERS,
  WEBSITE_PROJECT,
  WORKSPACE_ID,
  seedState,
} from '../client/src/demo/fixtures.js'
import { INVITE_DAYS as SERVER_INVITE_DAYS, TOKEN_SCOPES as SERVER_SCOPES } from '../src/hosted/app.js'
import { SHARE_DAYS as SERVER_SHARE_DAYS } from '../src/hosted/shares.js'
import { createProject, invite, reauth, signUp, startHostedServer } from './hosted-helpers.js'

const userId = (handle) => USERS.find((item) => item.handle === handle).id
const ws = (rest = '') => `/api/workspaces/${WORKSPACE_ID}${rest}`

// A small export: the board view and comments the backend reads.
const PAGES = [
  { id: 'home', title: 'Home', group: 'Marketing', viewports: ['desktop', 'phone'] },
  { id: 'pricing', title: 'Pricing', group: 'Marketing', viewports: ['desktop', 'phone'] },
  { id: 'dashboard', title: 'Dashboard', group: 'App', viewports: ['desktop', 'phone'] },
]
const EXPORT = {
  'data/boards/demo.json': {
    board: { id: 'demo', title: 'Lumen Notes (demo)', groups: ['Marketing', 'App'], pages: PAGES },
    viewports: { desktop: { width: 1440, height: 2200 }, phone: { width: 390, height: 1800 } },
    manifest: { pages: { home: {}, pricing: {}, dashboard: {} } },
    captures: { home: {}, pricing: {}, dashboard: {} },
    links: { home: ['pricing', 'dashboard'] },
    // Steps are page ids (and forks), as the server's listJourneys gives them.
    journeys: [
      { id: 'buy', name: 'Buy', steps: ['home', 'pricing'] },
      {
        id: 'tour',
        name: 'Tour',
        steps: [
          'home',
          {
            branches: [
              { id: 'plans', label: 'Plans', steps: ['pricing'] },
              { id: 'app', label: 'App', steps: ['dashboard'] },
            ],
          },
        ],
      },
      { id: 'sign-in', name: 'Sign in', steps: ['home', 'dashboard'] },
    ],
    versions: {},
    environments: [{ id: 'staging' }, { id: 'production' }],
    variants: [],
    commentCounts: {},
  },
  'data/boards/demo/comments.json': {
    comments: [
      {
        id: 1,
        pageId: 'pricing',
        viewport: 'desktop',
        x: 10,
        y: 10,
        body: 'Make Plus primary. @agent',
        author: 'Robin',
        status: 'open',
        createdAt: '2026-09-30T10:00:00.000Z',
        replies: [{ id: 1, author: 'Coding agent', body: 'Done.', createdAt: '2026-09-30T11:00:00.000Z' }],
        agentStatus: 'done',
      },
      {
        id: 2,
        pageId: 'home',
        viewport: 'phone',
        x: 50,
        y: 50,
        body: 'Shorter label.',
        author: 'Mei',
        status: 'open',
        createdAt: '2026-09-30T12:00:00.000Z',
        replies: [],
      },
    ],
  },
}

function demo(change = () => {}, location = { project: NOTES_PROJECT }) {
  const state = seedState(Date.parse('2026-10-01T15:00:00.000Z'))
  change(state)
  const saves = { count: 0 }
  const backend = createDemoBackend({
    state,
    location,
    now: () => Date.parse('2026-10-01T15:00:00.000Z'),
    loadJson: async (url) => structuredClone(EXPORT[url] ?? Promise.reject(new Error(url))),
    save: () => (saves.count += 1),
  })
  const call = async (method, path, body) => {
    const [pathname, search = ''] = path.split('?')
    return backend.handle({ method, path: pathname, search: search ? `?${search}` : '', body })
  }
  return { state, backend, call, saves }
}
const as = (role) => (state) => (state.viewAs = role)

test('demo checks count the same on every poll (the shared fixtures are never changed)', () => {
  // Pages whose fixtures list findings and get run-level duplicates added.
  const base = EXPORT['data/boards/demo.json']
  const extra = ['blog', 'blog-post', 'features', 'templates', 'status'].map((id) => ({
    id,
    title: id,
    path: `/${id}`,
    group: 'Marketing',
    viewports: ['desktop'],
  }))
  const view = { ...base, board: { ...base.board, pages: [...base.board.pages, ...extra] } }
  const now = Date.parse('2026-10-01T15:00:00.000Z')
  const count = () =>
    demoChecks(view, { now })
      .views.flatMap((v) => v.runs.filter((r) => r.runner === 'playwright').map((r) => r.report.findings.length))
      .reduce((a, b) => a + b, 0)
  const first = count()
  assert.ok(first > 0)
  assert.equal(count(), first)
  assert.equal(count(), first)
})

test('fictional diagnostic fixtures are valid reports and demo guest access is explicitly scoped', async () => {
  const checks = demoChecks(EXPORT['data/boards/demo.json'], { now: Date.parse('2026-10-01T15:00:00.000Z') })
  assert.equal(checks.demo, true)
  assert.equal(checks.views[0].canvasCapture, true)
  const other = demoChecks(EXPORT['data/boards/demo.json'], { environment: 'production' })
  assert.equal(other.views[0].captureUnverified, true)
  assert.notEqual(other.views[0].report.id, checks.views[0].report.id)
  const reports = checks.views.flatMap((v) => v.runs.flatMap((r) => r.history))
  for (const report of reports) {
    validateReport(report)
    assert.ok(report.completeness.limitations.some((s) => s.includes('Fictional demo fixture')))
    if (report.profile.runner === 'axe') assert.equal(report.state, 'partial')
  }
  assert.deepEqual([...new Set(reports.map((r) => r.profile.runner))].sort(), ['axe', 'lighthouse', 'playwright', 'playwright-flow'])
  const run = checks.views.find((v) => v.pageId === 'pricing').runs.find((r) => r.runner === 'lighthouse')
  assert.equal(compareReports(run.history[1], run.history[0]).comparable, false)
  assert.equal(compareReports(run.history[1], run.history[0], { allowBuildChange: true }).comparable, true)
  const owner = demo()
  assert.equal((await owner.call('GET', '/api/info')).json.checksAvailable, true)
  assert.equal((await owner.call('GET', '/api/boards/demo/checks')).json.demo, true)
  const guest = demo(as('guest'))
  assert.equal((await guest.call('GET', '/api/boards/demo/checks')).status, 404)
  const share = guest.state.shares.find((s) => s.id === REVIEW_SHARE)
  share.includeChecks = true
  assert.equal((await guest.call('GET', '/api/info')).json.checksAvailable, true)
  assert.equal((await guest.call('GET', '/api/boards/demo/checks')).status, 200)
  share.revokedAt = '2026-10-01T14:00:00.000Z'
  assert.equal((await guest.call('GET', '/api/boards/demo/checks')).status, 401)
})

test('the demo offers the same choices as the server', () => {
  assert.deepEqual(INVITE_DAYS, SERVER_INVITE_DAYS)
  assert.deepEqual(SHARE_DAYS, SERVER_SHARE_DAYS)
  assert.deepEqual(
    TOKEN_SCOPES,
    SERVER_SCOPES.filter((scope) => scope !== 'import'),
  )
})

test('fixtures: fictional, with every role, pending invites, share links, tokens and an audit trail', () => {
  const state = seedState()
  const roles = new Set(state.memberships.filter((item) => item.workspaceId === WORKSPACE_ID).map((item) => item.role))
  assert.deepEqual([...roles].sort(), ['admin', 'member', 'owner', 'viewer'])
  assert.ok(state.memberships.filter((item) => item.workspaceId === WORKSPACE_ID).length >= 6)
  assert.ok(state.invites.some((item) => !item.usedAt && !item.revokedAt))
  assert.ok(state.shares.filter((item) => !item.revokedAt).length >= 2)
  assert.ok(state.tokens.length >= 3)
  assert.ok(state.audit.length >= 20)
  assert.equal(state.projects.filter((item) => item.workspaceId === WORKSPACE_ID).length, 2)
  const text = JSON.stringify(state)
  for (const email of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []) assert.match(email, /@example\.com$/, email)
  assert.ok(!/localhost|127\.0\.0\.1/.test(text))
})

test('invite as an admin: it shows in invites, the access overview and the audit log', async () => {
  const { call } = demo(as('admin'))
  const made = await call('POST', ws('/invites'), { role: 'member', expiresInDays: 7 })
  assert.equal(made.status, 201)
  assert.match(made.json.url, /^https:\/\/shapewall\.example\/invite#/)
  const invites = await call('GET', ws('/invites'))
  assert.ok(invites.json.pending.some((item) => item.id === made.json.invite.id && item.createdBy.handle === 'jo'))
  const access = await call('GET', ws('/access'))
  assert.equal(access.json.pendingInvites.member, 2)
  const log = await call('GET', ws('/audit'))
  assert.equal(log.json.entries[0].action, 'invite_created')
  assert.equal(log.json.entries[0].actor.label, 'Jo Park')
  // Admins invite up to admin, never an owner.
  assert.equal((await call('POST', ws('/invites'), { role: 'owner', expiresInDays: 7 })).status, 403)
})

test('change a role: members and access follow, the audit log says so, and demoting revokes their links', async () => {
  const { call, state } = demo()
  const priya = userId('priya')
  // Priya made a share link; demoting her below admin ends it.
  state.shares.push({ ...state.shares[0], id: 'sh_4c756d0000000000000000ff', createdBy: priya, revokedAt: null })
  const changed = await call('PATCH', ws(`/members/${priya}`), { role: 'member' })
  assert.equal(changed.status, 200)
  assert.deepEqual(changed.json.revoked, { invites: 0, shares: 1, tokens: 0 })
  const detail = await call('GET', ws())
  assert.equal(detail.json.members.find((item) => item.userId === priya).role, 'member')
  const access = await call('GET', ws('/access'))
  assert.equal(access.json.people.find((item) => item.userId === priya).access, 'comment')
  const log = await call('GET', ws('/audit?limit=2'))
  assert.deepEqual(
    log.json.entries.map((item) => item.action),
    ['member_grants_revoked', 'member_role_changed'],
  )
})

test('share links: create, open as its guest, guest comments are audited, revoke ends the visit', async () => {
  const { call, state, backend } = demo()
  const made = await call('POST', ws(`/projects/${WEBSITE_PROJECT}/shares`), { mode: 'comment', expiresInDays: 7, name: 'Review' })
  assert.equal(made.status, 201)
  assert.match(made.json.url, /index\.html\?share=sh_[a-f0-9]{24}$/)
  backend.setViewAs('guest', { shareId: made.json.share.id })
  const info = await call('GET', '/api/info')
  assert.equal(info.json.role, 'guest')
  assert.deepEqual(info.json.permissions, { comment: true, reply: true, resolve: false, edit: false, delete: false, react: false })
  assert.equal(info.json.agent, undefined, 'no chat for guests')
  assert.equal(info.json.consoleUrl, undefined)
  const boards = await call('GET', '/api/boards')
  assert.deepEqual(
    boards.json.boards.map((item) => item.id),
    ['website'],
  )
  const view = await call('GET', '/api/boards/website')
  assert.deepEqual(
    view.json.board.pages.map((page) => page.id),
    ['home', 'pricing'],
  )
  const posted = await call('POST', '/api/boards/website/comments', { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'Looks good' })
  assert.equal(posted.status, 201)
  assert.equal(posted.json.comment.author, 'Taylor (guest)')
  assert.equal(posted.json.comment.authorGuest, true)
  assert.equal((await call('POST', `/api/boards/website/comments/${posted.json.comment.id}/resolve`, {})).status, 403)
  // Members' handles and agent details never reach a guest.
  const list = await call('GET', '/api/boards/website/comments')
  assert.ok(list.json.comments.every((item) => item.authorHandle === undefined && item.agentStatus === null))
  backend.setViewAs('owner')
  const log = await call('GET', ws('/audit?limit=1'))
  assert.equal(log.json.entries[0].action, 'guest_commented')
  assert.equal(log.json.entries[0].actor.type, 'guest')
  assert.equal((await call('DELETE', ws(`/projects/${WEBSITE_PROJECT}/shares/${made.json.share.id}`))).status, 200)
  backend.setViewAs('guest')
  assert.equal((await call('GET', '/api/info')).status, 401)
  assert.equal(state.guestShareId, made.json.share.id)
})

test('board: comments seeded from the export as accounts; edit own, delete own or as admin', async () => {
  const member = demo(as('member'))
  const list = await member.call('GET', '/api/boards/demo/comments')
  const robins = list.json.comments.find((item) => item.id === 1)
  assert.equal(robins.author, 'Robin Ash')
  assert.equal(robins.authorHandle, 'robin')
  assert.equal(robins.replies[0].agent, true)
  assert.equal(robins.authorUserId, undefined, 'internal fields stay inside')
  assert.equal((await member.call('PATCH', '/api/boards/demo/comments/1', { body: 'Changed' })).status, 403)
  assert.equal((await member.call('PATCH', '/api/boards/demo/comments/2', { body: 'Changed' })).status, 200)
  assert.equal((await member.call('DELETE', '/api/boards/demo/comments/1')).status, 403)
  assert.equal((await member.call('POST', '/api/boards/demo/comments/1/resolve', {})).status, 200)
  const admin = demo(as('admin'))
  assert.equal((await admin.call('DELETE', '/api/boards/demo/comments/1')).status, 200)
  const viewer = demo(as('viewer'))
  assert.equal((await viewer.call('POST', '/api/boards/demo/comments', { pageId: 'home', x: 1, y: 1, body: 'x' })).status, 403)
  assert.equal((await viewer.call('GET', '/api/info')).json.readOnly, true)
  // Journeys and captures are refused like on a hosted board.
  assert.equal((await admin.call('POST', '/api/boards/demo/journeys', {})).status, 403)
  assert.equal((await admin.call('POST', '/api/boards/demo/capture', {})).status, 403)
})

test('the second project is made from part of the export', async () => {
  const { call } = demo(() => {}, { project: WEBSITE_PROJECT })
  const view = await call('GET', '/api/boards/website')
  assert.equal(view.json.board.id, 'website')
  assert.deepEqual(view.json.board.groups, ['Marketing'])
  assert.deepEqual(Object.keys(view.json.captures), ['home', 'pricing'])
  assert.deepEqual(view.json.links.home, ['pricing'])
  // Journeys keep their steps on the board's pages: "Sign in" loses its
  // second page and goes; "Tour" loses a branch and falls back to its path.
  assert.deepEqual(
    view.json.journeys.map((item) => [item.id, item.steps, item.pages, item.paths.length, item.branching]),
    [
      ['buy', ['home', 'pricing'], ['home', 'pricing'], 1, false],
      ['tour', ['home', 'pricing'], ['home', 'pricing'], 1, false],
    ],
  )
  assert.deepEqual((await call('GET', '/api/boards/website/journeys')).json.journeys, view.json.journeys)
  assert.equal(view.json.environments.length, 1)
  const comments = await call('GET', '/api/boards/website/comments')
  assert.ok(comments.json.comments.length >= 2)
})

test('comment routes answer like the server: unknown boards, pages, viewports, anchors, statuses and filters', async () => {
  const { call } = demo(as('owner'))
  for (const [method, path] of [
    ['GET', '/api/boards/nope/comments'],
    ['POST', '/api/boards/nope/comments'],
    ['PATCH', '/api/boards/nope/comments/1'],
    ['POST', '/api/boards/nope/comments/1/replies'],
    ['POST', '/api/boards/nope/comments/1/reactions'],
    ['POST', '/api/boards/nope/comments/1/resolve'],
    ['DELETE', '/api/boards/nope/comments/1'],
  ]) {
    const answer = await call(method, path, { body: 'x', pageId: 'home', viewport: 'desktop', x: 1, y: 1, emoji: '👍' })
    assert.equal(answer.status, 404, `${method} ${path}`)
    assert.equal(answer.json.error.code, 'unknown_board', `${method} ${path}`)
  }
  const post = (body) => call('POST', '/api/boards/demo/comments', { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'Hi', ...body })
  const code = async (body) => (await post(body)).json.error?.code
  assert.equal((await post({ pageId: 'nowhere' })).status, 404)
  assert.equal(await code({ pageId: 'nowhere' }), 'unknown_page')
  assert.equal(await code({ viewport: 'tablet' }), 'invalid_viewport')
  assert.equal(await code({ viewport: undefined }), 'invalid_viewport')
  assert.equal(await code({ x: '5' }), 'invalid_position')
  assert.equal(await code({ y: Number.NaN }), 'invalid_position')
  assert.equal(await code({ anchor: { selector: 'script; alert(1)', dx: 0.5, dy: 0.5 } }), 'invalid_anchor')
  assert.equal(await code({ anchor: { selector: '#plans', dx: 2, dy: 0.5 } }), 'invalid_anchor')
  const anchored = await post({ anchor: { selector: '#plans', text: '  Plans  ', dx: 0.123456, dy: 0.5, extra: true }, body: 'Ask @mei' })
  assert.equal(anchored.status, 201)
  assert.deepEqual(anchored.json.comment.anchor, { selector: '#plans', text: 'Plans', dx: 0.1235, dy: 0.5 })
  const id = anchored.json.comment.id

  const patch = (body) => call('PATCH', `/api/boards/demo/comments/${id}`, body)
  assert.equal((await patch({ status: 'done' })).json.error.code, 'invalid_status')
  assert.equal((await patch({ resolution: 5 })).json.error.code, 'invalid_resolution')
  assert.equal((await patch({ fixRef: 'a\nb' })).json.error.code, 'invalid_fix_ref')
  const note = 'n'.repeat(1500)
  const resolved = await patch({ status: 'resolved', resolution: note, fixRef: ' https://example.com/pr/1 ' })
  assert.equal(resolved.json.comment.resolution, note, 'notes up to the comment limit')
  assert.equal(resolved.json.comment.fixRef, 'https://example.com/pr/1')
  assert.equal((await patch({ resolution: 'Shorter' })).json.comment.resolution, 'Shorter')
  assert.equal((await patch({ fixRef: null })).json.comment.fixRef, undefined)

  const ids = async (query) => (await call('GET', `/api/boards/demo/comments${query}`)).json.comments.map((item) => item.id).sort()
  assert.deepEqual(await ids('?status=resolved'), [id])
  assert.deepEqual(await ids('?status=open'), [1, 2])
  assert.deepEqual(await ids('?status=everything'), [1, 2, id])
  assert.deepEqual(await ids('?mention=mei'), [id])
  assert.deepEqual(await ids('?mention=@mei'), [id])
  assert.deepEqual(await ids('?mention=agent'), [1])
})

test('console caps and cleanup: project names, tokens per project, deleted projects forget their boards', async () => {
  const { call, state } = demo(as('owner'))
  const named = (name) => call('POST', ws('/projects'), { name })
  assert.equal((await named('p'.repeat(80))).status, 201)
  assert.equal((await named('q'.repeat(81))).json.error.code, 'invalid_name')
  const tokens = ws(`/projects/${NOTES_PROJECT}/tokens`)
  const live = state.tokens.filter((item) => item.projectId === NOTES_PROJECT && !item.revokedAt).length
  for (let n = live; n < 50; n += 1) assert.equal((await call('POST', tokens, { name: `t${n}` })).status, 201)
  const over = await call('POST', tokens, { name: 'one too many' })
  assert.equal(over.status, 409)
  assert.equal(over.json.error.code, 'too_many_tokens')

  // Comments and chat threads go with their project, and with its workspace.
  await call('GET', '/api/boards/demo/comments')
  assert.ok(Object.keys(state.comments).some((key) => key.startsWith(`${NOTES_PROJECT}/`)))
  assert.ok(Object.keys(state.threads).some((key) => key.startsWith(`${NOTES_PROJECT}/`)))
  assert.equal((await call('DELETE', ws(`/projects/${NOTES_PROJECT}`))).status, 200)
  assert.deepEqual(
    [...Object.keys(state.comments), ...Object.keys(state.threads)].filter((key) => key.startsWith(`${NOTES_PROJECT}/`)),
    [],
  )
  const website = demo(as('owner'), { project: WEBSITE_PROJECT })
  await website.call('GET', '/api/boards/website/comments')
  assert.ok(Object.keys(website.state.comments).length)
  // The demo keeps its main workspace (View as needs its people); the console
  // is told so, and shows Delete workspace switched off.
  assert.equal((await website.call('GET', ws())).json.features.deleteWorkspace, false)
  const kept = await website.call('DELETE', ws(), { confirm: 'Lumen' })
  assert.equal(kept.status, 409)
  assert.equal(kept.json.error.code, 'demo')
  assert.ok(Object.keys(website.state.comments).length)
  // Any other workspace deletes as on a server.
  const made = await website.call('POST', '/api/workspaces', { name: 'Scratch' })
  const scratch = made.json.workspace.id
  assert.equal((await website.call('GET', '/api/workspaces/' + scratch)).json.features.deleteWorkspace, undefined)
  assert.equal((await website.call('DELETE', '/api/workspaces/' + scratch, { confirm: 'Scratch' })).status, 200)
  assert.equal(
    website.state.workspaces.some((item) => item.id === scratch),
    false,
  )
})

test('each backend has its own copy of the fixtures', async () => {
  const one = demo(as('owner'))
  const two = demo(as('owner'))
  assert.equal((await one.call('PATCH', '/auth/me', { displayName: 'Renamed' })).status, 200)
  assert.equal(one.state.users.find((item) => item.handle === 'robin').displayName, 'Renamed')
  assert.equal(two.state.users.find((item) => item.handle === 'robin').displayName, 'Robin Ash')
  assert.equal(USERS.find((item) => item.handle === 'robin').displayName, 'Robin Ash')
  one.state.projects[1].boards[0].groups.push('App')
  assert.deepEqual(two.state.projects[1].boards[0].groups, ['Marketing', 'Content'])
})

test('a board that fails to load is tried again, and a failed chat leaves the thread free', async () => {
  const state = seedState(Date.parse('2026-10-01T15:00:00.000Z'))
  let failing = true
  const backend = createDemoBackend({
    state,
    location: { project: NOTES_PROJECT },
    now: () => Date.parse('2026-10-01T15:00:00.000Z'),
    loadJson: async (url) => {
      if (failing) throw new Error(`offline: ${url}`)
      return structuredClone(EXPORT[url])
    },
  })
  const key = `${NOTES_PROJECT}/demo/board`
  const before = structuredClone(state.threads[key] || [])
  const message = () =>
    backend.handle({
      method: 'POST',
      path: '/api/agent/boards/demo/threads/board/messages',
      search: '',
      body: { text: "What's still open?" },
    })
  await assert.rejects(message(), /offline/)
  assert.deepEqual(state.threads[key] || [], before, 'no message left behind')
  const thread = await backend.handle({ method: 'GET', path: '/api/agent/boards/demo/threads/board', search: '' })
  assert.equal(thread.json.running, false)
  await assert.rejects(backend.handle({ method: 'GET', path: '/api/boards/demo', search: '' }), /offline/)
  failing = false
  assert.equal((await backend.handle({ method: 'GET', path: '/api/boards/demo', search: '' })).status, 200)
  const answer = await message()
  assert.equal(answer.status, 200)
  for await (const event of answer.events) void event
  assert.equal(state.threads[key].at(-1).role, 'assistant')
})

test('demo chat: model and effort are known and settable before the first message', async () => {
  const { call } = demo()
  const path = '/api/agent/boards/demo/threads/chat-aaaaaaaaaaaaaaaa'
  const fresh = await call('GET', path)
  assert.deepEqual(
    fresh.json.options.map((option) => option.id),
    ['model', 'effort'],
  )
  const model = await call('POST', path + '/options', { configId: 'model', value: 'scripted-thorough' })
  assert.equal(model.status, 200)
  const effort = await call('POST', path + '/options', { configId: 'effort', value: 'high' })
  assert.deepEqual(
    effort.json.options.map((option) => option.currentValue),
    ['scripted-thorough', 'high'],
  )
  assert.equal((await call('POST', path + '/options', { configId: 'effort', value: 'max' })).status, 400)
  // Before the first message, as on the server: the choices kept in the browser apply.
  const other = '/api/agent/boards/demo/threads/chat-bbbbbbbbbbbbbbbb'
  const prepared = await call('POST', other + '/prepare', { choices: { model: 'scripted-thorough', effort: 'nope' } })
  assert.deepEqual(
    prepared.json.options.map((option) => option.currentValue),
    ['scripted-thorough', 'medium'],
  )
  assert.equal(prepared.json.options[0].values[1].description, 'Slower, more careful')
  // The answer's meta line names the model and level it ran with.
  const answer = await call('POST', other + '/messages', { text: "What's still open?", options: { effort: 'high' } })
  let done = null
  for await (const [name, data] of answer.events) if (name === 'done') done = data.message
  assert.deepEqual(done.options, [
    { category: 'model', name: 'Model', value: 'Thorough' },
    { category: 'thought_level', name: 'Thinking', value: 'High' },
  ])
  // The second scripted agent has its own list.
  assert.equal((await call('POST', other + '/profile', { profileId: 'second' })).status, 200)
  assert.deepEqual(
    (await call('GET', other)).json.options[0].values.map((item) => item.name),
    ['Brief', 'Brief Plus'],
  )
})

test('scripted chat: streams, asks before it edits, and Stop ends the answer', async () => {
  const { call } = demo()
  const collect = async (answer) => {
    const events = []
    for await (const event of answer.events) events.push(event)
    return events
  }
  const summary = await collect(await call('POST', '/api/agent/boards/demo/threads/board/messages', { text: "What's still open?" }))
  assert.deepEqual(summary[0][0], 'user')
  assert.ok(summary.some(([name]) => name === 'tool'))
  assert.equal(summary.at(-1)[0], 'done')
  assert.match(summary.at(-1)[1].message.text, /2 open comments/)

  const answer = await call('POST', '/api/agent/boards/demo/threads/comment-2/messages', { text: 'Please fix this' })
  const seen = []
  for await (const [name, data] of answer.events) {
    seen.push(name)
    if (name === 'tool' && data.kind === 'permission' && data.state === 'pending') {
      const approved = await call('POST', `/api/agent/boards/demo/threads/comment-2/permissions/${data.id}`, { optionId: 'allow' })
      assert.equal(approved.json.state, 'approved')
    }
    if (name === 'done') assert.match(data.message.text, /Done\./)
  }
  assert.ok(seen.includes('done'))

  const stopping = await call('POST', '/api/agent/boards/demo/threads/board/messages', { text: 'Fix the next @agent comment' })
  let stopped = null
  for await (const [name, data] of stopping.events) {
    if (name === 'text') await call('POST', '/api/agent/boards/demo/threads/board/stop', {})
    if (name === 'done') stopped = data.message
  }
  assert.equal(stopped.status, 'stopped')
  const thread = await call('GET', '/api/agent/boards/demo/threads/board')
  assert.equal(thread.json.running, false)
  assert.ok(thread.json.messages.length >= 6, 'seeded exchange plus two turns')
  // Viewers get no chat.
  const viewer = demo(as('viewer'))
  assert.equal((await viewer.call('GET', '/api/agent/boards/demo/threads')).status, 404)
})

test('one-click sign in and sign up', async () => {
  const { call, state } = demo()
  await call('POST', '/auth/logout', {})
  assert.equal((await call('GET', '/auth/me')).json.user, null)
  await call('POST', '/auth/demo/signup', {})
  const me = await call('GET', '/auth/me')
  assert.equal(me.json.user.displayName, 'Demo visitor')
  assert.deepEqual(me.json.workspaces.map((item) => item.role).sort(), ['member', 'owner'])
  assert.equal(state.viewAs, 'self')
  await call('POST', '/auth/demo/signin', { role: 'admin' })
  assert.equal((await call('GET', '/auth/me')).json.user.handle, 'jo')
})

// ---- Parity with the real server -------------------------------------------

let hosted
const people = {}
let realWs
let realProject

before(async () => {
  hosted = await startHostedServer('demo-parity')
  people.owner = await signUp(hosted, { handle: 'olive' })
  realWs = people.owner.workspaceId
  await reauth(people.owner)
  for (const [key, role] of [
    ['admin', 'admin'],
    ['adminTarget', 'admin'],
    ['member', 'member'],
    ['memberTarget', 'member'],
    ['viewer', 'viewer'],
    ['viewerTarget', 'viewer'],
  ]) {
    hosted.rateLimiter.reset()
    await reauth(people.owner)
    people[key] = await signUp(hosted, { handle: `${key.toLowerCase()}x`, invite: await invite(people.owner, realWs, role) })
    await reauth(people[key])
  }
  realProject = await createProject(people.owner, realWs, 'Parity')
})
after(async () => hosted?.close())

const realCall = async (who, method, path, body) => {
  // The test makes many passkey checks; the server's per-IP ceremony limit is not what is tested here.
  hosted.rateLimiter.reset()
  await reauth(people[who])
  const response = await people[who].browser.call(method, path, { body })
  return response.status
}
const realRole = (who) => ({ owner: 'owner', admin: 'admin', member: 'member', viewer: 'viewer' })[who]

// Mock people for the same seats: actors are the personas, targets the next in line.
const MOCK_TARGET = { owner: 'robin', admin: 'priya', member: 'sam', viewer: 'lee' }
function mockFor(actor) {
  return demo((state) => {
    state.viewAs = actor
    // A second viewer to act on (Lee left in the fixtures; here they are back).
    state.memberships.push({
      workspaceId: WORKSPACE_ID,
      userId: userId('lee'),
      role: 'viewer',
      createdAt: state.seededAt,
      lastActiveAt: null,
    })
  })
}

test('parity: console reads and invites answer the same for every role', async () => {
  for (const actor of ['owner', 'admin', 'member', 'viewer']) {
    for (const [method, rest, body] of [
      ['GET', '', undefined],
      ['GET', '/invites', undefined],
      ['GET', '/access', undefined],
      ['GET', '/tokens', undefined],
      ['GET', '/shares', undefined],
      ['GET', '/audit', undefined],
      ['GET', '/audit/filters', undefined],
      ['POST', '/invites', { role: 'viewer', expiresInDays: 1 }],
      ['POST', '/invites', { role: 'admin', expiresInDays: 1 }],
      ['POST', '/invites', { role: 'owner', expiresInDays: 1 }],
      ['POST', '/invites', { role: 'member', expiresInDays: 2 }],
      ['PATCH', '', { name: 'Renamed' }],
    ]) {
      const real = await realCall(actor, method, `/api/workspaces/${realWs}${rest}`, body)
      const mock = (await mockFor(actor).call(method, ws(rest), body)).status
      assert.equal(mock, real, `${actor} ${method} ${rest || '/'} ${JSON.stringify(body || {})}: server ${real}, demo ${mock}`)
    }
    const real = await realCall(actor, 'GET', `/w/${realWs}/p/${realProject.id}/api/info`)
    assert.equal(real, 200)
    const realInfo = (await people[actor].browser.get(`/w/${realWs}/p/${realProject.id}/api/info`)).json
    const mockInfo = (await mockFor(actor).call('GET', '/api/info')).json
    assert.deepEqual(mockInfo.permissions, realInfo.permissions, `${actor}: board permissions`)
    assert.equal(mockInfo.readOnly, realInfo.readOnly, `${actor}: read-only`)
    assert.equal(mockInfo.role, realRole(actor))
  }
})

test('parity: role changes and removals answer the same for every actor, target and new role', async () => {
  const realTarget = { owner: 'owner', admin: 'adminTarget', member: 'memberTarget', viewer: 'viewerTarget' }
  for (const actor of ['owner', 'admin', 'member', 'viewer']) {
    for (const target of ['owner', 'admin', 'member', 'viewer']) {
      const targetId = people[realTarget[target]].user.id
      for (const role of ['viewer', 'member', 'admin', 'owner']) {
        if (role === target) continue
        const real = await realCall(actor, 'PATCH', `/api/workspaces/${realWs}/members/${targetId}`, { role })
        // Put the target back.
        if (real === 200)
          assert.equal(await realCall('owner', 'PATCH', `/api/workspaces/${realWs}/members/${targetId}`, { role: target }), 200)
        const mock = (await mockFor(actor).call('PATCH', ws(`/members/${userId(MOCK_TARGET[target])}`), { role })).status
        assert.equal(mock, real, `${actor} makes the ${target} a ${role}: server ${real}, demo ${mock}`)
      }
      if (target === actor) continue
      // Removing: only try it on the server when the demo says it is refused (a removal cannot be undone here).
      const mock = (await mockFor(actor).call('DELETE', ws(`/members/${userId(MOCK_TARGET[target])}`))).status
      if (mock !== 200) {
        const real = await realCall(actor, 'DELETE', `/api/workspaces/${realWs}/members/${targetId}`)
        assert.equal(mock, real, `${actor} removes the ${target}: server ${real}, demo ${mock}`)
      } else {
        assert.ok(['owner', 'admin'].includes(actor), `${actor} may remove the ${target} in the demo`)
      }
    }
  }
})

test('parity: the guest of a share link gets the server guest permissions', async () => {
  const { call, backend } = demo()
  backend.setViewAs('guest', { shareId: REVIEW_SHARE })
  const info = (await call('GET', '/api/info')).json
  assert.deepEqual(info.permissions, { comment: true, reply: true, resolve: false, edit: false, delete: false, react: false })
  assert.equal(info.readOnly, false)
})

test('demo answer feedback: rate, take back, regenerate with versions, and the admin-only Agent feedback page', async () => {
  const { call, state } = demo()
  const collect = async (answer) => {
    const events = []
    for await (const event of answer.events) events.push(event)
    return events
  }
  const done = (await collect(await call('POST', '/api/agent/boards/demo/threads/board/messages', { text: "What's still open?" }))).at(
    -1,
  )[1].message
  const path = (id) => '/api/agent/boards/demo/threads/board/messages/' + id + '/rating'
  assert.equal((await call('POST', path(done.id), { rating: 'down', reasons: ['rude'] })).status, 400)
  assert.equal((await call('POST', path('msg_nope123'), { rating: 'up' })).status, 404)
  const rated = await call('POST', path(done.id), { rating: 'down', reasons: ['wrong'], note: 'Missed one.' })
  assert.deepEqual(rated.json.rating, { rating: 'down', reasons: ['wrong'], note: 'Missed one.' })
  const thread = await call('GET', '/api/agent/boards/demo/threads/board')
  assert.equal(thread.json.ratings[done.id].rating, 'down')
  assert.equal((await call('DELETE', path(done.id))).json.rating, null)
  await call('POST', path(done.id), { rating: 'up' })

  // Regenerate: the latest answer only; the old one becomes version 1.
  assert.equal((await call('POST', '/api/agent/boards/demo/threads/board/messages', { regenerate: 'msg_seed2' })).status, 409)
  const again = (await collect(await call('POST', '/api/agent/boards/demo/threads/board/messages', { regenerate: done.id }))).at(-1)[1]
    .message
  assert.match(again.text, /^Another take/)
  assert.deepEqual(
    again.versions.map((item) => item.id),
    [done.id],
  )
  const key = NOTES_PROJECT + '/demo/board'
  assert.equal(state.threads[key].at(-1).id, again.id)
  assert.equal(state.threads[key].filter((item) => item.role === 'user').length, 2, 'no new person message')

  // The console page: admins and owners, with the seeded and the new ratings.
  const review = await call('GET', ws('/agent-feedback?days=30&rating=down'))
  assert.equal(review.status, 200)
  assert.ok(review.json.summary.total >= 9)
  assert.ok(review.json.items.every((item) => item.rating === 'down'))
  assert.ok(review.json.items.every((item) => item.boardTitle === 'Lumen Notes'))
  const exported = await call('GET', ws('/agent-feedback/export'))
  assert.equal(exported.json.format, 'shapewall-agent-feedback')
  assert.ok(exported.json.entries.some((item) => item.messageId === done.id && item.rating === 'up'))
  const detail = await call('GET', ws())
  assert.equal(detail.json.features.agentFeedback, true)
  const member = demo(as('member'))
  assert.equal((await member.call('GET', ws('/agent-feedback'))).status, 403)
})

test('two scripted agents: status lists both, a chat switches, the second answers in its own voice', async () => {
  const { call, state } = demo()
  const collect = async (answer) => {
    const events = []
    for await (const event of answer.events) events.push(event)
    return events
  }
  const status = (await call('GET', '/api/agent/status')).json
  assert.equal(status.label, 'Demo agent')
  assert.equal(status.demo, true)
  assert.deepEqual(
    status.profiles.map((item) => [item.id, item.label, item.state, item.sameAs || null]),
    [
      ['default', 'Demo agent', 'ready', 'demo'],
      ['demo', 'Demo agent', 'ready', null],
      ['second', 'Second agent', 'ready', null],
    ],
  )
  assert.match(status.settingsUrl, /^console\.html#\/w\/ws_[a-f0-9]{24}\/agents$/)

  const path = '/api/agent/boards/demo/threads/board'
  const before = (await call('GET', path)).json
  assert.equal(before.profileId, 'default')
  assert.equal(before.agent.label, 'Demo agent')
  assert.equal((await call('POST', path + '/profile', { profileId: 'nope' })).status, 400)
  const switched = await call('POST', path + '/profile', { profileId: 'second' })
  assert.equal(switched.json.profileId, 'second')
  assert.equal(switched.json.agent.label, 'Second agent')
  const after = (await call('GET', path)).json
  assert.equal(after.profileId, 'second')
  assert.equal(after.agent.label, 'Second agent')
  const second = (await collect(await call('POST', path + '/messages', { text: "What's still open?" }))).at(-1)[1].message
  assert.match(second.text, /^Short version\. /)
  assert.match(second.text, /Second agent, scripted for the demo/)
  // While an answer runs, the agent stays as it is.
  const running = await call('POST', path + '/messages', { text: "What's still open?" })
  assert.equal((await call('POST', path + '/profile', { profileId: 'demo' })).status, 409)
  await collect(running)
  // Back to the default: the thread forgets its pick, the first voice again.
  assert.equal((await call('POST', path + '/profile', { profileId: 'default' })).json.profileId, 'default')
  assert.equal((await call('GET', path)).json.profileId, 'default')
  const first = (await collect(await call('POST', path + '/messages', { text: "What's still open?" }))).at(-1)[1].message
  assert.doesNotMatch(first.text, /Short version/)
  // The pick lives in the browser's demo state; the default leaves no mark.
  assert.equal(
    Object.values(state.threadMeta || {}).some((meta) => meta.profileId),
    false,
  )
})
