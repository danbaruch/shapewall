import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BROWSER_PROFILE_MARKER,
  CAPABILITY_DEFAULTS,
  CAPABILITY_KEYS,
  CAPABILITY_NARROWEST,
  hostPlatform,
  localOrigin,
  PATHS,
  TIERS,
  browserProfileBase,
  cleanBrowserProfile,
  cleanCapabilityKeys,
  cleanNarrowing,
  cleanOrigin,
  cleanTrust,
  combineNarrowing,
  configOrigins,
  machineView,
  markBrowserProfile,
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
  describeMachinePolicy,
  fileVersion,
  policyFile,
  readMachinePolicy,
  saveMachinePolicy,
  upgradeV1Entry,
} from '../src/remote/agent-policy-file.js'
import { localMachinePolicy, validateUserEntry } from '../src/agent/user-settings.js'
import { cleanPolicy } from '../src/hosted/agent-policy.js'
import { summaryChanges } from '../src/hosted/agents.js'
import { summaryCard } from '../src/agent/capability-views.js'
import { cleanHello } from '../src/hosted/agent-link.js'
import { cleanJob } from '../src/remote/agent-job.js'
import { loadConfig } from '../src/config.js'
import { deniedRoots } from '../src/agent/sandbox-exec.js'
import { tempDir } from './helpers.js'

// ---- Fixtures ----

// Agent browser profiles live in <XDG_STATE_HOME>/shapewall/agent-browser-profiles:
// this test process gets a state folder of its own.
process.env.XDG_STATE_HOME = tempDir('capabilities-state')
// An agent browser profile folder Shapewall made (marked).
const PROFILE_DIR = markBrowserProfile('agent-profile')

const COMMANDS_CONFIG = {
  test: { run: 'npm test', argv: ['npm', 'test'], inputs: null, mutating: true, args: false, ready: null },
  lint: { run: 'npm run lint', argv: ['npm', 'run', 'lint'], inputs: null, mutating: false, args: false, ready: null },
}
const CONFIG = {
  baseUrl: 'http://127.0.0.1:5173/app',
  boards: [{ baseUrl: 'http://127.0.0.1:5173/app', publicUrl: 'https://staging.example.com/x', environments: [] }],
  commands: COMMANDS_CONFIG,
}
// A machine whose owner opted in to the wider capabilities (CAPABILITY_DEFAULTS),
// key by key, as `shapewall agent set` will write them.
const optIn = (entry, warn) => cleanMachinePolicy({ ...CAPABILITY_DEFAULTS, ...entry }, warn)
// A connected machine that takes edits, with one exact command and a team.
// It names an agent config folder of its own (extensions), which holds one skill and one server.
const MACHINE = optIn({ approvals: 'owner', commands: ['npm test'], trustTeam: ['robin'], agentConfig: '/home/ada/agent-config/builder' })
const FOLDER = { skills: ['notes'], servers: ['brain'] }
const CLEAN = { tainted: false, authors: [] }
const TRUST = {
  solo: { authors: [{ handle: 'dan', owner: true, member: true }], guests: false, thread: CLEAN },
  team: { authors: [{ handle: 'robin', owner: false, member: true }], guests: false, thread: CLEAN },
  open: { authors: [{ handle: 'eve', owner: false, member: true }], guests: false, thread: CLEAN },
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
  resolveCapabilities({
    path: where,
    trust: TRUST[tier],
    audience: 'owner',
    machine: MACHINE,
    config: CONFIG,
    platform,
    extensions: FOLDER,
    ...extra,
  })

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
    // An ACP session Shapewall starts itself: not an endpoint, not watch --exec.
    extensions: tier === 'solo' && ['local-chat', 'hosted-fix', 'pickup'].includes(where),
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
        for (const line of lines(caps)) assert.ok(line.state !== 'off' || line.why.length > 0, `${where} ${tier} ${name}: ${line.id}`)
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
  // shell-unsandboxed on: solo only.
  const loud = optIn({ approvals: 'owner', shellUnsandboxed: true, trustTeam: ['robin'], trustTeamShell: true })
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
  // The starter agent's container does not lift this machine's "no commands", or the server's.
  for (const extra of [{ machine: optIn({ approvals: 'owner', shell: 'off' }) }, { server: { shell: false } }]) {
    const caps = resolve('solo', 'starter', PLATFORMS['linux sandbox'], extra)
    assert.deepEqual([caps.shell.mode, caps.commands.length], ['off', 0], JSON.stringify(extra))
    assert.ok(lines(caps).every((line) => line.state !== 'off' || line.why.length > 0))
  }
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
    browserProfile: [null, '/srv/profile', PROFILE_DIR, '/home/x/.config/google-chrome/Default'],
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
    const machine = optIn({ approvals: 'owner', trustTeam: ['robin'], ...unknown })
    const defaults = optIn({ approvals: 'owner', trustTeam: ['robin'] })
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
      browserNoSandbox: 'yes',
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
    browserProfile: PROFILE_DIR,
    allowTool: ['mcp__notes__memory_write'],
    handoffHops: 2,
  })
  assert.deepEqual(good.trustTeam, ['robin', 'eve'])
  assert.deepEqual(good.browserAllow, ['https://staging.example.com', 'http://127.0.0.1:5173'])
  assert.equal(good.browserProfile, fs.realpathSync(PROFILE_DIR))
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
  // The server keeps known lines and states only; a state it cannot read is "unknown"; its own Chrome is always off.
  const kept = cleanCapabilitySummary({
    v: 1,
    team: 'everyone',
    fix: { solo: { shell: 'root', browser: 'on', chrome: 'on', extra: 'on' }, team: { shell: 'on' } },
    chat: 'x',
  })
  assert.equal(kept.team, 'none')
  assert.equal(kept.fix.solo.shell, 'unknown')
  assert.equal(kept.fix.solo.browser, 'on')
  assert.equal(kept.fix.solo.chrome, 'off')
  assert.equal(kept.fix.solo.extra, undefined)
  assert.equal(kept.fix.team, null)
  assert.deepEqual(
    Object.values(kept.chat.solo),
    LINE_IDS.map((id) => (id === 'chrome' ? 'off' : 'unknown')),
  )
  for (const raw of [null, 'x', [], { v: 2 }]) assert.equal(cleanCapabilitySummary(raw), null)
  // In hello: cleaned on the way in.
  const hello = cleanHello({ kind: 'claude', capabilitySummary: { ...summary, fix: { ...summary.fix, solo: { shell: 'sudo' } } } })
  assert.equal(hello.capabilities.summary.fix.solo.shell, 'unknown')
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
  // A connection the file never had: what version 1 allowed (reads and answers only), not the wider capabilities.
  const fresh = read('new')
  assert.deepEqual([fresh.approvals, fresh.shell, fresh.browser, fresh.extensionsFor], ['none', 'off', 'off', []])

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
  // Values that only say what version 1 allowed are not written: they keep following approvals and commands.
  assert.equal(Object.hasOwn(data.connections[`${origin}#reader`], 'shell'), false)
  assert.equal(read('reader').shell, 'off')
  assert.equal(data.connections[`${origin}#broken`].shellNetwork, 'none')
  assert.deepEqual([read('builder').base, read('builder').shell], ['main', 'commands'])
  // Version 2 now: approvals alone opt in to nothing new; each wider key is the owner's to set.
  saveMachinePolicy(origin, 'new', { approvals: 'owner' }, env)
  assert.deepEqual([read('new').shell, read('new').browser], ['off', 'off'])
  saveMachinePolicy(origin, 'new', { shell: 'sandboxed' }, env)
  assert.deepEqual([read('new').shell, read('new').browser, read('new').approvals], ['sandboxed', 'off', 'owner'])
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
    // $PORT only bare: quoted or escaped it would read as text to a person and as the port to Shapewall.
    [{ dev: 'npm run dev -- --port \\$PORT' }, /\$PORT goes unquoted and unescaped/],
    [{ dev: "npm run dev -- --port '$PORT'" }, /\$PORT goes unquoted/],
    [{ dev: 'npm run dev -- --port "$PORT"' }, /\$PORT goes unquoted/],
    [{ dev: '$PORT --serve' }, /\$PORT is never the program itself/],
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
    machine: optIn({ approvals: 'owner', browserAllow: ['https://api.example.com'] }),
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
    machine: optIn({ approvals: 'owner', browserAuth: 'staging' }),
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
    machine: optIn({ approvals: 'owner', browserAuth: 'staging', trustTeam: ['robin'] }),
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

