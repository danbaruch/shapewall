// `shapewall agent status [--as NAME] [--remote URL] [--json]` and
// `shapewall agent set KEY VALUE [--as NAME] [--remote URL]`.
//
// status: what the agent can do, per tier, from this machine's own policy
// (agent-policy.json for a connected agent, the project's agents.json entry
// for a local board), worked out by the same resolver every turn uses and
// printed by the same renderer as the console card and the agent's own
// prompt block (src/agent/capability-render.js). For a connected agent, the
// live link state from the server too (its saved token asks it).
//
// set: changes one line of that policy without reconnecting. The next
// `shapewall agent connect` (and the next turn on a local board) reads it.

import fs from 'node:fs'
import { CAPABILITY_KEYS, cleanCapabilityKeys, hostPlatform, resolveCeiling } from '../agent/capabilities.js'
import { toCli, toPanel } from '../agent/capability-render.js'
import { TIER_LABELS } from '../agent/capability-views.js'
import { localMachinePolicy, updateUserAgentEntry, userAgentEntry } from '../agent/user-settings.js'
import { findConfigFile, loadConfig } from '../config.js'
import { AGENT_SLUG_RE, readAgentCredential } from '../remote/credentials.js'
import { readMachinePolicy, saveMachinePolicy } from '../remote/agent-policy-file.js'
import { createRemote, remoteOrigin } from '../remote/remote.js'

const CONNECTED_PATHS = [
  ['fix', 'hosted-fix', 'In Fix with'],
  ['chat', 'hosted-chat', 'In chat'],
]
const LIVE_TIMEOUT_MS = 5000

const isRemote = (flags, env) => flags.remote !== undefined || Boolean(env.SHAPEWALL_REMOTE)
function slugOf(flags) {
  const slug = flags.as === undefined ? 'default' : String(flags.as)
  if (!AGENT_SLUG_RE.test(slug)) throw new Error('--as: the name of a connection (lower-case letters, digits and dashes)')
  return slug
}
function configAt(flags, cwd, { required }) {
  const file = findConfigFile(flags.config, cwd)
  if (fs.existsSync(file)) return loadConfig(flags.config, { cwd })
  if (required)
    throw new Error('No shapewall.config.json here. Run this in a project, or add --remote URL for an agent connected to a hosted board.')
  return null
}
const ceiling = (tier, where, machine, config, platform) =>
  resolveCeiling(tier, { path: where, machine, config, platform, trust: { authors: [{ owner: true }], guests: false } })

// The tiers this machine can reach: no team unless it names one.
const tiersOf = (machine) => (machine.trustTeam && machine.trustTeam !== 'none' ? ['solo', 'team', 'open'] : ['solo', 'open'])

// Everything `status` prints: the resolved objects per path and tier, and
// the link. agentStatusData turns them into the --json output.
async function collect(flags, { env = process.env, cwd = process.cwd(), fetchImpl = fetch, platform = hostPlatform() } = {}) {
  if (!isRemote(flags, env)) {
    const config = configAt(flags, cwd, { required: true })
    const { entry, problem } = userAgentEntry(config.dir, env)
    if (problem) throw new Error(problem)
    const machine = localMachinePolicy(entry)
    return {
      kind: 'local',
      project: config.dir,
      as: null,
      tiers: Object.fromEntries(['solo', 'open'].map((tier) => [tier, ceiling(tier, 'local-chat', machine, config, platform)])),
    }
  }
  const origin = remoteOrigin(flags, env)
  const slug = slugOf(flags)
  const warnings = []
  const machine = readMachinePolicy(origin, slug, env, { warn: (text) => warnings.push(text) })
  const config = configAt(flags, cwd, { required: false })
  const as = slug === 'default' ? null : slug
  const paths = {}
  for (const [key, where] of CONNECTED_PATHS)
    paths[key] = Object.fromEntries(tiersOf(machine).map((tier) => [tier, ceiling(tier, where, machine, config, platform)]))
  const saved = readAgentCredential(origin, slug, env)
  let link = { state: 'no_token', agent: saved?.agent?.name || saved?.tokenName || null, error: null }
  if (saved) {
    try {
      const remote = createRemote({ origin, token: saved.token, fetchImpl })
      const info = await Promise.race([
        remote.project(),
        new Promise((resolve, reject) =>
          setTimeout(() => reject(new Error('the server did not answer in 5 seconds')), LIVE_TIMEOUT_MS).unref?.(),
        ),
      ])
      link = {
        state: info.agent ? info.agent.state : 'unknown',
        agent: info.agent?.name || link.agent,
        project: info.project?.name || null,
        workspace: info.workspace?.name || null,
        error: null,
      }
    } catch (error) {
      link = { ...link, state: 'unreachable', error: String(error?.message || error) }
    }
  }
  return { kind: 'connected', origin, as: slug, fixAs: as, warnings, link, paths }
}

const panels = (byTier, as) => Object.fromEntries(Object.entries(byTier).map(([tier, caps]) => [tier, toPanel(caps, { as })]))

// The --json output: each tier as the console card's panel (toPanel).
export async function agentStatusData(flags, deps = {}) {
  const data = await collect(flags, deps)
  if (data.kind === 'local') return { kind: 'local', project: data.project, tiers: panels(data.tiers, null) }
  const { fixAs, paths, ...rest } = data
  return { ...rest, paths: Object.fromEntries(Object.entries(paths).map(([key, byTier]) => [key, panels(byTier, fixAs)])) }
}

const LINK_WORDS = {
  online: 'open (online)',
  busy: 'open (working)',
  offline: 'not open: run shapewall agent connect to open it',
  revoked: 'refused: its token was revoked. Run shapewall agent connect to get a new one approved',
  unknown: 'the server did not say (an older Shapewall there)',
}

