// The demo's fictional history: about sixty days of agent turns and the
// activity that goes with them, made in the browser from a seeded generator
// and placed relative to today, so it never reads as stale. The same day and
// the same clock always give the same rows.
//
// Rows have the columns the server keeps (agent_runs, audit_log): numbers and
// ids only, never text. So the same rows can be put into a real server's
// database, which is how test/demo-usage.test.js holds the demo's answers
// against src/hosted/usage.js.
//
// The shape of the history:
//   - busy weekdays, quiet weekends, the recent weeks busier than the first
//     (each agent has turns only from the day it was connected)
//   - three spikes (a release day), and a quiet stretch (two days with next
//     to nothing, running into a weekend)
//   - a day when most turns failed
//   - chat, comment answers, fixes and a few pushes; outcomes of every group
//   - approvals asked, allowed, denied and allowed without asking
//   - one agent reports tokens and a cost, one tokens only, one nothing
//   - durations with a long tail

const DAY = 86_400_000
const HOUR = 3_600_000

// A small seeded generator (mulberry32): the same data every run.
export function generator(seed = 7) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hexOf = (random, length) => {
  let out = ''
  while (out.length < length) out += Math.floor(random() * 16).toString(16)
  return out
}
const weighted = (random, items) => {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let roll = random() * total
  for (const item of items) {
    roll -= item.weight
    if (roll < 0) return item
  }
  return items.at(-1)
}
const iso = (ms) => new Date(ms).toISOString()
// Monday is 0. Day 0 (1970-01-01) was a Thursday.
const weekdayOf = (day) => (((day + 3) % 7) + 7) % 7

// The days that stand out, counted from the last Wednesday at least four
// days back: so each of them is a working day, and the default 30 days show
// two spikes, the quiet stretch and the day of failures.
export function historyMarks(today) {
  let wednesday = today - 4
  while (weekdayOf(wednesday) !== 2) wednesday -= 1
  return {
    spikes: new Map([
      [wednesday, 2.2],
      [wednesday - 15, 1.8],
      [wednesday - 36, 1.9],
    ]),
    quiet: new Set([wednesday - 6, wednesday - 5]),
    failures: wednesday - 9,
  }
}

const PATHS = [
  'src/pages/pricing.html',
  'src/styles/buttons.css',
  'src/components/PlanCard.jsx',
  'src/pages/index.html',
  'src/styles/tokens.css',
]
const PRICE = { 'opus-max': 5, 'sonnet-large': 1 }

