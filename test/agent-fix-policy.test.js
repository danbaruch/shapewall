// The pieces of approvals from a hosted board that are pure: the hash that
// ties an answer to one card (src/agent/card-hash.js), which files run
// something (src/agent/exec-paths.js), the machine's policy file and the
// flags of `shapewall agent connect` that change it
// (src/remote/agent-policy-file.js, agent-connect.js), what a machine's
// hello may claim (src/hosted/agent-link.js cleanHello), the summary of a
// fix as the server keeps it (src/hosted/chat-frames.js cleanSummary), and
// what a session that takes edits is started with (src/agent/backends/acp.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CARD_LIMITS, cardContent, cardHash } from '../src/agent/card-hash.js'
import { filesThatRun, neverCommitted, runsSomething } from '../src/agent/exec-paths.js'
import { diffForFiles } from '../src/agent/text-diff.js'
import { remoteEditSession, readOnlySession } from '../src/agent/backends/acp.js'
import { agentEnv } from '../src/agent/acp/command.js'
import { cleanHello } from '../src/hosted/agent-link.js'
import { cleanSummary } from '../src/hosted/chat-frames.js'
import { approvalAutoAvailable, approvalRuleFor, effectiveApprovalRule } from '../src/hosted/permissions.js'
import { policyChanges } from '../src/remote/agent-connect.js'
import { inertLine, pullLink } from '../src/remote/agent-fix.js'
import {
  DEFAULT_MACHINE_POLICY,
  cleanMachinePolicy,
  describeMachinePolicy,
  policyFile,
  readMachinePolicy,
  saveMachinePolicy,
} from '../src/remote/agent-policy-file.js'
import { tempDir } from './helpers.js'

const TURN = `turn_${'a'.repeat(24)}`
const edit = (fields = {}) => ({
  id: 'perm_0123456789ab',
  kind: 'permission',
  name: 'edit',
  label: 'Edit src/app.js',
  detail: 'src/app.js',
  diff: diffForFiles([{ path: 'src/app.js', oldText: 'one\ntwo\n', newText: 'one\n2\n', outside: false }]),
  ttlMs: 120_000,
  ...fields,
})

test('the card hash covers the turn, the card, what is asked, the whole diff and how long it waits; both ends get the same one', () => {
  const card = edit()
  const hash = cardHash(TURN, card)
  assert.match(hash, /^[a-f0-9]{64}$/)
  // The server computes it from what arrived as JSON, after its own cleaning.
  assert.equal(cardHash(TURN, JSON.parse(JSON.stringify(card))), hash)
  assert.equal(cardHash(TURN, cardContent(card)), hash, 'cleaning again changes nothing')
  // Display fields are not what is approved. Nor is any moment in time: the two clocks need not agree.
  assert.equal(
    cardHash(TURN, { ...card, state: 'approved', options: [1], chosen: 'x', answeredBy: 'y', expiresAt: '1999-01-01T00:00:00Z' }),
    hash,
  )
  // Anything that is: another turn, card, path, label, diff line, length of the wait.
  const other = [
    cardHash(`turn_${'b'.repeat(24)}`, card),
    cardHash(TURN, { ...card, id: 'perm_0123456789ac' }),
    cardHash(TURN, { ...card, label: 'Edit src/app.js ' }),
    cardHash(TURN, { ...card, ttlMs: 119_000 }),
    cardHash(TURN, { ...card, diff: diffForFiles([{ path: 'src/app.js', oldText: 'one\ntwo\n', newText: 'one\n3\n', outside: false }]) }),
    cardHash(TURN, { ...card, diff: { ...card.diff, added: 2 } }),
  ]
  assert.equal(new Set([hash, ...other]).size, 7)
  // A long line with a bidi override: escaped and clipped the same way every time.
  const long = edit({
    diff: diffForFiles([
      { path: 'src/app.js', oldText: 'a\n', newText: `a\n${'L'.repeat(900)}\u202e${'R'.repeat(900)}\n`, outside: false },
    ]),
  })
  assert.equal(cardHash(TURN, JSON.parse(JSON.stringify(cardContent(long)))), cardHash(TURN, long))
  assert.doesNotMatch(JSON.stringify(cardContent(long)), /\u202e/)
})

