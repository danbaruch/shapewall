// Team mode on the solo engine (2.0.0, plan R6): `shapewall serve --team`, or
// Invite people in the engine's console. The same data, no copy: the engine
// keeps its owner, its folder and its loopback address, and adds a second
// listener for the people the owner invites, on the tailnet.
//
//   owner      the owner's app (src/hosted/app.js with `solo`): unchanged. The
//              owner signs in on this machine by the terminal's one-time page
//              (signin.js), at http://<label>-<random>.shapewall.localhost:<port>.
//   team       a second app on the same database (createHostedApp with
//              `secondary`), on its own loopback port, put on the tailnet by
//              `tailscale serve` with tailnet sign-in (src/tailnet-proof.js,
//              the same proof `shapewall hosted --tailscale --tailnet-sign-in`
//              uses): https://<machine>.<tailnet>.ts.net[:port]. It is a team
//              server: no solo surface is mounted on it, a local session never
//              counts there (it has no local gate), passkeys are off (the
//              tailnet signs people in), and sign-up is by invite only.
//
// Why two apps and not one with two origins: every gate that trusts "this
// machine" or "the solo owner" (soloLocalGate admits and admitsMachine, the
// peer-uid check, soloOwner for self-update, capture, journeys and checks,
// the board's hostedOrSolo features) lives on the owner's app and its port. A
// request that came through the tailnet arrives at the team port, where none
// of them is mounted. The owner's cookie is host-only on the engine's own name
// and SameSite=Strict, so a browser never sends it to the team address, and
// a session row read there would not count anyway.
//
// What the team listener refuses on top of a team server (teamFilter below),
// so the owner keeps the engine:
//   - invites: only the owner invites, from this machine, with the fixed
//     core's check (team-routes.js);
//   - new workspaces and projects, and deleting a project or a board: the
//     engine serves one project, bound to this folder's config;
//   - this machine's own tokens (cli, watch, the board's agent): they never
//     work from another machine.
//
// The setting is kept in <data>/team.json (0600): `shapewall serve` starts
// the way it was left, and says so. Off means loopback only again: the
// tailscale serve entry is removed and the team listener closed; accounts
// and their sessions stay (and count again when it is back on).
//
// Public internet exposure is not here: no Funnel, no --host. A board for the
// internet is a team server behind your own domain (docs/hosted.md, "Own
// domain", and its checklist).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { sha256 } from '../../shared/account-tokens.js'
import { readSoloBinding } from './binding.js'
import { machineTokenIds } from './machine-tokens.js'

export const TEAM_FILE = 'team.json'
export const DEFAULT_TEAM_PORT = 443

export class SoloTeamError extends Error {}

// The saved setting: { on, httpsPort }. A file that is missing reads as off;
// one that does not read (or is not a plain file) reads as off and says why.
export function readTeamSetting(dataDir) {
  const file = path.join(dataDir, TEAM_FILE)
  let stat = null
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { on: false, httpsPort: DEFAULT_TEAM_PORT }
    return { on: false, httpsPort: DEFAULT_TEAM_PORT, problem: `${file} cannot be read (${error.code || error.message})` }
  }
  if (!stat.isFile()) return { on: false, httpsPort: DEFAULT_TEAM_PORT, problem: `${file} is not a plain file` }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    const httpsPort = Number.isInteger(value?.httpsPort) && value.httpsPort > 0 && value.httpsPort < 65536 ? value.httpsPort : DEFAULT_TEAM_PORT
    return { on: value?.on === true, httpsPort }
  } catch {
    return { on: false, httpsPort: DEFAULT_TEAM_PORT, problem: `${file} is damaged` }
  }
}

// Written whole through a new 0600 file (never through one put in its place).
export function writeTeamSetting(dataDir, { on, httpsPort = DEFAULT_TEAM_PORT, now = () => new Date() }) {
  const file = path.join(dataDir, TEAM_FILE)
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, on: on === true, httpsPort, at: now().toISOString() })}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

export function teamPortProblem(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? null : '--team-port: the HTTPS port on the tailnet (443 by default, like 8443)'
}

// ---- What the team listener refuses (on top of a team server) ----

const WS = '[^/]+'
const REFUSED = [
  [
    'POST',
    new RegExp(`^/api/workspaces/${WS}/invites/?$`),
    'owner_invites',
    'Only the owner invites people to this board, from the machine that runs it (the console there, Invite people).',
  ],
  ['POST', /^\/api\/workspaces\/?$/, 'one_project', 'This board serves one project of its owner; it makes no new workspaces.'],
  ['POST', new RegExp(`^/api/workspaces/${WS}/projects/?$`), 'one_project', 'This board serves one project of its owner; it makes no new projects.'],
  [
    'DELETE',
    new RegExp(`^/api/workspaces/${WS}/projects/${WS}(?:/boards/${WS})?/?$`),
    'one_project',
    'The project and its boards come from the owner’s config file; they are not deleted from here.',
  ],
]

const refuse = (res, status, code, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify({ error: { code, message } }))
}

