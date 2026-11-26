import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CAPABILITY_DEFAULTS,
  CAPABILITY_KEYS,
  CAPABILITY_NARROWEST,
  PATHS,
  TIERS,
  cleanBrowserProfile,
  cleanCapabilityKeys,
  cleanNarrowing,
  cleanOrigin,
  cleanTrust,
  combineNarrowing,
  configOrigins,
  machineView,
  namedCommands,
  resolveCapabilities,
  tierOf,
  tierRank,
  validateCommands,
} from '../src/agent/capabilities.js'
import {
  LINE_IDS,
  LINE_LABELS,
  capabilitySummary,
  cleanCapabilitySummary,
  lineStates,
  lines,
  toCli,
  toPanel,
  toPrompt,
} from '../src/agent/capability-render.js'
import {
  DEFAULT_MACHINE_POLICY,
  cleanMachinePolicy,
  fileVersion,
  policyFile,
  readMachinePolicy,
  saveMachinePolicy,
  upgradeV1Entry,
} from '../src/remote/agent-policy-file.js'
import { localMachinePolicy, validateUserEntry } from '../src/agent/user-settings.js'
import { cleanPolicy } from '../src/hosted/agent-policy.js'
import { cleanHello } from '../src/hosted/agent-link.js'
import { cleanJob } from '../src/remote/agent-job.js'
import { loadConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

// ---- Fixtures ----

const COMMANDS_CONFIG = {
  test: { run: 'npm test', argv: ['npm', 'test'], inputs: null, mutating: true, args: false, ready: null },
  lint: { run: 'npm run lint', argv: ['npm', 'run', 'lint'], inputs: null, mutating: false, args: false, ready: null },
}
const CONFIG = {
  baseUrl: 'http://127.0.0.1:5173/app',
  boards: [{ baseUrl: 'http://127.0.0.1:5173/app', publicUrl: 'https://staging.example.com/x', environments: [] }],
  commands: COMMANDS_CONFIG,
}
// A connected machine that takes edits, with one exact command and a team.
const MACHINE = cleanMachinePolicy({ approvals: 'owner', commands: ['npm test'], trustTeam: ['robin'] })
const TRUST = {
  solo: { authors: [{ handle: 'dan', owner: true, member: true }], guests: false },
  team: { authors: [{ handle: 'robin', owner: false, member: true }], guests: false },
  open: { authors: [{ handle: 'eve', owner: false, member: true }], guests: false },
}
const PLATFORMS = {
  'linux sandbox': { os: 'linux', sandbox: true },
  'linux no sandbox': { os: 'linux', sandbox: false },
  'macOS sandbox': { os: 'darwin', sandbox: true },
  windows: { os: 'win32', sandbox: true },
  unknown: { os: 'aix', sandbox: true },
  missing: undefined,
}
const sandboxed = (platform) => ['linux', 'darwin'].includes(platform?.os) && platform.sandbox === true

const resolve = (tier, where, platform, extra = {}) =>
  resolveCapabilities({ path: where, trust: TRUST[tier], audience: 'owner', machine: MACHINE, config: CONFIG, platform, ...extra })

// What a resolved object grants, in a few words a table can hold.
function shapeOf(caps) {
  const free = caps.commands.filter((item) => !item.needsCard).map((item) => item.name)
  const asked = caps.commands.filter((item) => item.needsCard).map((item) => item.name)
  return {
    shell: caps.shell.mode,
    commands: free.length ? `run ${free.join(',')}` : asked.length ? `card ${asked.join(',')}` : 'none',
    browser: caps.browser.on,
    edit: caps.edit.on ? caps.edit.where : 'off',
    push: caps.push.on,
    extensions: caps.extensions.on,
  }
}

// The expected grant per path, tier and whether an OS sandbox is there.
// Spelled out, not computed: this is the plan's table (section 3.2 and 3.3).
function expected(where, tier, box) {
  if (where === 'hosted-chat') {
    return {
      shell: 'off',
      commands: tier === 'solo' ? (box ? 'run lint' : 'card lint') : 'none',
      browser: tier === 'solo',
      edit: 'off',
      push: false,
      extensions: tier === 'solo',
    }
  }
  if (where === 'starter') {
    return {
      shell: 'container',
      commands: tier === 'open' ? 'card test,lint' : 'run test,lint',
      browser: true,
      edit: 'container',
      push: true,
      extensions: false,
    }
  }
  // Fix with, comment pickup, the local chat and watch --exec.
  const full = tier === 'solo' && box
  return {
    shell: full ? 'sandboxed' : 'exact',
    commands: tier !== 'open' && box ? 'run test,lint' : 'card test,lint',
    browser: true,
    edit: 'copy',
    push: true,
    extensions: tier === 'solo' && where !== 'watch-exec',
  }
}

test('capabilities: every tier x path x platform resolves to the table, fail closed where it must', () => {
  let rows = 0
  for (const where of PATHS) {
    for (const tier of TIERS) {
      for (const [name, platform] of Object.entries(PLATFORMS)) {
        const caps = resolve(tier, where, platform)
        assert.equal(caps.tier, tier, `${where} ${tier} ${name}: tier`)
        assert.deepEqual(shapeOf(caps), expected(where, tier, sandboxed(platform)), `${where} ${tier} ${name}`)
        // Always, everywhere.
        assert.equal(caps.browser.realChrome, false)
        assert.equal(caps.selfEdit, false)
        assert.equal(caps.memory.auto, false)
        assert.equal(caps.enforced, where !== 'watch-exec')
        assert.ok(Object.isFrozen(caps) && Object.isFrozen(caps.commands) && Object.isFrozen(caps.browser.allow))
        // A full shell only ever with a sandbox, solo, and the owner's choice.
        if (caps.shell.mode === 'sandboxed') assert.ok(tier === 'solo' && sandboxed(platform))
        // An open turn never runs a command without a card, and never gets extensions or a login.
        if (tier === 'open') {
          assert.ok(caps.commands.every((item) => item.needsCard))
          assert.equal(caps.extensions.on, false)
          assert.equal(caps.browser.auth, null)
          assert.equal(caps.browser.profile, null)
        }
        rows += 1
      }
    }
  }
  assert.equal(rows, PATHS.length * TIERS.length * Object.keys(PLATFORMS).length)
})

test('capabilities: an unknown path, a missing machine and junk inputs read as the narrowest', () => {
  for (const where of ['nope', '', undefined, 7, 'HOSTED-FIX']) {
    const caps = resolveCapabilities({ path: where, trust: TRUST.solo, audience: 'owner', machine: MACHINE, config: CONFIG })
    assert.equal(caps.tier, 'open')
    assert.equal(caps.path, null)
    assert.equal(caps.enforced, false)
    for (const line of lines(caps)) assert.equal(line.state, 'off', `${String(where)} ${line.id}`)
  }
  // No machine policy at all: no instructions, no edits, no shell, no browser, no extensions.
  for (const machine of [undefined, null, 'admins', [], 7]) {
    const caps = resolveCapabilities({ path: 'hosted-fix', trust: TRUST.solo, audience: 'owner', machine, config: CONFIG })
    const states = lineStates(caps)
    for (const id of ['instructions', 'edits', 'commands', 'shell', 'browser', 'extensions', 'push'])
      assert.equal(states[id], 'off', `${JSON.stringify(machine)} ${id}`)
  }
  assert.deepEqual(
    Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, machineView({})[key]])),
    Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, CAPABILITY_NARROWEST[key]])),
  )
  // A sandbox counts only where Shapewall knows how to use one.
  for (const platform of [{ os: 'win32', sandbox: true }, { os: 'linux', sandbox: 'yes' }, { os: 'linux' }, { sandbox: true }, null]) {
    const caps = resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST.solo,
      audience: 'owner',
      machine: MACHINE,
      config: CONFIG,
      platform,
    })
    assert.notEqual(caps.shell.mode, 'sandboxed', JSON.stringify(platform))
    assert.ok(caps.commands.every((item) => item.needsCard))
  }
  // --shell-unsandboxed: solo only.
  const loud = cleanMachinePolicy({ approvals: 'owner', shellUnsandboxed: true, trustTeam: ['robin'], trustTeamShell: true })
  const at = (tier) =>
    resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST[tier],
      audience: 'owner',
      machine: loud,
      config: CONFIG,
      platform: PLATFORMS.windows,
    })
  assert.equal(at('solo').shell.mode, 'unsandboxed')
  assert.equal(at('team').shell.mode, 'off')
  assert.equal(at('open').shell.mode, 'off')
  assert.ok(toCli(at('solo')).some((line) => line.includes('WITHOUT an OS sandbox')))
})

