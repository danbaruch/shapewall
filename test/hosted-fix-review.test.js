// What the security review of approvals from a hosted board found, each as
// a test through the real HTTP surfaces (the pieces themselves are in
// test/agent-fix-git.test.js and test/agent-fix-policy.test.js):
//
//   1  files that run something are refused unless the machine names them,
//      and even then never go without asking; a fix made without asking is
//      held on the machine until a person allows "Push this fix" on its
//      whole diff
//   3  Stop: nothing is pushed afterwards, and the comment says what the chat says
//   4  on a machine that says "owner", only the connecting person switches
//      "allow without asking" on
//   5  an edit Git would leave out of the commit is refused when it is asked
//   8  a card's wait is a length of time, so the clocks need not agree, and
//      an answer the machine did not take is not shown as allowed
//   9  Fix on a comment whose run needs approval: given by an admin's Fix,
//      or really sent for approval
//   10 a late status write does not end a running fix's claim
//   11 the diff on a card goes to the people the agent works for
//   12 a card counts against the storage quota
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { cardHash } from '../src/agent/card-hash.js'
import { createQuotas } from '../src/hosted/quotas.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { createProject, invite, reauth, signUp, startHostedServer, tokenCall, writeLocalCaptures, askAgain } from './hosted-helpers.js'
import { connectAgent, fixScript, gitRepo, parseEvents, startLink, until } from './hosted-chat-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'

let hosted
let ada // owner
let bea // admin
let cyd // member
let ws
let project
let skew = 0
let storageLimit = null
const links = []

const boardUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`
const agentUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/agent/boards/sample${rest}`
const threadUrl = (number, rest = '') => agentUrl(`/threads/comment-${number}${rest}`)
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const fresh = async (user) => {
  hosted.rateLimiter.reset()
  await reauth(user)
}
const stale = () => hosted.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z'").run()
const audit = (action) =>
  hosted.db
    .prepare('SELECT action, target, detail, user_id FROM audit_log WHERE workspace_id = ? AND action = ? ORDER BY rowid')
    .all(ws, action)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }))
const cardRow = (id) => hosted.db.prepare('SELECT * FROM chat_permissions WHERE id = ?').get(id)
const comment = async (user, body) => {
  hosted.rateLimiter.reset()
  const made = await user.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 30, y: 30, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}
const seen = async (id) => (await ada.browser.get(boardUrl('/comments'))).json.comments.find((item) => item.id === id)
function post(user, number, body) {
  hosted.rateLimiter.reset()
  const done = user.browser.post(threadUrl(number, '/messages'), body).then((response) => {
    const events = response.status === 200 ? parseEvents(response.text) : []
    return {
      status: response.status,
      json: response.json,
      events,
      final: events.find((event) => event.name === 'done')?.data.message || null,
    }
  })
  return { done }
}
const pressFix = (user, number, body = {}) => post(user, number, { fix: true, ...body })
const waiting = async (user = ada) => (await user.browser.get(agentUrl('/permissions'))).json?.permissions || []
const card = (number, user = ada, not = []) =>
  until(
    async () => (await waiting(user)).find((item) => item.thread === `comment-${number}` && !not.includes(item.id)),
    `a card on comment ${number}`,
  )
const answer = (user, number, item, optionId, hash = item.hash) =>
  user.browser.post(threadUrl(number, `/permissions/${item.id}`), { optionId, hash })
const liveTurn = (number) => hosted.app.locals.chat.hub.all().find((turn) => turn.threadId === `comment-${number}`)
const setRule = (user, agent, body) => user.browser.call('PUT', consoleUrl(`/agents/${agent.agentId}/approval`), { body })
const setPolicy = async (body) => {
  await fresh(ada)
  const saved = await ada.browser.call('PUT', consoleUrl('/agent'), { body })
  assert.equal(saved.status, 200, saved.text)
}
const OPEN_POLICY = { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false, dailyClaims: 500, maxOpenClaims: 50 }