test('a card that cannot be approved whole has no hash: nobody is asked', () => {
  const push = (fields = {}) => edit({ name: 'push', label: 'Push this fix', detail: 'shapewall/comment-1-x', ttlMs: 600_000, ...fields })
  for (const [why, card] of [
    ['an edit without a diff', edit({ diff: null })],
    ['a diff that was cut', edit({ diff: { ...edit().diff, truncated: true } })],
    ['a diff for another file than the card names', edit({ detail: 'src/other.js' })],
    ['a file outside the project', edit({ diff: { ...edit().diff, outside: true } })],
    ['no length of time to wait', edit({ ttlMs: null })],
    ['a moment in time in its place', { ...edit({ ttlMs: undefined }), expiresAt: '2030-01-01T00:02:00.000Z' }],
    ['an edit that would wait longer than two minutes', edit({ ttlMs: CARD_LIMITS.ttlMs + 1 })],
    ['an id that is not a card id', edit({ id: 'perm_../x' })],
    ['a kind that is neither an edit, a command nor a push', edit({ name: 'fetch' })],
    ['a command with a diff', edit({ name: 'execute', detail: 'npm test' })],
    ['a command too long to show', { ...edit({ name: 'execute', diff: null }), detail: 'x'.repeat(CARD_LIMITS.detail + 1) }],
    ['a push without the diff', push({ diff: null })],
    ['a push whose diff was cut', push({ diff: { ...edit().diff, truncated: true } })],
    ['a push that would wait longer than ten minutes', push({ ttlMs: CARD_LIMITS.pushTtlMs + 1 })],
    ['nothing', null],
  ])
    assert.equal(cardHash(TURN, card), null, why)
  assert.match(cardHash(TURN, edit({ name: 'execute', label: 'Run a command', detail: 'npm test', diff: null })), /^[a-f0-9]{64}$/)
  assert.match(cardHash(TURN, push()), /^[a-f0-9]{64}$/)
  assert.equal(cardHash('', edit()), null)
})

test('which files run something: one list for the card and for the push', () => {
  const runs = [
    // What the push guard already knew.
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
    'Makefile',
    'requirements-dev.txt',
    'docs/Dockerfile',
    // Dotfiles and dot folders.
    '.env',
    '.eslintrc.json',
    '.husky/pre-commit',
    'src/.hidden/x.js',
    // Tool and build configuration.
    'vite.config.js',
    'vitest.config.ts',
    'jest.config.cjs',
    'webpack.config.mjs',
    'rollup.config.js',
    'babel.config.json',
    'eslint.config.js',
    'tailwind.config.ts',
    'tsconfig.json',
    'tsconfig.build.json',
    'packages/app/tsconfig.json',
    'shapewall.config.json',
    // Scripts a package runs, install hooks, containers, makefiles.
    'scripts/build.js',
    'bin/cli.js',
    'tools/release.mjs',
    'postinstall.js',
    'deploy.sh',
    'Dockerfile.prod',
    'docker-compose.override.yml',
    'compose.yaml',
    'GNUmakefile',
    'rules.mk',
    // Tests: CI runs them.
    'src/app.test.js',
    'src/app.spec.ts',
    'test/app.js',
    'src/__tests__/app.js',
    'e2e/login.js',
    'pkg/thing_test.go',
    'tests/test_thing.py',
    '',
  ]
  for (const file of runs) assert.equal(runsSomething(file), true, file)
  const source = [
    'index.html',
    'styles.css',
    'src/app.js',
    'src/pages/pricing.tsx',
    'README.md',
    'docs/guide.md',
    'public/logo.svg',
    'src/config.js',
    'src/testing.js',
    'content/scripts.md',
  ]
  for (const file of source) assert.equal(runsSomething(file), false, file)
  assert.deepEqual(filesThatRun(['index.html', 'package.json', 'src/app.test.js']), ['package.json', 'src/app.test.js'])
  // What Shapewall's own commit never takes, named or not.
  for (const file of ['.gitattributes', 'sub/.gitmodules', 'node_modules/x/index.js', 'a/node_modules/b.js', '.git/config'])
    assert.equal(neverCommitted(file), true, file)
  assert.equal(neverCommitted('src/app.js'), false)
})