test('capabilities: the tier needs a clean trust block, the owner audience, and the machine’s own team list', () => {
  const view = machineView(MACHINE)
  // Missing or malformed: open.
  for (const trust of [
    undefined,
    null,
    'solo',
    [],
    {},
    { authors: [] },
    { authors: 'dan' },
    { authors: [null] },
    { authors: [{ owner: true }] }, // guests not said to be false
    { authors: [{ owner: true }], guests: true },
    { authors: [{ owner: 'true' }], guests: false },
    { authors: [{ owner: 1 }], guests: false },
    { authors: Array.from({ length: 201 }, () => ({ owner: true })), guests: false },
  ])
    assert.equal(tierOf({ trust, audience: 'owner', machine: view }).tier, 'open', JSON.stringify(trust)?.slice(0, 80))
  assert.equal(cleanTrust({ authors: [{ owner: true }], guests: false }).guests, false)
  // Solo needs an owner-only agent: from the server's audience or the machine's own rule.
  assert.equal(tierOf({ trust: TRUST.solo, audience: 'owner', machine: { ...view, audience: 'server' } }).tier, 'solo')
  assert.equal(tierOf({ trust: TRUST.solo, audience: 'members', machine: { ...view, audience: 'owner' } }).tier, 'solo')
  const shared = tierOf({ trust: TRUST.solo, audience: 'members', machine: { ...view, audience: 'server', trustTeam: 'none' } })
  assert.deepEqual(shared, { tier: 'open', why: 'audience_not_owner' })
  // The owner on an agent others can use is in the team tier when the machine has a team.
  assert.equal(tierOf({ trust: TRUST.solo, audience: 'members', machine: { ...view, audience: 'server' } }).tier, 'team')
  // Team: every author on the machine's list (the owner always is).
  const mixed = { authors: [...TRUST.solo.authors, ...TRUST.team.authors], guests: false }
  assert.equal(tierOf({ trust: mixed, audience: 'owner', machine: view }).tier, 'team')
  const outsider = { authors: [...TRUST.team.authors, ...TRUST.open.authors], guests: false }
  assert.deepEqual(tierOf({ trust: outsider, audience: 'owner', machine: view }), { tier: 'open', why: 'outside_authors' })
  // A handle the block does not give is not on any list.
  assert.equal(tierOf({ trust: { authors: [{ handle: '../robin' }], guests: false }, machine: view }).tier, 'open')
  // "members": every author a member.
  const members = { ...view, trustTeam: 'members' }
  assert.equal(tierOf({ trust: TRUST.open, audience: 'owner', machine: members }).tier, 'team')
  assert.equal(tierOf({ trust: { authors: [{ handle: 'x', member: 'yes' }], guests: false }, machine: members }).tier, 'open')
  // No team on the machine: never team, whatever the server says.
  assert.equal(tierOf({ trust: TRUST.team, audience: 'owner', machine: { ...view, trustTeam: 'none' } }).tier, 'open')
  // Taint keeps a thread at the tier its outside text allowed; a taint it does not know is open.
  assert.deepEqual(tierOf({ trust: { ...TRUST.solo, taint: 'team' }, audience: 'owner', machine: view }), {
    tier: 'team',
    why: 'thread_taint',
  })
  assert.equal(tierOf({ trust: { ...TRUST.solo, taint: 'SOLO' }, audience: 'owner', machine: view }).tier, 'open')
  assert.equal(tierOf({ trust: { ...TRUST.team, taint: 'solo' }, audience: 'owner', machine: view }).tier, 'team')
  // The server's maxTier only lowers.
  assert.deepEqual(tierOf({ trust: TRUST.solo, audience: 'owner', machine: view, server: { maxTier: 'team' } }), {
    tier: 'team',
    why: 'server_max_tier',
  })
  assert.equal(tierOf({ trust: TRUST.open, audience: 'owner', machine: view, server: { maxTier: 'solo' } }).tier, 'open')
})

