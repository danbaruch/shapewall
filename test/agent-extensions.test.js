// Extensions on trusted turns (1.4.0 Q5): the thread trust table
// (src/agent/thread-trust.js), the agent config folder's checks and reader
// (src/agent/agent-config-folder.js), the resolver's extension rules
// (src/agent/capabilities.js) and the three renderers of its line
// (src/agent/capability-render.js), the ACP session options
// (src/agent/backends/acp.js withExtensions) and a local board's threads
// (src/agent/threads.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AUTHORS_MAX,
  applyThreadTrust,
  nextThreadTrust,
  readThreadTrust,
  taintingToolName,
  threadStateOf,
} from '../src/agent/thread-trust.js'
import {
  ExtensionsFolderError,
  buildExtensionPlugin,
  checkExtensionsFolder,
  extensionNames,
  extensionServers,
  extensionSession,
  policyExtensions,
  readExtensions,
  serverOfTool,
  turnExtensions,
} from '../src/agent/agent-config-folder.js'
import { resolveCapabilities, resolveCeiling } from '../src/agent/capabilities.js'
import { capabilitySummary, extensionsText, lineStates, toCli, toPanel, toPrompt } from '../src/agent/capability-render.js'
import { localRestrictedSession, readOnlySession, toolNameOf, withExtensions } from '../src/agent/backends/acp.js'
import { localAgentOf, localTrust } from '../src/agent/local-tools.js'
import { localCard } from '../src/agent/capability-views.js'
import { extensionLines } from '../src/remote/agent-connect.js'
import { appendUserMessage, localTextEvent, markThreadTainted, readThread, setThreadProfile } from '../src/agent/threads.js'
import { validateUserEntry } from '../src/agent/user-settings.js'
import { SAMPLE, sampleConfig, tempDir } from './helpers.js'

// A folder of this user's that nobody else may change (tempDir is in the repo, not /tmp).
function privateDir(name) {
  const dir = tempDir(name)
  fs.chmodSync(dir, 0o700)
  return dir
}
// An agent config folder with two skills and two servers, and things that are never loaded.
function agentFolder(name = 'ext-folder') {
  const dir = privateDir(name)
  fs.mkdirSync(path.join(dir, 'skills', 'notes', 'ref'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Take notes\n---\nBody\n')
  fs.writeFileSync(path.join(dir, 'skills', 'notes', 'ref', 'more.md'), 'More\n')
  fs.mkdirSync(path.join(dir, 'skills', 'release'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'release', 'SKILL.md'), '---\ndescription: Ship it\n---\n')
  fs.mkdirSync(path.join(dir, 'skills', 'Bad Name'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'skills', 'Bad Name', 'SKILL.md'), 'x')
  fs.mkdirSync(path.join(dir, 'skills', 'empty'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: {} }))
  fs.mkdirSync(path.join(dir, 'hooks'))
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        brain: { command: '/usr/bin/brain-mcp', args: ['--stdio'], env: { BRAIN_HOME: '/srv/brain', SHAPEWALL_TOKEN: 'x' } },
        brain_extra: { type: 'stdio', command: 'node', args: ['x.js'] },
        remote: { type: 'http', url: 'https://example.com/mcp' },
        shapewall: { command: 'evil' },
        shapewall_exec: { command: 'evil' },
      },
      projects: { '/somewhere': { mcpServers: { local: { command: 'x' } } } },
    }),
  )
  return dir
}

// ---- Thread trust ----

