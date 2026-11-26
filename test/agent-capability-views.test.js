// The "What it can do" card, `shapewall agent status` and the agent's own
// prompt block list the same lines with the same states (src/agent/capability-views.js,
// src/cli/agent-status.js, src/agent/capability-render.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveCapabilities, resolveCeiling } from '../src/agent/capabilities.js'
import { loadConfig } from '../src/config.js'
import { LINE_IDS, LINE_LABELS, capabilitySummary, cleanCapabilitySummary, lineStates, toPrompt } from '../src/agent/capability-render.js'
import { compactCard, localCard, summaryCard, viewerTier } from '../src/agent/capability-views.js'
import { agentSet, agentStatus, agentStatusData } from '../src/cli/agent-status.js'
import { saveMachinePolicy, readMachinePolicy } from '../src/remote/agent-policy-file.js'
import { tempDir } from './helpers.js'

const ORIGIN = 'https://sw.example.com'
const PLATFORM = { os: 'linux', sandbox: true }
const CONFIG = {
  dir: '/nowhere',
  boards: [{ id: 'main', baseUrl: 'http://127.0.0.1:5173' }],
  commands: { test: { run: 'npm test' }, lint: { run: 'npm run lint', mutating: false } },
}
// Three fixture agents: what each machine allows, and the tier of the turn we look at.
const FIXTURES = {
  solo: {
    audience: 'owner',
    approvals: 'owner',
    instructions: 'all',
    agentConfig: null,
    remote: 'origin',
    commands: [],
    shell: 'sandboxed',
    browser: 'on',
  },
  team: {
    audience: 'server',
    approvals: 'admins',
    instructions: 'project',
    agentConfig: null,
    remote: null,
    commands: ['npm test'],
    trustTeam: 'members',
    trustTeamShell: false,
    shell: 'sandboxed',
    browser: 'on',
  },
  open: {
    audience: 'server',
    approvals: 'none',
    instructions: 'none',
    agentConfig: null,
    remote: null,
    commands: [],
    shell: 'off',
    browser: 'off',
  },
}
const owner = { authors: [{ owner: true }], guests: false }

// The prompt block as states: "- Label: text" under "you can", "only after a card", "you cannot".
function promptStates(text) {
  const out = {}
  let state = null
  for (const line of text.split('\n')) {
    if (/you can:$/.test(line)) state = 'on'
    else if (/^Only after a person answers/.test(line)) state = 'ask'
    else if (/^You cannot:/.test(line)) state = 'off'
    else if (/^To change this/.test(line)) state = null
    else if (state && line.startsWith('- ')) {
      const label = Object.entries(LINE_LABELS).find(([, name]) => line.startsWith(`- ${name}: `))
      if (label) out[label[0]] = state
    }
  }
  return out
}

function env() {
  const dir = tempDir('cap-views')
  return { dir, env: { XDG_CONFIG_HOME: path.join(dir, 'xdg'), XDG_STATE_HOME: path.join(dir, 'state'), HOME: dir } }
}