// ---- The property: nothing the server sends raises a capability ----

function rng(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}
const JUNK = [
  undefined,
  null,
  true,
  false,
  0,
  1,
  -1,
  2.5,
  '',
  'solo',
  'team',
  'open',
  'on',
  'true',
  'admin',
  [],
  ['solo'],
  {},
  { solo: true },
  NaN,
]
const pick = (random, list) => list[Math.floor(random() * list.length)]
function junkNarrowing(random) {
  const roll = random()
  if (roll < 0.15) return pick(random, JUNK)
  const out = {}
  for (const key of ['maxTier', 'shell', 'browser', 'tier', 'commands', 'sandbox', 'allow', 'extensions', 'push']) {
    if (random() < 0.5) out[key] = pick(random, JUNK)
  }
  return out
}
function randomMachine(random) {
  const entry = {}
  const choices = {
    audience: ['owner', 'server', 'x'],
    approvals: ['none', 'owner', 'admins', 'all'],
    commands: [[], ['npm test'], ['npm test', 'make'], 'npm test'],
    remote: ['origin', null, ''],
    instructions: ['all', 'project', 'none', 'x'],
    agentConfig: [null, 'none', '/srv/agent'],
    trustTeam: ['none', 'members', ['robin'], ['robin', 'eve'], 'all', []],
    trustTeamShell: [true, false, 'yes'],
    shell: ['sandboxed', 'commands', 'off', 'full'],
    shellNetwork: ['registries', 'open', 'none', 'all'],
    shellUnsandboxed: [true, false, 1],
    commandApproval: ['tier', 'always', 'never'],
    browser: ['on', 'off', true],
    browserAllow: [[], ['https://a.example'], ['https://a.example/path'], 'x'],
    browserAuth: [null, 'staging', '../x'],
    browserProfile: [null, '/srv/profile', '/home/x/.config/google-chrome/Default'],
    browserProfileTeam: [true, false],
    extensionsFor: [['owner'], [], ['owner', 'robin'], ['robin'], 'owner'],
    allowTool: [[], ['mcp__notes__memory_write'], ['mcp__notes__search'], ['Bash']],
    handoffHops: [0, 1, 2, 3, -1],
  }
  for (const [key, values] of Object.entries(choices)) if (random() < 0.7) entry[key] = pick(random, values)
  return cleanMachinePolicy(entry)
}
function randomTrust(random) {
  const authors = []
  const count = 1 + Math.floor(random() * 3)
  for (let index = 0; index < count; index += 1) {
    const kind = random()
    authors.push(
      kind < 0.5
        ? { handle: 'dan', owner: true, member: true }
        : kind < 0.75
          ? { handle: 'robin', owner: false, member: true }
          : { handle: 'eve', owner: false, member: random() < 0.5 },
    )
  }
  const trust = { authors, guests: random() < 0.1 }
  if (random() < 0.2) trust.taint = pick(random, ['team', 'open', 'solo', 'x'])
  return trust
}
function randomConfig(random) {
  const config = { baseUrl: 'http://127.0.0.1:5173' }
  if (random() < 0.7) config.commands = random() < 0.5 ? COMMANDS_CONFIG : { lint: COMMANDS_CONFIG.lint }
  if (random() < 0.3) config.starterAgent = { testCommand: ['node', '--test'] }
  if (random() < 0.4) config.agent = { browser: { allow: ['https://staging.example.com'] }, fixIn: pick(random, ['copy', 'checkout']) }
  return config
}
const randomPlatform = (random) => pick(random, Object.values(PLATFORMS))