test('thread trust: every row of the transition table, and the guard fails closed', () => {
  const clean = readThreadTrust(null)
  assert.deepEqual(clean, { tainted: false, authors: [] })
  assert.equal(threadStateOf(clean, 'owner'), 'clean')
  // clean + person by the owner -> clean
  const owner = nextThreadTrust(clean, { kind: 'person', id: 'owner' })
  assert.equal(threadStateOf(owner, 'owner'), 'clean')
  // clean + person by a member -> shared; shared + known author -> shared
  const shared = nextThreadTrust(owner, { kind: 'person', id: 'usr_cyd' })
  assert.equal(threadStateOf(shared, 'owner'), 'shared')
  assert.deepEqual(nextThreadTrust(shared, { kind: 'person', id: 'usr_cyd' }), shared)
  assert.deepEqual(nextThreadTrust(shared, { kind: 'person', id: 'owner' }), shared)
  // any + the thread's own agent -> same
  assert.deepEqual(nextThreadTrust(shared, { kind: 'agent', own: true }), shared)
  assert.deepEqual(nextThreadTrust(clean, { kind: 'agent', own: true }), clean)
  // clean, shared + each taint -> tainted, and tainted stays tainted
  for (const from of [clean, shared])
    for (const event of [
      { kind: 'outside' },
      { kind: 'agent', own: false },
      { kind: 'agent' },
      { kind: 'moved' },
      { kind: 'tool' },
      { kind: 'legacy' },
      { kind: 'person' },
      { kind: 'person', id: 'has space' },
      { kind: 'nobody knows this' },
      null,
      'tool',
    ]) {
      const next = nextThreadTrust(from, event)
      assert.equal(next.tainted, true, JSON.stringify(event))
      for (const later of [
        { kind: 'person', id: 'owner' },
        { kind: 'agent', own: true },
      ])
        assert.equal(nextThreadTrust(next, later).tainted, true, 'never cleared')
    }
  // More than AUTHORS_MAX people -> tainted.
  let many = clean
  for (let index = 0; index < AUTHORS_MAX; index += 1) many = nextThreadTrust(many, { kind: 'person', id: `usr_${index}` })
  assert.equal(many.tainted, false)
  assert.equal(nextThreadTrust(many, { kind: 'person', id: 'usr_one_more' }).tainted, true)
  // A stored value nobody can read is tainted.
  for (const raw of ['x', [], { tainted: 'no' }, { authors: 'a' }, { authors: [1] }, { authors: Array(AUTHORS_MAX + 1).fill('a') }])
    assert.equal(readThreadTrust(raw).tainted, true, JSON.stringify(raw))
  assert.equal(applyThreadTrust(null, [{ kind: 'person', id: 'owner' }, { kind: 'tool' }]).tainted, true)
})

test("board tools that return other people's text taint; the others do not", () => {
  for (const name of ['list_comments', 'get_comment', 'mcp__shapewall__list_comments', 'mcp__shapewall__get_comment'])
    assert.equal(taintingToolName(name), true, name)
  for (const name of ['reply_to_comment', 'mcp__shapewall__list_pages', 'mcp__brain__list_comments', 'Read', null, 3])
    assert.equal(taintingToolName(name), false, String(name))
  assert.equal(toolNameOf({ _meta: { claudeCode: { toolName: 'mcp__a__b' } }, title: 'x' }), 'mcp__a__b')
  assert.equal(toolNameOf({ title: ' mcp__a__b ' }), 'mcp__a__b')
  assert.equal(toolNameOf(null), '')
})

// ---- The folder ----