// One turn. `random` is the day's own generator.
function turn(world, random, { day, age, start, failing, agents }) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const agent = weighted(random, agents)
  const roll = random()
  const kind = roll < 0.52 ? 'chat' : roll < 0.74 ? 'review' : roll < 0.96 ? 'fix' : 'push'
  const fix = kind === 'fix' || kind === 'push'
  // Who asked: nobody for a few comment answers (sent on their own), and
  // someone who has since left for some of the older ones.
  let asker = weighted(random, world.people).id
  if (kind === 'review' && random() < 0.06) asker = null
  else if (age > world.former.leftDays && random() < 0.07) asker = world.former.id
  const comment = kind === 'chat' ? null : 1 + Math.floor(random() * 14)
  // A person's private chats: a few per stretch of days, so some grow long.
  const chat = `chat-${hexOf(generator((world.people.findIndex((item) => item.id === asker) + 2) * 7919 + Math.floor(day / 9) * 31 + Math.floor(random() * 4)), 16)}`
  const thread = kind === 'chat' ? (random() < 0.4 ? 'board' : chat) : `comment-${comment}`
  // A long tail: most turns take seconds, a few take many minutes.
  const spread = Math.exp(1.3 * (random() + random() + random() - 1.5))
  const durationMs = Math.round((fix ? 48_000 : kind === 'review' ? 11_000 : 6500) * spread * (random() < 0.03 ? 6 + random() * 14 : 1))

  const asked = fix && random() < 0.62 ? 1 + Math.floor(random() * 4) : fix ? 0 : null
  // An agent whose rule is "allow without asking" mostly is not held up.
  const auto = asked
    ? random() < (agent.rule === 'auto' ? 0.8 : 0.12)
      ? Math.min(asked, 1 + Math.floor(random() * 3))
      : 0
    : asked === null
      ? null
      : 0
  const denied = asked ? (random() < 0.18 ? Math.min(asked - auto, 1 + Math.floor(random() * 2)) : 0) : asked
  const allowed = asked === null ? null : asked - denied
  const answerer = pick(world.people.filter((item) => item.answers)).id
  const waited = asked ? allowed - auto + denied : 0
  const by = waited > 0 ? JSON.stringify({ [answerer]: { allowed: allowed - auto, denied } }) : null

  const outcomeRoll = random()
  let outcome
  if (failing) outcome = pick(['failed', 'failed', 'interrupted'])
  else if (outcomeRoll < 0.05) outcome = 'stopped'
  else if (kind === 'push') outcome = 'done'
  else if (kind === 'fix') {
    if (denied && outcomeRoll < 0.45) outcome = 'stopped'
    else if (outcomeRoll < 0.19) outcome = 'needs-human'
    else if (outcomeRoll < 0.21) outcome = 'released'
    else outcome = outcomeRoll < 0.36 ? 'branch-ready' : 'fix_ready'
  } else outcome = kind === 'review' && outcomeRoll < 0.12 ? 'resolved' : 'answered'

  // What this agent reports: tokens and a cost, tokens only, or nothing. Now
  // and then even a reporting agent sends nothing (it was cut off).
  const reports = agent.reports !== 'none' && random() > 0.04
  const model = reports ? pick(agent.models) : null
  const size = outcome === 'failed' || outcome === 'interrupted' ? 0.4 : 1
  const input = reports ? Math.round((fix ? 62_000 : kind === 'review' ? 14_000 : 9000) * (0.2 + random() * 1.8) * size) : null
  const output = reports ? Math.round((fix ? 5200 : kind === 'review' ? 1300 : 900) * (0.2 + random() * 1.8) * size) : null
  const cached = reports && random() < 0.7 ? Math.round(input * random() * 0.8) : null
  // A cost only from the agent that reports one, and never without tokens.
  const cost =
    reports && agent.reports === 'cost' ? Math.round((input * 3 + output * 15 - (cached || 0) * 2.7) * (PRICE[model] || 1)) : null
  const steps = fix ? 4 + Math.floor(random() * 30) : Math.floor(random() * 6)
  const tools = {}
  for (let index = 0; index < steps; index += 1) {
    const name = pick(fix ? ['read', 'read', 'edit', 'search', 'execute'] : ['read', 'search', 'fetch'])
    tools[name] = (tools[name] || 0) + 1
  }
  return {
    workspace_id: world.workspaceId,
    project_id: agent.projectId,
    id: `run_${hexOf(random, 24)}`,
    kind,
    agent_id: agent.id,
    claim_id: fix ? `cl_${hexOf(random, 24)}` : null,
    board_id: world.boards[agent.projectId],
    comment_number: comment,
    thread_id: thread,
    asked_by: asker,
    started_at: iso(start),
    ended_at: iso(start + durationMs),
    outcome,
    model,
    effort: reports && random() < 0.6 ? pick(['low', 'medium', 'high']) : null,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cached,
    cost_micros: cost,
    steps,
    approvals_asked: asked,
    approvals_allowed: allowed,
    approvals_denied: denied,
    approvals_auto: auto,
    approvals_by: by,
    agent_owner: agent.owner,
    duration_ms: durationMs,
    agent_ms: reports ? Math.round(durationMs * 0.9) : null,
    tools: steps ? JSON.stringify(tools) : null,
    window_used: reports ? Math.round(20_000 + random() * 120_000) : null,
    window_size: reports ? 200_000 : null,
  }
}

