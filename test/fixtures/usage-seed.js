// A fictional workspace with weeks of agent usage and activity, for the
// Usage and Activity tests, their browser tests and the screenshots.
//
//   people    Ada (owner), Ben (admin), Cyd (member), Viewer (viewer)
//   projects  Marketing site, Docs, Shop
//   agents    Builder and Scout on several projects, on made-up machines
//   turns     a few thousand over 60 days: busy weekdays, quiet weekends, two
//             days with nothing, a day of failures, and agents that report
//             different things (one reports tokens and a cost, one tokens
//             only, one nothing at all)
//
// Everything is made up and deterministic (a seeded generator), and the
// usage rows hold what real ones hold: numbers and ids, never text.
//
// As a module: seedWorkspace(hosted) then seedUsage(hosted.db, seeded, {...}).
// As a script: starts a throwaway hosted server on localhost with the built
// console and prints its address and one session cookie per person:
//   node test/fixtures/usage-seed.js --port 4791 [--turns 3000] [--days 60] [--empty]

import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generator } from '../../client/src/demo/usage/generate.js'

const DAY = 86_400_000
const hex = (bytes) => randomBytes(bytes).toString('hex')

// The seeded generator (mulberry32) is the public demo's (its fictional usage
// history is made with it too): the same data every run.
export { generator }