test("the agent config folder is refused where its files could be anyone else's, or the project's, or Claude Code's own", () => {
  const home = privateDir('ext-home')
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') }
  const ok = agentFolder('ext-ok')
  assert.equal(checkExtensionsFolder(ok, { env }), fs.realpathSync(ok))
  const refused = (dir, pattern, options = {}) =>
    assert.throws(
      () => checkExtensionsFolder(dir, { env, ...options }),
      (error) => error instanceof ExtensionsFolderError && pattern.test(error.message),
      String(dir),
    )
  refused('relative/dir', /not an absolute path/)
  refused(path.join(ok, 'missing'), /is not there/)
  refused(path.join(ok, 'settings.json'), /is not a folder/)
  if (process.platform !== 'win32') {
    const open = privateDir('ext-open')
    fs.chmodSync(open, 0o770)
    refused(open, /changed by other users/)
  }
  // ~/.claude, $CLAUDE_CONFIG_DIR, in them or holding them.
  fs.mkdirSync(path.join(home, '.claude', 'agents', 'x'), { recursive: true, mode: 0o700 })
  refused(path.join(home, '.claude'), /Claude Code's own folder/)
  refused(path.join(home, '.claude', 'agents', 'x'), /Claude Code's own folder/)
  const custom = privateDir('ext-claude-config')
  refused(custom, /Claude Code's own folder/, { env: { ...env, CLAUDE_CONFIG_DIR: custom } })
  // The home folder itself, a temporary folder, Shapewall's state folder.
  refused(home, /home folder|Claude Code/)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ext-'))
  fs.chmodSync(tmp, 0o700)
  refused(tmp, /temporary folder/)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(path.join(home, 'state', 'shapewall', 'x'), { recursive: true, mode: 0o700 })
  refused(path.join(home, 'state', 'shapewall', 'x'), /Shapewall's own state folder/)
  // In the project, or holding it, or its output folder.
  const project = privateDir('ext-project')
  fs.mkdirSync(path.join(project, '.agent'), { mode: 0o700 })
  refused(path.join(project, '.agent'), /in the project/, { projectDir: project })
  refused(ok, /in the project/, { projectDir: path.join(ok, 'skills') })
  refused(ok, /in the project/, { outputDir: path.join(ok, 'skills', 'notes') })
  // policyExtensions never throws: the reason, and no extensions.
  const bad = policyExtensions(path.join(ok, 'missing'), { env })
  assert.equal(bad.found, null)
  assert.match(bad.error, /is not there/)
  for (const none of [null, 'none', 'relative', 7])
    assert.deepEqual(policyExtensions(none, { env }), { found: null, names: null, error: null })
})

test('the folder gives skills and stdio servers only, and says what it skipped', () => {
  const dir = agentFolder('ext-read')
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.join(dir, 'skills', 'linked'))
    fs.symlinkSync(path.join(dir, 'settings.json'), path.join(dir, 'skills', 'linked', 'SKILL.md'))
  }
  const found = readExtensions(checkExtensionsFolder(dir, { env: { HOME: privateDir('ext-read-home') } }))
  assert.deepEqual(
    found.skills.map((skill) => [skill.name, skill.description]),
    [
      ['notes', 'Take notes'],
      ['release', 'Ship it'],
    ],
  )
  assert.deepEqual(found.skills[0].files.map((file) => file.rel).sort(), ['SKILL.md', path.join('ref', 'more.md')].sort())
  assert.deepEqual(
    found.servers.map((server) => server.name),
    ['brain', 'brain_extra'],
  )
  assert.deepEqual(found.servers[0].env, { BRAIN_HOME: '/srv/brain' }, 'no SHAPEWALL_ variable')
  const skipped = found.skipped.map((item) => item.what)
  for (const what of [
    'settings.json',
    'hooks',
    'skills/Bad Name',
    'skills/empty',
    'server remote',
    'server shapewall',
    'server shapewall_exec',
    'server brain: env SHAPEWALL_TOKEN',
    '.claude.json projects',
  ])
    assert.ok(skipped.includes(what), `${what} in ${skipped.join(', ')}`)
  if (process.platform !== 'win32') assert.ok(skipped.includes('skills/linked'), 'a linked SKILL.md is not read')
  assert.deepEqual(extensionNames(found), { skills: ['notes', 'release'], servers: ['brain', 'brain_extra'] })
  // The ACP entries: exactly the entry's env, plus PATH and HOME.
  const entries = extensionServers(found, { env: { PATH: '/bin', HOME: '/home/x', SECRET: 'no' } })
  assert.deepEqual(entries[0], {
    name: 'brain',
    command: '/usr/bin/brain-mcp',
    args: ['--stdio'],
    env: [
      { name: 'BRAIN_HOME', value: '/srv/brain' },
      { name: 'PATH', value: '/bin' },
      { name: 'HOME', value: '/home/x' },
    ],
  })
})

test("the skills plugin is Shapewall's own copy: plain files, private, rebuilt from scratch", () => {
  const dir = agentFolder('ext-plugin')
  const state = privateDir('ext-plugin-state')
  const env = { HOME: privateDir('ext-plugin-home'), XDG_STATE_HOME: state }
  const found = readExtensions(checkExtensionsFolder(dir, { env }))
  const plugin = buildExtensionPlugin(found, 'key-1', { env })
  assert.ok(plugin.startsWith(path.join(state, 'shapewall', 'agent-ext')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'shapewall-extensions')
  assert.equal(fs.readFileSync(path.join(plugin, 'skills', 'notes', 'ref', 'more.md'), 'utf8'), 'More\n')
  assert.ok(!fs.lstatSync(path.join(plugin, 'skills', 'notes', 'SKILL.md')).isSymbolicLink())
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(plugin, 'skills', 'notes', 'SKILL.md')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(plugin)).mode & 0o777, 0o700)
  }
  // A file left there is gone on the next build; a skill removed from the folder too.
  fs.writeFileSync(path.join(plugin, 'skills', 'notes', 'planted.md'), 'x')
  fs.rmSync(path.join(dir, 'skills', 'release'), { recursive: true })
  const again = buildExtensionPlugin(readExtensions(dir), 'key-1', { env })
  assert.equal(again, plugin)
  assert.ok(!fs.existsSync(path.join(plugin, 'skills', 'notes', 'planted.md')))
  assert.ok(!fs.existsSync(path.join(plugin, 'skills', 'release')))
  assert.equal(buildExtensionPlugin({ skills: [], servers: [] }, 'key-2', { env }), null)
  // The session: tools allowed by exact name, of the folder's servers only; the longest server name wins.
  const session = extensionSession(readExtensions(dir), plugin, ['mcp__brain__search', 'mcp__other__x', 'mcp__brain_extra__go'], { env })
  assert.deepEqual(session.allow, ['mcp__brain__search', 'mcp__brain_extra__go'])
  assert.deepEqual(session.skills, ['notes'])
  assert.equal(serverOfTool('mcp__brain_extra__go', ['brain', 'brain_extra']), 'brain_extra')
  assert.equal(serverOfTool('mcp__brain__', ['brain']), null)
  assert.equal(serverOfTool('Read', ['brain']), null)
  // turnExtensions: only when the turn's capabilities turned them on.
  assert.equal(turnExtensions({ extensions: { on: false } }, readExtensions(dir), 'k', { env }), null)
  assert.ok(turnExtensions({ extensions: { on: true, tools: [] } }, readExtensions(dir), 'k', { env }).plugin)
})