// ---- Review fixes (PR #35) ----

test('approvals "none": reads and answers only, on every tier x path x platform', () => {
  // Everything else opted in, so only approvals holds it.
  const none = optIn({ approvals: 'none', commands: ['npm test'], trustTeam: ['robin'], trustTeamShell: true, shellUnsandboxed: true })
  let rows = 0
  for (const where of PATHS) {
    for (const tier of TIERS) {
      for (const [name, platform] of Object.entries(PLATFORMS)) {
        const caps = resolve(tier, where, platform, { machine: none })
        const label = `${where} ${tier} ${name}`
        const states = lineStates(caps)
        if (where === 'local-chat' || where === 'local-endpoint' || where === 'starter') {
          // A local board's owner, and the starter's container, answer their own cards: approvals do not apply there.
          assert.equal(caps.edit.on, true, label)
        } else {
          assert.deepEqual([caps.edit.on, caps.commands.length, caps.shell.mode, caps.push.on], [false, 0, 'off', false], label)
          for (const id of ['edits', 'commands', 'shell', 'push']) assert.equal(states[id], 'off', `${label}: ${id}`)
          for (const id of ['commands', 'shell'])
            assert.ok(
              caps.why.some((item) => item.line === id && item.code === 'machine_approvals_none'),
              `${label}: ${id} why`,
            )
          assert.ok(
            toCli(caps).some((line) => line.includes('reads and answers only')),
            label,
          )
        }
        rows += 1
      }
    }
  }
  assert.equal(rows, PATHS.length * TIERS.length * Object.keys(PLATFORMS).length)
})

