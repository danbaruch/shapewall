// Approvals and edits from a hosted board, through the real HTTP surfaces:
// a machine that opted in (`shapewall agent connect --approvals ...`, here
// the link in this process with a scripted agent that edits with its own
// file calls, like Claude Code does), "Fix with <agent>" on a comment, the
// permission card someone answers on the board, and what is left on the
// machine: a commit on a new branch, in a folder of its own, with the
// person's checkout untouched.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { watchRemote } from '../src/remote/remote-watch.js'
import { createProject, invite, reauth, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'
import { connectAgent, fixScript, gitRepo, parseEvents, startLink, until } from './hosted-chat-helpers.js'
import { sampleConfig, tempDir } from './helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOUCH = path.join(HERE, 'fixtures', 'agent-touch.mjs')

let hosted
let ada // owner, connects the agents
let bea // admin
let cyd // member
let ws
let project
let skew = 0
const links = []

const boardUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/boards/sample${rest}`
const agentUrl = (rest = '') => `/w/${ws}/p/${project.id}/api/agent/boards/sample${rest}`
const threadUrl = (number, rest = '') => agentUrl(`/threads/comment-${number}${rest}`)
const consoleUrl = (rest = '') => `/api/workspaces/${ws}/projects/${project.id}${rest}`
const fresh = async (user) => {
  hosted.rateLimiter.reset()
  await reauth(user)
}
const audit = () =>
  hosted.db
    .prepare('SELECT action, target, detail, user_id, token_id FROM audit_log WHERE workspace_id = ? ORDER BY rowid')
    .all(ws)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }))
const lastRun = () => hosted.db.prepare('SELECT * FROM agent_runs WHERE workspace_id = ? ORDER BY rowid DESC').get(ws)
const open = (token, options) => {
  const entry = startLink(hosted, token, options)
  links.push(entry)
  return entry
}
const comment = async (user, body) => {
  hosted.rateLimiter.reset()
  const made = await user.browser.post(boardUrl('/comments'), { pageId: 'home', viewport: 'desktop', x: 30, y: 30, body })
  assert.equal(made.status, 201, made.text)
  return made.json.comment
}
const seen = async (id) => (await ada.browser.get(boardUrl('/comments'))).json.comments.find((item) => item.id === id)
// Presses Fix and returns at once: { done } resolves to the turn's events and final answer.
function pressFix(user, number, body = {}) {
  hosted.rateLimiter.reset()
  const done = user.browser.post(threadUrl(number, '/messages'), { fix: true, ...body }).then((response) => {
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
const waiting = async (user = ada) => (await user.browser.get(agentUrl('/permissions'))).json.permissions
const card = (number, user = ada) =>
  until(async () => (await waiting(user)).find((item) => item.thread === `comment-${number}`), `a card on comment ${number}`)
const answer = (user, number, item, optionId, hash = item.hash) =>
  user.browser.post(threadUrl(number, `/permissions/${item.id}`), { optionId, hash })
const consoleAgent = async (id) => (await ada.browser.get(consoleUrl('/agents'))).json.agents.find((agent) => agent.id === id)
const boardAgent = async (user, id) => (await user.browser.get(boardUrl('/agents'))).json.agents.find((agent) => agent.id === id)

async function pushSample() {
  await fresh(ada)
  const made = await ada.browser.post(consoleUrl('/tokens'), { name: 'push', scopes: ['read', 'push'] })
  assert.equal(made.status, 201, made.text)
  const config = sampleConfig('hosted-fix-board')
  writeLocalCaptures(config, 'sample')
  const remote = createRemote({ origin: hosted.origin, token: made.json.token })
  const board = config.boards[0]
  const started = await remote.startPush(pushDefinition(config, board))
  for (const [area, name, file] of pushFiles(config, board)) await remote.pushFile(started.id, area, name, fs.readFileSync(file))
  const manifest = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample', 'captures', 'manifest.json'), 'utf8'))
  await remote.commitPush(started.id, { manifest, variants: [] })
}
// An agent connected from a fresh repository, with this machine policy for edits.
async function agentWith(name, edits, { audience = 'trusted', files, ...options } = {}) {
  const made = await connectAgent(hosted, ada, { workspaceId: ws, projectId: project.id, name, kind: 'claude', audience })
  assert.equal(made.status, 200, JSON.stringify(made.error))
  const dir = tempDir(`hosted-fix-${name.toLowerCase()}`)
  const git = gitRepo(dir, files)
  const link = open(made.token, { cwd: dir, edits, ...options })
  assert.ok(await link.ready, link.failure()?.message)
  return { ...made, dir, git, link, name }
}
const branches = (agent) => agent.git('branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()
const fixFolders = (agent) => {
  const root = path.join(agent.link.stateDir, 'shapewall', 'agent-fixes')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).flatMap((project) => fs.readdirSync(path.join(root, project)))
}

let builder

before(async () => {
  hosted = await startHostedServer('hosted-fix', { now: () => new Date(Date.now() + skew) })
  ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  ws = ada.workspaceId
  bea = await signUp(hosted, { handle: 'bea', displayName: 'Bea', invite: await invite(ada, ws, 'admin') })
  cyd = await signUp(hosted, { handle: 'cyd', displayName: 'Cyd', invite: await invite(ada, ws, 'member') })
  project = await createProject(ada, ws, 'Site')
  await pushSample()
  await fresh(ada)
  const policy = await ada.browser.call('PUT', consoleUrl('/agent'), {
    body: { trustedRoles: ['member', 'admin', 'owner'], approveNonAdmin: false, dailyClaims: 500, maxOpenClaims: 50 },
  })
  assert.equal(policy.status, 200, policy.text)
  builder = await agentWith('Builder', { approvals: 'admins' })
})

after(async () => {
  for (const entry of links) await entry.stop()
  await hosted?.close()
})

test('a machine that opted in says so: the console and the board show the mode, who may answer, and the change is audited', async () => {
  const agent = await consoleAgent(builder.agentId)
  assert.deepEqual(agent.link.capabilities, { chat: true, edits: true, commands: false, images: false })
  assert.deepEqual(agent.link.policy, { audience: 'server', approvals: 'admins', commands: [], auto: [] })
  assert.equal(agent.approval.mode, 'ask')
  assert.equal(agent.approval.autoAvailable, false, 'this machine named nothing to allow without asking')
  assert.deepEqual(agent.approval.rules, { edits: 'ask', commands: 'ask' })
  const changed = audit().filter((row) => row.action === 'agent_edit_mode_changed' && row.target === builder.agentId)
  assert.equal(changed.length, 1)
  assert.deepEqual(changed[0].detail.before, { approvals: 'none', commands: 0, auto: [] })
  assert.deepEqual(changed[0].detail.after, { approvals: 'admins', commands: 0, auto: [] })
  // The board: plainly which mode, and for each person whether Fix and the cards are theirs.
  const forAda = (await boardAgent(ada, builder.agentId)).edits
  assert.equal(forAda.mode, 'ask')
  assert.match(forAda.text, /Edits on a branch, each allowed by an admin/)
  assert.deepEqual([forAda.fix.ok, forAda.answer.ok], [true, true])
  const forCyd = (await boardAgent(cyd, builder.agentId)).edits
  assert.equal(forCyd.fix.ok, true, 'a trusted member in the audience may ask for a fix')
  assert.equal(forCyd.answer.ok, false)
  assert.match(forCyd.answer.reason, /Waiting for an admin Builder takes work from/)
})

test('Fix with agent: a card with the diff, answered with a fresh passkey, ends as a commit on a new branch; the checkout is untouched', async () => {
  const head = builder.git('rev-parse', 'HEAD')
  const made = await comment(ada, `Say Hi instead of Hello ${fixScript([['edit', 'index.html', 'Hello', 'Hi there']])}`)
  const turn = pressFix(ada, made.id, { dispatchHash: made.dispatchHash })
  const asked = await card(made.id)
  // What the card says is the machine's own wording and the whole change.
  assert.equal(asked.label, 'Edit index.html', "never the agent's own title")
  assert.equal(asked.name, 'edit')
  assert.equal(asked.detail, 'index.html')
  assert.equal(asked.state, 'pending')
  assert.match(asked.diff.preview, /-<h1>Hello<\/h1>/)
  assert.match(asked.diff.preview, /\+<h1>Hi there<\/h1>/)
  assert.match(asked.hash, /^[a-f0-9]{64}$/)
  assert.deepEqual(
    asked.options.map((option) => option.optionId),
    ['allow', 'deny'],
  )
  assert.ok(Date.parse(asked.expiresAt) - Date.now() <= 2 * 60_000 + 1000)
  assert.equal((await seen(made.id)).agentStatus, 'working')
  // A member sees the card in the thread, and has none to answer.
  assert.deepEqual(await waiting(cyd), [])
  const thread = (await cyd.browser.get(threadUrl(made.id))).json
  assert.equal(thread.running, true)
  assert.equal(thread.agent.edits.answer.ok, false)
  assert.equal((await answer(cyd, made.id, asked, 'allow')).status, 403)
  // Allow needs a passkey check in the last minutes.
  skew += 11 * 60_000
  const stale = await answer(ada, made.id, asked, 'allow')
  assert.equal(stale.status, 409, 'and after 11 minutes the card itself has expired')
  skew -= 11 * 60_000
  hosted.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z'").run()
  const unverified = await answer(ada, made.id, asked, 'allow')
  assert.equal(unverified.status, 403)
  assert.equal(unverified.json.error.code, 'reauth_required')
  assert.equal(fs.readFileSync(path.join(builder.dir, 'index.html'), 'utf8'), '<h1>Hello</h1>\n')
  await fresh(ada)
  const allowed = await answer(ada, made.id, asked, 'allow')
  assert.equal(allowed.status, 200, allowed.text)
  // Once: the same answer again changes nothing.
  assert.equal((await answer(ada, made.id, asked, 'allow')).status, 409)

  const { final, events } = await turn.done
  assert.equal(final.status, 'done', JSON.stringify(final.error))
  assert.match(final.text, /allowed edit index\.html/)
  // Everyone watching saw the card wait, then be allowed, by name.
  const states = events.filter((event) => event.name === 'tool' && event.data.id === asked.id).map((event) => event.data.state)
  assert.deepEqual([...new Set(states)], ['pending', 'approved'])
  const stored = final.cards.find((item) => item.id === asked.id)
  assert.deepEqual([stored.state, stored.answeredName, stored.options.length, stored.hash], ['approved', 'Ada', 0, undefined])
  assert.match(stored.diff.preview, /Hi there/)
  // The run summary: the branch, its files with counts, no diff.
  assert.equal(final.summary.kind, 'remote-branch')
  const branch = final.summary.branch.name
  assert.match(branch, new RegExp(`^shapewall/comment-${made.id}-say-hi`))
  assert.deepEqual(final.summary.files, [{ path: 'index.html', status: 'modified', added: 1, removed: 1, diff: null }])
  assert.deepEqual([final.summary.branch.pushed, final.summary.pr], [false, null])

  // On the machine: the commit is on the new branch, and nowhere else.
  assert.deepEqual(branches(builder), ['main', branch])
  assert.equal(builder.git('rev-parse', 'HEAD'), head)
  assert.equal(builder.git('status', '--porcelain'), '', 'the checkout is as it was')
  assert.equal(fs.readFileSync(path.join(builder.dir, 'index.html'), 'utf8'), '<h1>Hello</h1>\n')
  assert.equal(fs.existsSync(path.join(builder.dir, '.shapewall')), false, 'nothing was made in the project folder')
  assert.equal(builder.git('show', `${branch}:index.html`), '<h1>Hi there</h1>')
  assert.equal(builder.git('rev-parse', `${branch}~1`), head)
  assert.match(
    builder.git('log', '-1', '--format=%an <%ae>%n%B', branch),
    new RegExp(`^Ada <ada@example.com>\\nFix comment #${made.id}: Say Hi`),
  )
  assert.deepEqual(
    fixFolders(builder).filter((name) => !name.endsWith('.owner')),
    [],
    'the folder the fix was made in is gone',
  )

  // The comment: a reply from the agent, and where the fix is.
  const after = await until(async () => {
    const item = await seen(made.id)
    return item.agentStatus === 'branch-ready' ? item : null
  }, 'the comment to say branch-ready')
  assert.equal(after.replies.at(-1).author, 'Builder')
  assert.match(after.replies.at(-1).body, new RegExp(`Fix ready on branch ${branch}\\.`))

  // Usage: one row for the fix, with its steps, its requests and how it ended. No text.
  const run = lastRun()
  assert.deepEqual(
    [run.kind, run.outcome, run.asked_by, run.comment_number, run.approvals_asked, run.approvals_allowed, run.approvals_denied],
    ['fix', 'fix_ready', ada.user.id, made.id, 1, 1, 0],
  )
  assert.ok(run.ended_at && run.claim_id)
  // Audit: asked, answered by whom, the branch. The path; never the content.
  const log = audit()
  const of = (action) => log.filter((row) => row.action === action).at(-1)
  assert.equal(of('agent_turn_started').detail.kind, 'fix')
  assert.deepEqual(
    [of('agent_permission_asked').detail.kind, of('agent_permission_asked').detail.path, of('agent_permission_asked').token_id !== null],
    ['edit', 'index.html', true],
  )
  const approved = of('agent_permission_approved')
  assert.deepEqual(
    [approved.user_id, approved.detail.path, approved.detail.cardHash, approved.detail.card],
    [ada.user.id, 'index.html', asked.hash, asked.id],
  )
  assert.equal(of('agent_fix_branch_ready').detail.branch, branch)
  assert.doesNotMatch(JSON.stringify(log), /Hi there|<h1>/, 'no file content in the audit log')
  assert.doesNotMatch(JSON.stringify(hosted.db.prepare('SELECT * FROM agent_runs').all()), /Hi there|Say Hi/)
})