// The turns of the last `days` days up to `now`, oldest first, plus two
// that are still running. `offsetMinutes`: the viewer's time zone (minutes
// ahead of UTC), so days and working hours are the viewer's own.
export function generateRuns(world, { now, days = 60, seed = 20_260_704, offsetMinutes = 0, running = 2 } = {}) {
  const offset = offsetMinutes * 60_000
  const today = Math.floor((now + offset) / DAY)
  const marks = historyMarks(today)
  const rows = []
  for (let day = today - days + 1; day <= today; day += 1) {
    const random = generator((seed + Math.imul(day, 7919)) >>> 0)
    const age = today - day
    const weekday = weekdayOf(day)
    let volume = (weekday < 5 ? 62 : 11) * (0.55 + 0.45 * (1 - age / days))
    if (marks.spikes.has(day)) volume *= marks.spikes.get(day)
    if (marks.quiet.has(day)) volume *= 0.03
    // An agent has turns from the day it was connected.
    const agents = world.agents.filter((agent) => agent.connectedDays === undefined || age < agent.connectedDays)
    const count = agents.length ? Math.round(volume * (0.85 + 0.3 * random())) : 0
    for (let index = 0; index < count; index += 1) {
      // Working hours, mostly; a few in the evening.
      const hour = 8 + random() * 10 + (random() < 0.1 ? 4 : 0)
      const start = day * DAY - offset + Math.floor(hour * HOUR)
      const failing = day === marks.failures ? random() < 0.62 : random() < 0.04
      const row = turn(world, random, { day, age, start, failing, agents })
      // Today: only what has already ended.
      if (Date.parse(row.ended_at) <= now) rows.push(row)
    }
  }
  rows.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id))
  // Turns still running: started within the last minutes, nothing reported yet.
  const slot = Math.floor(now / (5 * 60_000))
  for (let index = 0; index < running; index += 1) {
    const random = generator((seed ^ Math.imul(slot + index, 2_654_435_761)) >>> 0)
    const agent = world.agents[index % world.agents.length]
    const fix = index % 2 === 1
    rows.push({
      workspace_id: world.workspaceId,
      project_id: agent.projectId,
      id: `run_${hexOf(random, 24)}`,
      kind: fix ? 'fix' : 'chat',
      agent_id: agent.id,
      claim_id: fix ? `cl_${hexOf(random, 24)}` : null,
      board_id: world.boards[agent.projectId],
      comment_number: fix ? 4 : null,
      thread_id: fix ? 'comment-4' : 'board',
      asked_by: world.people[(index + 1) % world.people.length].id,
      started_at: iso(now - (index + 1) * 40_000 - Math.floor(random() * 20_000)),
      ended_at: null,
      outcome: null,
      model: null,
      effort: null,
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      cost_micros: null,
      steps: null,
      approvals_asked: null,
      approvals_allowed: null,
      approvals_denied: null,
      approvals_auto: null,
      approvals_by: null,
      agent_owner: agent.owner,
      duration_ms: null,
      agent_ms: null,
      tools: null,
      window_used: null,
      window_size: null,
    })
  }
  return rows
}