test('edit powers: a full shell or a command that changes files is never on while edits are off (3000 random turns)', () => {
  const random = rng(0xed17)
  for (let run = 0; run < 3000; run += 1) {
    const caps = resolveCapabilities({
      path: pick(random, [...PATHS, 'nope']),
      trust: randomTrust(random),
      audience: pick(random, ['owner', 'members', undefined]),
      machine: random() < 0.5 ? randomMachine(random) : optIn({ approvals: pick(random, ['none', 'owner', 'x']) }),
      server: random() < 0.3 ? junkNarrowing(random) : null,
      config: randomConfig(random),
      platform: randomPlatform(random),
    })
    if (caps.edit.on) continue
    assert.equal(caps.shell.mode, 'off', `run ${run}`)
    assert.ok(
      caps.commands.every((item) => !item.mutating),
      `run ${run}`,
    )
  }
})

test('a connection with nothing saved (or saved by 1.3.0 without flags) reads and answers only', () => {
  const env = { XDG_CONFIG_HOME: tempDir('capabilities-nothing-saved') }
  const origin = 'https://wall.example.com'
  const fresh = readMachinePolicy(origin, 'default', env)
  assert.deepEqual(
    Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, fresh[key]])),
    Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, DEFAULT_MACHINE_POLICY[key]])),
  )
  for (const where of ['hosted-chat', 'hosted-fix', 'pickup', 'watch-exec'])
    for (const tier of TIERS) {
      const states = lineStates(resolve(tier, where, PLATFORMS['linux sandbox'], { machine: fresh }))
      for (const id of ['edits', 'commands', 'shell', 'browser', 'extensions', 'push', 'handoff'])
        assert.equal(states[id], 'off', `${where} ${tier} ${id}`)
    }
  // What 1.3.0 wrote for a connection without flags: the version 1 keys only.
  const file = policyFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      connections: { [`${origin}#old`]: { audience: 'server', approvals: 'none', commands: [], auto: [], remote: 'origin' } },
    }),
    { mode: 0o600 },
  )
  const old = readMachinePolicy(origin, 'old', env)
  assert.deepEqual([old.shell, old.browser, old.extensionsFor, old.commandApproval], ['off', 'off', [], 'always'])
  // Saved by 1.4.0 with approvals "none", then given approvals and an exact command: the command follows (behind a card).
  saveMachinePolicy(origin, 'later', {}, env)
  saveMachinePolicy(origin, 'later', { approvals: 'owner', commands: ['npm test'] }, env)
  const later = readMachinePolicy(origin, 'later', env)
  assert.deepEqual([later.shell, later.commandApproval, later.browser], ['commands', 'always', 'off'])
  const caps = resolve('solo', 'hosted-fix', PLATFORMS['linux sandbox'], { machine: later })
  assert.deepEqual(caps.shell.exact, ['npm test'])
  assert.ok(caps.commands.length && caps.commands.every((item) => item.needsCard))
  // A key the owner chose is written and kept.
  saveMachinePolicy(origin, 'later', { browser: 'on' }, env)
  assert.equal(readMachinePolicy(origin, 'later', env).browser, 'on')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).connections[`${origin}#later`].browser, 'on')
})

test('describeMachinePolicy (what connect prints) agrees with agent status (toCli) on 300 random policies', () => {
  const random = rng(0xde5c)
  const stateOf = (caps, id) => lines(caps).find((line) => line.id === id).state
  for (let run = 0; run < 300; run += 1) {
    const policy =
      random() < 0.5
        ? randomMachine(random)
        : optIn({
            approvals: pick(random, ['none', 'owner', 'admins']),
            shell: pick(random, ['sandboxed', 'commands', 'off']),
            browser: pick(random, ['on', 'off']),
          })
    const said = describeMachinePolicy(policy).join('\n')
    const caps = resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST.solo,
      audience: 'owner',
      machine: policy,
      config: CONFIG,
      platform: PLATFORMS['linux sandbox'],
    })
    const label = `run ${run}: ${JSON.stringify(policy).slice(0, 200)}`
    const readsOnly = /^Reads and answers\. No edits, no commands, no shell/.test(said)
    assert.equal(readsOnly, policy.approvals === 'none', label)
    if (readsOnly) for (const id of ['edits', 'commands', 'shell']) assert.equal(stateOf(caps, id), 'off', `${label} ${id}`)
    else assert.equal(stateOf(caps, 'edits'), 'ask', label)
    const never = /Commands: never/.test(said)
    assert.equal(never, !readsOnly && stateOf(caps, 'commands') === 'off' && stateOf(caps, 'shell') === 'off', label)
    assert.equal(/Browser: none\./.test(said), stateOf(caps, 'browser') === 'off', label)
    assert.equal(/Shell: a full shell/.test(said), caps.shell.mode === 'sandboxed', label)
  }
})