test('the policy file: a value it does not know reads as the narrowest setting, by name; never as the default', () => {
  const NONE = { audience: 'server', approvals: 'none', commands: [], auto: [], allowPaths: [], base: null, remote: 'origin' }
  const read = (entry) => {
    const warnings = []
    return [cleanMachinePolicy(entry, (text) => warnings.push(text)), warnings]
  }
  // Nothing saved, or keys left out: the defaults.
  assert.deepEqual(read(undefined), [NONE, []])
  assert.deepEqual(read({ approvals: 'owner' })[0], { ...NONE, approvals: 'owner' })
  // "remote": false, "", 0, a number, an option-like name: never pushed. Only a missing key is "origin".
  for (const remote of [false, '', 0, 7, '-x', ['origin'], {}]) {
    const [policy, warnings] = read({ approvals: 'owner', remote })
    assert.equal(policy.remote, null, JSON.stringify(remote))
    assert.match(warnings.join('\n'), /"remote" has a value this version does not know: read as none \(a fix is never pushed\)/)
  }
  assert.equal(read({ remote: null })[0].remote, null)
  assert.equal(read({ remote: 'upstream' })[0].remote, 'upstream')
  // An audience typo is the narrower one, not the wider.
  for (const audience of ['ownr', 'Owner', '', false, 1]) {
    const [policy, warnings] = read({ audience })
    assert.equal(policy.audience, 'owner', JSON.stringify(audience))
    assert.match(warnings.join('\n'), /"audience"/)
  }
  // Approvals it does not know: none, and with that nothing else.
  const [off, offWarnings] = read({ approvals: 'everyone', auto: ['edits'], allowPaths: ['package.json'], commands: ['npm test'] })
  assert.deepEqual(off, NONE)
  assert.match(offWarnings.join('\n'), /"approvals" has a value this version does not know: read as "none"/)
  // A list with one entry it cannot read is not trusted for the rest.
  for (const [key, value] of [
    ['auto', ['edits', 'everything']],
    ['auto', 'edits'],
    ['allowPaths', ['package.json', '../outside']],
    ['allowPaths', ['.git/config']],
    ['commands', ['npm test', 'rm -rf /\nnpm test']],
    ['commands', 'npm test'],
  ]) {
    const [policy, warnings] = read({ approvals: 'owner', [key]: value })
    assert.deepEqual(policy[key], [], `${key}: ${JSON.stringify(value)}`)
    assert.match(warnings.join('\n'), new RegExp(`"${key}" has a value this version does not know: read as empty`))
  }
  assert.equal(read({ approvals: 'owner', base: '--upload-pack=x' })[0].base, null)
  // A key this version has never heard of is said, and changes nothing.
  assert.match(
    read({ approvals: 'owner', pushWithoutAsking: true })[1].join('\n'),
    /"pushWithoutAsking" is not a setting this version knows/,
  )
  // An entry that is not an object at all: the narrowest of everything.
  assert.deepEqual(read('admins')[0], { ...NONE, audience: 'owner', remote: null })

  // The file itself: yours, and only yours to write, checked before a byte of it is read.
  const env = { XDG_CONFIG_HOME: tempDir('fix-policy-file') }
  const origin = 'https://wall.example.com'
  saveMachinePolicy(origin, 'default', { approvals: 'owner', auto: ['edits'] }, env)
  const file = policyFile(env)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readMachinePolicy(origin, 'default', env).auto, ['edits'])
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o620)
    assert.throws(() => readMachinePolicy(origin, 'default', env), /can be changed by other users/)
    fs.chmodSync(file, 0o600)
    // A link in its place is not followed.
    const real = `${file}.real`
    fs.renameSync(file, real)
    fs.symlinkSync(real, file)
    assert.throws(() => readMachinePolicy(origin, 'default', env), /symbolic link/)
    fs.rmSync(file)
    fs.renameSync(real, file)
  }
  // Hand-edited into nonsense: said by name through `warn`, and read narrow.
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  data.connections[`${origin}#default`] = { approvals: 'owner', remote: false, audience: 'everyone', auto: ['edits'] }
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
  const warned = []
  const policy = readMachinePolicy(origin, 'default', env, { warn: (text) => warned.push(text) })
  assert.deepEqual([policy.remote, policy.audience, policy.approvals, policy.auto], [null, 'owner', 'owner', ['edits']])
  assert.equal(warned.length, 2)
  assert.ok(warned.every((text) => text.startsWith(path.dirname(file))))
  fs.writeFileSync(file, '{ "connections": 7 }', { mode: 0o600 })
  assert.throws(() => readMachinePolicy(origin, 'default', env), /has no "connections"/)
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
  // What the terminal says of each, and exactly who can switch "without asking" on.
  assert.deepEqual(describeMachinePolicy(none), ['Reads and answers. No edits, no commands (this machine refuses both).'])
  const said = describeMachinePolicy({ ...on, auto: ['edits'], allowPaths: ['package.json'], base: 'main' }).join('\n')
  assert.match(said, /allowed by the person who connected it/)
  assert.match(said, /never in this checkout/)
  assert.match(said, /Commands: only "npm test"/)
  assert.match(said, /May be allowed without asking: edits, once the person who connected it \(nobody else\) switches that on/)
  assert.match(said, /never a file that runs something/)
  assert.match(said, /not pushed until a person has looked at its whole diff/)
  assert.match(said, /starts from the branch main/)
  assert.match(
    describeMachinePolicy({ ...on, approvals: 'admins', auto: ['edits'] }).join('\n'),
    /once someone with the agent's rule-changing role \(an admin by default\) switches that on/,
  )
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