// ---- The resolver and its renderers ----

const MACHINE = {
  audience: 'owner',
  approvals: 'owner',
  instructions: 'all',
  agentConfig: '/home/ada/agent-config/builder',
  commands: [],
  shell: 'off',
  browser: 'off',
  trustTeam: ['cyd'],
  extensionsFor: ['owner', 'cyd'],
  allowTool: ['mcp__brain__search', 'mcp__nothere__x'],
}
const FOLDER = { skills: ['notes'], servers: ['brain'] }
const OWNER = { handle: 'ada', owner: true, member: true }
const CYD = { handle: 'cyd', owner: false, member: true }
const DEE = { handle: 'dee', owner: false, member: true }
const resolve = (where, trust, { machine = MACHINE, extensions = FOLDER } = {}) =>
  resolveCapabilities({ path: where, trust, audience: 'server', machine, server: null, config: null, platform: null, extensions })
const why = (caps) => caps.why.find((item) => item.line === 'extensions')?.code || null

test('extensions: on for a trusted turn on a clean thread, off for a tainted one, a guest, an open turn and every reason in order', () => {
  const clean = { authors: [OWNER], guests: false, thread: { tainted: false, authors: [OWNER] } }
  const on = resolve('hosted-chat', clean)
  assert.equal(on.tier, 'solo')
  assert.deepEqual(on.extensions, { on: true, tools: ['mcp__brain__search'], skills: ['notes'], servers: ['brain'] })
  for (const where of ['local-chat', 'hosted-fix', 'pickup']) assert.equal(resolve(where, clean).extensions.on, true, where)
  // Team: every author of the turn and of the thread in the extension set.
  const team = { authors: [CYD], guests: false, thread: { tainted: false, authors: [OWNER, CYD] } }
  assert.equal(resolve('hosted-chat', team).tier, 'team')
  assert.equal(resolve('hosted-chat', team).extensions.on, true)
  const cases = [
    ['a tainted thread', { ...clean, thread: { tainted: true, authors: [OWNER] } }, {}, 'thread_tainted'],
    ['no thread state', { authors: [OWNER], guests: false }, {}, 'thread_tainted'],
    ['a malformed thread state', { authors: [OWNER], guests: false, thread: { tainted: 'no' } }, {}, 'thread_tainted'],
    [
      'a thread someone outside the set wrote in',
      { ...clean, thread: { tainted: false, authors: [OWNER, DEE] } },
      {},
      'extensions_not_for_thread',
    ],
    ['a guest', { ...clean, guests: true }, {}, 'open_tier_extensions'],
    ['no trust block', null, {}, 'open_tier_extensions'],
    ['an open turn (someone the machine does not trust)', { ...clean, authors: [DEE] }, {}, 'open_tier_extensions'],
    ['the default folder', clean, { machine: { ...MACHINE, agentConfig: null } }, 'no_agent_config'],
    ['"none"', clean, { machine: { ...MACHINE, agentConfig: 'none' } }, 'no_agent_config'],
    ['an empty folder', clean, { extensions: { skills: [], servers: [] } }, 'no_extensions_found'],
    ['a folder not read', clean, { extensions: null }, 'no_extensions_found'],
    ['not for the owner', clean, { machine: { ...MACHINE, extensionsFor: [] } }, 'extensions_not_for_owner'],
    ['a team turn outside the set', { ...team }, { machine: { ...MACHINE, extensionsFor: ['owner'] } }, 'extensions_not_for_team'],
  ]
  for (const [label, trust, options, code] of cases) {
    const caps = resolve('hosted-chat', trust, options)
    assert.equal(caps.extensions.on, false, label)
    assert.equal(why(caps), code, label)
  }
  // No path that is not an ACP agent's.
  assert.equal(why(resolve('local-endpoint', clean)), 'path_no_extensions')
  assert.equal(why(resolve('watch-exec', clean)), 'path_no_extensions')
  // The local trust block: only the owner's text, or tainted.
  assert.equal(localTrust({ owner: true, thread: { tainted: false, authors: ['owner'] } }).thread.authors[0].owner, true)
  assert.equal(localTrust({ owner: true }).thread.tainted, true, 'no state: tainted')
  assert.equal(localTrust({ owner: true, thread: { tainted: true, authors: [] } }).thread.tainted, true)
})