const STATE_RANK = { off: 0, ask: 1, on: 2 }
const NETWORK_RANK = { none: 0, egress: 1, registries: 1, open: 2 }
const subset = (small, big) => small.every((item) => big.includes(item))
// `a` grants nothing `b` does not.
function assertAtMost(a, b, label) {
  assert.ok(tierRank(a.tier) <= tierRank(b.tier), `${label}: tier ${a.tier} > ${b.tier}`)
  const sa = lineStates(a)
  const sb = lineStates(b)
  for (const id of LINE_IDS) assert.ok(STATE_RANK[sa[id]] <= STATE_RANK[sb[id]], `${label}: ${id} ${sa[id]} > ${sb[id]}`)
  assert.ok(
    subset(
      a.commands.map((item) => item.name),
      b.commands.map((item) => item.name),
    ),
    `${label}: commands`,
  )
  const freeA = a.commands.filter((item) => !item.needsCard).map((item) => item.name)
  const freeB = b.commands.filter((item) => !item.needsCard).map((item) => item.name)
  assert.ok(subset(freeA, freeB), `${label}: commands without a card`)
  // A full shell covers any exact command; below one, the exact list only shrinks.
  if (['off', 'exact'].includes(b.shell.mode)) assert.ok(subset(a.shell.exact, b.shell.exact), `${label}: exact commands`)
  if (a.shell.mode !== 'off') assert.ok(NETWORK_RANK[a.shell.network] <= NETWORK_RANK[b.shell.network], `${label}: network`)
  if (a.shell.mode === 'unsandboxed') assert.equal(b.shell.mode, 'unsandboxed', `${label}: unsandboxed`)
  assert.ok(subset(a.browser.allow, b.browser.allow), `${label}: browser allow`)
  for (const key of ['auth', 'profile']) assert.ok(a.browser[key] === null || a.browser[key] === b.browser[key], `${label}: ${key}`)
  assert.ok(subset(a.extensions.tools, b.extensions.tools), `${label}: tools`)
  assert.ok(subset(a.memory.write, b.memory.write), `${label}: memory`)
  assert.ok(a.handoff.hops <= b.handoff.hops, `${label}: hops`)
  // A fix copy is narrower than this checkout; nothing else changes where edits land.
  if (a.edit.on)
    assert.ok(a.edit.where === b.edit.where || (a.edit.where === 'copy' && b.edit.where === 'checkout'), `${label}: edit where`)
  assert.ok(!a.edit.on || b.edit.on, `${label}: edits`)
  assert.ok(!a.push.on || b.push.on, `${label}: push`)
}

test('capabilities property: no server input raises any capability (2000 random turns)', () => {
  const random = rng(0x5eed)
  for (let run = 0; run < 2000; run += 1) {
    const inputs = {
      path: pick(random, PATHS),
      trust: randomTrust(random),
      audience: pick(random, ['owner', 'members', 'trusted', undefined]),
      machine: randomMachine(random),
      config: randomConfig(random),
      platform: randomPlatform(random),
    }
    const baseline = resolveCapabilities(inputs)
    const server = junkNarrowing(random)
    const narrowed = resolveCapabilities({ ...inputs, server })
    assertAtMost(narrowed, baseline, `run ${run} server ${JSON.stringify(server)}`)
    // And a narrower tier grants no more than a wider one, on the same machine.
    const lower = resolveCapabilities({ ...inputs, server: { maxTier: TIERS[Math.max(0, tierRank(baseline.tier) - 1)] } })
    assertAtMost(lower, baseline, `run ${run} one tier lower`)
  }
})

test('capabilities property: junk trust never reaches solo or team; junk machine keys never exceed the defaults', () => {
  const random = rng(42)
  for (let run = 0; run < 1000; run += 1) {
    const trust = random() < 0.5 ? pick(random, JUNK) : { authors: pick(random, JUNK), guests: pick(random, JUNK) }
    const caps = resolveCapabilities({
      path: pick(random, PATHS),
      trust,
      audience: 'owner',
      machine: randomMachine(random),
      config: randomConfig(random),
      platform: randomPlatform(random),
    })
    assert.equal(caps.tier, 'open', JSON.stringify(trust))
  }
  // A capability key with a value this version does not know reads as the narrowest for that key,
  // and a machine made of such keys never does more than one with the defaults.
  for (let run = 0; run < 300; run += 1) {
    const entry = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, pick(random, JUNK)]))
    const warned = new Set()
    const cleaned = cleanCapabilityKeys(entry, { warn: (key) => warned.add(key) })
    for (const key of warned) assert.deepEqual(cleaned[key], CAPABILITY_NARROWEST[key], `${key}: ${JSON.stringify(entry[key])}`)
    // trustTeam stays the team's: a junk one is "none", which only takes the team tier away.
    const unknown = Object.fromEntries([...warned].filter((key) => key !== 'trustTeam').map((key) => [key, entry[key]]))
    const machine = cleanMachinePolicy({ approvals: 'owner', trustTeam: ['robin'], ...unknown })
    const defaults = cleanMachinePolicy({ approvals: 'owner', trustTeam: ['robin'] })
    for (const where of PATHS)
      for (const tier of TIERS) {
        const common = { path: where, trust: TRUST[tier], audience: 'owner', config: CONFIG, platform: PLATFORMS['linux sandbox'] }
        const junk = resolveCapabilities({ ...common, machine })
        const known = resolveCapabilities({ ...common, machine: defaults })
        assertAtMost(junk, known, `junk ${JSON.stringify(unknown)} ${where} ${tier}`)
      }
  }
})