test('Deny leaves nothing: no branch, no folder, the comment needs a person', async () => {
  const before = branches(builder)
  const made = await comment(ada, `Change the colour ${fixScript([['edit', 'styles.css', 'blue', 'red']])}`)
  const turn = pressFix(ada, made.id)
  const asked = await card(made.id)
  // Deny needs no passkey: it only ever stops something.
  hosted.db.prepare("UPDATE sessions SET verified_at = '2000-01-01T00:00:00.000Z'").run()
  const denied = await answer(bea, made.id, asked, 'deny')
  assert.equal(denied.status, 200, denied.text)
  const { final } = await turn.done
  assert.match(final.text, /refused edit styles\.css/)
  assert.equal(final.summary, undefined)
  const stored = final.cards.find((item) => item.id === asked.id)
  assert.deepEqual([stored.state, stored.answeredName], ['denied', 'Bea'])
  assert.deepEqual(branches(builder), before)
  assert.equal(builder.git('status', '--porcelain'), '')
  assert.deepEqual(
    fixFolders(builder).filter((name) => !name.endsWith('.owner')),
    [],
  )
  await until(async () => (await seen(made.id)).agentStatus === 'needs-human', 'needs-human')
  assert.match((await seen(made.id)).replies.at(-1).body, /No change was committed/)
  const run = lastRun()
  assert.deepEqual([run.kind, run.outcome, run.approvals_asked, run.approvals_allowed, run.approvals_denied], ['fix', 'answered', 1, 0, 1])
  assert.equal(
    audit()
      .filter((row) => row.action === 'agent_permission_denied')
      .at(-1).user_id,
    bea.user.id,
  )
  await fresh(ada)
})