test('the Extensions line reads the same on the card, in agent status and in the prompt block, and in the hello summary', () => {
  for (const [label, extensions, machine] of [
    ['on', FOLDER, MACHINE],
    ['on, no tool allowed', FOLDER, { ...MACHINE, allowTool: [] }],
    ['empty folder', { skills: [], servers: [] }, MACHINE],
    ['off for the owner', FOLDER, { ...MACHINE, extensionsFor: [] }],
    ['no folder', null, { ...MACHINE, agentConfig: null }],
  ]) {
    for (const tier of ['solo', 'team', 'open']) {
      const caps = resolveCeiling(tier, { path: 'hosted-chat', machine, trust: { authors: [{ owner: true }], guests: false }, extensions })
      const panel = toPanel(caps).lines.find((line) => line.id === 'extensions')
      const cli = toCli(caps).join('\n')
      const prompt = toPrompt(caps)
      const state = lineStates(caps).extensions
      assert.equal(panel.state, state, `${label} ${tier} panel`)
      assert.ok(cli.includes(panel.text), `${label} ${tier} cli says the panel's words`)
      assert.ok(prompt.includes(panel.text) || state === 'off', `${label} ${tier} prompt`)
      if (state === 'on') {
        assert.match(panel.text, /skills notes; MCP servers brain/)
        assert.match(prompt, /you can:\n[\s\S]*skills notes[\s\S]*\nYou cannot:/)
      }
      assert.equal(
        capabilitySummary({ machine, extensions }).chat[tier]?.extensions ?? 'off',
        tier === 'team' && !machine.trustTeam ? 'off' : state,
      )
    }
  }
  assert.match(
    extensionsText({ on: true, skills: ['a'], servers: ['b'], tools: [] }),
    /None of their tools is allowed yet \(shapewall agent set allow-tool mcp__SERVER__TOOL\)/,
  )
  assert.match(
    extensionsText({ on: true, skills: [], servers: ['b'], tools: ['mcp__b__c'] }),
    /mcp__b__c; every other tool of those servers is refused/,
  )
})

