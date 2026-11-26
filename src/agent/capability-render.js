// Three views of one resolved capability object (src/agent/capabilities.js):
// the console's "What it can do" card (toPanel), `shapewall agent status`
// (toCli) and the block appended to the agent's own instructions (toPrompt).
// All three come from lines(), so they list the same lines with the same
// on, ask or off state; a test holds them to that.
//
// A line's state: "on" (it may, without asking), "ask" (only after a person
// answers a card on the board), "off" (never on this turn). Each off line
// says why, and where the machine can change it, the command that does.

import { TIERS, resolveCeiling, machineView } from './capabilities.js'

export const LINE_IDS = [
  'who',
  'instructions',
  'read',
  'edits',
  'commands',
  'shell',
  'browser',
  'extensions',
  'memory',
  'push',
  'handoff',
  'chrome',
]
export const LINE_STATES = ['on', 'ask', 'off']
// The board's copy of a machine's summary: a state it could not read is "unknown", never a guess.
export const SUMMARY_STATES = [...LINE_STATES, 'unknown']
export const LINE_LABELS = {
  who: 'Who can use it',
  instructions: 'Instructions',
  read: 'Read tools',
  edits: 'Edits',
  commands: 'Named commands',
  shell: 'Shell',
  browser: 'Browser',
  extensions: 'Extensions',
  memory: 'Memory',
  push: 'Push and pull requests',
  handoff: 'Hand off to another agent',
  chrome: 'Your own Chrome',
}

const TIER_TEXT = {
  solo: 'Solo: only the person who connected it wrote this turn.',
  team: "Team: everyone who wrote this turn is on this machine's trusted list.",
  open: 'Open: someone outside the trusted list wrote part of this turn, so it gets the narrowest tools.',
}

