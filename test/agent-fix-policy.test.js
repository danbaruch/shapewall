// The pieces of approvals from a hosted board that are pure: the hash that
// ties an answer to one card (src/agent/card-hash.js), the flags of
// `shapewall agent connect` that change this machine's policy
// (src/remote/agent-connect.js policyChanges), what a machine's hello may
// claim (src/hosted/agent-link.js cleanHello), the summary of a fix as the
// server keeps it (src/hosted/chat-frames.js cleanSummary), and what a
// session that takes edits is started with (src/agent/backends/acp.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARD_LIMITS, cardContent, cardHash } from '../src/agent/card-hash.js'
import { diffForFiles } from '../src/agent/text-diff.js'
import { remoteEditSession, readOnlySession } from '../src/agent/backends/acp.js'
import { agentEnv } from '../src/agent/acp/command.js'
import { cleanHello } from '../src/hosted/agent-link.js'
import { cleanSummary } from '../src/hosted/chat-frames.js'
import { approvalAutoAvailable, approvalRuleFor, effectiveApprovalRule } from '../src/hosted/permissions.js'
import { policyChanges } from '../src/remote/agent-connect.js'
import { DEFAULT_MACHINE_POLICY, describeMachinePolicy } from '../src/remote/agent-policy-file.js'

const TURN = `turn_${'a'.repeat(24)}`
const edit = (fields = {}) => ({
  id: 'perm_0123456789ab',
  kind: 'permission',
  name: 'edit',
  label: 'Edit src/app.js',
  detail: 'src/app.js',
  diff: diffForFiles([{ path: 'src/app.js', oldText: 'one\ntwo\n', newText: 'one\n2\n', outside: false }]),
  expiresAt: '2030-01-01T00:02:00.000Z',
  ...fields,
})

test('the card hash covers the turn, the card, what is asked, the whole diff and the expiry; both ends get the same one', () => {
  const card = edit()
  const hash = cardHash(TURN, card)
  assert.match(hash, /^[a-f0-9]{64}$/)
  // The server computes it from what arrived as JSON, after its own cleaning.
  assert.equal(cardHash(TURN, JSON.parse(JSON.stringify(card))), hash)
  assert.equal(cardHash(TURN, cardContent(card)), hash, 'cleaning again changes nothing')
  // Display fields are not what is approved.
  assert.equal(cardHash(TURN, { ...card, state: 'approved', options: [1], chosen: 'x', answeredBy: 'y' }), hash)
  // Anything that is: another turn, card, path, label, diff line, expiry.
  const other = [
    cardHash(`turn_${'b'.repeat(24)}`, card),
    cardHash(TURN, { ...card, id: 'perm_0123456789ac' }),
    cardHash(TURN, { ...card, label: 'Edit src/app.js ' }),
    cardHash(TURN, { ...card, expiresAt: '2030-01-01T00:02:01.000Z' }),
    cardHash(TURN, { ...card, diff: diffForFiles([{ path: 'src/app.js', oldText: 'one\ntwo\n', newText: 'one\n3\n', outside: false }]) }),
    cardHash(TURN, { ...card, diff: { ...card.diff, added: 2 } }),
  ]
  assert.equal(new Set([hash, ...other]).size, 7)
  // A long line with a bidi override: escaped and clipped the same way every time.
  const long = edit({
    diff: diffForFiles([{ path: 'src/app.js', oldText: 'a\n', newText: `a\n${'L'.repeat(900)}‮${'R'.repeat(900)}\n`, outside: false }]),
  })
  assert.equal(cardHash(TURN, JSON.parse(JSON.stringify(cardContent(long)))), cardHash(TURN, long))
  assert.doesNotMatch(JSON.stringify(cardContent(long)), /‮/)
})

test('a card that cannot be approved whole has no hash: nobody is asked', () => {
  for (const [why, card] of [
    ['an edit without a diff', edit({ diff: null })],
    ['a diff that was cut', edit({ diff: { ...edit().diff, truncated: true } })],
    ['a diff for another file than the card names', edit({ detail: 'src/other.js' })],
    ['a file outside the project', edit({ diff: { ...edit().diff, outside: true } })],
    ['no expiry', edit({ expiresAt: null })],
    ['an id that is not a card id', edit({ id: 'perm_../x' })],
    ['a kind that is neither an edit nor a command', edit({ name: 'fetch' })],
    ['a command with a diff', edit({ name: 'execute', detail: 'npm test' })],
    ['a command too long to show', { ...edit({ name: 'execute', diff: null }), detail: 'x'.repeat(CARD_LIMITS.detail + 1) }],
    ['nothing', null],
  ])
    assert.equal(cardHash(TURN, card), null, why)
  assert.match(cardHash(TURN, edit({ name: 'execute', label: 'Run a command', detail: 'npm test', diff: null })), /^[a-f0-9]{64}$/)
  assert.equal(cardHash('', edit()), null)
})