// The activity that goes with those turns, oldest first, as audit entries
// ({ workspaceId, action, target, userId, tokenId, shareId, detail, ip, at };
// `account`: an event of a person's account, like a sign-in). Who asked which
// agent and who answered which approval card come from the turns themselves;
// sign-ins, connected and reconfigured agents, role changes and exports are
// spread over the same weeks.
export function generateActivity(world, runs, { now, days = 60, seed = 20_260_705, offsetMinutes = 0, projectNames = {} } = {}) {
  const offset = offsetMinutes * 60_000
  const today = Math.floor((now + offset) / DAY)
  const random = generator(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const agentOf = new Map(world.agents.map((agent) => [agent.id, agent]))
  const personOf = new Map([...world.people, world.viewer].map((person) => [person.id, person]))
  const ipOf = (userId) => personOf.get(userId)?.ip || '203.0.113.99'
  const out = []
  const add = (at, action, userId, { target = null, detail = {}, account = false, ip } = {}) => {
    if (at > now) return
    out.push({
      workspaceId: account ? null : world.workspaceId,
      account,
      action,
      target,
      userId,
      tokenId: null,
      shareId: null,
      detail,
      ip: ip || ipOf(userId),
      at: iso(at),
    })
  }
  const ago = (daysAgo) => now - Math.round(daysAgo * DAY)

  // From the turns: who asked, and who answered the approval cards.
  for (const run of runs) {
    const agent = agentOf.get(run.agent_id)
    const start = Date.parse(run.started_at)
    const about = { project: run.project_id, agent: run.agent_id, agentName: agent?.name || null, board: run.board_id }
    if (run.asked_by)
      add(start, 'agent_turn_started', run.asked_by, {
        target: `turn_${run.id.slice(4)}`,
        detail: { ...about, kind: run.kind === 'fix' || run.kind === 'push' ? 'fix' : run.kind === 'review' ? 'comment' : 'chat' },
      })
    if (!run.approvals_by) continue
    for (const [userId, counts] of Object.entries(JSON.parse(run.approvals_by))) {
      const card = (action, index) =>
        add(start + Math.min(run.duration_ms || 60_000, 8000 + index * 9000), action, userId, {
          target: `turn_${run.id.slice(4)}`,
          detail: { ...about, card: `card-${run.id.slice(4, 10)}-${index}`, kind: 'edit', path: PATHS[(run.steps + index) % PATHS.length] },
        })
      for (let index = 0; index < counts.allowed; index += 1) card('agent_permission_approved', index)
      for (let index = 0; index < counts.denied; index += 1) card('agent_permission_denied', counts.allowed + index)
    }
  }

  // Sign-ins: most people on most working days, now and then from a second device.
  for (let day = today - days + 1; day <= today; day += 1) {
    const weekday = weekdayOf(day)
    for (const person of [...world.people, world.viewer]) {
      if (random() > (weekday < 5 ? 0.55 : 0.08)) continue
      const at = day * DAY - offset + Math.floor((7.5 + random() * 3) * HOUR)
      const device = random() < 0.8 ? person.devices[0] : pick(person.devices)
      add(at, 'signed_in', person.id, { account: true, detail: { via: 'passkey', device } })
      if (random() < 0.12) add(at + Math.floor((6 + random() * 4) * HOUR), 'signed_out', person.id, { account: true, detail: { device } })
    }
  }
  const [robin, jo, mei, sam, priya] = world.people.map((person) => person.id)
  add(ago(28.2), 'passkey_added', mei, { account: true })
  add(ago(11.4), 'passkey_added', sam, { account: true })
  add(ago(9.3), 'sessions_revoked', priya, { account: true })

  // Agents connected and reconfigured.
  for (const agent of world.agents) {
    const about = { project: agent.projectId, name: agent.name, machine: agent.machine }
    add(ago(agent.connectedDays), 'agent_created', agent.owner, { target: agent.id, detail: about })
    add(ago(agent.connectedDays) + 90_000, 'agent_connected', agent.owner, { target: agent.id, detail: about })
    if (agent.audience === 'trusted')
      add(ago(agent.connectedDays - 1.3), 'agent_audience_changed', robin, {
        target: agent.id,
        detail: { project: agent.projectId, name: agent.name, before: { audience: 'owner' }, after: { audience: 'trusted' } },
      })
    if (agent.rule === 'auto')
      add(ago(agent.connectedDays - 8.6), 'agent_approval_rule_changed', agent.owner, {
        target: agent.id,
        detail: { project: agent.projectId, name: agent.name, before: { rule: 'ask' }, after: { rule: 'auto' } },
      })
  }
  const website = world.agents.at(-1)
  add(ago(19.7), 'agent_renamed', priya, {
    target: website.id,
    detail: { project: website.projectId, from: 'Site agent', to: website.name },
  })
  add(ago(14.2), 'agent_identity_changed', jo, {
    target: world.agents[1].id,
    detail: { project: world.agents[1].projectId, name: world.agents[1].name, before: { icon: null }, after: { icon: 'sparkles' } },
  })
  for (const [daysAgo, projectId, before, after] of [
    [23.5, world.projects[0], 80, 120],
    [8.8, world.projects[1], 40, 60],
  ])
    add(ago(daysAgo), 'agent_policy_changed', robin, {
      target: projectId,
      detail: {
        name: projectNames[projectId] || null,
        changed: ['dailyTurns'],
        before: { dailyTurns: before },
        after: { dailyTurns: after },
      },
    })

  // Roles: Sam was an admin for an afternoon.
  add(ago(22.1), 'member_role_changed', robin, { target: sam, detail: { from: 'member', to: 'admin' } })
  add(ago(21.9), 'member_role_changed', robin, { target: sam, detail: { from: 'admin', to: 'member' } })

  // Exports.
  for (const [daysAgo, who, format, rows] of [
    [52.3, robin, 'csv', 214],
    [38.4, jo, 'csv', 655],
    [27.6, robin, 'json', 1180],
    [13.2, priya, 'csv', 941],
    [4.4, jo, 'csv', 1322],
  ])
    add(ago(daysAgo), 'usage_exported', who, { detail: { format, rows, scope: 'workspace' } })
  add(ago(30.5), 'audit_exported', priya, { detail: { rows: 310, scope: 'workspace', view: 'activity' } })
  add(ago(6.2), 'access_exported', robin, { detail: { people: 6, tokens: 3, agents: world.agents.length, shares: 2 } })
  add(ago(3.1), 'usage_exported', mei, { detail: { format: 'csv', rows: 96, scope: 'own' } })

  return out.sort((a, b) => a.at.localeCompare(b.at))
}
