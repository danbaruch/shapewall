// The "What it can do" card, worked out on the server or the local board
// for the console, the board's agent panel and `shapewall agent status`.
// Nothing here decides a turn: the lines come from capability-render.js
// (lines and toPanel for a resolved object, or the line states a connected
// machine sent in hello), so the three views list the same lines with the
// same states. The client only draws what it is given.
//
// The card's shape (client/src/console/components/CapabilityCard.jsx):
//   { v: 1, paths: [{ id, label, tiers: [{ tier, label, limitedTo, lines }] }] }
//   lines: [{ id, label, state, text, why, fix, narrowed }] or null
//          (null: the tier does not exist on that machine, or the project
//          holds every turn below it, see limitedTo)
//   state: "on", "ask", "off" or "unknown" (the machine did not say)
//   fix:   the command that changes the line on the agent's machine, or null

import { TIERS, cleanNarrowing, hostPlatform, resolveCeiling, tierOf, tierRank } from './capabilities.js'
import { LINE_IDS, LINE_LABELS, SUMMARY_PATHS, toPanel } from './capability-render.js'

export const TIER_LABELS = { solo: 'Solo', team: 'Team', open: 'Open' }
export const PATH_LABELS = { chat: 'In chat', fix: 'In Fix with', local: 'On this board' }
// Solo first: what the person who connected it gets.
const TIER_ORDER = [...TIERS].reverse()
export const LIMITED = "limited by this project's setting"

// One sentence per line and state, for a machine's summary: the summary
// carries states only (no commands, handles or paths), so these say what
// the state means, never details the board was not told.
const SUMMARY_TEXT = {
  who: {
    solo: 'Turns that only the person who connected it wrote.',
    team: "Turns where everyone who wrote is on its machine's trusted list.",
    open: 'Turns where someone outside the trusted list wrote too.',
  },
  instructions: { on: "Reads the project's CLAUDE.md or AGENTS.md.", off: 'No instruction files.' },
  read: { on: "Reads, searches and lists the project's files.", off: 'No read tools.' },
  edits: { on: 'Edits inside its container.', ask: 'Edits in a fix copy of its own, each asked on the board.', off: 'No edits.' },
  commands: {
    on: 'Runs the named commands from shapewall.config.json, and asks again when they change.',
    ask: 'Asks on the board before each named command.',
    off: 'No named commands.',
  },
  shell: {
    on: 'A full shell in the fix copy, inside an OS sandbox.',
    ask: 'Only exact commands, each asked on the board.',
    off: 'No shell.',
  },
  browser: { on: "A throwaway headless browser, limited to the app's own addresses.", off: 'No browser.' },
  extensions: { on: 'Skills and MCP servers from its agent config folder.', off: 'No extensions.' },
  memory: { on: 'Memory tools given by exact name. Automatic memory stays off.', off: 'No memory.' },
  push: { ask: 'Pushes and opens pull requests only after a card on the board.', off: 'No push.' },
  handoff: { on: 'Hands work to another connected agent.', off: 'No handoff.' },
  chrome: { off: 'Never your own Chrome or its profile.' },
}
// The machine allows the browser without Chromium's own sandbox (solo and
// team turns only, as capabilities.js resolves it).
const NO_SANDBOX_TEXT =
  " Where Chromium's own sandbox cannot start on its machine, it starts without it (the owner chose browser-no-sandbox)."
const UNKNOWN_TEXT = 'Its machine did not say (an older Shapewall there). Update it and connect again.'

// The setting on the agent's machine that turns a line on, for a summary
// line that is not on (the summary has no reasons, so it is the usual one).
const SUMMARY_FIX = {
  instructions: ['instructions', 'all'],
  edits: ['approvals', 'owner'],
  commands: ['shell', 'sandboxed'],
  shell: ['shell', 'sandboxed'],
  browser: ['browser', 'on'],
  extensions: ['agent-config', 'DIR'],
  memory: ['allow-tool', 'mcp__SERVER__TOOL'],
  push: ['remote', 'origin'],
}
const setCommand = ([key, value], remote) => `shapewall agent set ${key} ${value}${remote ? ` --remote ${remote}` : ''}`

const summaryText = (id, state, tier) => {
  if (state === 'unknown') return UNKNOWN_TEXT
  if (id === 'who') return SUMMARY_TEXT.who[tier]
  return SUMMARY_TEXT[id]?.[state] || SUMMARY_TEXT[id]?.off || ''
}