test('capability keys: a value it does not know reads as the narrowest, by name', () => {
  const warned = []
  const cleaned = cleanCapabilityKeys(
    {
      trustTeam: ['ok', 'Not A Handle!'],
      trustTeamShell: 'yes',
      shell: 'full',
      shellNetwork: 'internet',
      shellUnsandboxed: 1,
      commandApproval: 'never',
      browser: true,
      browserAllow: ['https://a.example', 'https://b.example/path'],
      browserAuth: '../../etc/passwd',
      browserProfile: '/home/x/.config/google-chrome/Default',
      browserProfileTeam: 'on',
      extensionsFor: 'owner',
      allowTool: ['Bash'],
      handoffHops: 3,
    },
    { warn: (key) => warned.push(key) },
  )
  assert.deepEqual(cleaned, { ...CAPABILITY_NARROWEST, browserAllow: [], extensionsFor: [], allowTool: [] })
  assert.deepEqual(warned.sort(), [...CAPABILITY_KEYS].sort())
  // Missing keys read as the defaults; good values stay.
  assert.deepEqual(cleanCapabilityKeys({}), { ...CAPABILITY_DEFAULTS, browserAllow: [], extensionsFor: ['owner'], allowTool: [] })
  const good = cleanCapabilityKeys({
    trustTeam: ['@Robin', 'robin', 'eve'],
    browserAllow: ['https://staging.example.com/', 'http://127.0.0.1:5173'],
    browserAuth: 'staging',
    browserProfile: '/srv/agent-profile/../agent-profile',
    allowTool: ['mcp__notes__memory_write'],
    handoffHops: 2,
  })
  assert.deepEqual(good.trustTeam, ['robin', 'eve'])
  assert.deepEqual(good.browserAllow, ['https://staging.example.com', 'http://127.0.0.1:5173'])
  assert.equal(good.browserProfile, '/srv/agent-profile')
  // Never a real browser's own profile folder, or one inside it.
  for (const dir of [
    '/home/x/.config/google-chrome',
    '/home/x/.config/chromium/Profile 1',
    '/Users/x/Library/Application Support/Google/Chrome/Default',
    '/Users/x/Library/Application Support/BraveSoftware/Brave-Browser',
    '/home/x/.config/microsoft-edge',
    'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data',
    'relative/profile',
  ])
    assert.equal(cleanBrowserProfile(dir), null, dir)
  for (const origin of ['https://a.example/x', 'ftp://a.example', 'https://u:p@a.example', 'javascript:alert(1)', 'a.example'])
    assert.equal(cleanOrigin(origin), null, origin)
})

// ---- The three renderers ----

function cliStates(caps) {
  const out = {}
  const byLabel = Object.fromEntries(Object.entries(LINE_LABELS).map(([id, label]) => [label, id]))
  for (const line of toCli(caps)) {
    const match = /^ {2}(on|ask|off) *([^:]+): /.exec(line)
    if (match) out[byLabel[match[2]]] = match[1]
  }
  return out
}
function promptStates(caps) {
  const out = {}
  const byLabel = Object.fromEntries(Object.entries(LINE_LABELS).map(([id, label]) => [label, id]))
  let state = null
  for (const line of toPrompt(caps).split('\n')) {
    if (/^On this board .* you can:$/.test(line)) state = 'on'
    else if (line.startsWith('Only after a person answers a card')) state = 'ask'
    else if (line === 'You cannot:') state = 'off'
    else if (line.startsWith('To change this')) state = null
    else if (state && line.startsWith('- ')) out[byLabel[line.slice(2, line.indexOf(':'))]] = state
  }
  return out
}

test('capability renderers: the panel, agent status and the prompt agree on 100 random fixtures', () => {
  const random = rng(7)
  for (let run = 0; run < 100; run += 1) {
    const caps = resolveCapabilities({
      path: pick(random, [...PATHS, 'nope']),
      trust: random() < 0.8 ? randomTrust(random) : null,
      audience: pick(random, ['owner', 'members']),
      machine: randomMachine(random),
      server: random() < 0.3 ? junkNarrowing(random) : null,
      config: randomConfig(random),
      platform: randomPlatform(random),
    })
    const panel = Object.fromEntries(toPanel(caps, { as: 'builder' }).lines.map((line) => [line.id, line.state]))
    assert.deepEqual(Object.keys(panel), LINE_IDS)
    assert.deepEqual(cliStates(caps), panel, `run ${run}: cli`)
    assert.deepEqual(promptStates(caps), panel, `run ${run}: prompt`)
    // Every off line says why; every copyable command is the machine's own, never for a server-held line.
    for (const line of toPanel(caps, { as: 'builder' }).lines) {
      if (line.state === 'off') assert.ok(line.why.length > 0, `run ${run}: ${line.id} off without a reason`)
      if (line.fix) {
        assert.match(line.fix, /^shapewall agent set [a-z-]+ \S+ --as builder$/)
        assert.equal(line.narrowed, false)
      }
    }
  }
})

test('capability renderers: a narrowed line says it is the project’s setting, with no machine command', () => {
  const caps = resolve('solo', 'hosted-fix', PLATFORMS['linux sandbox'], { server: { shell: false, browser: false, maxTier: 'team' } })
  assert.equal(caps.tier, 'team')
  const panel = toPanel(caps, { as: 'builder' })
  for (const id of ['who', 'commands', 'shell', 'browser']) {
    const line = panel.lines.find((item) => item.id === id)
    assert.equal(line.narrowed, true, id)
    assert.equal(line.fix, null, id)
  }
  assert.match(toPrompt(caps), /only on the server, by an admin/)
  assert.ok(toCli(caps).some((line) => line.includes("limited by this project's setting")))
  // The prompt tells the agent what it can and cannot do, in that order.
  const text = toPrompt(resolve('solo', 'hosted-fix', PLATFORMS['linux sandbox']))
  assert.ok(text.indexOf('you can:') < text.indexOf('You cannot:'))
  assert.match(text, /Shell: A full shell in the fix copy, inside an OS sandbox/)
  assert.match(text, /Your own Chrome: Never/)
})