// Why a line is off (or narrower), as a sentence and the setting that changes it.
// `set`: [key, value] for `shapewall agent set KEY VALUE`. `server`: the project's
// setting on the server holds it; only an admin there can change it.
export const REASONS = {
  no_trust: { text: 'the server did not say who wrote this turn, so it is treated as open' },
  guests: { text: 'a share-link guest wrote part of this turn' },
  outside_authors: { text: "someone outside this machine's trusted list wrote part of this turn", set: ['trust-team', 'HANDLE,...'] },
  audience_not_owner: { text: 'solo needs an agent only the person who connected it can use', set: ['audience', 'owner'] },
  team_turn: { text: 'people on the trusted list wrote this turn' },
  thread_taint: { text: 'this thread once carried text from outside the trusted list' },
  server_max_tier: { text: "limited by this project's setting", server: true },
  unknown_path: { text: 'Shapewall does not know this way of reaching the agent' },
  machine_instructions_none: { text: 'this machine gives the agent no instruction files', set: ['instructions', 'all'] },
  chat_answer_only: { text: 'chat answers only; edits happen in Fix with' },
  machine_approvals_none: {
    text: 'this machine reads and answers only: nobody may answer its requests on the board',
    set: ['approvals', 'owner'],
  },
  edits_off: { text: 'a command that changes files, or a full shell, needs edits, and edits are off here' },
  // Handing work to another agent is not built yet: no setting turns it on.
  machine_handoff_none: { text: 'handing work to another agent is not available yet' },
  machine_shell_off: { text: 'this machine allows no commands', set: ['shell', 'sandboxed'] },
  server_shell_off: { text: "limited by this project's setting", server: true },
  no_named_commands: { text: 'the config names no commands (add "commands" to shapewall.config.json)' },
  chat_mutating_only: { text: 'chat runs only commands marked "mutating": false' },
  chat_not_solo: { text: 'in chat, only on turns only its owner wrote' },
  no_sandbox: { text: 'no OS sandbox on this machine, so each command waits for a card (install bubblewrap)' },
  chat_no_shell: { text: 'chat has no shell' },
  in_place_commands: {
    text: 'edits land in your checkout itself, so commands run only in a copy: turn on Work on a branch to give the agent commands',
  },
  edits_without_fd_checks: {
    text: 'on this system Shapewall cannot check where a file write really lands once a command has run, so an agent that edits gets no commands (Linux only in 1.4.0)',
  },
  no_sandbox_read_only: { text: 'read-only commands need the OS sandbox, and there is none on this machine (install bubblewrap)' },
  machine_shell_commands: { text: 'this machine allows named commands only', set: ['shell', 'sandboxed'] },
  team_shell_off: { text: 'the team gets no full shell unless this machine says so', set: ['trust-team-shell', 'on'] },
  open_tier_shell: { text: 'open turns get no full shell' },
  // Exact commands are dropped for every agent in this release (agent-connect.js COMMANDS_PROVEN),
  // so no setting turns them on.
  no_exact_commands: { text: 'exact commands are not available for connected agents in this release' },
  machine_browser_off: { text: 'this machine allows no browser', set: ['browser', 'on'] },
  server_browser_off: { text: "limited by this project's setting", server: true },
  login_not_this_tier: { text: 'the logged-in browser is not for this tier, so the browser starts without a login' },
  // `set` as a function: the command names the very origins held back.
  // browser-allow replaces the machine's list, so the sentence says to keep
  // the ones it already has.
  loopback_not_listed: {
    text:
      'an address on this machine that the committed config names (a loopback address, localhost or a local name) opens only where this machine lists that exact origin too; ' +
      'add it to the origins this machine already allows',
    set: (caps) => ['browser-allow', caps.browser.withheld?.length ? caps.browser.withheld.join(',') : 'ORIGIN'],
  },
  private_not_listed: {
    text:
      "on open turns an address on this machine's networks that the committed config names (a LAN or tailnet address) opens only where this machine lists that exact origin too; " +
      'add it to the origins this machine already allows',
    set: (caps) => ['browser-allow', caps.browser.withheld?.length ? caps.browser.withheld.join(',') : 'ORIGIN'],
  },
  open_tier_browser_sandbox: { text: "on open turns the browser never starts without Chromium's own sandbox" },
  never_real_chrome: { text: 'never: an agent only gets a throwaway browser of its own' },
  path_no_extensions: { text: 'not on this path' },
  open_tier_extensions: { text: 'never on open turns' },
  agent_not_claude: { text: 'only Claude Code takes extensions' },
  session_unrestricted: { text: 'not in the agent\'s own full session (agent.localSession "own"): only the restricted one' },
  extensions_build_failed: { text: 'its skills could not be copied for this turn (see the server log)' },
  no_agent_config: { text: 'no agent config folder', set: ['agent-config', 'DIR'] },
  extensions_not_for_owner: { text: 'extensions are not switched on for the owner', set: ['extensions-for', 'owner'] },
  extensions_not_for_team: { text: 'not everyone who wrote this turn is in the extensions list', set: ['extensions-for', 'owner,HANDLE'] },
  no_extensions_found: { text: 'its agent config folder holds no skills or MCP servers Shapewall loads' },
  thread_tainted: {
    text: 'this thread once carried text nobody on the extensions list wrote (or its history is not known), so it never gets them',
  },
  extensions_not_for_thread: {
    text: 'someone not on the extensions list wrote earlier in this thread',
    set: ['extensions-for', 'owner,HANDLE'],
  },
  memory_off: { text: 'automatic memory is off; a memory tool needs its exact name', set: ['allow-tool', 'mcp__SERVER__TOOL'] },
  machine_remote_none: { text: 'this machine pushes nowhere', set: ['remote', 'origin'] },
}

const command = (set, as) => `shapewall agent set ${set[0]} ${set[1]}${as ? ` --as ${as}` : ''}`
const setOf = (reason, caps) => (typeof reason.set === 'function' ? reason.set(caps) : reason.set)

const list = (items) => items.join(', ')
const reasonOf = (caps, line) => caps.why.filter((item) => item.line === line).map((item) => REASONS[item.code] || { text: item.code })

// The Extensions line when it is on: what the folder holds, by name, and
// which of its tools run (every other tool of its servers is refused).
export function extensionsText(ext) {
  const skills = ext.skills || []
  const servers = ext.servers || []
  const parts = []
  if (skills.length) parts.push(`skills ${list(skills)}`)
  if (servers.length) parts.push(`MCP servers ${list(servers)}`)
  const held = parts.length ? parts.join('; ') : 'nothing'
  const tools = ext.tools.length
    ? `Tools it may call: ${list(ext.tools)}; every other tool of those servers is refused.`
    : servers.length
      ? 'None of their tools is allowed yet (shapewall agent set allow-tool mcp__SERVER__TOOL).'
      : ''
  return `From its agent config folder: ${held}.${tools ? ` ${tools}` : ''}`
}