// (app, { db, dataDir }) -> a request handler for the team listener.
export function teamFilter(app, { db, dataDir }) {
  return (req, res) => {
    const pathname = String(req.url || '/').split('?')[0]
    for (const [method, pattern, code, message] of REFUSED)
      if (req.method === method && pattern.test(pathname)) return refuse(res, 403, code, message)
    // This machine's own tokens: cli.token, watch.token and agent.token stay on this machine.
    if (/^\/(?:api\/v1|mcp)(?:\/|$)/.test(pathname)) {
      const match = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''))
      if (match) {
        const ids = machineTokenIds(dataDir)
        const row = ids.length ? db.prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(sha256(match[1])) : null
        if (row && ids.includes(row.id))
          return refuse(res, 403, 'machine_token', 'This token is for the machine that runs the engine; it does not work through the tailnet.')
      }
    }
    return app(req, res)
  }
}

// ---- Who can reach it ----

// The engine's people, for the lines that say who can reach the team address.
export function teamPeople(db) {
  let bound = null
  try {
    bound = readSoloBinding(db)
  } catch {
    bound = null
  }
  if (!bound) return { members: [], invites: [] }
  const members = db
    .prepare(
      `SELECT u.handle, u.tailnet_login, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.handle`,
    )
    .all(bound.workspaceId)
    .map((row) => ({ handle: row.handle, login: row.tailnet_login || null, role: row.role }))
  const invites = db
    .prepare(
      `SELECT role, tailnet_login, expires_at FROM invites WHERE workspace_id = ? AND used_at IS NULL AND revoked_at IS NULL
       AND expires_at > ? ORDER BY created_at`,
    )
    .all(bound.workspaceId, new Date().toISOString())
    .map((row) => ({ role: row.role, login: row.tailnet_login || null, expiresAt: row.expires_at }))
  return { members, invites }
}

// The lines `serve` and the console show: exactly who can reach what.
export function reachLines({ on, origin, ownerOrigin, httpsPort, people }) {
  if (!on) return [`Only you, on this machine: ${ownerOrigin} (loopback; nothing else can reach it).`]
  const host = origin ? new URL(origin).hostname : 'this machine'
  const others = people.members.filter((member) => member.role !== 'owner')
  const lines = [
    `Team mode: on, at ${origin} (tailscale serve with tailnet sign-in; not public, no Funnel).`,
    `Who can reach it: devices on your tailnet that your tailnet's access rules let reach ${host} on port ${httpsPort}. Of those, only a person signed in to Tailscale whose login has an account here sees the board; anyone else sees whom to ask, and is listed for you under Members. Tagged devices and this machine itself are never signed in by the tailnet.`,
    `You (owner): on this machine at ${ownerOrigin}, as before.`,
    others.length
      ? `Members (${others.length}): ${others.map((member) => `@${member.handle}${member.login ? ` (${member.login})` : ''}, ${member.role}`).join('; ')}.`
      : 'Members: nobody yet. Invite people in the console (Members, Invite) or by their tailnet login.',
  ]
  if (people.invites.length)
    lines.push(
      `Invited, not joined yet (${people.invites.length}): ${people.invites
        .map((invite) => `${invite.login || 'a link'}, ${invite.role}, until ${invite.expiresAt.slice(0, 10)}`)
        .join('; ')}.`,
    )
  lines.push('Turn it off (back to this machine only): shapewall serve --team off, or Stop sharing in the console.')
  return lines
}

// ---- The controller ----