async function agentWith(name, edits, { audience = 'trusted', files, by = ada, remote = false, ...options } = {}) {
  await fresh(by)
  const made = await connectAgent(hosted, by, { workspaceId: ws, projectId: project.id, name, kind: 'claude', audience })
  assert.equal(made.status, 200, JSON.stringify(made.error))
  const dir = tempDir(`hosted-fix-rev-${name.toLowerCase()}`)
  const git = gitRepo(dir, files)
  let bare = null
  if (remote) {
    bare = tempDir(`hosted-fix-rev-${name.toLowerCase()}-bare`)
    execFileSync('git', ['init', '-q', '--bare', bare])
    git('remote', 'add', 'origin', bare)
  }
  const link = startLink(hosted, made.token, { cwd: dir, edits: { ...(remote ? { remote: 'origin' } : {}), ...edits }, ...options })
  links.push(link)
  assert.ok(await link.ready, link.failure()?.message)
  const onRemote = () =>
    bare
      ? execFileSync('git', ['--git-dir', bare, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n').filter(Boolean)
      : []
  const branches = () => git('branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()
  return { ...made, dir, git, link, name, bare, onRemote, branches }
}

before(async () => {
  const base = createQuotas()
  hosted = await startHostedServer('hosted-fix-rev', {
    now: () => new Date(Date.now() + skew),
    quotas: { ...base, of: (id) => ({ ...base.of(id), ...(storageLimit === null ? {} : { storageBytes: storageLimit }) }) },
  })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  // These tests are about the passkey checks: the workspace asks for them (off by default).
  askAgain(hosted, ws)
  bea = await signUp(hosted, { handle: 'bea', displayName: 'Bea', invite: await invite(ada, ws, 'admin') })
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  await fresh(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  const config = sampleConfig('hosted-fix-rev-board')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: made.json.token })
  const started = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  await remote.commitPush(started.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8')),
    variants: [],
  })
  await setPolicy(OPEN_POLICY)
})

after(async () => {
  for (const entry of links) await entry.stop()
  await hosted?.close()
})

test('1, 5: files that run something are refused or always asked; a fix made without asking is held until its whole diff is looked at', async () => {
  const auto = await agentWith(
    'Auto',
    { approvals: 'owner', auto: ['edits'], allowPaths: ['vite.config.js'] },
    {
      remote: true,
      limits: { pushCardMs: 4000 },
      files: {
        'index.html': '<h1>Hello</h1>\n',
        'styles.css': 'h1 { color: blue; }\n',
        'vite.config.js': 'export default {}\n',
        'tsconfig.json': '{}\n',
        'src/app.test.js': 'test()\n',
        '.gitignore': 'build/\n*.log\n',
      },
    },
  )
  await fresh(ada)
  assert.equal((await setRule(ada, auto, { rule: 'auto' })).status, 200)
  const before = hosted.db.prepare('SELECT COUNT(*) AS n FROM chat_permissions').get().n
  const script = fixScript([
    // Run on install, build, test or CI, and not named by this machine: refused there, never a question.
    ['write', 'scripts/build.js', 'x'],
    ['edit', 'src/app.test.js', 'test()', 'owned()'],
    ['edit', 'tsconfig.json', '{}', '{"x":1}'],
    ['write', 'jest.config.cjs', 'x'],
    ['write', 'docker-compose.yml', 'x'],
    ['write', 'deploy.sh', 'x'],
    // What Git would leave out of the commit: refused when asked, not dropped afterwards.
    ['write', '.gitattributes', '* text=auto\n'],
    ['write', 'debug.log', 'x'],
    ['write', 'build/out.js', 'x'],
    ['write', 'node_modules/left-pad/index.js', 'x'],
    // Named by this machine: asked, even though the rule says "without asking".
    ['edit', 'vite.config.js', '{}', '{ base: "/x/" }'],
    // Ordinary source: goes without asking.
    ['edit', 'index.html', 'Hello', 'Automatic'],
  ])
  const made = await comment(ada, `Everything ${script}`)
  const turn = pressFix(ada, made.id, { agentId: auto.agentId })
  const config = await card(made.id)
  assert.deepEqual(
    [config.name, config.detail],
    ['edit', 'vite.config.js'],
    'a file that runs something waits for a person, rule or no rule',
  )
  await fresh(ada)
  assert.equal((await answer(ada, made.id, config, 'deny')).status, 200)
  // The edit that went without asking is committed, and held: "Push this fix", with the whole diff.
  const push = await card(made.id, ada, [config.id])
  assert.deepEqual([push.name, push.label], ['push', 'Push this fix'])
  assert.match(push.detail, new RegExp(`^shapewall/comment-${made.id}-`))
  assert.match(push.diff.preview, /-<h1>Hello<\/h1>/)
  assert.match(push.diff.preview, /\+<h1>Automatic<\/h1>/)
  assert.ok(Date.parse(push.expiresAt) - Date.now() > 2000, 'it waits longer than an edit card')
  assert.deepEqual(auto.branches(), ['main', push.detail], 'committed on the machine')
  assert.deepEqual(auto.onRemote(), [], 'and pushed nowhere')
  assert.equal((await answer(cyd, made.id, push, 'allow')).status, 403, 'only someone who may answer cards')
  stale()
  assert.equal((await answer(ada, made.id, push, 'allow')).json.error.code, 'reauth_required')
  assert.equal((await answer(ada, made.id, push, 'allow', 'f'.repeat(64))).status, 409)
  assert.deepEqual(auto.onRemote(), [])
  await fresh(ada)
  assert.equal((await answer(ada, made.id, push, 'allow')).status, 200)
  const { final } = await turn.done
  assert.equal((final.text.match(/^refused/gm) || []).length, 11, final.text)
  assert.match(final.text, /^allowed edit index\.html/m)
  assert.equal(
    hosted.db.prepare('SELECT COUNT(*) AS n FROM chat_permissions').get().n - before,
    3,
    'the named file, the automatic edit, the push',
  )
  assert.ok(final.cards.some((item) => /runs on install, build, test or CI/.test(item.detail || '')))
  assert.ok(
    final.cards.some((item) => /Git's own files, node_modules and files Git ignores are never part of a fix/.test(item.detail || '')),
  )
  assert.deepEqual([final.summary.branch.pushed, final.summary.branch.held], [true, false])
  assert.deepEqual(auto.onRemote(), [push.detail])
  assert.deepEqual(
    final.summary.files.map((file) => file.path),
    ['index.html'],
  )
  const pushed = audit('agent_permission_approved').at(-1)
  assert.deepEqual([pushed.user_id, pushed.detail.kind, pushed.detail.branch], [ada.user.id, 'push', push.detail])
  assert.equal(audit('agent_branch_pushed').at(-1).detail.branch, push.detail)

  // Nobody answers: it stays on the machine, and the thread says so. Then it is asked again.
  const second = await comment(ada, `Held ${fixScript([['edit', 'styles.css', 'blue', 'green']])}`)
  const held = await pressFix(ada, second.id, { agentId: auto.agentId }).done
  assert.deepEqual([held.final.summary.branch.pushed, held.final.summary.branch.held], [false, true])
  assert.ok(
    held.final.cards.some(
      (item) => item.kind === 'note' && /Not pushed: nobody answered in time\..*"Push this fix" asks again/.test(item.label),
    ),
  )
  assert.equal(held.final.cards.find((item) => item.name === 'push').state, 'expired')
  const branch = held.final.summary.branch.name
  assert.equal(auto.onRemote().includes(branch), false)
  await until(async () => ((item) => item.agentStatus === 'branch-ready' && item.replies.length > 0)(await seen(second.id)), 'branch-ready')
  assert.match((await seen(second.id)).replies.at(-1).body, /It is not pushed until someone has looked at its whole diff on the board/)
  // A member who may ask this agent for a fix may ask again; the card is still an admin's to answer.
  const again = post(cyd, second.id, { push: true })
  const card2 = await card(second.id)
  assert.deepEqual([card2.name, card2.detail], ['push', branch])
  assert.match(card2.diff.preview, /green/)
  assert.equal((await answer(ada, second.id, card2, 'deny')).status, 200)
  const denied = (await again.done).final
  assert.equal(denied.summary.branch.held, true)
  assert.equal(auto.onRemote().includes(branch), false)
  const third = post(ada, second.id, { push: true })
  await fresh(ada)
  assert.equal((await answer(ada, second.id, await card(second.id, ada, [card2.id]), 'allow')).status, 200)
  const done = (await third.done).final
  assert.deepEqual([done.summary.branch.pushed, done.summary.branch.held], [true, false])
  assert.ok(auto.onRemote().includes(branch))
  assert.equal(auto.git('status', '--porcelain'), '')
  // Nothing is held any more: asking again says so.
  const none = (await post(ada, second.id, { push: true }).done).final
  assert.equal(none.error.code, 'no_held_fix')
  await auto.link.stop()
})

test('3: Stop while a fix waits to be pushed: nothing is pushed, the branch is taken back, and the comment says what the chat says', async () => {
  const auto = await agentWith('Stopper', { approvals: 'owner', auto: ['edits'] }, { remote: true })
  await fresh(ada)
  assert.equal((await setRule(ada, auto, { rule: 'auto' })).status, 200)
  const made = await comment(ada, `Stop me ${fixScript([['edit', 'index.html', 'Hello', 'Stopped']])}`)
  const turn = pressFix(ada, made.id, { agentId: auto.agentId })
  const push = await card(made.id)
  assert.equal(push.name, 'push')
  assert.equal(auto.branches().length, 2)
  hosted.rateLimiter.reset()
  assert.equal((await ada.browser.post(threadUrl(made.id, '/stop'), {})).status, 200)
  await fresh(ada)
  assert.equal((await answer(ada, made.id, push, 'allow')).status, 409)
  const { final } = await turn.done
  assert.equal(final.status, 'stopped')
  assert.equal(final.summary, undefined)
  assert.equal(final.cards.find((item) => item.id === push.id).state, 'cancelled')
  assert.deepEqual(auto.onRemote(), [], 'nothing was pushed')
  await until(async () => ((item) => item.agentStatus === 'needs-human' && item.replies.length > 0)(await seen(made.id)), 'needs-human')
  await until(() => auto.branches().length === 1, 'the branch to be taken back')
  const reply = (await seen(made.id)).replies.at(-1).body
  assert.match(reply, /This fix was stopped before it was finished\. Nothing was committed or pushed\./)
  assert.doesNotMatch(reply, /Fix ready/)
  assert.equal(audit('agent_branch_pushed').filter((row) => row.target === final.turnId).length, 0)
  assert.equal(auto.git('status', '--porcelain'), '')
  await auto.link.stop()
})

test('4: on a machine that takes approvals from its connector alone, nobody else switches "allow without asking" on', async () => {
  // Bea, an admin, connects one from her machine: --approvals owner --auto edits.
  const hers = await agentWith('Hers', { approvals: 'owner', auto: ['edits'] }, { by: bea })
  const view = async () => (await ada.browser.get(consoleUrl('/agents'))).json.agents.find((agent) => agent.id === hers.agentId)
  assert.equal((await view()).approval.autoBy, 'owner')
  // Ada owns the workspace and may change any agent's rule by role. Not this one.
  await fresh(ada)
  const refused = await setRule(ada, hers, { rule: 'auto' })
  assert.equal(refused.status, 403)
  assert.match(
    refused.json.error.message,
    /Only Bea can let Hers edit without asking: its machine takes approvals from the person who connected it alone/,
  )
  assert.equal((await view()).approval.rule, 'ask')
  // Other settings stay hers to change by role.
  assert.equal((await setRule(ada, hers, { answerRole: 'owner' })).status, 200)
  assert.equal((await setRule(ada, hers, { answerRole: 'admin' })).status, 200)
  await fresh(bea)
  assert.equal((await setRule(bea, hers, { rule: 'auto' })).status, 200)
  assert.deepEqual((await view()).approval.rules, { edits: 'auto', commands: 'ask' })
  // A rule in the database that she did not set herself does not stand: not for the board, not for the machine.
  hosted.db.prepare('UPDATE agents SET approval_rule_by = ? WHERE id = ?').run(ada.user.id, hers.agentId)
  assert.equal((await view()).approval.mode, 'ask')
  const made = await comment(bea, `Ask me ${fixScript([['edit', 'index.html', 'Hello', 'Asked']])}`)
  const turn = pressFix(bea, made.id, { agentId: hers.agentId, dispatchHash: made.dispatchHash })
  const asked = await card(made.id, bea)
  assert.equal(asked.name, 'edit', 'a card, not "allowed automatically"')
  assert.equal((await answer(bea, made.id, asked, 'deny')).status, 200)
  await turn.done
  // And the machine asks the same of the server's word: "auto" without "set by the owner" is "ask".
  const lying = (url, init) =>
    fetch(url, init).then(async (response) => {
      if (!/\/api\/v1\/agent\/turns\/turn_[a-f0-9]+$/.test(String(url)) || (init?.method || 'GET') !== 'GET') return response
      const data = await response.json()
      if (data.job) data.job.approvals = { edits: 'auto', commands: 'auto' }
      return new Response(JSON.stringify(data), { status: response.status, headers: { 'Content-Type': 'application/json' } })
    })
  await hers.link.stop()
  const again = startLink(hosted, hers.token, { cwd: hers.dir, edits: { approvals: 'owner', auto: ['edits'] }, fetchImpl: lying })
  links.push(again)
  assert.ok(await again.ready)
  const other = await comment(bea, `Lied to ${fixScript([['edit', 'index.html', 'Hello', 'Lied']])}`)
  const second = pressFix(bea, other.id, { agentId: hers.agentId, dispatchHash: other.dispatchHash })
  const card2 = await card(other.id, bea)
  assert.equal(card2.name, 'edit')
  assert.equal((await answer(bea, other.id, card2, 'deny')).status, 200)
  await second.done
  assert.equal(audit('agent_permission_auto').filter((row) => row.detail.agent === hers.agentId).length, 0)
  await again.stop()
})

test('8: a card waits a length of time, so the clocks need not agree; an answer the machine did not take is not shown as allowed', async () => {
  const builder = await agentWith('Builder', { approvals: 'admins' })
  // The server's clock is an hour ahead of the machine's: the card still waits its two minutes on both.
  skew = 60 * 60_000
  const made = await comment(ada, `Skewed ${fixScript([['edit', 'index.html', 'Hello', 'Skewed']])}`)
  const turn = pressFix(ada, made.id, { agentId: builder.agentId })
  const asked = await card(made.id)
  const left = Date.parse(asked.expiresAt) - (Date.now() + skew)
  assert.ok(left > 100_000 && left <= 120_000, `two minutes by the server's own clock (${left} ms left)`)
  await fresh(ada)
  assert.equal((await answer(ada, made.id, asked, 'allow')).status, 200)
  const { final } = await turn.done
  assert.equal(final.summary.kind, 'remote-branch', 'allowed and done, an hour apart')
  skew = 0
  await fresh(ada)

  // An "allow" the machine does not take (it came too late there): the machine says expired, and
  // that is what everyone sees. Nobody is named as having allowed it, and it is not counted as allowed.
  const slow = await comment(ada, `Slow ${fixScript([['slow']])}`)
  const second = pressFix(ada, slow.id, { agentId: builder.agentId })
  const live = await until(() => (liveTurn(slow.id)?.state === 'running' ? liveTurn(slow.id) : null), 'the fix to run')
  // A batch posted with the agent's token, under the number the server expects next. The machine
  // posts too, and a number it took first makes this one a repeat (dropped): so it is sent until
  // `taken()` says the server acted on it.
  const inject = async (events, taken) => {
    for (let tries = 0; tries < 20; tries += 1) {
      const work = await tokenCall(hosted, builder.token, 'GET', '/api/v1/agent/work')
      const ack = work.json.turns.find((item) => item.id === live.id).ack
      await tokenCall(hosted, builder.token, 'POST', `/api/v1/agent/turns/${live.id}/events`, { body: { seq: ack + 1, events } })
      if (taken()) return
    }
    throw new Error('the batch was not taken')
  }
  const shownAs = () => live.events.findLast((event) => event.data?.id === 'perm_aaaaaaaaaaaa')?.data
  const frame = {
    id: 'perm_aaaaaaaaaaaa',
    kind: 'permission',
    name: 'edit',
    label: 'Edit index.html',
    detail: 'index.html',
    diff: { path: 'index.html', added: 1, removed: 1, created: false, outside: false, preview: '-a\n+b', full: null, truncated: false },
    state: 'pending',
    ttlMs: 60_000,
  }
  await inject([{ name: 'permission', data: { ...frame, hash: cardHash(live.id, frame) } }], () => Boolean(cardRow(frame.id)))
  const late = await card(slow.id)
  assert.equal((await answer(ada, slow.id, late, 'allow')).status, 200)
  assert.equal(cardRow(late.id).state, 'approved')
  await inject([{ name: 'tool', data: { ...frame, state: 'expired' } }], () => shownAs()?.state === 'expired')
  const row = cardRow(late.id)
  assert.deepEqual([row.state, row.answered_by], ['expired', null])
  const shown = shownAs()
  assert.deepEqual([shown.state, shown.answeredName], ['expired', null])
  const note = audit('agent_permission_not_taken').at(-1)
  assert.deepEqual([note.detail.card, note.detail.answeredBy, note.detail.became], [late.id, ada.user.id, 'expired'])
  // And "approved" from the machine afterwards changes nothing.
  const count = () => live.events.filter((event) => event.data?.id === frame.id).length
  const shownBefore = count()
  await inject([{ name: 'tool', data: { ...frame, state: 'approved' } }], () => count() > shownBefore)
  assert.equal(cardRow(late.id).state, 'expired')
  hosted.rateLimiter.reset()
  await ada.browser.post(threadUrl(slow.id, '/stop'), {})
  const stopped = (await second.done).final
  assert.equal(stopped.cards.find((item) => item.id === late.id).state, 'expired')
  const run = hosted.db.prepare("SELECT * FROM agent_runs WHERE kind = 'fix' ORDER BY rowid DESC").get()
  assert.deepEqual([run.approvals_asked, run.approvals_allowed, run.approvals_denied], [1, 0, 1])
  await builder.link.stop()
})

test('9: Fix on a comment whose run needs approval: an admin’s Fix gives it, with a passkey; a member’s is really sent for approval', async () => {
  const builder = await agentWith('Approver', { approvals: 'admins' })
  await setPolicy({ ...OPEN_POLICY, approveNonAdmin: true })
  const script = fixScript([['say', 'nothing to do']])
  const theirs = await comment(cyd, `Member's ${script}`)
  // The member: the comment is vouched for and waits for an admin, on the comment, where admins look.
  const sent = await pressFix(cyd, theirs.id, { agentId: builder.agentId, dispatchHash: theirs.dispatchHash }).done
  assert.deepEqual([sent.status, sent.json.error.code], [409, 'run_needs_approval'])
  assert.match(
    sent.json.error.message,
    /^Sent for approval\. An admin has to approve this agent run first \(Approve agent run, on the comment\)\. Press Fix with Approver again after that\./,
  )
  const pending = await seen(theirs.id)
  assert.equal(pending.needsRunApproval, true, 'an approval that is really pending')
  assert.equal(pending.agentId, builder.agentId)
  assert.equal(pending.agentStatus, null)
  assert.equal(liveTurn(theirs.id), undefined)
  // An admin's Fix on it is also their approval: it needs the passkey, then it starts.
  stale()
  const unverified = await pressFix(bea, theirs.id, { agentId: builder.agentId, dispatchHash: pending.dispatchHash }).done
  assert.deepEqual([unverified.status, unverified.json.error.code], [403, 'reauth_required'])
  assert.equal((await seen(theirs.id)).needsRunApproval, true, 'nothing was approved without it')
  await fresh(bea)
  const started = await pressFix(bea, theirs.id, { agentId: builder.agentId, dispatchHash: pending.dispatchHash }).done
  assert.equal(started.status, 200, JSON.stringify(started.json))
  assert.match(started.final.text, /nothing to do/)
  const vouch = audit('comment_vouched').at(-1)
  assert.deepEqual([vouch.user_id, vouch.detail.approve, vouch.detail.fix], [bea.user.id, true, true])
  // The other way round: an admin approves on the comment, then the member's Fix starts at once.
  const next = await comment(cyd, `Second ${script}`)
  assert.equal((await pressFix(cyd, next.id, { agentId: builder.agentId, dispatchHash: next.dispatchHash }).done).status, 409)
  await fresh(bea)
  hosted.rateLimiter.reset()
  const approved = await bea.browser.post(boardUrl(`/comments/${next.id}/send-to-agent`), {
    approve: true,
    agentId: null,
    dispatchHash: (await seen(next.id)).dispatchHash,
  })
  assert.equal(approved.status, 200, approved.text)
  const after = await pressFix(cyd, next.id, { agentId: builder.agentId }).done
  assert.equal(after.status, 200, JSON.stringify(after.json))
  await setPolicy(OPEN_POLICY)
  await builder.link.stop()
})

test('10: a status write that does not belong to the running fix does not end its claim', async () => {
  const builder = await agentWith('Twice', { approvals: 'admins' })
  const made = await comment(ada, `Twice ${fixScript([['say', 'first']])}`)
  const first = await pressFix(ada, made.id, { agentId: builder.agentId }).done
  assert.equal(first.status, 200)
  await until(
    async () => ((item) => item.agentStatus === 'needs-human' && item.replies.length > 0)(await seen(made.id)),
    'the first fix to end',
  )
  const firstRow = hosted.db.prepare("SELECT * FROM chat_turns WHERE kind = 'fix' AND comment_number = ? ORDER BY rowid").get(made.id)
  // The second fix of the same comment, by the same agent, is running.
  hosted.db.prepare("UPDATE comments SET body = ? WHERE board_id = 'sample' AND number = ?").run(`Twice ${fixScript([['slow']])}`, made.id)
  hosted.rateLimiter.reset()
  await ada.browser.post(boardUrl(`/comments/${made.id}/send-to-agent`), {
    agentId: builder.agentId,
    dispatchHash: (await seen(made.id)).dispatchHash,
  })
  const second = pressFix(ada, made.id, { agentId: builder.agentId })
  await until(() => liveTurn(made.id)?.state === 'running', 'the second fix to run')
  const open = () =>
    hosted.db
      .prepare("SELECT COUNT(*) AS n FROM agent_claims WHERE board_id = 'sample' AND comment_number = ? AND ended_at IS NULL")
      .get(made.id).n
  assert.equal(open(), 1)
  await until(async () => (await seen(made.id)).agentStatus === 'working', 'working')
  // The first fix's late write, through the token API (as its machine would have sent it): not taken.
  const late = await tokenCall(hosted, builder.token, 'POST', `/api/v1/boards/sample/comments/${made.id}/agent-status`, {
    body: { agentStatus: 'needs-human' },
  })
  assert.deepEqual([late.status, late.json.error.code], [409, 'fix_running'])
  // And the server's own end-of-turn write for the first fix, run again: bound to that fix's claim, which is over.
  const { service } = hosted.app.locals.chat
  const { tenant } = await import('../src/hosted/tenancy.js')
  hosted.db.exec('BEGIN')
  service.releaseFix(tenant(hosted.db, ws), firstRow, 'needs-human')
  hosted.db.exec('COMMIT')
  assert.equal(open(), 1, "the running fix's claim is still open")
  assert.equal((await seen(made.id)).agentStatus, 'working')
  hosted.rateLimiter.reset()
  await ada.browser.post(threadUrl(made.id, '/stop'), {})
  await second.done
  assert.equal(open(), 0)
  await builder.link.stop()
})

test('11: the diff on a card goes to the people the agent works for; everyone else reads that it asked, and how that ended', async () => {
  // Mine: only Ada may use it. Bea is an admin and Cyd a member: both can open the comment's thread.
  const mine = await agentWith('Mine', { approvals: 'admins' }, { audience: 'owner' })
  const made = await comment(ada, `Private ${fixScript([['edit', 'index.html', 'Hello', 'SECRET-SOURCE']])}`)
  const turn = pressFix(ada, made.id, { agentId: mine.agentId })
  const asked = await card(made.id)
  assert.match(asked.diff.preview, /SECRET-SOURCE/)
  // Live: what the others' browsers are sent while it waits and when it ends.
  const watching = [bea, cyd].map((user) => user.browser.get(threadUrl(made.id, '/events?after=0')))
  for (const user of [bea, cyd]) {
    const thread = (await user.browser.get(threadUrl(made.id))).json
    assert.equal(thread.running, true)
    assert.equal(thread.agent.edits.answer.ok, false)
    assert.deepEqual(await waiting(user), [])
  }
  await fresh(ada)
  assert.equal((await answer(ada, made.id, asked, 'allow')).status, 200)
  const mineSaw = await turn.done
  assert.ok(
    mineSaw.events.some(
      (event) => event.name === 'tool' && event.data.id === asked.id && /SECRET-SOURCE/.test(event.data.diff?.preview || ''),
    ),
  )
  for (const stream of watching) {
    const text = (await stream).text
    assert.doesNotMatch(text, /SECRET-SOURCE/, 'not in any event, the final answer included')
    const events = parseEvents(text).filter((event) => event.name === 'tool' && event.data.id === asked.id)
    assert.ok(events.length >= 2)
    for (const event of events) {
      assert.deepEqual([event.data.diff, event.data.hash, event.data.options.length, event.data.diffHidden], [null, undefined, 0, true])
      assert.equal(event.data.label, 'Edit index.html', 'that it asked, and what about')
    }
    assert.deepEqual(events.at(-1).data.state, 'approved')
    assert.equal(events.at(-1).data.answeredName, 'Ada', 'and how it ended')
  }
  // Stored: the same, for whoever opens the thread later.
  for (const user of [bea, cyd]) {
    const thread = await user.browser.get(threadUrl(made.id))
    assert.doesNotMatch(thread.text, /SECRET-SOURCE/)
    const stored = thread.json.messages.at(-1).cards.find((item) => item.id === asked.id)
    assert.deepEqual([stored.diff, stored.diffHidden, stored.state], [null, true, 'approved'])
    assert.equal(
      thread.json.messages.at(-1).summary.files[0].path,
      'index.html',
      'the file names and counts are for everyone who reads the thread',
    )
  }
  const own = (await ada.browser.get(threadUrl(made.id))).json.messages.at(-1).cards.find((item) => item.id === asked.id)
  assert.match(own.diff.preview, /SECRET-SOURCE/)
  // Someone the agent works for, who cannot answer (a member in a "trusted" audience), does read it.
  const shared = await agentWith('Shared', { approvals: 'admins' })
  const other = await comment(ada, `Shared ${fixScript([['edit', 'index.html', 'Hello', 'FOR-THE-TEAM']])}`)
  const second = pressFix(ada, other.id, { agentId: shared.agentId })
  const card2 = await card(other.id)
  const cyds = cyd.browser.get(threadUrl(other.id, '/events?after=0'))
  await fresh(ada)
  assert.equal((await answer(ada, other.id, card2, 'deny')).status, 200)
  await second.done
  assert.match((await cyds).text, /FOR-THE-TEAM/)
  await mine.link.stop()
  await shared.link.stop()
})

test('12: a card with its diff counts against the storage quota: over it, the card is refused, not stored', async () => {
  const builder = await agentWith('Full', { approvals: 'admins' })
  const made = await comment(ada, `Full ${fixScript([['edit', 'index.html', 'Hello', 'Over quota']])}`)
  const before = hosted.db.prepare('SELECT COUNT(*) AS n FROM chat_permissions').get().n
  // The workspace is full from here on.
  hosted.rateLimiter.reset()
  const started = pressFix(ada, made.id, { agentId: builder.agentId })
  await until(() => liveTurn(made.id), 'the fix to start')
  storageLimit = 1
  const { final } = await started.done
  storageLimit = null
  assert.equal(hosted.db.prepare('SELECT COUNT(*) AS n FROM chat_permissions').get().n, before, 'not stored')
  assert.match(final.text, /refused edit index\.html/)
  assert.equal(final.summary, undefined)
  assert.deepEqual(builder.git('branch', '--format=%(refname:short)').split('\n').filter(Boolean), ['main'])
  await builder.link.stop()
})