for (const [tier, machine] of Object.entries(FIXTURES))
  test(`the ${tier} fixture agent: console card, agent status and its own prompt list the same lines and states`, async () => {
    const { dir, env: e } = env()
    saveMachinePolicy(ORIGIN, 'default', machine, e)
    const policy = readMachinePolicy(ORIGIN, 'default', e)
    fs.writeFileSync(
      path.join(dir, 'shapewall.config.json'),
      JSON.stringify({
        boards: [{ id: 'main', baseUrl: 'http://127.0.0.1:5173', pages: [{ id: 'home', path: '/' }] }],
        commands: CONFIG.commands,
      }),
    )
    const status = await agentStatusData({ remote: ORIGIN }, { env: e, cwd: dir, platform: PLATFORM })
    const config = loadConfig(undefined, { cwd: dir })
    for (const [key, where] of [
      ['fix', 'hosted-fix'],
      ['chat', 'hosted-chat'],
    ]) {
      const caps = resolveCeiling(tier, { path: where, machine: policy, config, platform: PLATFORM, trust: owner })
      const expected = lineStates(caps)
      // The console: from the summary the machine sends at hello, as the server keeps it.
      const summary = cleanCapabilitySummary(JSON.parse(JSON.stringify(capabilitySummary({ machine: policy, config, platform: PLATFORM }))))
      const card = summaryCard(summary, { remote: ORIGIN })
      const lines = card.paths.find((item) => item.id === key).tiers.find((item) => item.tier === tier).lines
      assert.deepEqual(Object.fromEntries(lines.map((line) => [line.id, line.state])), expected, `${key} console`)
      assert.deepEqual(
        lines.map((line) => line.label),
        LINE_IDS.map((id) => LINE_LABELS[id]),
      )
      // agent status --json, from the policy file.
      const panel = status.paths[key][tier]
      assert.ok(panel, `${key} ${tier} in agent status`)
      assert.deepEqual(Object.fromEntries(panel.lines.map((line) => [line.id, line.state])), expected, `${key} status`)
      // The agent's own prompt block.
      assert.deepEqual(promptStates(toPrompt(caps)), expected, `${key} prompt`)
    }
    // The text output says the same lines for every path and tier.
    const printed = []
    await agentStatus(
      { remote: ORIGIN },
      (line) => printed.push(line),
      () => {},
      { env: e, cwd: dir, platform: PLATFORM },
    )
    for (const id of LINE_IDS)
      assert.ok(
        printed.some((line) => line.includes(`${LINE_LABELS[id]}:`)),
        id,
      )
    assert.ok(printed.includes('Link: no saved token on this machine. Run shapewall agent connect to connect it'))
  })

test("the project's setting narrows the card the way the machine narrows a turn, and says so", () => {
  const machine = FIXTURES.solo
  const summary = cleanCapabilitySummary(capabilitySummary({ machine, config: CONFIG, platform: PLATFORM }))
  const narrowing = { maxTier: 'team', shell: false, browser: false }
  const card = summaryCard(summary, { narrowing })
  const fix = card.paths.find((item) => item.id === 'fix')
  assert.deepEqual(
    fix.tiers.find((item) => item.tier === 'solo'),
    { tier: 'solo', label: 'Solo', limitedTo: 'team', lines: null },
  )
  const open = fix.tiers.find((item) => item.tier === 'open').lines
  // A real turn by someone outside the team, with the project's narrowing.
  const turn = resolveCapabilities({
    path: 'hosted-fix',
    trust: { authors: [{ owner: false, member: true, handle: 'zed' }], guests: false },
    audience: 'owner',
    machine,
    server: narrowing,
    config: CONFIG,
    platform: PLATFORM,
  })
  assert.equal(turn.tier, 'open')
  const states = Object.fromEntries(open.map((line) => [line.id, line.state]))
  for (const id of ['commands', 'shell', 'browser']) {
    assert.equal(states[id], 'off')
    const line = open.find((item) => item.id === id)
    assert.equal(line.narrowed, true)
    assert.equal(line.fix, null, 'only an admin on the server changes it')
    assert.deepEqual(line.why, ["limited by this project's setting"])
  }
  // The same states as the resolver with the server's narrowing.
  const narrowedTurn = Object.fromEntries(Object.entries(lineStates(turn)).filter(([id]) => ['commands', 'shell', 'browser'].includes(id)))
  for (const [id, state] of Object.entries(narrowedTurn)) assert.equal(states[id], state)
})

test('an older machine: every line it did not say is unknown, never a guess; no summary is no card', () => {
  const summary = cleanCapabilitySummary({ v: 1, team: 'none', fix: { solo: { edits: 'ask' }, open: {} }, chat: {} })
  const card = summaryCard(summary)
  const solo = card.paths.find((item) => item.id === 'fix').tiers.find((item) => item.tier === 'solo').lines
  assert.equal(solo.find((line) => line.id === 'edits').state, 'ask')
  assert.equal(solo.find((line) => line.id === 'shell').state, 'unknown')
  assert.equal(solo.find((line) => line.id === 'shell').fix, null)
  assert.equal(solo.find((line) => line.id === 'chrome').state, 'off')
  assert.equal(card.paths[0].tiers.find((item) => item.tier === 'team').lines, null, 'no team on that machine')
  assert.equal(summaryCard(null), null)
})