// Usage rows as objects with the columns of agent_runs, straight into the
// table. The demo's generated history goes in this way
// (test/demo-usage.test.js), to compare its answers with the server's.
const RUN_COLUMNS = [
  'workspace_id',
  'project_id',
  'id',
  'kind',
  'agent_id',
  'claim_id',
  'board_id',
  'comment_number',
  'thread_id',
  'asked_by',
  'started_at',
  'ended_at',
  'outcome',
  'model',
  'effort',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'cost_micros',
  'steps',
  'approvals_asked',
  'approvals_allowed',
  'approvals_denied',
  'approvals_auto',
  'approvals_by',
  'agent_owner',
  'duration_ms',
  'agent_ms',
  'tools',
  'window_used',
  'window_size',
]
export function insertRuns(db, rows) {
  const insert = db.prepare(`INSERT INTO agent_runs (${RUN_COLUMNS.join(', ')}) VALUES (${RUN_COLUMNS.map(() => '?').join(', ')})`)
  db.exec('BEGIN')
  try {
    for (const row of rows) insert.run(...RUN_COLUMNS.map((column) => row[column] ?? null))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return rows.length
}

// The people, projects and agents, made through the server's own API (so
// roles, tokens and audit entries are real). Returns their ids and browsers.
export async function seedWorkspace(hosted, helpers) {
  const { signUp, invite, createProject, reauth } = helpers
  const ada = await signUp(hosted, { handle: 'ada', displayName: 'Ada' })
  const ws = ada.workspaceId
  const join = async (handle, displayName, role) => {
    await reauth(ada)
    return signUp(hosted, { handle, displayName, invite: await invite(ada, ws, role) })
  }
  const ben = await join('ben', 'Ben', 'admin')
  const cyd = await join('cyd', 'Cyd', 'member')
  const viewer = await join('viewer', 'Viewer', 'viewer')
  await ada.browser.call('PATCH', `/api/workspaces/${ws}`, { body: { name: 'Example Studio' } })
  const projects = []
  for (const name of ['Marketing site', 'Docs', 'Shop']) projects.push(await createProject(ada, ws, name))
  // An agent is a token that may take work. Ada connects three, Ben two.
  const agents = []
  const connect = async (person, project, name, machine, kind) => {
    await reauth(person)
    const made = await person.browser.post(`/api/workspaces/${ws}/projects/${project.id}/tokens`, {
      name,
      scopes: ['read', 'comment', 'claim'],
    })
    if (made.status !== 201) throw new Error(`token ${made.status} ${made.text}`)
    const id = made.json.agentId
    hosted.db.prepare('UPDATE agents SET machine = ?, kind = ? WHERE id = ?').run(machine, kind, id)
    agents.push({
      id,
      name,
      machine,
      kind,
      projectId: project.id,
      owner: person.user.id,
      token: made.json.token,
      tokenId: made.json.info.id,
    })
  }
  await connect(ada, projects[0], 'Builder', 'studio-mac', 'claude')
  await connect(ada, projects[1], 'Scout', 'studio-mac', 'codex')
  await connect(ada, projects[2], 'Builder (shop)', 'build-box', 'claude')
  await connect(ben, projects[0], 'Scout (review)', 'ben-laptop', 'codex')
  await connect(ben, projects[1], 'Builder (docs)', 'ben-laptop', 'custom')
  return { ws, ada, ben, cyd, viewer, people: [ada, ben, cyd], projects, agents }
}

const MODELS = {
  claude: ['sonnet-large', 'sonnet-large', 'opus-max'],
  codex: ['sol-high', 'sol-medium'],
  custom: [null],
}

// Usage rows, straight into the table. `turns` over `days` ending at `now`.
export function seedUsage(db, seeded, { turns = 3000, days = 60, now = new Date(), seed = 7, running = 3 } = {}) {
  const random = generator(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const end = now.getTime()
  const start = end - days * DAY
  const insert = db.prepare(
    `INSERT INTO agent_runs (workspace_id, project_id, id, kind, agent_id, claim_id, board_id, comment_number, thread_id, asked_by,
       started_at, ended_at, outcome, model, effort, input_tokens, output_tokens, cached_tokens, cost_micros, steps,
       approvals_asked, approvals_allowed, approvals_denied, approvals_auto, approvals_by, agent_owner, duration_ms, agent_ms, tools,
       window_used, window_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // Two days with nothing at all, and one day when most turns failed.
  const quiet = new Set([Math.floor(days * 0.35), Math.floor(days * 0.35) + 1])
  const bad = Math.floor(days * 0.7)
  const people = seeded.people.map((person) => person.user.id)
  let made = 0
  db.exec('BEGIN')
  try {
    while (made < turns) {
      const day = Math.floor(random() * days)
      if (quiet.has(day)) continue
      const dayStart = start + day * DAY
      const weekday = new Date(dayStart).getUTCDay()
      // Weekends are quiet; the last weeks are busier than the first.
      if ((weekday === 0 || weekday === 6) && random() < 0.8) continue
      if (random() > 0.45 + (0.55 * day) / days) continue
      // Working hours, mostly.
      const at = dayStart + (Math.floor((8 + random() * 10 + (random() < 0.1 ? 6 : 0)) * 3_600_000) % DAY)
      if (at >= end) continue
      const agent = pick(seeded.agents)
      const roll = random()
      const kind = roll < 0.55 ? 'chat' : roll < 0.75 ? 'review' : roll < 0.97 ? 'fix' : 'push'
      const asker = roll > 0.985 ? null : random() < 0.5 ? people[0] : random() < 0.6 ? people[1] : people[2]
      const comment = kind === 'chat' ? null : 1 + Math.floor(random() * 40)
      const thread = kind === 'chat' ? (random() < 0.4 ? 'board' : `chat-${hex(8)}`) : `comment-${comment}`
      const fix = kind === 'fix' || kind === 'push'
      const durationMs = Math.round((fix ? 40_000 : 6000) * (0.3 + random() * 2.2) * (random() < 0.04 ? 9 : 1))
      const failing = day === bad ? random() < 0.7 : random() < 0.05
      const outcomeRoll = random()
      const outcome = failing
        ? pick(['failed', 'failed', 'interrupted'])
        : outcomeRoll < 0.06
          ? 'stopped'
          : fix
            ? outcomeRoll < 0.2
              ? 'needs-human'
              : 'fix_ready'
            : 'answered'
      // What each kind of agent reports: claude tokens and a cost, codex
      // tokens only, custom nothing.
      const reports = agent.kind !== 'custom' && !(agent.kind === 'codex' && random() < 0.08)
      const input = reports ? Math.round((fix ? 60_000 : 9000) * (0.2 + random() * 1.8)) : null
      const output = reports ? Math.round((fix ? 5000 : 900) * (0.2 + random() * 1.8)) : null
      const cached = reports && random() < 0.7 ? Math.round(input * random() * 0.8) : null
      const cost = agent.kind === 'claude' && reports ? Math.round(input * 3 + output * 15 - (cached || 0) * 2.7) : null
      const steps = fix ? 4 + Math.floor(random() * 30) : Math.floor(random() * 6)
      const tools = {}
      for (let i = 0; i < steps; i += 1) {
        const name = pick(fix ? ['read', 'read', 'edit', 'search', 'execute'] : ['read', 'search', 'fetch'])
        tools[name] = (tools[name] || 0) + 1
      }
      const asked = fix && random() < 0.6 ? 1 + Math.floor(random() * 4) : fix ? 0 : null
      const auto = asked && random() < 0.25 ? Math.min(asked, 1 + Math.floor(random() * 2)) : asked === null ? null : 0
      const denied = asked ? (random() < 0.2 ? Math.min(asked - (auto || 0), 1 + Math.floor(random() * 2)) : 0) : asked
      const allowed = asked === null ? null : asked - denied
      const answerer = pick([people[0], people[1]])
      const by =
        asked && allowed - (auto || 0) + denied > 0 ? JSON.stringify({ [answerer]: { allowed: allowed - (auto || 0), denied } }) : null
      insert.run(
        seeded.ws,
        agent.projectId,
        `run_${hex(12)}`,
        kind,
        agent.id,
        fix ? `cl_${hex(12)}` : null,
        'home',
        comment,
        thread,
        asker,
        new Date(at).toISOString(),
        new Date(at + durationMs).toISOString(),
        outcome,
        reports ? pick(MODELS[agent.kind]) : null,
        reports && random() < 0.6 ? pick(['low', 'medium', 'high']) : null,
        input,
        output,
        cached,
        cost,
        steps,
        asked,
        allowed,
        denied,
        auto,
        by,
        agent.owner,
        durationMs,
        reports ? Math.round(durationMs * 0.9) : null,
        steps ? JSON.stringify(tools) : null,
        reports ? Math.round(20_000 + random() * 120_000) : null,
        reports ? 200_000 : null,
      )
      made += 1
    }
    // A few turns still running, started in the last minutes.
    for (let i = 0; i < running; i += 1) {
      const agent = seeded.agents[i % seeded.agents.length]
      insert.run(
        seeded.ws,
        agent.projectId,
        `run_${hex(12)}`,
        'chat',
        agent.id,
        null,
        'home',
        null,
        'board',
        people[i % people.length],
        new Date(end - (i + 1) * 40_000).toISOString(),
        ...Array(14).fill(null),
        agent.owner,
        null,
        null,
        null,
        null,
        null,
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return made + running
}

// Audit entries spread over the same weeks, so the Activity page has a past:
// sign-ins, settings, approvals and exports. Names and ids only.
export function seedActivity(db, seeded, { days = 60, now = new Date(), seed = 11, entries = 400 } = {}) {
  const random = generator(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const insert = db.prepare(
    'INSERT INTO audit_log (workspace_id, user_id, token_id, share_id, action, target, ip, detail, at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)',
  )
  const people = seeded.people.map((person) => person.user.id)
  const rows = []
  for (let i = 0; i < entries; i += 1) {
    const at = new Date(now.getTime() - Math.floor(random() * days * DAY) - 3_600_000).toISOString()
    const user = pick(people)
    const agent = pick(seeded.agents)
    const ip = `203.0.113.${1 + Math.floor(random() * 40)}`
    const roll = random()
    if (roll < 0.35)
      rows.push([
        null,
        user,
        'signed_in',
        null,
        ip,
        { via: 'passkey', device: pick(['Chrome on macOS', 'Safari on iPhone', 'Firefox on Linux']) },
        at,
      ])
    else if (roll < 0.4) rows.push([null, user, 'signed_out', null, ip, { device: 'Chrome on macOS' }, at])
    else if (roll < 0.65)
      rows.push([
        seeded.ws,
        pick(people.slice(0, 2)),
        random() < 0.85 ? 'agent_permission_approved' : 'agent_permission_denied',
        `turn_${hex(12)}`,
        ip,
        {
          project: agent.projectId,
          agent: agent.id,
          agentName: agent.name,
          board: 'home',
          card: `card-${i}`,
          kind: 'edit',
          path: 'src/pages/index.html',
        },
        at,
      ])
    else if (roll < 0.85)
      rows.push([
        seeded.ws,
        user,
        'agent_turn_started',
        `turn_${hex(12)}`,
        ip,
        { project: agent.projectId, agent: agent.id, agentName: agent.name, board: 'home', kind: 'chat' },
        at,
      ])
    else if (roll < 0.9)
      rows.push([
        seeded.ws,
        people[0],
        'agent_audience_changed',
        agent.id,
        ip,
        { project: agent.projectId, name: agent.name, before: { audience: 'owner' }, after: { audience: 'trusted' } },
        at,
      ])
    else if (roll < 0.94)
      rows.push([seeded.ws, pick(people.slice(0, 2)), 'usage_exported', null, ip, { format: 'csv', rows: 120 + i, scope: 'workspace' }, at])
    else if (roll < 0.97) rows.push([seeded.ws, people[0], 'member_role_changed', people[2], ip, { from: 'viewer', to: 'member' }, at])
    else
      rows.push([
        seeded.ws,
        people[0],
        'agent_approval_rule_changed',
        agent.id,
        ip,
        { project: agent.projectId, name: agent.name, before: { rule: 'ask' }, after: { rule: 'auto' } },
        at,
      ])
  }
  // The log is ordered by id: insert oldest first.
  rows.sort((a, b) => a[6].localeCompare(b[6]))
  db.exec('BEGIN')
  for (const [ws, user, action, target, ip, detail, at] of rows) insert.run(ws, user, action, target, ip, JSON.stringify(detail), at)
  db.exec('COMMIT')
  return rows.length
}

// ---- As a script ----

async function main() {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 ? args[index + 1] : fallback
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const helpers = await import('../hosted-helpers.js')
  const hosted = await helpers.startHostedServer('usage-seed', {
    port: Number(flag('port', 4791)),
    clientDir: path.join(root, 'dist', 'client'),
    consoleDir: path.join(root, 'dist', 'console'),
    ...(flag('dir', null) ? { dataDir: flag('dir', null) } : {}),
  })
  const seeded = await seedWorkspace(hosted, helpers)
  const empty = args.includes('--empty')
  const turns = empty ? 0 : seedUsage(hosted.db, seeded, { turns: Number(flag('turns', 3000)), days: Number(flag('days', 60)) })
  const events = empty ? 0 : seedActivity(hosted.db, seeded, { days: Number(flag('days', 60)) })
  const cookies = Object.fromEntries(['ada', 'ben', 'cyd', 'viewer'].map((name) => [name, Object.fromEntries(seeded[name].browser.jar)]))
  console.log(
    JSON.stringify({
      origin: hosted.origin,
      workspace: seeded.ws,
      turns,
      events,
      projects: seeded.projects.map((item) => ({ id: item.id, name: item.name })),
      agents: seeded.agents.map((item) => ({ id: item.id, name: item.name })),
      people: Object.fromEntries(['ada', 'ben', 'cyd', 'viewer'].map((name) => [name, seeded[name].user.id])),
      cookies,
    }),
  )
  const stop = async () => {
    await hosted.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