// ---- The ACP session ----

test("a session with extensions gets the skills plugin, the Skill tool and nothing else of Claude Code's own config", () => {
  const ext = { plugin: '/state/plugin', skills: ['notes'], servers: [], serverNames: ['brain'], allow: [], key: 'k' }
  for (const base of [readOnlySession('claude'), localRestrictedSession('claude', { exec: true })]) {
    const session = withExtensions(base, ext)
    const options = session._meta.claudeCode.options
    assert.ok(options.tools.includes('Skill'))
    assert.ok(!(options.disallowedTools || []).includes('Skill'))
    assert.deepEqual(options.plugins, [{ type: 'local', path: '/state/plugin' }])
    assert.deepEqual(options.skills, ['notes'])
    assert.deepEqual(options.settingSources, [], 'still no settings files')
    assert.equal(options.strictMcpConfig, true, 'still only the servers Shapewall gives')
    assert.ok(!(options.allowedTools || []).some((tool) => tool.startsWith('mcp__brain')), 'never allowed without asking')
    assert.deepEqual(withExtensions(base, null), base)
  }
  // Servers only: the plugin options stay out.
  const serversOnly = withExtensions(readOnlySession('claude'), { ...ext, plugin: null, skills: [] })
  assert.ok(!('plugins' in serversOnly._meta.claudeCode.options))
  // An agent whose session takes no Claude Code options gets nothing.
  assert.deepEqual(withExtensions({}, ext), {})
})

// ---- A local board's threads ----

test("a local thread keeps its trust: the owner's text keeps it clean; anyone else's, a move or a tool result taints it for good", async () => {
  const config = sampleConfig('ext-threads')
  const board = 'sample'
  const chat = 'chat-aaaaaaaaaaaaaaaa'
  const write = (threadId, viewer, extra = {}) =>
    appendUserMessage(config, board, threadId, { text: 'hi', attachments: [] }, { viewer, ...extra })
  assert.deepEqual(readThread(config, board, chat).trust, { tainted: false, authors: [] })
  await write(chat, 'owner')
  assert.deepEqual(readThread(config, board, chat).trust, { tainted: false, authors: ['owner'] })
  assert.deepEqual(localTextEvent('owner'), { kind: 'person', id: 'owner' })
  assert.deepEqual(localTextEvent('share:abc'), { kind: 'outside' })
  // A comment mention that is not the owner's own: tainted.
  await write(chat, 'owner', { trustEvents: [localTextEvent('owner'), { kind: 'outside' }] })
  assert.equal(readThread(config, board, chat).trust.tainted, true)
  // A visitor's words.
  await write('board', 'visitor:1')
  assert.equal(readThread(config, board, 'board').trust.tainted, true)
  // A move to another profile once it has messages.
  const other = 'chat-bbbbbbbbbbbbbbbb'
  await write(other, 'owner')
  await setThreadProfile(config, board, other, 'default')
  assert.equal(readThread(config, board, other).trust.tainted, false, 'the same profile is no move')
  await setThreadProfile(config, board, other, 'second')
  assert.equal(readThread(config, board, other).trust.tainted, true)
  // A tool result mid-turn.
  const third = 'chat-cccccccccccccccc'
  await write(third, 'owner')
  await markThreadTainted(config, board, third)
  assert.equal(readThread(config, board, third).trust.tainted, true)
  await write(third, 'owner')
  assert.equal(readThread(config, board, third).trust.tainted, true, 'never cleared')
})

test('the local agent config folder is a setting of the machine only: an absolute path or none', () => {
  assert.equal(validateUserEntry({ agentConfig: '/home/me/agent-config' }).entry.agentConfig, '/home/me/agent-config')
  assert.deepEqual(validateUserEntry({ agentConfig: 'none' }).problems, [])
  for (const bad of ['relative', '/a\nb', 7, '/' + 'a'.repeat(1001)])
    assert.match(validateUserEntry({ agentConfig: bad }).problems.join(' '), /agentConfig/, String(bad))
})