test('browser allowlist: the machine caps the config; config origins widen it only on a solo turn without a login', () => {
  const config = { agent: { browser: { allow: ['http://169.254.169.254', 'https://cdn.example.com'] } } }
  const machine = optIn({ approvals: 'owner', trustTeam: ['robin'], browserAllow: ['https://cdn.example.com'] })
  const at = (tier, extra = {}) =>
    resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST[tier],
      audience: 'owner',
      machine,
      config,
      platform: PLATFORMS['linux sandbox'],
      ...extra,
    }).browser.allow
  // The review's case: an open turn with a config that names the metadata address gets nothing from it.
  assert.deepEqual(
    resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST.open,
      audience: 'owner',
      machine: optIn({ approvals: 'owner' }),
      config: { agent: { browser: { allow: ['http://169.254.169.254'] } } },
      platform: PLATFORMS['linux sandbox'],
    }).browser.allow,
    [],
  )
  assert.deepEqual([...at('open')], ['https://cdn.example.com'])
  assert.deepEqual([...at('team')], ['https://cdn.example.com'])
  assert.deepEqual([...at('solo')].sort(), ['http://169.254.169.254', 'https://cdn.example.com'])
  // With a login for the browser, not even solo.
  const loggedIn = resolveCapabilities({
    path: 'hosted-fix',
    trust: TRUST.solo,
    audience: 'owner',
    machine: optIn({ approvals: 'owner', browserAuth: 'staging' }),
    config,
    platform: PLATFORMS['linux sandbox'],
  })
  assert.deepEqual(loggedIn.browser.allow, [])
  // A wildcard is never an origin.
  for (const origin of ['*', 'https://*.example.com', 'http://*', 'https://a*.example.com']) assert.equal(cleanOrigin(origin), null, origin)
  // An audience it cannot read is "server": it never lets a turn reach solo on its own.
  for (const audience of ['members', 'OWNER', 1, null, undefined])
    assert.equal(machineView({ audience }).audience, 'server', String(audience))
})