function lineFor(caps, id) {
  const reasons = reasonOf(caps, id)
  let state = 'off'
  let text = ''
  switch (id) {
    case 'who':
      state = caps.path ? 'on' : 'off'
      text = caps.path ? TIER_TEXT[caps.tier] : 'Nothing: an unknown path.'
      break
    case 'instructions':
      state = caps.instructions.on ? 'on' : 'off'
      text = caps.instructions.on
        ? caps.instructions.files === 'all'
          ? "The project's CLAUDE.md or AGENTS.md and its agent config folder's."
          : "The project's CLAUDE.md or AGENTS.md."
        : 'No instruction files.'
      break
    case 'read':
      state = caps.read ? 'on' : 'off'
      text = caps.read ? 'Reads, searches and lists files of the project.' : 'No read tools.'
      break
    case 'edits':
      if (caps.edit.on) {
        state = caps.edit.where === 'container' ? 'on' : 'ask'
        const where = {
          copy: 'in a fix copy of its own, never this checkout',
          checkout: 'in this checkout (the config chose it)',
          container: 'inside its container',
        }[caps.edit.where]
        text = `Edits ${where}${state === 'ask' ? `, each asked on the board (answered by ${caps.edit.approvals === 'admins' ? 'the people the server lets answer' : 'the person who connected it'})` : ''}.`
      } else text = 'No edits.'
      break
    case 'commands': {
      const free = caps.commands.filter((item) => !item.needsCard).map((item) => item.name)
      const asked = caps.commands.filter((item) => item.needsCard).map((item) => item.name)
      state = free.length ? 'on' : asked.length ? 'ask' : 'off'
      text = caps.commands.length
        ? [free.length && `Runs ${list(free)}`, asked.length && `${free.length ? 'asks first for' : 'Asks first for'} ${list(asked)}`]
            .filter(Boolean)
            .join('; ') + '. Asks again when the command or its inputs change.'
        : 'No named commands.'
      break
    }
    case 'shell':
      state = { sandboxed: 'on', unsandboxed: 'on', container: 'on', exact: 'ask', off: 'off' }[caps.shell.mode] || 'off'
      text = {
        sandboxed: `A full shell in the fix copy, inside an OS sandbox (network: ${caps.shell.network}).`,
        unsandboxed: `A full shell WITHOUT an OS sandbox (the owner ran agent set shell-unsandboxed on; network: ${caps.shell.network}).`,
        container: 'Commands inside its container.',
        exact: `Only these exact commands, each asked on the board: ${list(caps.shell.exact.map((item) => `"${item}"`))}.`,
        off: 'No shell.',
      }[caps.shell.mode]
      break
    case 'browser':
      state = caps.browser.on ? 'on' : 'off'
      text = caps.browser.on
        ? `A throwaway headless browser limited to ${caps.browser.allow.length ? list(caps.browser.allow) : "the app's own addresses"}${caps.browser.auth ? `, logged in as "${caps.browser.auth}"` : ''}${caps.browser.profile ? ', with its own saved profile' : ''}.` +
          (caps.browser.withheld?.length
            ? ` Not ${list(caps.browser.withheld)}: an address on this machine from the config${caps.tier === 'open' ? ' (or on its networks)' : ''}, which this machine does not list for this tier.`
            : '') +
          (caps.browser.allowNoSandbox
            ? " Where Chromium's own sandbox cannot start on this machine, it starts without it (the owner chose browser-no-sandbox); pages then run with less isolation."
            : '')
        : 'No browser.'
      break
    case 'extensions':
      state = caps.extensions.on ? 'on' : 'off'
      text = caps.extensions.on ? extensionsText(caps.extensions) : 'No extensions.'
      break
    case 'memory':
      state = caps.memory.write.length ? 'on' : 'off'
      text = caps.memory.write.length ? `Memory tools named exactly: ${list(caps.memory.write)}. Automatic memory stays off.` : 'No memory.'
      break
    case 'push':
      state = caps.push.on ? 'ask' : 'off'
      text = caps.push.on
        ? `Pushes and opens pull requests only after a card on the board${caps.push.remote ? ` (remote "${caps.push.remote}")` : ''}.`
        : 'No push.'
      break
    case 'handoff':
      state = caps.handoff.hops > 0 ? 'on' : 'off'
      text =
        caps.handoff.hops > 0
          ? `Hands work to another connected agent, at most ${caps.handoff.hops} ${caps.handoff.hops === 1 ? 'hop' : 'hops'} deep.`
          : 'No handoff.'
      break
    case 'chrome':
      state = 'off'
      text = 'Never your own Chrome or its profile.'
      break
  }
  return { id, state, text, reasons }
}

// The lines of one resolved object: [{ id, label, state, text, why, fix, narrowed }].
// `as`: the connection name, for the copyable command.
export function lines(caps, { as = null } = {}) {
  return LINE_IDS.map((id) => {
    const { state, text, reasons } = lineFor(caps, id)
    const narrowed = caps.narrowed.includes(id) || reasons.some((reason) => reason.server)
    const fixable = reasons.find((reason) => reason.set)
    return {
      id,
      label: LINE_LABELS[id],
      state,
      text,
      why: reasons.map((reason) => reason.text),
      // Lines the project's setting holds: only an admin there changes them.
      fix: narrowed || !fixable ? null : command(setOf(fixable, caps), as),
      narrowed,
    }
  })
}