test('agent connect: the flags that change this machine’s policy, and what they refuse', () => {
  const none = { ...DEFAULT_MACHINE_POLICY }
  assert.deepEqual(policyChanges({}, none), {}, 'no flag changes nothing: read and answer only stays')
  assert.deepEqual(policyChanges({ approvals: 'owner' }, none), { approvals: 'owner' })
  assert.throws(() => policyChanges({ approvals: 'remote' }, none), /--approvals: "none"/)
  assert.throws(() => policyChanges({ approvals: 'everyone' }, none), /--approvals/)
  // Nothing about commands, settings files or "without asking" while the machine reads and answers only.
  for (const flags of [{ 'allow-command': 'npm test' }, { 'allow-path': 'package.json' }, { auto: 'edits' }])
    assert.throws(() => policyChanges(flags, none), /needs --approvals owner or --approvals admins/)
  assert.deepEqual(policyChanges({ auto: 'none' }, none), { auto: [] })
  // Lists grow one exact entry at a time; "none" empties them.
  const on = { ...none, approvals: 'owner', commands: ['npm test'] }
  assert.deepEqual(policyChanges({ 'allow-command': 'npm  run   lint' }, on), { commands: ['npm test', 'npm run lint'] })
  assert.deepEqual(policyChanges({ 'allow-command': 'none' }, on), { commands: [] })
  assert.throws(() => policyChanges({ 'allow-command': 'npm test\nrm -rf /' }, on), /one exact command on one line/)
  assert.deepEqual(policyChanges({ 'allow-path': 'package.json' }, on), { allowPaths: ['package.json'] })
  for (const file of ['../x', '/etc/passwd', '.git/config', '.shapewall/x', 'a//b'])
    assert.throws(() => policyChanges({ 'allow-path': file }, on), /--allow-path/, file)
  assert.deepEqual(policyChanges({ auto: 'edits,commands' }, on), { auto: ['edits', 'commands'] })
  assert.throws(() => policyChanges({ auto: 'everything' }, on), /--auto/)
  assert.throws(() => policyChanges({ auto: 'commands' }, { ...on, commands: [] }), /needs at least one --allow-command/)
  assert.deepEqual(policyChanges({ approvals: 'admins', auto: 'edits' }, none), { approvals: 'admins', auto: ['edits'] })
  assert.deepEqual(policyChanges({ base: 'main', 'git-remote': 'none' }, on), { base: 'main', remote: null })
  assert.deepEqual(policyChanges({ base: 'head' }, on), { base: null })
  assert.throws(() => policyChanges({ base: '--upload-pack=x' }, on), /--base/)
  assert.throws(() => policyChanges({ 'git-remote': '-x' }, on), /--git-remote/)
  // What the terminal says of each.
  assert.deepEqual(describeMachinePolicy(none), ['Reads and answers. No edits, no commands (this machine refuses both).'])
  const said = describeMachinePolicy({ ...on, auto: ['edits'], allowPaths: ['package.json'], base: 'main' }).join('\n')
  assert.match(said, /allowed by the person who connected it/)
  assert.match(said, /never in this checkout/)
  assert.match(said, /Commands: only "npm test"/)
  assert.match(said, /May be allowed without asking.*: edits\./)
  assert.match(said, /starts from the branch main/)
})