test('Stop cancels a waiting card; a card nobody answers expires; neither can be answered afterwards', async () => {
  const before = branches(builder)
  const stopped = await comment(ada, `Stop me ${fixScript([['edit', 'index.html', 'Hello', 'Stopped']])}`)
  const turn = pressFix(ada, stopped.id)
  const asked = await card(stopped.id)
  hosted.rateLimiter.reset()
  assert.equal((await ada.browser.post(threadUrl(stopped.id, '/stop'), {})).status, 200)
  await fresh(ada)
  assert.equal((await answer(ada, stopped.id, asked, 'allow')).status, 409, 'a stopped turn takes no answer')
  const { final, events } = await turn.done
  assert.equal(final.status, 'stopped')
  assert.ok(events.some((event) => event.name === 'tool' && event.data.id === asked.id && event.data.state === 'cancelled'))
  assert.equal(final.cards.find((item) => item.id === asked.id).state, 'cancelled')
  assert.deepEqual(await waiting(), [])
  assert.deepEqual(branches(builder), before)
  await until(async () => (await seen(stopped.id)).agentStatus === 'needs-human', 'needs-human after Stop')

  // Nobody answers: two minutes later the card is expired here, whatever the machine does.
  const slow = await comment(ada, `Wait for me ${fixScript([['edit', 'index.html', 'Hello', 'Late']])}`)
  const second = pressFix(ada, slow.id)
  const late = await card(slow.id)
  skew += 2 * 60_000 + 1000
  assert.deepEqual(await waiting(), [], 'an expired card is not offered')
  const tooLate = await answer(ada, slow.id, late, 'allow')
  assert.equal(tooLate.status, 409)
  assert.equal(tooLate.json.error.code, 'no_permission')
  hosted.app.locals.chat.service.sweep()
  const row = hosted.db.prepare('SELECT state FROM chat_permissions WHERE id = ?').get(late.id)
  assert.equal(row.state, 'expired')
  assert.ok(audit().some((item) => item.action === 'agent_permission_expired' && item.detail.card === late.id))
  skew -= 2 * 60_000 + 1000
  hosted.rateLimiter.reset()
  await ada.browser.post(threadUrl(slow.id, '/stop'), {})
  await second.done
  assert.deepEqual(branches(builder), before)
})