// Just the states: { who: "on", ... }.
export const lineStates = (caps) => Object.fromEntries(lines(caps).map((line) => [line.id, line.state]))

// The console card and the board's agent panel.
export function toPanel(caps, { as = null } = {}) {
  return { version: 1, tier: caps.tier, path: caps.path, enforced: caps.enforced, lines: lines(caps, { as }) }
}

// `shapewall agent status`: one line each, the state first.
export function toCli(caps, { as = null } = {}) {
  const out = [`Tier: ${caps.tier}${caps.enforced ? '' : ' (not enforced: the program you run is its own boundary)'}`]
  for (const line of lines(caps, { as })) {
    const why = line.why.length ? ` (${line.why.join('; ')})` : ''
    out.push(`  ${line.state.padEnd(4)}${line.label}: ${line.text}${line.state === 'on' ? '' : why}`)
    if (line.fix) out.push(`        change: ${line.fix}`)
  }
  return out
}

// The block appended after the instruction files: what the agent can do
// here, so "what can you do?" has a true answer.
export function toPrompt(caps, { as = null } = {}) {
  const all = lines(caps, { as })
  const section = (state) => all.filter((line) => line.state === state).map((line) => `- ${line.label}: ${line.text}`)
  const fixes = all.filter((line) => line.fix).map((line) => `- ${line.label}: ${line.fix}`)
  const out = [`On this board (tier: ${caps.tier}) you can:`, ...section('on')]
  const asked = section('ask')
  if (asked.length) out.push('Only after a person answers a card on the board:', ...asked)
  out.push('You cannot:', ...section('off'))
  if (fixes.length) out.push('To change this, the owner runs:', ...fixes)
  if (all.some((line) => line.narrowed)) out.push("Lines marked by the project's setting change only on the server, by an admin.")
  return out.join('\n')
}

// What a connected agent's machine tells the board at hello: the ceiling
// per tier, for chat and for Fix with, as line states only (no commands,
// handles or paths). The board shows it; it never decides anything there.
export const SUMMARY_PATHS = { chat: 'hosted-chat', fix: 'hosted-fix' }
export function capabilitySummary({ machine, config = null, platform = null, extensions = null, agent = null }) {
  const m = machineView(machine)
  const team = m.trustTeam === 'members' ? 'members' : Array.isArray(m.trustTeam) ? 'named' : 'none'
  // browserNoSandbox: the browser on solo and team turns may start without
  // Chromium's own sandbox where it cannot start (an older server drops it).
  const out = { v: 1, team, browserNoSandbox: m.browser === 'on' && m.browserNoSandbox === true }
  for (const [key, where] of Object.entries(SUMMARY_PATHS)) {
    out[key] = {}
    for (const tier of [...TIERS].reverse()) {
      // A machine without a team never reaches the team tier.
      out[key][tier] =
        tier === 'team' && team === 'none'
          ? null
          : lineStates(
              resolveCeiling(tier, {
                path: where,
                machine,
                config,
                platform,
                trust: { authors: [{ owner: true }], guests: false },
                extensions,
                agent,
              }),
            )
    }
  }
  return out
}

// The summary as the server keeps it: known paths, tiers and lines only,
// each state one of LINE_STATES; a state it does not know, or one that is
// missing (an older or newer machine), is "unknown": the board says it
// cannot tell, rather than guessing either way. null: none given.
export function cleanCapabilitySummary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null
  const out = { v: 1, team: ['members', 'named'].includes(raw.team) ? raw.team : 'none', browserNoSandbox: raw.browserNoSandbox === true }
  for (const key of Object.keys(SUMMARY_PATHS)) {
    out[key] = {}
    const given = raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key]) ? raw[key] : {}
    for (const tier of [...TIERS].reverse()) {
      const states = given[tier]
      if (tier === 'team' && (out.team === 'none' || states === null)) {
        out[key][tier] = null
        continue
      }
      const valid = states && typeof states === 'object' && !Array.isArray(states) ? states : {}
      out[key][tier] = Object.fromEntries(LINE_IDS.map((id) => [id, LINE_STATES.includes(valid[id]) ? valid[id] : 'unknown']))
      // Never more than a machine can say: its own Chrome is always off.
      out[key][tier].chrome = 'off'
    }
  }
  return out
}