test('agent set agent-config checks the folder first; agent status and agent connect then name what it holds', async () => {
  const { agentSet, agentStatusData } = await import('../src/cli/agent-status.js')
  const { extensionLines } = await import('../src/remote/agent-connect.js')
  const config = sampleConfig('ext-set')
  fs.writeFileSync(path.join(config.dir, 'shapewall.config.json'), JSON.stringify(SAMPLE))
  const home = privateDir('ext-set-home')
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state') }
  const said = []
  const out = (line) => said.push(line)
  await assert.rejects(
    agentSet(['set', 'agent-config', path.join(config.dir, 'inside')], {}, out, out, { env, cwd: config.dir }),
    /is not there|in the project/,
  )
  fs.mkdirSync(path.join(config.dir, 'agent'), { mode: 0o700 })
  await assert.rejects(
    agentSet(['set', 'agent-config', path.join(config.dir, 'agent')], {}, out, out, { env, cwd: config.dir }),
    /in the project/,
  )
  const folder = agentFolder('ext-set-folder')
  assert.equal(await agentSet(['set', 'agent-config', folder], {}, out, out, { env, cwd: config.dir }), 0)
  // No agent set up that takes extensions: off, as every turn would have them.
  const none = await agentStatusData({}, { env, cwd: config.dir })
  assert.equal(none.tiers.solo.lines.find((item) => item.id === 'extensions').state, 'off')
  env.SHAPEWALL_AGENT_ACP = 'npx @agentclientprotocol/claude-agent-acp'
  const status = await agentStatusData({}, { env, cwd: config.dir })
  const line = status.tiers.solo.lines.find((item) => item.id === 'extensions')
  assert.equal(line.state, 'on')
  assert.match(line.text, /skills notes, release; MCP servers brain, brain_extra/)
  assert.equal(status.tiers.open.lines.find((item) => item.id === 'extensions').state, 'off')
  assert.equal(await agentSet(['set', 'agent-config', 'none'], {}, out, out, { env, cwd: config.dir }), 0)
  assert.equal((await agentStatusData({}, { env, cwd: config.dir })).tiers.solo.lines.find((item) => item.id === 'extensions').state, 'off')
  // What agent connect prints.
  const read = policyExtensions(folder, { env })
  const lines = extensionLines(read, { extensionsFor: ['owner'], allowTool: ['mcp__brain__search'] })
  assert.match(lines[0], /skills notes, release; MCP servers brain, brain_extra/)
  assert.ok(lines.includes('Tools it may call: mcp__brain__search. Every other tool of those servers is refused.'))
  assert.ok(lines.some((text) => /^Not loaded: settings\.json/.test(text)))
  assert.ok(extensionLines(read, {}).some((text) => /allow-tool/.test(text)))
  assert.match(
    extensionLines({ found: null, names: null, error: 'The agent config folder /x is not there.' }, {})[0],
    /^Extensions: none\. /,
  )
  assert.deepEqual(extensionLines({ found: null, names: null, error: null }, {}), [])
})