test('a fix is pushed to the machine’s remote when it has one, and the run says so; a change that would run in CI is not pushed', async () => {
  const bare = tempDir('hosted-fix-bare')
  execFileSync('git', ['init', '-q', '--bare', bare])
  const pusher = await agentWith(
    'Pusher',
    { approvals: 'owner', remote: 'origin', allowPaths: ['package.json'] },
    { files: { 'index.html': '<h1>Hello</h1>\n', 'package.json': '{ "name": "site" }\n' } },
  )
  pusher.git('remote', 'add', 'origin', bare)
  const made = await comment(ada, `Push me ${fixScript([['edit', 'index.html', 'Hello', 'Pushed']])}`)
  const turn = pressFix(ada, made.id, { agentId: pusher.agentId })
  await fresh(ada)
  assert.equal((await answer(ada, made.id, await card(made.id), 'allow')).status, 200)
  const { final } = await turn.done
  assert.deepEqual([final.summary.branch.pushed, final.summary.branch.remote], [true, 'origin'])
  const branch = final.summary.branch.name
  assert.equal(execFileSync('git', ['--git-dir', bare, 'show', `${branch}:index.html`], { encoding: 'utf8' }).trim(), '<h1>Pushed</h1>')
  assert.equal(
    execFileSync('git', ['--git-dir', bare, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).trim(),
    branch,
    'only that branch',
  )
  const pushed = audit()
    .filter((row) => row.action === 'agent_branch_pushed')
    .at(-1)
  assert.deepEqual([pushed.detail.branch, pushed.detail.remote, pushed.detail.agentName], [branch, 'origin', 'Pusher'])
  await until(async () => (await seen(made.id)).agentStatus === 'branch-ready', 'branch-ready')

  // package.json is a settings file: only because this machine named it may it be asked at all,
  // and a branch that changes it is kept on the machine.
  const guarded = await comment(ada, `Rename ${fixScript([['edit', 'package.json', 'site', 'shop']])}`)
  const second = pressFix(ada, guarded.id, { agentId: pusher.agentId })
  await fresh(ada)
  assert.equal((await answer(ada, guarded.id, await card(guarded.id), 'allow')).status, 200)
  const kept = (await second.done).final
  assert.equal(kept.summary.branch.pushed, false)
  assert.ok(
    kept.cards.some((item) => item.kind === 'note' && /Not pushed: the fix changes package\.json, which would run in CI/.test(item.label)),
  )
  assert.throws(() =>
    execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', `refs/heads/${kept.summary.branch.name}`], { stdio: 'pipe' }),
  )
  await pusher.link.stop()
})

test('"always allow": only where the machine says so, set by the role that may; a machine that takes it back resets the rule', async () => {
  // Builder's machine named nothing to allow without asking: the rule cannot be set.
  await fresh(ada)
  const refused = await ada.browser.call('PUT', consoleUrl(`/agents/${builder.agentId}/approval`), { body: { rule: 'auto' } })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'approval_auto_unavailable')

  const auto = await agentWith('Auto', { approvals: 'owner', auto: ['edits'], commands: ['node --version'] })
  let agent = await consoleAgent(auto.agentId)
  assert.deepEqual(agent.link.policy, { audience: 'server', approvals: 'owner', commands: ['node --version'], auto: ['edits'] })
  assert.equal(agent.approval.autoAvailable, true)
  assert.equal(agent.approval.mode, 'ask', 'available is not on')
  // The rule is the owner's to change here: an admin is refused.
  await fresh(ada)
  assert.equal(
    (await ada.browser.call('PUT', consoleUrl(`/agents/${auto.agentId}/approval`), { body: { changeRole: 'owner' } })).status,
    200,
  )
  await fresh(bea)
  assert.equal((await bea.browser.call('PUT', consoleUrl(`/agents/${auto.agentId}/approval`), { body: { rule: 'auto' } })).status, 403)
  await fresh(ada)
  const set = await ada.browser.call('PUT', consoleUrl(`/agents/${auto.agentId}/approval`), { body: { rule: 'auto' } })
  assert.equal(set.status, 200, set.text)
  assert.deepEqual(set.json.agent.approval.rules, { edits: 'auto', commands: 'ask' }, 'only the kind the machine named')
  assert.equal((await boardAgent(ada, auto.agentId)).edits.mode, 'auto')
  assert.match((await boardAgent(ada, auto.agentId)).edits.text, /allowed without asking/)

  // An edit goes through with no card waiting; a command still asks; a file outside is still refused.
  const made = await comment(
    ada,
    `Auto ${fixScript([
      ['edit', 'index.html', 'Hello', 'Automatic'],
      ['write', '../outside.txt', 'x'],
      ['bash', 'node --version'],
    ])}`,
  )
  const turn = pressFix(ada, made.id, { agentId: auto.agentId })
  const asked = await card(made.id)
  assert.equal(asked.name, 'execute')
  assert.equal(asked.detail, 'node --version')
  await fresh(ada)
  assert.equal((await answer(ada, made.id, asked, 'allow')).status, 200)
  const { final } = await turn.done
  assert.match(final.text, /allowed edit index\.html/)
  assert.match(final.text, /refused write \.\.\/outside\.txt/)
  assert.match(final.text, /allowed bash node --version: v\d+/)
  const automatic = final.cards.find((item) => item.kind === 'permission' && item.label === 'Edit index.html')
  assert.deepEqual(
    [automatic.state, automatic.auto, automatic.chosen, automatic.answeredName],
    ['approved', true, 'Allowed automatically', null],
  )
  assert.equal(final.summary.files.length, 1)
  assert.equal(fs.existsSync(path.join(path.dirname(auto.dir), 'outside.txt')), false)
  const log = audit()
  assert.ok(log.some((row) => row.action === 'agent_permission_auto' && row.detail.path === 'index.html'))
  const command = log.filter((row) => row.action === 'agent_permission_approved').at(-1)
  assert.equal(command.detail.kind, 'execute')
  assert.match(command.detail.commandHash, /^[a-f0-9]{64}$/)
  assert.equal(command.detail.path, undefined)
  assert.doesNotMatch(JSON.stringify(command.detail), /node --version/, 'a command is in the audit log as its hash')
  const run = lastRun()
  assert.deepEqual([run.approvals_asked, run.approvals_allowed, run.approvals_denied], [2, 2, 0])

  // The machine connects again without "auto": the stored rule does not wait for it to come back.
  await auto.link.stop()
  const again = open(auto.token, { cwd: auto.dir, edits: { approvals: 'owner' } })
  assert.ok(await again.ready)
  agent = await consoleAgent(auto.agentId)
  assert.deepEqual([agent.approval.rule, agent.approval.mode, agent.approval.autoAvailable], ['ask', 'ask', false])
  const reset = audit()
    .filter((row) => row.action === 'agent_approval_rule_changed' && row.target === auto.agentId)
    .at(-1)
  assert.deepEqual([reset.detail.before.rule, reset.detail.after.rule], ['auto', 'ask'])
  await again.stop()
})