// The lines of one tier of a summary, with the project's narrowing laid
// over them the way the machine applies it (capabilities.js: no shell
// means no commands and no shell; no browser means no browser).
function summaryLines(states, tier, { narrowing, remote, noSandbox = false }) {
  return LINE_IDS.map((id) => {
    let state = states[id] || 'unknown'
    let narrowed = false
    if (narrowing && ((!narrowing.shell && (id === 'commands' || id === 'shell')) || (!narrowing.browser && id === 'browser'))) {
      state = 'off'
      narrowed = true
    }
    const fixable = !narrowed && state !== 'on' && state !== 'unknown' && SUMMARY_FIX[id]
    return {
      id,
      label: LINE_LABELS[id],
      state,
      text: summaryText(id, state, tier) + (id === 'browser' && state === 'on' && noSandbox && tier !== 'open' ? NO_SANDBOX_TEXT : ''),
      why: narrowed ? [LIMITED] : [],
      fix: fixable ? setCommand(SUMMARY_FIX[id], remote) : null,
      narrowed,
    }
  })
}

// A connected agent's card from the summary its machine sent at hello
// (cleanCapabilitySummary) and the project's narrowing (cleanNarrowing
// input). `remote`: this server's address, for the copyable commands.
// null: an agent that sent no summary (an older machine, or a watcher).
export function summaryCard(summary, { narrowing = null, remote = null } = {}) {
  if (!summary || summary.v !== 1) return null
  const narrow = cleanNarrowing(narrowing)
  return {
    v: 1,
    team: summary.team,
    paths: Object.keys(SUMMARY_PATHS).map((key) => ({
      id: key,
      label: PATH_LABELS[key],
      tiers: TIER_ORDER.map((tier) => {
        const states = summary[key]?.[tier]
        if (narrow && tierRank(tier) > tierRank(narrow.maxTier))
          return { tier, label: TIER_LABELS[tier], limitedTo: narrow.maxTier, lines: null }
        return {
          tier,
          label: TIER_LABELS[tier],
          limitedTo: null,
          lines: states ? summaryLines(states, tier, { narrowing: narrow, remote, noSandbox: summary.browserNoSandbox === true }) : null,
        }
      }),
    })),
  }
}

// The tier a turn this viewer wrote alone would reach, as far as the
// server can tell from the summary: the same rule as tierOf, with what
// the board knows of the machine (its audience setting, and whether its
// team is "members"; a named team's handles never reach the board, so a
// viewer is not counted in one).
export function viewerTier(summary, { audience, machineAudience, owner, narrowing = null }) {
  const machine = {
    audience: machineAudience === 'owner' ? 'owner' : 'server',
    trustTeam: summary?.team === 'members' ? 'members' : 'none',
  }
  return tierOf({
    trust: { authors: [{ owner: Boolean(owner), member: true, handle: null }], guests: false },
    audience,
    machine,
    server: narrowing,
  }).tier
}

// The compact view for the board's agent panel: one tier of one path.
export function compactCard(card, { path = 'fix', tier }) {
  const lines = card?.paths.find((item) => item.id === path)?.tiers.find((item) => item.tier === tier)?.lines
  if (!lines) return null
  return {
    path,
    pathLabel: PATH_LABELS[path],
    tier,
    tierLabel: TIER_LABELS[tier],
    lines: lines.map(({ id, label, state, narrowed }) => ({ id, label, state, narrowed })),
  }
}

// A local board's card: the resolved object itself (toPanel), for its
// owner (solo) and for everyone else on it (open). `machine`: the local
// machine policy (user-settings.js localMachinePolicy).
export function localCard({ machine, config = null, platform = hostPlatform(), extensions = null, agent = null }) {
  return {
    v: 1,
    team: 'none',
    paths: [
      {
        id: 'local',
        label: PATH_LABELS.local,
        tiers: ['solo', 'open'].map((tier) => ({
          tier,
          label: TIER_LABELS[tier],
          limitedTo: null,
          lines: toPanel(
            resolveCeiling(tier, {
              path: 'local-chat',
              machine,
              config,
              platform,
              trust: { authors: [{ owner: true }], guests: false },
              extensions,
              agent,
            }),
          ).lines,
        })),
      },
    ],
  }
}