// Review of PR #41, F5: the folders above the agent config folder, every
// folder a skill is read from, and the path a file is copied from.
test(
  'F5: a folder above, a skill folder others may change, or a folder swapped for a link since the check is refused',
  { skip: process.platform === 'win32' },
  () => {
    const env = { HOME: privateDir('ext-f5-home'), XDG_STATE_HOME: privateDir('ext-f5-state') }
    // A parent anyone may change (no sticky bit): they could swap the folder out.
    const open = tempDir('ext-f5-open')
    fs.chmodSync(open, 0o777)
    const inOpen = path.join(open, 'agent')
    fs.mkdirSync(inOpen, { mode: 0o700 })
    assert.throws(() => checkExtensionsFolder(inOpen, { env }), /any user of this machine can change/)
    // The same parent with the sticky bit: nobody may rename what is not theirs.
    fs.chmodSync(open, 0o1777)
    assert.equal(checkExtensionsFolder(inOpen, { env }), fs.realpathSync(inOpen))

    // A skill folder (or a folder in one) others may change is not read.
    const dir = agentFolder('ext-f5-skills')
    fs.chmodSync(path.join(dir, 'skills', 'release'), 0o777)
    fs.chmodSync(path.join(dir, 'skills', 'notes', 'ref'), 0o777)
    const found = readExtensions(checkExtensionsFolder(dir, { env }))
    assert.deepEqual(
      found.skills.map((skill) => skill.name),
      ['notes'],
    )
    assert.ok(!found.skills[0].files.some((file) => file.rel.startsWith('ref')))
    assert.ok(found.skipped.some((item) => item.what === 'skill release: .' && /other users/.test(item.why)))
    assert.ok(found.skipped.some((item) => item.what === 'skill notes: ref'))

    // A folder on the way swapped for a link between the check and the copy.
    const swap = agentFolder('ext-f5-swap')
    const before = readExtensions(checkExtensionsFolder(swap, { env }))
    const outside = privateDir('ext-f5-outside')
    fs.writeFileSync(path.join(outside, 'more.md'), 'OUTSIDE\n')
    fs.renameSync(path.join(swap, 'skills', 'notes', 'ref'), path.join(swap, 'skills', 'notes', 'ref-was'))
    fs.symlinkSync(outside, path.join(swap, 'skills', 'notes', 'ref'))
    const plugin = buildExtensionPlugin(before, 'key-f5', { env })
    assert.ok(!fs.existsSync(path.join(plugin, 'skills', 'notes', 'ref', 'more.md')), 'nothing from outside the folder is copied')
    assert.ok(fs.existsSync(path.join(plugin, 'skills', 'notes', 'SKILL.md')))
  },
)

// F6: the agent's kind and its session are the resolver's to say, so the
// card, `agent status` and the prompt never say on where the session drops them.
test('F6: an agent that is not Claude Code, or one in its own full session, has extensions off in the resolver and every renderer', () => {
  const clean = { authors: [OWNER], guests: false, thread: { tainted: false, authors: [OWNER] } }
  const at = (agent, extra = {}) =>
    resolveCapabilities({ path: 'local-chat', trust: clean, audience: 'owner', machine: MACHINE, extensions: FOLDER, agent, ...extra })
  assert.equal(at({ kind: 'claude', hardened: true }).extensions.on, true)
  assert.equal(why(at({ kind: 'codex', hardened: true })), 'agent_not_claude')
  assert.equal(why(at({ kind: null, hardened: true })), 'agent_not_claude')
  assert.equal(why(at({ kind: 'claude', hardened: false })), 'session_unrestricted')
  assert.equal(why(at({ kind: 'claude', hardened: true }, { extensionsFailed: true })), 'extensions_build_failed')
  for (const agent of [
    { kind: 'codex', hardened: true },
    { kind: 'claude', hardened: false },
  ]) {
    const caps = at(agent)
    const cardLine = localCard({ machine: MACHINE, extensions: FOLDER, agent })
      .paths[0].tiers.find((tier) => tier.tier === 'solo')
      .lines.find((line) => line.id === 'extensions')
    assert.equal(cardLine.state, 'off', JSON.stringify(agent))
    assert.equal(lineStates(caps).extensions, 'off')
    assert.match(toPrompt(caps), /Extensions: No extensions\./)
    assert.ok(toCli(caps).join('\n').includes(cardLine.text))
    assert.equal(capabilitySummary({ machine: MACHINE, extensions: FOLDER, agent }).chat.solo.extensions, 'off')
  }
  // What a local board runs, as routes.js and the card read it.
  assert.deepEqual(localAgentOf({ agent: {} }, { backend: 'acp', acp: { argv: ['/x/codex-acp'] } }), { kind: 'codex', hardened: true })
  assert.deepEqual(localAgentOf({ agent: { localSession: 'own' } }, { backend: 'acp', acp: { argv: ['/x/claude-agent-acp'] } }), {
    kind: 'claude',
    hardened: false,
  })
  assert.equal(localAgentOf({}, { backend: 'openai' }).kind, null)
  // agent connect says so for an agent that is not Claude Code.
  const found = { found: { dir: '/home/ada/agent-config', skipped: [] }, names: FOLDER, error: null }
  assert.match(extensionLines(found, MACHINE, 'codex')[0], /Extensions: off\. Only Claude Code/)
  assert.match(extensionLines(found, MACHINE, 'claude')[0], /^Extensions from/)
})