function listen(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

// createSoloTeam(options) -> { start({ httpsPort, save }), stop({ save }), status(), lines(), close() }
//   ownerApp   the owner's app (its live state is shared: events, presence, turns, agent links)
//   makeApp({ origin, tailnet, shared, eventBus, presenceHub }) -> the team app (server.js: createHostedApp with
//              the server's common options, `secondary: true`, trustProxy, signup invite, no passkeys)
//   tailscale  { run, watchMs } (tests: a fake `tailscale` command); proof, facts: as startHosted's tailnetProof/Facts
//   ownerOrigin  the owner's address (for the lines)
export function createSoloTeam({
  db,
  dataDir,
  ownerApp,
  makeApp,
  ownerOrigin,
  tailscale = {},
  proof: givenProof = null,
  facts = null,
  out = () => {},
  now = () => new Date(),
}) {
  let state = null // { server, served, gate, app, timer, httpsPort, origin }
  let busy = null
  let problem = null
  let saved = readTeamSetting(dataDir).on

  const status = () => ({
    on: Boolean(state),
    origin: state?.origin || null,
    httpsPort: state?.httpsPort || readTeamSetting(dataDir).httpsPort,
    saved,
    problem,
  })
  const lines = () =>
    reachLines({ ...status(), ownerOrigin, httpsPort: status().httpsPort, people: teamPeople(db) })

  async function bringUp(httpsPort) {
    const proofModule = await import('../../tailnet-proof.js')
    const ts = await import('../tailscale.js')
    const holder = { handler: null, gate: null }
    const entry = (req, res) => {
      const pass = () => (holder.handler ? holder.handler(req, res) : res.writeHead(503).end())
      if (!holder.gate) return res.writeHead(503).end()
      holder.gate.admit(req, res).then(
        (ok) => ok && pass(),
        () => res.writeHead(500).end(),
      )
    }
    const server = await listen(entry)
    const undo = [() => new Promise((resolve) => server.close(() => resolve()))]
    const unwind = async () => {
      server.closeAllConnections?.()
      for (const step of undo.reverse()) await step().catch(() => {})
    }
    try {
      // Before anything is put on the tailnet: this machine must be able to tell tailscaled's connections apart.
      const proof = givenProof || proofModule.peerProof()
      const refused = proof.problem?.() || (await proofModule.proofSelfTest(server, proof))
      if (refused) throw new SoloTeamError(`Team mode stays off: ${refused}`)
      const secret = proofModule.newServeSecret()
      const served = await ts
        .startTailscale({
          localPort: server.address().port,
          httpsPort,
          secret,
          ...(tailscale.run ? { run: tailscale.run } : {}),
          ...(facts ? { facts } : {}),
        })
        .catch((error) => {
          throw new SoloTeamError(`Team mode stays off: ${error.message}`, { cause: error })
        })
      undo.push(async () => {
        const ok = await served.stop()
        if (!ok) out('Could not remove the tailscale serve entry team mode added; check tailscale serve status.')
      })
      const first = await served.verify()
      if (first) throw new SoloTeamError(`Team mode stays off: ${first}.`)
      const gate = proofModule.createTailnetGate({ secret, proof, whois: served.whois, self: served.self, log: out })
      holder.gate = gate
      const app = makeApp({
        origin: served.origin,
        tailnet: gate,
        eventBus: ownerApp.locals.events,
        presenceHub: ownerApp.locals.presence.hub,
        shared: {
          turnHub: ownerApp.locals.chat.hub,
          links: ownerApp.locals.chat.links,
          chat: ownerApp.locals.chat.service,
          agentPresence: ownerApp.locals.agentPresence,
        },
      })
      undo.push(() => app.locals.close())
      const upgrades = new EventEmitter()
      app.locals.presence.attach(upgrades)
      server.on('upgrade', (req, socket, head) => {
        gate.admit(req).then(
          (ok) => (ok ? upgrades.emit('upgrade', req, socket, head) : socket.destroy()),
          () => socket.destroy(),
        )
      })
      holder.handler = teamFilter(app, { db, dataDir })
      // The serve entry must stay the only way in, and tailscaled one whose connections can be believed: checked
      // again every half minute, and nobody is believed while it is not so.
      const watch = async () => {
        const issue = await served.verify().catch(() => 'tailscale serve status could not be read')
        if (issue && !gate.suspended()) {
          out(`Team sign-in is suspended: ${issue}. Nobody is signed in by tailnet identity until this is fixed.`)
          gate.suspend(issue)
          problem = issue
          app.locals.cutTailnetSessions?.()
        } else if (!issue && gate.suspended()) {
          out('Team sign-in is back: the tailscale serve entry and tailscaled are as the engine needs them.')
          gate.resume()
          problem = null
        }
      }
      const every = tailscale.watchMs ?? 30_000
      const timer = every ? setInterval(watch, every) : null
      timer?.unref()
      undo.push(async () => timer && clearInterval(timer))
      return { server, served, gate, app, httpsPort, origin: served.origin, unwind, watch }
    } catch (error) {
      await unwind()
      throw error
    }
  }

  // Turns team mode on; `save` keeps it for the next start. -> status().
  async function start({ httpsPort = readTeamSetting(dataDir).httpsPort, save = true } = {}) {
    await busy
    if (state) return status()
    busy = (async () => {
      const portProblem = teamPortProblem(httpsPort)
      if (portProblem) throw new SoloTeamError(portProblem)
      try {
        state = await bringUp(httpsPort)
        problem = null
      } catch (error) {
        problem = error.message
        throw error
      }
      if (save) {
        writeTeamSetting(dataDir, { on: true, httpsPort, now })
        saved = true
      }
    })()
    try {
      await busy
    } finally {
      busy = null
    }
    return status()
  }

  // Back to this machine only; `save` keeps it off for the next start. -> status().
  async function stop({ save = true } = {}) {
    await busy
    busy = (async () => {
      const was = state
      state = null
      problem = null
      if (was) {
        // What a member still has open (live streams) ends now.
        was.app.locals.cutTailnetSessions?.()
        await was.unwind()
      }
      if (save) {
        writeTeamSetting(dataDir, { on: false, httpsPort: was?.httpsPort || readTeamSetting(dataDir).httpsPort, now })
        saved = false
      }
    })()
    try {
      await busy
    } finally {
      busy = null
    }
    return status()
  }

  return {
    start,
    stop,
    status,
    lines,
    // For tests: the team listener's local port, and one watch round.
    localPort: () => state?.server.address().port || null,
    watch: () => state?.watch(),
    app: () => state?.app || null,
    // Engine stop: the tailscale serve entry goes, the setting stays as it was.
    close: () => stop({ save: false }),
  }
}