test('refused before it starts: a checkout with uncommitted changes, a folder that is no repository; a named base branch lifts the first', async () => {
  const dirty = await agentWith('Dirty', { approvals: 'owner' })
  fs.writeFileSync(path.join(dirty.dir, 'index.html'), '<h1>Work in progress</h1>\n')
  const made = await comment(ada, `Dirty ${fixScript([['edit', 'index.html', 'Hello', 'Hi']])}`)
  const { final } = await pressFix(ada, made.id, { agentId: dirty.agentId }).done
  assert.equal(final.status, 'error')
  assert.equal(final.error.code, 'fix_refused')
  assert.match(final.error.message, /uncommitted changes, which a fix would not include/)
  assert.deepEqual(branches(dirty), ['main'])
  assert.equal(fs.readFileSync(path.join(dirty.dir, 'index.html'), 'utf8'), '<h1>Work in progress</h1>\n')
  await until(async () => (await seen(made.id)).agentStatus === 'needs-human', 'needs-human')
  assert.match((await seen(made.id)).replies.at(-1).body, /I could not start this fix\. .*uncommitted changes/)
  await dirty.link.stop()

  // With a base branch named on the machine, the fix starts from that branch, whatever the checkout holds.
  const based = open(dirty.token, { cwd: dirty.dir, edits: { approvals: 'owner', base: 'main' } })
  assert.ok(await based.ready)
  const turn = pressFix(ada, made.id, { agentId: dirty.agentId })
  await fresh(ada)
  assert.equal((await answer(ada, made.id, await card(made.id), 'allow')).status, 200)
  const ok = (await turn.done).final
  assert.equal(ok.summary.branch.baseName, 'main')
  assert.equal(dirty.git('show', `${ok.summary.branch.name}:index.html`), '<h1>Hi</h1>')
  assert.equal(
    fs.readFileSync(path.join(dirty.dir, 'index.html'), 'utf8'),
    '<h1>Work in progress</h1>\n',
    'the work in progress is as it was',
  )
  await based.stop()

  const plain = await connectAgent(hosted, ada, {
    workspaceId: ws,
    projectId: project.id,
    name: 'Plain',
    kind: 'claude',
    audience: 'trusted',
  })
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'shapewall-fix-nogit-'))
  try {
    fs.writeFileSync(path.join(folder, 'index.html'), '<h1>Hello</h1>\n')
    const link = open(plain.token, { cwd: folder, edits: { approvals: 'owner' } })
    assert.ok(await link.ready)
    const other = await comment(ada, `No git ${fixScript([['edit', 'index.html', 'Hello', 'Hi']])}`)
    const refused = (await pressFix(ada, other.id, { agentId: plain.agentId }).done).final
    assert.match(refused.error.message, /not a Git repository/)
    assert.equal(fs.readFileSync(path.join(folder, 'index.html'), 'utf8'), '<h1>Hello</h1>\n')
    await link.stop()
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('an agent that reads and answers only is not offered for a fix, with the reason; a watcher with --exec works as before', async () => {
  const reader = await connectAgent(hosted, ada, {
    workspaceId: ws,
    projectId: project.id,
    name: 'Reader',
    kind: 'claude',
    audience: 'trusted',
  })
  const link = open(reader.token, { cwd: tempDir('hosted-fix-reader') })
  assert.ok(await link.ready)
  const view = (await boardAgent(ada, reader.agentId)).edits
  assert.equal(view.mode, 'none')
  assert.equal(view.text, 'Reads and answers')
  assert.equal(view.fix.ok, false)
  assert.match(view.fix.reason, /Reader reads and answers only\. Edits are switched on on its own machine/)
  const made = await comment(ada, 'Tighten the footer spacing')
  const refused = await pressFix(ada, made.id, { agentId: reader.agentId }).done
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'read_only_agent')
  assert.equal((await seen(made.id)).agentStatus, null, 'the comment is as it was')
  await link.stop()

  // The same comment, left for any agent: a watcher takes it and runs its command, as in 0.5.0.
  hosted.rateLimiter.reset()
  await ada.browser.post(boardUrl(`/comments/${made.id}/send-to-agent`), {
    agentId: null,
    dispatchHash: (await seen(made.id)).dispatchHash,
  })
  await fresh(ada)
  const token = await ada.browser.post(consoleUrl('/tokens'), { name: 'Fixer', scopes: ['read', 'reply', 'status', 'claim'] })
  assert.equal(token.status, 201, token.text)
  const fixer = (await ada.browser.get(consoleUrl('/agents'))).json.agents.find((agent) => agent.name === 'Fixer')
  assert.deepEqual([fixer.kind, fixer.approval.mode], ['watcher', 'none'])
  await ada.browser.call('PUT', consoleUrl(`/agents/${fixer.id}/audience`), { body: { audience: 'trusted' } })
  const ranFile = path.join(tempDir('hosted-fix-watch'), 'ran.txt')
  fs.writeFileSync(ranFile, '')
  const lines = []
  await watchRemote({
    remote: createRemote({ origin: hosted.origin, token: token.json.token }),
    boardId: 'sample',
    projectId: project.id,
    exec: `${process.execPath} ${TOUCH}`,
    once: true,
    cwd: tempDir('hosted-fix-watch-cwd'),
    env: { ...process.env, SW_TOUCH_FILE: ranFile, SW_TOUCH_LABEL: 'fixer', SW_TOUCH_MS: '0' },
    out: (line) => lines.push(line),
    log: (line) => lines.push(line),
  })
  assert.match(fs.readFileSync(ranFile, 'utf8'), /fixer/, lines.join('\n'))
  assert.notEqual((await seen(made.id)).agentStatus, null)
})