test('capability summary: the ceiling per tier for hello, and what the server keeps of it', () => {
  const summary = capabilitySummary({ machine: MACHINE, config: CONFIG, platform: PLATFORMS['linux sandbox'] })
  assert.equal(summary.team, 'named')
  assert.equal(summary.fix.solo.shell, 'on')
  assert.equal(summary.fix.open.shell, 'ask')
  assert.equal(summary.chat.solo.edits, 'off')
  assert.equal(summary.chat.open.browser, 'off')
  // No commands, handles or paths go to the server.
  assert.doesNotMatch(JSON.stringify(summary), /npm|robin|127\.0\.0\.1|staging/)
  assert.deepEqual(cleanCapabilitySummary(summary), summary)
  assert.equal(capabilitySummary({ machine: cleanMachinePolicy({}) }).fix.team, null)
  // The server keeps known lines and states only; anything else is off; its own Chrome is always off.
  const kept = cleanCapabilitySummary({
    v: 1,
    team: 'everyone',
    fix: { solo: { shell: 'root', browser: 'on', chrome: 'on', extra: 'on' }, team: { shell: 'on' } },
    chat: 'x',
  })
  assert.equal(kept.team, 'none')
  assert.equal(kept.fix.solo.shell, 'off')
  assert.equal(kept.fix.solo.browser, 'on')
  assert.equal(kept.fix.solo.chrome, 'off')
  assert.equal(kept.fix.solo.extra, undefined)
  assert.equal(kept.fix.team, null)
  assert.deepEqual(
    Object.values(kept.chat.solo),
    LINE_IDS.map(() => 'off'),
  )
  for (const raw of [null, 'x', [], { v: 2 }]) assert.equal(cleanCapabilitySummary(raw), null)
  // In hello: cleaned on the way in.
  const hello = cleanHello({ kind: 'claude', capabilitySummary: { ...summary, fix: { ...summary.fix, solo: { shell: 'sudo' } } } })
  assert.equal(hello.capabilities.summary.fix.solo.shell, 'off')
  assert.equal(cleanHello({ kind: 'claude' }).capabilities.summary, null)
})

// ---- Server narrowing ----

test('server narrowing: the project setting validates, a board cannot lift the project, junk reads narrowest', () => {
  assert.deepEqual(
    ['maxTier', 'shell', 'browser'].map((key) => cleanPolicy({})[key]),
    ['solo', true, true],
  )
  assert.equal(cleanPolicy({ maxTier: 'team', shell: false }).maxTier, 'team')
  for (const bad of [{ maxTier: 'root' }, { maxTier: 1 }, { shell: 'no' }, { browser: 0 }])
    assert.throws(() => cleanPolicy(bad), /invalid_policy|maxTier|Invalid/, JSON.stringify(bad))
  assert.equal(cleanPolicy({ boards: { main: { maxTier: 'open' } } }).boards.main.maxTier, 'open')
  // The narrower of the project and a board.
  assert.deepEqual(combineNarrowing({ maxTier: 'open', shell: true, browser: true }, { maxTier: 'solo', shell: false, browser: true }), {
    maxTier: 'open',
    shell: false,
    browser: true,
  })
  assert.equal(combineNarrowing(null, undefined), null)
  // On the machine: absent is no narrowing; present and unclear is the narrowest.
  assert.equal(cleanNarrowing(undefined), null)
  assert.equal(cleanNarrowing(null), null)
  assert.deepEqual(cleanNarrowing({}), { maxTier: 'solo', shell: true, browser: true })
  for (const raw of ['x', 7, [], true])
    assert.deepEqual(cleanNarrowing(raw), { maxTier: 'open', shell: false, browser: false }, JSON.stringify(raw))
  assert.deepEqual(cleanNarrowing({ maxTier: 'god', shell: 'yes', browser: 1 }), { maxTier: 'open', shell: false, browser: false })
  // The job carries it, cleaned.
  const job = (narrowing) =>
    cleanJob({
      turn: { id: `turn_${'a'.repeat(24)}`, board: 'main', thread: 'board', kind: 'chat' },
      messages: [{ id: 'm1', role: 'user', text: 'hi' }],
      ...(narrowing === undefined ? {} : { narrowing }),
    })
  assert.equal(job(undefined).narrowing, null)
  assert.deepEqual(job({ maxTier: 'open', shell: false, browser: true }).narrowing, { maxTier: 'open', shell: false, browser: true })
  assert.deepEqual(job('everything').narrowing, { maxTier: 'open', shell: false, browser: false })
})

// ---- Policy file version 2 ----