test('the summary of a fix: a branch name that is one, counts, a link shaped like a pull request; never a diff or anything else', () => {
  const summary = cleanSummary({
    kind: 'remote-branch',
    files: [{ path: 'index.html', status: 'modified', added: 1, removed: 1, diff: { preview: 'SECRET' }, extra: 'x' }],
    branch: {
      name: 'shapewall/comment-3-fix',
      commit: 'a'.repeat(40),
      baseName: 'main',
      pushed: true,
      remote: 'origin',
      path: '/somewhere',
    },
    pr: { url: 'https://example.com/acme/site/pull/7', number: 9 },
    undo: { kind: 'branch' },
  })
  assert.deepEqual(summary, {
    kind: 'remote-branch',
    files: [{ path: 'index.html', status: 'modified', added: 1, removed: 1, diff: null }],
    added: 1,
    removed: 1,
    more: 0,
    branch: { name: 'shapewall/comment-3-fix', commit: 'a'.repeat(40), baseName: 'main', pushed: true, held: false, remote: 'origin' },
    // Shaped like a pull request, so it is shown; not on github.com, so as text, not as a link. Its number is the URL's.
    pr: { url: 'https://example.com/acme/site/pull/7', number: 7, link: false },
  })
  assert.equal(cleanSummary({ kind: 'starter', branch: { name: 'x' } }), null)
  assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: '--force' } }), null)
  assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: 'a b' } }), null)
  const pull = (url, extra = {}) => cleanSummary({ kind: 'remote-branch', branch: { name: 'fix', pushed: true, ...extra }, pr: { url } })
  assert.deepEqual(pull('https://github.com/acme/site/pull/7').pr, { url: 'https://github.com/acme/site/pull/7', number: 7, link: true })
  for (const url of [
    'javascript:alert(1)',
    'http://github.com/acme/site/pull/7',
    'https://user:pw@github.com/acme/site/pull/7',
    'https://github.com/acme/site/issues/7',
    'https://github.com/login?return_to=/acme/site/pull/7',
    'https://github.com/acme/site/pull/7#frag',
    'https://github.com/acme/pull/7',
    'https://github.com/acme/site/pull/7/files',
    'nope',
  ])
    assert.equal(pull(url).pr, null, url)
  // A pull request needs a pushed branch. Held: on the machine, pushed nowhere; never both.
  assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: 'fix' }, pr: { url: 'https://github.com/a/b/pull/1' } }).pr, null)
  assert.equal(cleanSummary({ kind: 'remote-branch', branch: { name: 'fix', held: true } }).branch.held, true)
  assert.equal(pull('https://github.com/acme/site/pull/7', { held: true }).branch.held, false)
  // On the machine: only a link on the host of the GitHub it is set up for.
  assert.equal(pullLink('https://github.com/acme/site/pull/7', {}), 'https://github.com/acme/site/pull/7')
  assert.equal(
    pullLink('https://git.example.com/acme/site/pull/7', { apiUrl: 'https://git.example.com/api/v3' }),
    'https://git.example.com/acme/site/pull/7',
  )
  for (const url of [
    'https://example.com/acme/site/pull/7',
    'https://github.com.example.com/acme/site/pull/7',
    'https://github.com/acme/site/pull/7?x=1',
    'x',
  ])
    assert.equal(pullLink(url, {}), null, url)
})