export async function agentStatus(flags, out, err, deps = {}) {
  if (flags.json) {
    out(JSON.stringify(await agentStatusData(flags, deps), null, 2))
    return 0
  }
  const data = await collect(flags, deps)
  if (data.kind === 'local') {
    out(`Local board in ${data.project}: what an agent can do here.`)
    for (const tier of ['solo', 'open']) {
      out('')
      out(tier === 'solo' ? 'Turns by you (the owner of this board):' : 'Turns by anyone else on the board:')
      for (const line of toCli(data.tiers[tier])) out(`  ${line}`)
    }
    return 0
  }
  for (const text of data.warnings) err(`Not understood, so read as the narrowest setting: ${text}`)
  const link = data.link
  out(`Connection "${data.as}" to ${data.origin}${link.agent ? `, agent "${link.agent}"` : ''}`)
  out(
    `Link: ${
      link.state === 'no_token'
        ? 'no saved token on this machine. Run shapewall agent connect to connect it'
        : link.state === 'unreachable'
          ? `could not ask the server (${link.error})`
          : LINK_WORDS[link.state] || link.state
    }`,
  )
  for (const [key, , label] of CONNECTED_PATHS)
    for (const [tier, caps] of Object.entries(data.paths[key])) {
      out('')
      out(`${label}, ${TIER_LABELS[tier].toLowerCase()} turns:`)
      for (const line of toCli(caps, { as: data.fixAs })) out(`  ${line}`)
    }
  out('')
  out('Change a line with the command under it. The board shows the same lines in the console, under What it can do.')
  return 0
}

// ---- agent set ----

// The policy file keys `agent connect` sets with a flag of the same name.
const CONNECT_KEYS = {
  audience: 'audience',
  approvals: 'approvals',
  instructions: 'instructions',
  'agent-config': 'agent-config',
  'allow-command': 'allow-command',
  'allow-path': 'allow-path',
  auto: 'auto',
  base: 'base',
  respond: 'respond',
  remote: 'git-remote',
  'git-remote': 'git-remote',
}
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const CAPABILITY_FLAGS = Object.fromEntries(CAPABILITY_KEYS.map((key) => [kebab(key), key]))
const BOOLEAN_KEYS = ['trustTeamShell', 'shellUnsandboxed', 'browserProfileTeam']
const LIST_KEYS = ['browserAllow', 'extensionsFor', 'allowTool']

// One value from the command line, as the policy file holds it.
function capabilityValue(key, raw) {
  const text = String(raw)
  if (BOOLEAN_KEYS.includes(key)) {
    if (['on', 'true', 'yes'].includes(text)) return true
    if (['off', 'false', 'no'].includes(text)) return false
    throw new Error(`${kebab(key)}: on or off`)
  }
  if (LIST_KEYS.includes(key)) return text === 'none' ? [] : text.split(',').map((item) => item.trim())
  if (key === 'trustTeam') return ['none', 'members'].includes(text) ? text : text.split(',').map((item) => item.trim())
  if (key === 'handoffHops') return /^\d+$/.test(text) ? Number(text) : NaN
  if ((key === 'browserAuth' || key === 'browserProfile') && text === 'none') return null
  return text
}
function capabilityChange(name, raw) {
  const key = CAPABILITY_FLAGS[name]
  const value = capabilityValue(key, raw)
  let problem = null
  const cleaned = cleanCapabilityKeys({ [key]: value }, { warn: (_, said) => (problem = said) })
  if (problem) throw new Error(`${name}: not a value this setting takes (it would read as ${problem})`)
  return { [key]: cleaned[key] }
}

export const SET_KEYS = [...Object.keys(CONNECT_KEYS), ...Object.keys(CAPABILITY_FLAGS)]
const SET_USAGE = `usage: shapewall agent set KEY VALUE [--as NAME] [--remote URL]. KEY: ${SET_KEYS.join(', ')}`

export async function agentSet(positional, flags, out, err, { env = process.env, cwd = process.cwd() } = {}) {
  const [, name, raw] = positional
  if (!name || raw === undefined || positional.length > 3) throw new Error(SET_USAGE)
  if (!SET_KEYS.includes(name)) throw new Error(`Not a setting: ${name}. ${SET_USAGE}`)
  if (!isRemote(flags, env)) {
    if (!CAPABILITY_FLAGS[name])
      throw new Error(`${name} is set per connection: add --remote URL. A local board's agent has its own settings in Settings > Agents.`)
    const config = configAt(flags, cwd, { required: true })
    const change = capabilityChange(name, raw)
    updateUserAgentEntry(config.dir, (entry) => ({ ...entry, capabilities: { ...(entry.capabilities || {}), ...change } }), env)
    out(`Saved ${name} ${raw} for the local board in ${config.dir}. The next turn uses it.`)
    out('See every line: shapewall agent status')
    return 0
  }
  const origin = remoteOrigin(flags, env)
  const slug = slugOf(flags)
  const saved = readMachinePolicy(origin, slug, env)
  let changes
  if (CONNECT_KEYS[name]) {
    const { policyChanges } = await import('../remote/agent-connect.js')
    changes = policyChanges({ [CONNECT_KEYS[name]]: raw }, saved, null, { cwd })
  } else changes = capabilityChange(name, raw)
  saveMachinePolicy(origin, slug, changes, env)
  const where = `--remote ${origin}${slug === 'default' ? '' : ` --as ${slug}`}`
  out(`Saved ${name} ${raw} for connection "${slug}" to ${origin}.`)
  out(`A running shapewall agent connect uses it once it connects again. See every line: shapewall agent status ${where}`)
  return 0
}