test('agent-policy.json: version 1 entries read as exactly what they allowed, and the next save writes every entry as version 2', () => {
  const env = { XDG_CONFIG_HOME: tempDir('capabilities-policy-v1') }
  const file = policyFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const origin = 'https://wall.example.com'
  const v1 = {
    version: 1,
    connections: {
      [`${origin}#builder`]: { approvals: 'owner', commands: ['npm test'], remote: 'origin' },
      [`${origin}#reader`]: { audience: 'owner' },
      [`${origin}#broken`]: 'admins',
      // A v1 file someone already wrote a v2 key into: their key stands.
      [`${origin}#early`]: { approvals: 'owner', browser: 'on' },
    },
  }
  fs.writeFileSync(file, JSON.stringify(v1), { mode: 0o600 })
  assert.equal(fileVersion(v1), 1)
  const read = (slug) => readMachinePolicy(origin, slug, env)
  const builder = read('builder')
  assert.deepEqual(
    [builder.shell, builder.commandApproval, builder.browser, builder.extensionsFor, builder.trustTeam],
    ['commands', 'always', 'off', [], 'none'],
  )
  const reader = read('reader')
  assert.deepEqual([reader.shell, reader.browser, reader.approvals], ['off', 'off', 'none'])
  assert.equal(read('broken').shell, 'off')
  assert.equal(read('early').browser, 'on')
  // A connection the file never had: the version 2 defaults.
  assert.equal(read('new').shell, 'sandboxed')

  // What a version 1 builder may do, resolved: a card for every command, no full shell, no browser.
  const caps = resolveCapabilities({
    path: 'hosted-fix',
    trust: TRUST.solo,
    audience: 'owner',
    machine: builder,
    config: CONFIG,
    platform: PLATFORMS['linux sandbox'],
  })
  assert.equal(caps.shell.mode, 'exact')
  assert.ok(caps.commands.length && caps.commands.every((item) => item.needsCard))
  assert.equal(caps.browser.on, false)
  assert.equal(caps.extensions.on, false)
  const reading = resolveCapabilities({ path: 'hosted-chat', trust: TRUST.solo, audience: 'owner', machine: reader, config: CONFIG })
  for (const id of ['edits', 'commands', 'shell', 'browser']) assert.equal(lineStates(reading)[id], 'off', id)

  // A save: the file becomes version 2, and the entries nobody touched read the same as before.
  const before = Object.fromEntries(['reader', 'broken', 'early'].map((slug) => [slug, read(slug)]))
  saveMachinePolicy(origin, 'builder', { base: 'main' }, env)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(data.version, 2)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  for (const slug of Object.keys(before)) assert.deepEqual(read(slug), before[slug], slug)
  assert.equal(data.connections[`${origin}#reader`].shell, 'off')
  assert.deepEqual([read('builder').base, read('builder').shell], ['main', 'commands'])
  // Version 2 now: a connection it never had still gets the defaults; a later save changes nothing else.
  saveMachinePolicy(origin, 'new', { approvals: 'owner' }, env)
  assert.equal(read('new').shell, 'sandboxed')
  assert.equal(read('reader').shell, 'off')
  // An unknown version reads as 1 unless it is a whole number of 2 or more.
  for (const version of [undefined, 'two', 1.5, 0, null]) assert.equal(fileVersion({ version }), 1, String(version))
  assert.equal(fileVersion({ version: 3 }), 2)
  assert.equal(upgradeV1Entry('x'), 'x')
})

test('agent-policy.json: the new keys go through the same narrow reading as the old ones', () => {
  const warned = []
  const policy = cleanMachinePolicy({ approvals: 'owner', shell: 'root', browserAllow: 'everything' }, (text) => warned.push(text))
  assert.equal(policy.shell, 'off')
  assert.deepEqual(policy.browserAllow, [])
  assert.match(warned.join('\n'), /"shell" has a value this version does not know: read as "off"/)
  assert.match(warned.join('\n'), /"browserAllow" has a value this version does not know/)
  assert.doesNotMatch(warned.join('\n'), /is not a setting this version knows/)
  for (const key of CAPABILITY_KEYS) assert.ok(Object.hasOwn(DEFAULT_MACHINE_POLICY, key), key)
  assert.equal(cleanMachinePolicy('nonsense').shell, 'off')
  assert.equal(cleanMachinePolicy('nonsense').browser, 'off')
})

// ---- Local boards: agents.json ----

test('agents.json: a project entry takes the same capability keys; a typo is a problem, a bad value the narrowest', () => {
  const ok = validateUserEntry({ capabilities: { shell: 'commands', browser: 'off', trustTeam: 'not a list' } })
  assert.deepEqual(ok.problems, [])
  assert.deepEqual(ok.entry.capabilities, { shell: 'commands', browser: 'off', trustTeam: 'none' })
  const typo = validateUserEntry({ capabilities: { shel: 'off' } })
  assert.equal(typo.entry, null)
  assert.match(typo.problems.join('\n'), /capabilities\.shel: not a capability setting/)
  assert.match(validateUserEntry({ capabilities: 'off' }).problems.join('\n'), /capabilities: an object/)
  const local = localMachinePolicy(ok.entry)
  assert.deepEqual([local.audience, local.approvals, local.shell, local.browser], ['owner', 'owner', 'commands', 'off'])
  assert.equal(localMachinePolicy(null).shell, 'sandboxed')
  // A local owner's turn is solo; the config may keep its fixes in the checkout there only.
  const caps = (fixIn, tier) =>
    resolveCapabilities({
      path: 'local-chat',
      trust: TRUST[tier],
      audience: 'owner',
      machine: { ...localMachinePolicy(null), trustTeam: ['robin'] },
      config: { ...CONFIG, agent: { fixIn } },
      platform: PLATFORMS['linux sandbox'],
    })
  assert.equal(caps('checkout', 'solo').edit.where, 'checkout')
  assert.equal(caps('checkout', 'team').edit.where, 'copy')
  assert.equal(caps('copy', 'solo').edit.where, 'copy')
  const hosted = resolve('solo', 'hosted-fix', PLATFORMS['linux sandbox'], { config: { ...CONFIG, agent: { fixIn: 'checkout' } } })
  assert.equal(hosted.edit.where, 'copy')
})

// ---- Config: commands, agent.browser.allow, agent.fixIn ----