test('comment text on its way into a commit subject or a pull request title does nothing there', () => {
  const line = inertLine('Fixes #12 and closes acme/site#3, thanks @octocat\u0000 see https://example.com/x\nsecond line', 200)
  assert.doesNotMatch(line, /#\d/, 'no issue is linked or closed')
  assert.doesNotMatch(line, /@octocat/, 'nobody is pinged')
  assert.doesNotMatch(line, /https:\/\//)
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(line, /[\u0000-\u001f]/)
  assert.doesNotMatch(line, /second line/)
  assert.match(
    line.replace(/\u200b/g, ''),
    /^Fixes #12 and closes acme\/site#3, thanks @octocat see https:\/\/example\.com\/x$/,
    'still readable',
  )
  assert.equal(inertLine('\u0000\n\n  '), '')
  assert.equal(inertLine('x'.repeat(200)).length, 72)
})

test('a session that takes edits: the agent’s own settings left out, only reading and editing tools, never the shell; no token in its environment', () => {
  const tools = (session) => session._meta.claudeCode.options
  const edits = tools(remoteEditSession('claude', { commands: [] }))
  assert.deepEqual(edits.settingSources, [])
  assert.equal(edits.strictMcpConfig, true)
  assert.equal(edits.allowDangerouslySkipPermissions, false)
  assert.deepEqual(edits.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit'])
  for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit', 'Skill'])
    assert.ok(edits.disallowedTools.includes(tool), tool)
  // Claude Code never gets its shell tool, whatever commands a machine lists: with it, it runs
  // commands it takes to be read-only without asking (seen with the real adapter).
  const withCommands = tools(remoteEditSession('claude', { commands: ['npm test'] }))
  assert.ok(!withCommands.tools.includes('Bash'))
  assert.ok(withCommands.disallowedTools.includes('Bash'))
  // So `agent connect` refuses to list a command for it, and says why.
  assert.throws(
    () => policyChanges({ 'allow-command': 'npm test' }, { ...DEFAULT_MACHINE_POLICY, approvals: 'owner' }, 'claude'),
    /Commands cannot be allowed for Claude Code in this release/,
  )
  assert.deepEqual(policyChanges({ 'allow-command': 'none' }, { ...DEFAULT_MACHINE_POLICY, approvals: 'owner' }, 'claude'), {
    commands: [],
  })
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