test('hello: what a machine says it allows is recorded as said, and anything unclear as nothing', () => {
  const hello = (policy, extra = {}) => cleanHello({ kind: 'claude', policy, ...extra }).capabilities
  assert.deepEqual(hello(undefined).policy, { audience: 'server', approvals: 'none', commands: [], auto: [] })
  assert.deepEqual([hello(undefined).edits, hello(undefined).commands], [false, false])
  // A 0.5.0 machine, a made-up level, and claims without approvals.
  for (const policy of [
    { approvals: 'none', commands: 'never' },
    { approvals: 'remote', commands: ['npm test'], auto: ['edits'] },
    { commands: ['npm test'], auto: ['edits', 'commands'] },
  ])
    assert.deepEqual(hello(policy).policy, { audience: 'server', approvals: 'none', commands: [], auto: [] })
  // The machine cannot claim capabilities apart from its policy.
  assert.equal(cleanHello({ kind: 'claude', capabilities: { chat: true, edits: true, commands: true } }).capabilities.edits, false)
  const on = hello({
    approvals: 'owner',
    commands: ['npm test', 'npm test', 'a\nb', 7, 'x'.repeat(201)],
    auto: ['commands', 'edits', 'all'],
  })
  assert.deepEqual(on.policy, { audience: 'server', approvals: 'owner', commands: ['npm test'], auto: ['edits', 'commands'] })
  assert.deepEqual([on.edits, on.commands], [true, true])
  assert.deepEqual(hello({ approvals: 'admins', auto: ['commands'] }).policy.auto, [], '"commands" with no command is nothing')
  // The approval rule follows: "auto" only for a kind the machine named, and only with approvals.
  const agent = (machineApprovals, machineAuto, approvalRule = 'auto') => ({ approvalRule, machineApprovals, machineAuto })
  assert.equal(approvalAutoAvailable(agent('none', ['edits'])), false)
  assert.equal(approvalAutoAvailable(agent('owner', [])), false)
  assert.equal(approvalAutoAvailable(agent('owner', undefined)), false)
  assert.equal(approvalAutoAvailable(agent('owner', ['edits'])), true)
  assert.equal(effectiveApprovalRule(agent('none', ['edits'])), 'ask')
  assert.deepEqual(
    [approvalRuleFor(agent('admins', ['edits']), 'edits'), approvalRuleFor(agent('admins', ['edits']), 'commands')],
    ['auto', 'ask'],
  )
  assert.equal(approvalRuleFor(agent('admins', ['edits'], 'ask'), 'edits'), 'ask')
})

test('the summary of a fix: a branch name that is one, counts, an https link; never a diff or anything else', () => {
  const summary = cleanSummary({
    kind: 'remote-branch',
    files: [{ path: 'index.html', status: 'modified', added: 1, removed: 1, diff: { preview: 'SECRET' }, extra: 'x' }],
    branch: { name: 'shapewall/comment-3-fix', commit: 'a'.repeat(40), baseName: 'main', pushed: true, remote: 'origin', path: '/home/x' },
    pr: { url: 'https://example.com/acme/site/pull/7', number: 7 },
    undo: { kind: 'branch' },
  })
  assert.deepEqual(summary, {
    kind: 'remote-branch',
    files: [{ path: 'index.html', status: 'modified', added: 1, removed: 1, diff: null }],
    added: 1,
    removed: 1,
    more: 0,
    branch: { name: 'shapewall/comment-3-fix', commit: 'a'.repeat(40), baseName: 'main', pushed: true, remote: 'origin' },
    pr: { url: 'https://example.com/acme/site/pull/7', number: 7 },
  })
  assert.equal(cleanSummary({ kind: 'starter', branch: { name: 'x' } }), null)
  assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: '--force' } }), null)
  assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: 'a b' } }), null)
  for (const url of ['javascript:alert(1)', 'http://example.com/x', 'https://user:pw@example.com/x', 'nope'])
    assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: 'fix', pushed: true }, pr: { url } }).pr, null, url)
  // A pull request needs a pushed branch.
  assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: 'fix' }, pr: { url: 'https://example.com/x' } }).pr, null)
})

test('a session that takes edits: the agent’s own settings left out, only reading and editing tools, commands only when listed; no token in its environment', () => {
  const tools = (session) => session._meta.claudeCode.options
  const edits = tools(remoteEditSession('claude', { commands: [] }))
  assert.deepEqual(edits.settingSources, [])
  assert.equal(edits.strictMcpConfig, true)
  assert.equal(edits.allowDangerouslySkipPermissions, false)
  assert.deepEqual(edits.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit'])
  for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'Skill'])
    assert.ok(edits.disallowedTools.includes(tool), tool)
  const withCommands = tools(remoteEditSession('claude', { commands: ['npm test'] }))
  assert.ok(withCommands.tools.includes('Bash'))
  assert.ok(!withCommands.disallowedTools.includes('Bash'))
  assert.ok(withCommands.disallowedTools.includes('WebFetch'))
  // Read only is unchanged.
  assert.deepEqual(tools(readOnlySession('claude')).tools, ['Read', 'Grep', 'Glob'])
  const env = agentEnv({
    PATH: '/usr/bin',
    HOME: '/home/ada',
    SHAPEWALL_TOKEN: 'swp_x',
    SHAPEWALL_GITHUB_TOKEN: 'ghp_x',
    GITHUB_TOKEN: 'ghp_y',
  })
  assert.deepEqual(
    Object.keys(env).filter((name) => /SHAPEWALL|TOKEN/.test(name)),
    [],
  )
})