test('the compact board view: the tier a viewer alone would reach', () => {
  const summary = cleanCapabilitySummary(capabilitySummary({ machine: FIXTURES.team, config: CONFIG, platform: PLATFORM }))
  assert.equal(viewerTier(summary, { audience: 'owner', machineAudience: 'server', owner: true }), 'solo')
  assert.equal(viewerTier(summary, { audience: 'members', machineAudience: 'server', owner: false }), 'team')
  assert.equal(viewerTier(summary, { audience: 'owner', machineAudience: 'server', owner: true, narrowing: { maxTier: 'open' } }), 'open')
  const named = cleanCapabilitySummary(
    capabilitySummary({ machine: { ...FIXTURES.team, trustTeam: ['ada'] }, config: CONFIG, platform: PLATFORM }),
  )
  assert.equal(
    viewerTier(named, { audience: 'members', machineAudience: 'server', owner: false }),
    'open',
    'named handles never reach the board',
  )
  const compact = compactCard(summaryCard(summary), { tier: 'team' })
  assert.equal(compact.tier, 'team')
  assert.deepEqual(Object.keys(compact.lines[0]).sort(), ['id', 'label', 'narrowed', 'state'])
})

test('a local board: the card, agent status and agent set agree, and set refuses what it cannot set', async () => {
  const { dir, env: e } = env()
  fs.writeFileSync(
    path.join(dir, 'shapewall.config.json'),
    JSON.stringify({ boards: [{ id: 'main', baseUrl: 'http://127.0.0.1:5173', pages: [{ id: 'home', path: '/' }] }] }),
  )
  const out = []
  assert.equal(
    await agentSet(
      ['set', 'browser', 'off'],
      {},
      (line) => out.push(line),
      () => {},
      { env: e, cwd: dir },
    ),
    0,
  )
  const status = await agentStatusData({}, { env: e, cwd: dir, platform: PLATFORM })
  assert.equal(status.kind, 'local')
  const browser = status.tiers.solo.lines.find((line) => line.id === 'browser')
  assert.deepEqual([browser.state, browser.fix], ['off', 'shapewall agent set browser on'])
  const { localMachinePolicy, userAgentEntry } = await import('../src/agent/user-settings.js')
  const card = localCard({
    machine: localMachinePolicy(userAgentEntry(fs.realpathSync(dir), e).entry ?? userAgentEntry(dir, e).entry),
    config: { dir },
    platform: PLATFORM,
  })
  assert.deepEqual(
    card.paths[0].tiers.map((tier) => tier.lines.map((line) => line.state)),
    ['solo', 'open'].map((tier) => status.tiers[tier].lines.map((line) => line.state)),
  )
  await assert.rejects(
    agentSet(
      ['set', 'approvals', 'owner'],
      {},
      () => {},
      () => {},
      { env: e, cwd: dir },
    ),
    /--remote URL/,
  )
  await assert.rejects(
    agentSet(
      ['set', 'shell', 'everything'],
      {},
      () => {},
      () => {},
      { env: e, cwd: dir },
    ),
    /not a value/,
  )
  await assert.rejects(
    agentSet(
      ['set', 'nonsense', 'x'],
      {},
      () => {},
      () => {},
      { env: e, cwd: dir },
    ),
    /Not a setting/,
  )
})

test('agent set on a connection: capability keys and connect keys, each checked as agent connect checks them', async () => {
  const { dir, env: e } = env()
  const set = (...args) =>
    agentSet(
      ['set', ...args],
      { remote: ORIGIN, as: 'builder' },
      () => {},
      () => {},
      { env: e, cwd: dir },
    )
  await set('trust-team', 'ada,bo')
  await set('trust-team-shell', 'on')
  await set('approvals', 'owner')
  await set('remote', 'origin')
  const policy = readMachinePolicy(ORIGIN, 'builder', e)
  assert.deepEqual([policy.trustTeam, policy.trustTeamShell, policy.approvals, policy.remote], [['ada', 'bo'], true, 'owner', 'origin'])
  assert.equal(readMachinePolicy(ORIGIN, 'default', e).approvals, 'none', 'another connection is untouched')
  await assert.rejects(set('handoff-hops', '9'), /not a value/)
  await assert.rejects(set('approvals', 'everyone'), /--approvals/)
})