test('browser profile: only a folder Shapewall marked in its own base, read after resolving links; never a browser’s own or a copy', () => {
  const env = { XDG_STATE_HOME: tempDir('capabilities-profiles-state') }
  const base = browserProfileBase(env)
  assert.equal(base, path.join(env.XDG_STATE_HOME, 'shapewall', 'agent-browser-profiles'))
  // Without XDG_STATE_HOME: ~/.local/state/... (a relative XDG_STATE_HOME is ignored).
  assert.equal(
    browserProfileBase({ HOME: '/home/d', XDG_STATE_HOME: 'rel' }),
    path.join('/home/d', '.local', 'state', 'shapewall', 'agent-browser-profiles'),
  )
  const opts = { env }
  // No base yet: nothing is a profile.
  assert.equal(cleanBrowserProfile('agent', opts), null)
  // A NAME makes <base>/NAME, 0700, the base 0700 too.
  const marked = markBrowserProfile('agent', opts)
  assert.equal(marked, path.join(fs.realpathSync(base), 'agent'))
  assert.equal(fs.statSync(base).mode & 0o777, 0o700)
  assert.equal(fs.statSync(marked).mode & 0o777, 0o700)
  assert.equal(cleanBrowserProfile('agent', opts), marked)
  assert.equal(cleanBrowserProfile(marked, opts), marked)
  assert.equal(fs.statSync(path.join(marked, BROWSER_PROFILE_MARKER)).mode & 0o777, 0o600)
  // An absolute path directly in the base is the same as its name.
  assert.equal(markBrowserProfile(path.join(base, 'second'), opts), path.join(fs.realpathSync(base), 'second'))
  // Marking again is fine once it is ours, even after the browser wrote to it.
  fs.writeFileSync(path.join(marked, 'Local State'), '{}')
  assert.equal(markBrowserProfile('agent', opts), marked)
  assert.equal(cleanBrowserProfile(marked, opts), marked)
  // A link to it (from anywhere) reads as the folder it points to, still in the base.
  const outside = tempDir('capabilities-profiles-outside')
  fs.symlinkSync(marked, path.join(outside, 'link'))
  assert.equal(cleanBrowserProfile(path.join(outside, 'link'), opts), marked)
  // A marked folder outside the base: refused, and never made there.
  const elsewhere = path.join(outside, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.copyFileSync(path.join(marked, BROWSER_PROFILE_MARKER), path.join(elsewhere, BROWSER_PROFILE_MARKER))
  assert.equal(cleanBrowserProfile(elsewhere, opts), null)
  assert.throws(() => markBrowserProfile(path.join(outside, 'new'), opts), /lives in/)
  assert.throws(() => markBrowserProfile(path.join(base, 'deep', 'er'), opts), /lives in/)
  assert.throws(() => markBrowserProfile('../escape', opts), /a name such as/)
  assert.throws(() => markBrowserProfile('relative/dir', opts), /a name such as/)
  // A link in the base to a marked folder outside it: refused after resolving it.
  fs.symlinkSync(elsewhere, path.join(base, 'sneaky'))
  assert.equal(cleanBrowserProfile('sneaky', opts), null)
  assert.throws(() => markBrowserProfile('sneaky', opts), /symbolic link/)
  // An unmarked folder, a missing one, a file: refused.
  fs.mkdirSync(path.join(base, 'plain'), { mode: 0o700 })
  assert.equal(cleanBrowserProfile('plain', opts), null)
  assert.equal(cleanBrowserProfile('missing', opts), null)
  assert.equal(cleanBrowserProfile(path.join(marked, BROWSER_PROFILE_MARKER), opts), null)
  // A copy of a real profile: its own files, no marker. Refused, and never marked.
  const copy = path.join(base, 'copy')
  fs.mkdirSync(path.join(copy, 'Default'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(copy, 'Local State'), '{}')
  fs.writeFileSync(path.join(copy, 'Default', 'Cookies'), 'x')
  assert.equal(cleanBrowserProfile('copy', opts), null)
  assert.throws(() => markBrowserProfile('copy', opts), /a browser's own files/)
  // A marker that is a link, or says something else: not ours.
  const fake = path.join(base, 'fake')
  fs.mkdirSync(fake, { mode: 0o700 })
  fs.symlinkSync(path.join(marked, BROWSER_PROFILE_MARKER), path.join(fake, BROWSER_PROFILE_MARKER))
  assert.equal(cleanBrowserProfile('fake', opts), null)
  const other = path.join(base, 'other')
  fs.mkdirSync(other, { mode: 0o700 })
  fs.writeFileSync(path.join(other, BROWSER_PROFILE_MARKER), 'trust me\n')
  assert.equal(cleanBrowserProfile('other', opts), null)
  // A non-empty folder is never marked.
  fs.writeFileSync(path.join(base, 'plain', 'notes.txt'), 'x')
  assert.throws(() => markBrowserProfile('plain', opts), /not empty/)
  // A profile folder others may enter: refused until it is 0700 again.
  fs.chmodSync(marked, 0o755)
  assert.equal(cleanBrowserProfile('agent', opts), null)
  assert.throws(() => markBrowserProfile('agent', opts), /open to other users/)
  fs.chmodSync(marked, 0o700)
  assert.equal(cleanBrowserProfile('agent', opts), marked)
  // A base with the wrong mode: nothing in it counts.
  fs.chmodSync(base, 0o755)
  assert.equal(cleanBrowserProfile('agent', opts), null)
  assert.throws(() => markBrowserProfile('agent', opts), /open to other users/)
  fs.chmodSync(base, 0o700)
  assert.equal(cleanBrowserProfile('agent', opts), marked)
  // A base that is a symbolic link (to a folder of the same shape): refused.
  const linkEnv = { XDG_STATE_HOME: tempDir('capabilities-profiles-linked') }
  fs.mkdirSync(path.join(linkEnv.XDG_STATE_HOME, 'shapewall'))
  fs.symlinkSync(fs.realpathSync(base), browserProfileBase(linkEnv))
  assert.equal(cleanBrowserProfile('agent', { env: linkEnv }), null)
  assert.equal(cleanBrowserProfile(marked, { env: linkEnv }), null)
  assert.throws(() => markBrowserProfile('new-one', { env: linkEnv }), /symbolic link/)
  // A name that looks like a browser's own folder is never made.
  assert.throws(() => markBrowserProfile('chromium-x', opts), /looks like a browser's own/)
  // The name check catches the folders the review listed before the disk is read.
  for (const dir of [
    '/home/d/.config/google-chrome',
    '/home/d/.config/Google-Chrome/Default',
    '/home/d/.config/vivaldi',
    '/home/d/.config/opera',
    '/home/d/.config/BraveSoftware/Brave-Browser',
    'C:\\Users\\d\\AppData\\Local\\MICROS~1\\Edge\\User Data',
    'C:\\Users\\d\\AppData\\Local\\BRAVES~1\\Brave-Browser\\User Data',
    '/Users/d/Library/Application Support/Arc/User Data',
    '/Users/d/Library/Application Support/Microsoft Edge',
    '/Users/d/Library/Application Support/Microsoft Edge Beta/Default',
    '/Users/d/Library/Application Support/Vivaldi',
    '/Users/d/Library/Application Support/com.operasoftware.Opera',
    '/Users/d/Library/Application Support/Google/Chrome Canary',
    '/home/d/snap/chromium/common/chromium',
    '/home/d/.var/app/com.google.Chrome/config/google-chrome',
    '/home/d/.config/chromium-browser',
    '/home/d/.config/net.imput.helium',
    '/home/d/.config/BRAVES~1',
    '/home/d/.config/yandex-browser',
    '/home/d/.config/thorium',
    '/home/d/.mozilla/firefox/abc.default',
    '/tmp/x/../../home/d/.config/google-chrome',
  ])
    assert.equal(cleanBrowserProfile(dir, opts), null, dir)
})

test('browser profile base: inside a folder the command sandbox hides', () => {
  // deniedRoots (src/agent/sandbox-exec.js) hides the home folder and the
  // XDG folders from every command, so the agent cannot write the base.
  const env = { XDG_STATE_HOME: tempDir('capabilities-profiles-denied') }
  const base = fs.realpathSync(path.dirname(path.dirname(markBrowserProfile('denied', { env }))))
  const within = (outer, inner) => inner === outer || inner.startsWith(outer + path.sep)
  assert.ok(
    deniedRoots({ env }).some((root) => within(root, base)),
    'the base is inside a denied root',
  )
  // The fallback (no XDG_STATE_HOME) is under the home folder, also hidden.
  const home = fs.realpathSync(os.homedir())
  const fallback = browserProfileBase({ HOME: os.homedir() })
  assert.ok(within(home, fallback))
  assert.ok(deniedRoots({ env: { HOME: os.homedir() } }).some((root) => within(root, home)))
})

// An old policy that names a profile folder outside the base reads as no
// profile, with a warning, like any value this version does not take.
test('browser profile: an old absolute path outside the base reads as none, with a warning', () => {
  const old = tempDir('capabilities-old-profile')
  fs.writeFileSync(path.join(old, BROWSER_PROFILE_MARKER), fs.readFileSync(path.join(PROFILE_DIR, BROWSER_PROFILE_MARKER)))
  fs.chmodSync(old, 0o700)
  const warned = []
  const cleaned = cleanCapabilityKeys({ browserProfile: old }, { warn: (key) => warned.push(key) })
  assert.equal(cleaned.browserProfile, null)
  assert.deepEqual(warned, ['browserProfile'])
  const policyWarnings = []
  const policy = cleanMachinePolicy({ ...CAPABILITY_DEFAULTS, browserProfile: old }, (text) => policyWarnings.push(text))
  assert.equal(policy.browserProfile, null)
  assert.ok(policyWarnings.some((text) => /browserProfile/.test(text)))
})

test('capability summary: what changed between two hellos, line by line', () => {
  const narrow = capabilitySummary({ machine: optIn({ approvals: 'owner', shell: 'off', browser: 'off' }) })
  const wide = capabilitySummary({ machine: optIn({ approvals: 'owner' }), platform: PLATFORMS['linux sandbox'] })
  assert.deepEqual(summaryChanges(narrow, narrow), [])
  const changed = summaryChanges(narrow, wide)
  assert.ok(changed.includes('fix.solo.shell'))
  assert.ok(changed.includes('fix.solo.browser'))
  assert.ok(changed.every((item) => item === 'team' || /^(chat|fix)\.(solo|team|open)\.[a-z]+$/.test(item)))
  assert.ok(summaryChanges(null, wide).length > 0)
  assert.ok(summaryChanges(narrow, { ...narrow, team: 'members' }).includes('team'))
  // The handoff line is in every view.
  const caps = resolve('solo', 'hosted-fix', PLATFORMS['linux sandbox'], { machine: optIn({ approvals: 'owner', handoffHops: 2 }) })
  assert.equal(lineStates(caps).handoff, 'on')
  assert.ok(toCli(caps).some((line) => line.includes('at most 2 hops')))
  assert.match(toPrompt(caps), /Hand off to another agent/)
  assert.ok('handoff' in wide.fix.solo)
  // A machine that sends no handoff line (older) reads as unknown on the server, not off.
  const older = JSON.parse(JSON.stringify(wide))
  delete older.fix.solo.handoff
  assert.equal(cleanCapabilitySummary(older).fix.solo.handoff, 'unknown')
})

test('hostPlatform reads the sandbox probe; Windows and a failing probe read as no sandbox', () => {
  assert.deepEqual(hostPlatform({ platform: 'linux', probe: () => ({ available: true }) }), { os: 'linux', sandbox: true })
  assert.deepEqual(hostPlatform({ platform: 'darwin', probe: () => ({ available: false }) }), { os: 'darwin', sandbox: false })
  assert.deepEqual(
    hostPlatform({
      platform: 'linux',
      probe: () => {
        throw new Error('x')
      },
    }),
    { os: 'linux', sandbox: false },
  )
  assert.deepEqual(hostPlatform({ platform: 'win32', probe: () => ({ available: true }) }), { os: 'win32', sandbox: false })
})

// ---- Review fixes (PR #37) ----

test('loopback origins from a committed config count below the owner’s own turn only where the machine lists them', () => {
  const spellings = [
    'http://127.0.0.1:5173',
    'http://127.0.0.2:8080',
    'http://127.1:3000',
    'http://0x7f000001:4000',
    'http://localhost:5173',
    'http://LOCALHOST:5174',
    'http://localhost.:5175',
    'http://app.localhost:5176',
    'http://[::1]:5177',
    'http://[::ffff:127.0.0.1]:5178',
    'http://[0:0:0:0:0:ffff:7f00:1]:5179',
    'http://0.0.0.0:5180',
    'http://[::]:5181',
    'http://myapp.test:5182',
  ]
  for (const origin of spellings) assert.equal(localOrigin(origin), true, origin)
  for (const origin of ['https://staging.example.com', 'http://10.0.0.5:3000', 'http://192.168.1.2', 'http://8.8.8.8'])
    assert.equal(localOrigin(origin), false, origin)
  const machines = {
    plain: optIn({ approvals: 'owner', trustTeam: ['robin'] }),
    login: optIn({ approvals: 'owner', trustTeam: ['robin'], browserAuth: 'staging', browserProfileTeam: true }),
  }
  // Each tier and machine: does a loopback origin from the config reach the allowlist?
  const cases = [
    ['solo', 'plain', true],
    ['solo', 'login', false],
    ['team', 'plain', false],
    ['team', 'login', false],
    ['open', 'plain', false],
    ['open', 'login', false],
  ]
  for (const origin of spellings) {
    for (const source of ['baseUrl', 'publicUrl', 'environment', 'board', 'agent.browser.allow']) {
      const config = {
        baseUrl: source === 'baseUrl' ? `${origin}/app` : undefined,
        publicUrl: source === 'publicUrl' ? origin : undefined,
        environments: source === 'environment' ? [{ id: 'local', baseUrl: `${origin}/` }] : [],
        boards: source === 'board' ? [{ baseUrl: `${origin}/x` }] : [],
        agent: source === 'agent.browser.allow' ? { browser: { allow: [new URL(origin).origin] } } : undefined,
      }
      const own = new URL(origin).origin
      for (const [tier, kind, reaches] of cases) {
        const label = `${origin} ${source} ${tier} ${kind}`
        const at = (machine) =>
          resolveCapabilities({
            path: 'hosted-fix',
            trust: TRUST[tier],
            audience: 'owner',
            machine,
            config,
            platform: PLATFORMS['linux sandbox'],
          })
        const caps = at(machines[kind])
        assert.equal(caps.browser.on, true, label)
        assert.equal(caps.browser.allow.includes(own), reaches, label)
        const held = caps.why.some((item) => item.line === 'browser' && item.code === 'loopback_not_listed')
        assert.equal(held, !reaches, label)
        assert.deepEqual([...caps.browser.withheld], reaches ? [] : [own], label)
        // Listed by the machine, that exact origin: it counts on every tier.
        const listed = at(optIn({ ...machines[kind], browserAllow: [own] }))
        assert.ok(listed.browser.allow.includes(own), `${label} listed`)
        assert.ok(!listed.why.some((item) => item.code === 'loopback_not_listed'), `${label} listed`)
      }
    }
  }
  // Another spelling of the same address on the machine's list is not that origin.
  const other = resolveCapabilities({
    path: 'hosted-fix',
    trust: TRUST.team,
    audience: 'owner',
    machine: optIn({ approvals: 'owner', trustTeam: ['robin'], browserAllow: ['http://127.0.0.1:5173'] }),
    config: { baseUrl: 'http://localhost:5173' },
    platform: PLATFORMS['linux sandbox'],
  })
  assert.deepEqual([...other.browser.allow], ['http://127.0.0.1:5173'])
  assert.deepEqual([...other.browser.withheld], ['http://localhost:5173'])
  // Non-loopback config origins are unchanged on every tier, except a
  // private address on an open turn (PR #39 review: another machine on this
  // one's networks needs the machine to list it there).
  for (const tier of TIERS) {
    const caps = resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST[tier],
      audience: 'owner',
      machine: optIn({ approvals: 'owner', trustTeam: ['robin'] }),
      config: { baseUrl: 'https://staging.example.com/app', publicUrl: 'http://10.0.0.5:3000' },
      platform: PLATFORMS['linux sandbox'],
    })
    const expected = tier === 'open' ? ['https://staging.example.com'] : ['http://10.0.0.5:3000', 'https://staging.example.com']
    assert.deepEqual([...caps.browser.allow].sort(), expected, tier)
    assert.ok(!caps.why.some((item) => item.code === 'loopback_not_listed'), tier)
    assert.equal(
      caps.why.some((item) => item.code === 'private_not_listed'),
      tier === 'open',
      tier,
    )
  }
  // The local board's open turns too; its owner's own (solo) keeps them.
  const local = (tier) =>
    resolveCapabilities({
      path: 'local-chat',
      trust: TRUST[tier],
      audience: 'owner',
      machine: localMachinePolicy({ capabilities: {} }),
      config: CONFIG,
      platform: PLATFORMS['linux sandbox'],
    })
  assert.ok(local('solo').browser.allow.includes('http://127.0.0.1:5173'))
  assert.ok(!local('open').browser.allow.includes('http://127.0.0.1:5173'))
  assert.ok(local('open').browser.allow.includes('https://staging.example.com'))
  // The starter agent's loopback is its container's: unchanged.
  const starter = resolveCapabilities({
    path: 'starter',
    trust: TRUST.open,
    audience: 'owner',
    machine: MACHINE,
    config: CONFIG,
    platform: PLATFORMS['linux sandbox'],
  })
  assert.ok(starter.browser.allow.includes('http://127.0.0.1:5173'))
})

test('loopback_not_listed: every view says which origin and the command that lists it; the browser stays on', () => {
  const caps = resolveCapabilities({
    path: 'hosted-fix',
    trust: TRUST.team,
    audience: 'owner',
    machine: optIn({ approvals: 'owner', trustTeam: ['robin'] }),
    config: CONFIG,
    platform: PLATFORMS['linux sandbox'],
  })
  const line = lines(caps, { as: 'staging' }).find((item) => item.id === 'browser')
  assert.equal(line.state, 'on')
  assert.match(line.text, /Not http:\/\/127\.0\.0\.1:5173: an address on this machine from the config/)
  assert.ok(line.why.some((text) => /lists that exact origin too/.test(text)))
  assert.equal(line.fix, 'shapewall agent set browser-allow http://127.0.0.1:5173 --as staging')
  const panel = toPanel(caps, { as: 'staging' }).lines.find((item) => item.id === 'browser')
  assert.deepEqual(panel, line)
  assert.ok(toCli(caps, { as: 'staging' }).some((text) => text.includes('change: shapewall agent set browser-allow http://127.0.0.1:5173')))
  assert.match(toPrompt(caps), /Not http:\/\/127\.0\.0\.1:5173/)
  // The command it prints is one `agent set` takes.
  assert.deepEqual(cleanCapabilityKeys({ browserAllow: ['http://127.0.0.1:5173'] }).browserAllow, ['http://127.0.0.1:5173'])
  // The board's copy of the summary: line states only, the code never reaches it.
  const summary = capabilitySummary({ machine: optIn({ approvals: 'owner', trustTeam: ['robin'] }), config: CONFIG })
  const cleaned = cleanCapabilitySummary(JSON.parse(JSON.stringify(summary)))
  assert.equal(cleaned.fix.team.browser, 'on')
  assert.ok(!JSON.stringify(cleaned).includes('loopback_not_listed'))
  // A summary carrying a reason code or text it does not know is cleaned to states only.
  const odd = cleanCapabilitySummary({ ...summary, fix: { ...summary.fix, team: { ...summary.fix.team, browser: 'loopback_not_listed' } } })
  assert.equal(odd.fix.team.browser, 'unknown')
})

test('browserNoSandbox: off by default and narrowest, on only while the browser is on for solo and team', () => {
  assert.equal(CAPABILITY_DEFAULTS.browserNoSandbox, false)
  assert.equal(CAPABILITY_NARROWEST.browserNoSandbox, false)
  assert.equal(DEFAULT_MACHINE_POLICY.browserNoSandbox, false)
  assert.equal(machineView({}).browserNoSandbox, false)
  assert.equal(localMachinePolicy({}).browserNoSandbox, false)
  for (const bad of ['yes', 1, 'on', null]) {
    const warned = []
    assert.equal(cleanCapabilityKeys({ browserNoSandbox: bad }, { warn: (key) => warned.push(key) }).browserNoSandbox, false, String(bad))
    assert.deepEqual(warned, ['browserNoSandbox'], String(bad))
  }
  const at = (tier, entry = {}, extra = {}) =>
    resolveCapabilities({
      path: 'hosted-fix',
      trust: TRUST[tier],
      audience: 'owner',
      machine: optIn({ approvals: 'owner', trustTeam: ['robin'], ...entry }),
      config: CONFIG,
      platform: PLATFORMS['linux sandbox'],
      ...extra,
    })
  for (const tier of TIERS) {
    assert.equal(at(tier).browser.allowNoSandbox, false, tier)
    assert.equal(at(tier, { browserNoSandbox: true }).browser.allowNoSandbox, tier !== 'open', tier)
    assert.equal(
      at(tier, { browserNoSandbox: true }).why.some((item) => item.code === 'open_tier_browser_sandbox'),
      tier === 'open',
      tier,
    )
    // The browser off: nothing to start, so nothing to skip.
    assert.equal(at(tier, { browserNoSandbox: true, browser: 'off' }).browser.allowNoSandbox, false, tier)
    assert.equal(at(tier, { browserNoSandbox: true }, { server: { browser: false } }).browser.allowNoSandbox, false, tier)
  }
  // The card, agent status and the prompt say so on the Browser line.
  const caps = at('solo', { browserNoSandbox: true })
  const line = lines(caps).find((item) => item.id === 'browser')
  assert.match(line.text, /starts without it \(the owner chose browser-no-sandbox\)/)
  assert.ok(toCli(caps).some((text) => /browser-no-sandbox/.test(text)))
  assert.match(toPrompt(caps), /browser-no-sandbox/)
  assert.doesNotMatch(lines(at('solo')).find((item) => item.id === 'browser').text, /no-sandbox/)
  assert.doesNotMatch(lines(at('open', { browserNoSandbox: true })).find((item) => item.id === 'browser').text, /no-sandbox/)
  // The hello summary carries it; the board's card says it on solo and team only.
  const summary = cleanCapabilitySummary(
    JSON.parse(JSON.stringify(capabilitySummary({ machine: optIn({ approvals: 'owner', trustTeam: ['robin'], browserNoSandbox: true }) }))),
  )
  assert.equal(summary.browserNoSandbox, true)
  assert.equal(cleanCapabilitySummary({ ...summary, browserNoSandbox: 'yes' }).browserNoSandbox, false)
  assert.equal(capabilitySummary({ machine: optIn({ approvals: 'owner' }) }).browserNoSandbox, false)
  assert.equal(
    capabilitySummary({ machine: optIn({ approvals: 'owner', browserNoSandbox: true, browser: 'off' }) }).browserNoSandbox,
    false,
  )
  const card = summaryCard(summary)
  const browserLine = (tier) =>
    card.paths
      .find((item) => item.id === 'fix')
      .tiers.find((item) => item.tier === tier)
      .lines.find((item) => item.id === 'browser').text
  assert.match(browserLine('solo'), /browser-no-sandbox/)
  assert.match(browserLine('team'), /browser-no-sandbox/)
  assert.doesNotMatch(browserLine('open'), /browser-no-sandbox/)
  assert.deepEqual(summaryChanges(summary, { ...summary, browserNoSandbox: false }), ['browserNoSandbox'])
  // The policy file: written and read back, local board entry too.
  const env = { XDG_CONFIG_HOME: tempDir('capabilities-no-sandbox') }
  saveMachinePolicy('https://board.example', 'default', { browserNoSandbox: true }, env)
  assert.equal(readMachinePolicy('https://board.example', 'default', env).browserNoSandbox, true)
  assert.equal(JSON.parse(fs.readFileSync(policyFile(env), 'utf8')).connections['https://board.example#default'].browserNoSandbox, true)
  saveMachinePolicy('https://board.example', 'default', { browserNoSandbox: false }, env)
  assert.equal(readMachinePolicy('https://board.example', 'default', env).browserNoSandbox, false)
  const local = validateUserEntry({ capabilities: { browserNoSandbox: true } })
  assert.deepEqual(local.problems, [])
  assert.equal(localMachinePolicy(local.entry).browserNoSandbox, true)
  assert.equal(localMachinePolicy(validateUserEntry({ capabilities: { browserNoSandbox: 'yes' } }).entry).browserNoSandbox, false)
})