test('config commands: names, a string shorthand, $PORT only, inputs and ready checked', () => {
  const problems = []
  const commands = validateCommands(
    {
      test: 'npm test',
      build: { run: 'npm run build' },
      dev: { run: 'npm run dev -- --port $PORT', ready: 'http://127.0.0.1:$PORT' },
      lint: { run: 'npm run lint', mutating: false, inputs: ['package.json', 'eslint.config.js', 'src/**'] },
      e2e: { run: 'node --test "test/e2e/a b.test.js"', args: true },
    },
    problems,
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(commands.test, { run: 'npm test', argv: ['npm', 'test'], inputs: null, mutating: true, args: false, ready: null })
  assert.deepEqual(commands.dev.argv, ['npm', 'run', 'dev', '--', '--port', '$PORT'])
  assert.equal(commands.lint.mutating, false)
  assert.deepEqual(commands.e2e.argv, ['node', '--test', 'test/e2e/a b.test.js'])
  for (const [raw, pattern] of [
    [[], /commands: an object/],
    [{ Test: 'npm test' }, /commands\.Test: a name of lowercase/],
    [{ test: 7 }, /commands\.test: a command line/],
    [{ test: { run: '' } }, /commands\.test\.run: one command line/],
    [{ test: 'npm test | tee out' }, /"\|" is not allowed/],
    [{ test: 'echo $HOME' }, /"\$" is not allowed/],
    [{ test: 'echo "$HOME"' }, /no \$ other than \$PORT/],
    [{ test: 'npm test\nrm -rf /' }, /commands\.test: a command line|one command line/],
    [{ test: { run: 'npm test', mutatinng: false } }, /commands\.test\.mutatinng: not a command setting/],
    [{ test: { run: 'npm test', inputs: ['../secrets'] } }, /commands\.test\.inputs/],
    [{ test: { run: 'npm test', inputs: ['/etc/passwd'] } }, /commands\.test\.inputs/],
    [{ test: { run: 'npm test', mutating: 'no' } }, /commands\.test\.mutating: true or false/],
    [{ dev: { run: 'npm run dev', ready: 'https://example.com:$PORT' } }, /commands\.dev\.ready: a loopback URL/],
    [Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`c${index}`, 'true'])), /at most 20/],
  ]) {
    const found = []
    validateCommands(raw, found)
    assert.match(found.join('\n'), pattern, JSON.stringify(raw).slice(0, 80))
  }
  // commands.test wins over the starter agent's testCommand, which stands in for it otherwise.
  assert.deepEqual(
    namedCommands({ commands: { test: commands.test }, starterAgent: { testCommand: ['node', '--test'] } }).map((item) => item.run),
    ['npm test'],
  )
  assert.deepEqual(namedCommands({ starterAgent: { testCommand: ['node', '--test'] } }), [
    {
      name: 'test',
      run: 'node --test',
      argv: ['node', '--test'],
      inputs: null,
      mutating: true,
      args: false,
      ready: null,
      source: 'starterAgent.testCommand',
    },
  ])
  assert.deepEqual(namedCommands(null), [])
})

test('config: commands, agent.browser.allow and agent.fixIn load, and the browser allowlist is the app’s own addresses plus them', () => {
  const dir = tempDir('capabilities-config')
  const write = (extra) => {
    const file = path.join(dir, 'shapewall.config.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        environments: [
          { id: 'local', baseUrl: 'http://127.0.0.1:5173/app' },
          { id: 'staging', baseUrl: 'https://staging.example.com/app', publicUrl: 'https://www.example.com/' },
        ],
        pages: [{ id: 'home', path: '/' }],
        ...extra,
      }),
    )
    return () => loadConfig(file)
  }
  const config = write({
    commands: { test: 'npm test', lint: { run: 'npm run lint', mutating: false } },
    agent: { browser: { allow: ['https://cdn.example.com'] }, fixIn: 'checkout' },
  })()
  assert.deepEqual(Object.keys(config.commands), ['test', 'lint'])
  assert.deepEqual(config.agent.browser.allow, ['https://cdn.example.com'])
  assert.equal(config.agent.fixIn, 'checkout')
  assert.deepEqual(configOrigins(config).sort(), ['http://127.0.0.1:5173', 'https://staging.example.com', 'https://www.example.com'])
  const caps = resolveCapabilities({
    path: 'hosted-fix',
    trust: TRUST.solo,
    audience: 'owner',
    machine: cleanMachinePolicy({ approvals: 'owner', browserAllow: ['https://api.example.com'] }),
    config,
    platform: PLATFORMS['linux sandbox'],
  })
  assert.deepEqual([...caps.browser.allow].sort(), [
    'http://127.0.0.1:5173',
    'https://api.example.com',
    'https://cdn.example.com',
    'https://staging.example.com',
    'https://www.example.com',
  ])
  // With a login for the browser, the config adds nothing.
  const loggedIn = resolveCapabilities({
    path: 'hosted-fix',
    trust: TRUST.solo,
    audience: 'owner',
    machine: cleanMachinePolicy({ approvals: 'owner', browserAuth: 'staging' }),
    config,
    platform: PLATFORMS['linux sandbox'],
  })
  assert.equal(loggedIn.browser.auth, 'staging')
  assert.ok(!loggedIn.browser.allow.includes('https://cdn.example.com'))
  // ...and below the tier the login is for, it starts without one.
  const team = resolveCapabilities({
    path: 'hosted-fix',
    trust: TRUST.team,
    audience: 'owner',
    machine: cleanMachinePolicy({ approvals: 'owner', browserAuth: 'staging', trustTeam: ['robin'] }),
    config,
  })
  assert.equal(team.browser.auth, null)
  assert.ok(team.why.some((item) => item.code === 'login_not_this_tier'))
  for (const [extra, pattern] of [
    [{ commands: { test: 'npm test; rm -rf /' } }, /";" is not allowed/],
    [{ agent: { browser: { allow: ['https://x.example/path'] } } }, /agent\.browser\.allow/],
    [{ agent: { browser: { deny: [] } } }, /agent\.browser: \{ "allow"/],
    [{ agent: { fixIn: 'home' } }, /agent\.fixIn/],
  ])
    assert.throws(write(extra), pattern, JSON.stringify(extra))
  // Not an unknown key any more.
  assert.deepEqual(write({ commands: { test: 'npm test' } })().warnings, [])
})
