// The command line on a server with tailnet sign-in (`shapewall hosted
// --tailscale --tailnet-sign-in`): where the machine's tailnet user is
// already known to the server, nothing needs a browser.
//
//   shapewall login / agent connect   approved by the tailnet identity (approveByTailnet)
//   shapewall join                    take an invite (joinCommand)
//   shapewall hosted claim            the first account of a new server (claimCommand)
//   shapewall admin ...               a few admin commands (adminCommand)
//
// How: the CLI asks the server who it is (GET /auth/me). Tailscale's serve
// proxy adds the identity of the machine's user to the request; the server
// believes it only on a request that provably came through that proxy
// (src/hosted/tailnet-identity.js), signs the linked account in and sets a
// session cookie that works only together with that identity. The CLI then
// uses the same console API the browser uses, with that session: the same
// role checks, the same audit entries (marked as a tailnet session), and it
// signs out when the command ends. No token is stored for this.
//
// A tailnet identity is per device, not per person: whatever runs as you on
// a tailnet device of yours gets the same answer from the server as this
// command does. A workspace that wants more for approving machines switches
// on "Approve command line logins in the browser"; the server then refuses
// a session that only an identity stands behind, whatever the client sends.
//
// On any other server, and when the request did not come through the
// tailnet, nothing here applies: `login` and `agent connect` use the code
// and the browser as before, and the other commands say what they need.

import os from 'node:os'
import { readBounded, remoteOrigin } from './remote.js'
import { safeOut, terminalSafe } from './terminal.js'

const machineName = () => os.hostname().split('.')[0] || 'this computer'

// Any program on the server's machine can ask the server through its tailnet name and be answered as
// the machine's owner, so the server never takes an identity from its own machine.
const OWN_MACHINE =
  'This is the server’s own machine: the server never takes a tailnet identity from here (any program on this machine could ask the same way).'

// One CLI run's conversation with the server: keeps the cookies it is given.
export function tailnetClient(origin, { fetchImpl = fetch, machine = machineName() } = {}) {
  const jar = new Map()
  async function call(method, pathname, body) {
    const response = await fetchImpl(`${origin}${pathname}`, {
      method,
      headers: {
        Accept: 'application/json',
        // The console API takes writes from its own origin only; this is the
        // command line saying where it is talking to, not a browser.
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'X-Shapewall-Client': 'cli',
        'User-Agent': `shapewall-cli (${machine.replace(/[^\w .-]/g, '').slice(0, 40)})`,
        ...(jar.size ? { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    })
    for (const line of response.headers.getSetCookie?.() || []) {
      const pair = line.split(';')[0]
      const index = pair.indexOf('=')
      if (index < 1) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!value || /max-age=0/i.test(line)) jar.delete(name)
      else jar.set(name, value)
    }
    let data = null
    try {
      data = JSON.parse((await readBounded(response, 1024 * 1024)).toString('utf8'))
    } catch {
      data = null
    }
    return { status: response.status, data, ok: response.status >= 200 && response.status < 300 }
  }
  return {
    origin,
    call,
    get: (pathname) => call('GET', pathname),
    post: (pathname, body = {}) => call('POST', pathname, body),
    // Ends the session this run was given (best effort: it expires anyway).
    signOut: () => call('POST', '/auth/logout', {}).catch(() => null),
  }
}

// Who the server says this machine's user is.
//   { mode: 'off' }                         no tailnet sign-in on this server (or it is not a Shapewall server)
//   { mode: 'none' }                        tailnet sign-in, but this request names no person
//   { mode: 'self' }                        this is the server's own machine: never taken by identity
//   { mode: 'visitor', login, invites }     a login without an account here
//   { mode: 'account', login, me }          signed in as the linked account
export async function whoAmI(client) {
  let answer
  try {
    answer = await client.get('/auth/me')
  } catch {
    return { mode: 'off' }
  }
  const me = answer.data
  if (!answer.ok || !me || typeof me !== 'object') return { mode: 'off' }
  if (me.user && me.via === 'tailnet') return { mode: 'account', login: terminalSafe(me.tailnet?.linked || ''), me }
  const state = me.tailnet?.state
  if (state === 'unknown' || state === 'invited')
    return { mode: 'visitor', login: terminalSafe(me.tailnet.login), invites: Array.isArray(me.tailnet.invites) ? me.tailnet.invites : [] }
  if (state === 'self') return { mode: 'self' }
  // 'changed': the login is linked here for another tailnet user than this one (nobody, like 'none').
  if (state === 'none' || state === 'signed_out' || state === 'changed') return { mode: 'none' }
  return { mode: 'off' }
}

const fold = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
const quote = (value) => (/^[\w.@-]+$/.test(String(value)) ? String(value) : JSON.stringify(String(value)))
const errorOf = (answer, fallback) => terminalSafe(answer?.data?.error?.message) || fallback

// A workspace of the account, by --workspace (its id or its name). One
// workspace needs no flag. Never a prompt: several without the flag is an
// error that lists them with the flag to add.
export function pickWorkspace(workspaces, wanted, { flagHint = '' } = {}) {
  const list = Array.isArray(workspaces) ? workspaces : []
  if (wanted !== undefined && wanted !== null && wanted !== true) {
    const found = list.filter((item) => item.id === wanted || fold(item.name) === fold(wanted))
    if (found.length === 1) return found[0]
    throw new Error(
      found.length
        ? `--workspace ${quote(wanted)} matches ${found.length} workspaces. Use an id: ${found.map((item) => item.id).join(', ')}`
        : `No workspace "${terminalSafe(wanted)}" for this account. It is in: ${list.map((item) => terminalSafe(item.name)).join(', ') || 'none'}.`,
    )
  }
  if (list.length === 1) return list[0]
  if (!list.length) throw new Error('This account is in no workspace here.')
  throw new Error(
    `This account is in ${list.length} workspaces. Add one of:\n${list.map((item) => `  --workspace ${quote(item.name)}${flagHint}`).join('\n')}`,
  )
}

// The project a login or an agent connection is for: --project (its slug,
// id or name) and, when the account may make tokens in several workspaces,
// --workspace. One project in all needs no flag.
export function pickProject(workspaces, flags) {
  let list = Array.isArray(workspaces) ? workspaces : []
  if (typeof flags.workspace === 'string') list = [pickWorkspace(list, flags.workspace)]
  const all = list.flatMap((workspace) => (workspace.projects || []).map((project) => ({ workspace, project })))
  const wanted = typeof flags.project === 'string' ? flags.project : null
  const found = wanted
    ? all.filter(({ project }) => project.id === wanted || fold(project.slug) === fold(wanted) || fold(project.name) === fold(wanted))
    : all
  if (found.length === 1) return found[0]
  if (!all.length) throw new Error('There is no project to pick yet. Make one first: shapewall admin projects create "Name" --remote URL')
  const lines = (found.length ? found : all).map(
    ({ workspace, project }) =>
      `  --project ${quote(project.slug || project.id)}${list.length > 1 || found.length > 1 ? ` --workspace ${quote(workspace.name)}` : ''}    (${terminalSafe(project.name)} in ${terminalSafe(workspace.name)})`,
  )
  throw new Error(
    wanted && !found.length
      ? `No project "${terminalSafe(wanted)}" that this account may make tokens for. Use one of:\n${lines.join('\n')}`
      : `Which project? Add the flags of one of these:\n${lines.join('\n')}`,
  )
}

// What the browser's approval page ticks by default (client/src/console/pages/device.jsx).
export const LOGIN_SCOPES = ['read', 'reply', 'status', 'resolve', 'push']

// `shapewall login` / `agent connect`, after the login was started: approves
// it as the account the tailnet signs this machine's user in as, when there
// is one that may. Returns true when approved (the caller polls for the
// token as always); false when the code and the browser are needed, with
// the reason printed. A choice only flags can make is an Error.
export async function approveByTailnet({ origin, userCode, flags, purpose, agent, out, fetchImpl = fetch, machine = machineName() }) {
  const client = tailnetClient(origin, { fetchImpl, machine })
  const who = await whoAmI(client)
  if (who.mode === 'self') {
    out(OWN_MACHINE)
    out('So this login is approved with the code, by someone signed in with a passkey or from another tailnet device:')
    return false
  }
  if (who.mode === 'off' || who.mode === 'none') return false
  if (who.mode === 'visitor') {
    out(`This server signs tailnet users in, and ${who.login} has no account on it yet (shapewall join --remote ${origin}).`)
    return false
  }
  try {
    const looked = await client.post('/api/device/lookup', { code: userCode })
    if (!looked.ok) return false
    const workspaces = looked.data?.workspaces || []
    if (!workspaces.length) {
      out(`${who.login} may not make tokens in any workspace here (that takes the admin role), so someone who may approves it:`)
      return false
    }
    const { workspace, project } = pickProject(workspaces, flags)
    const body = { code: userCode, workspaceId: workspace.id, projectId: project.id }
    if (purpose === 'agent') {
      const audience = flags['used-by'] === undefined ? 'owner' : String(flags['used-by'])
      if (!['owner', 'trusted'].includes(audience))
        throw new Error(
          '--used-by: "owner" (only you, the default) or "trusted" (everyone the project lets send work to an agent). Named members are picked in the console.',
        )
      body.agent = {
        name: typeof flags.name === 'string' && flags.name.trim() ? flags.name.trim() : agent?.name || machine,
        icon: typeof flags.icon === 'string' ? flags.icon : null,
        tint: typeof flags.tint === 'string' ? flags.tint : null,
        audience,
      }
    } else body.scopes = purpose === 'import' ? [...LOGIN_SCOPES, 'import'] : LOGIN_SCOPES
    const approved = await client.post('/api/device/approve', body)
    if (approved.ok) {
      out(
        `Approved by your tailnet identity (${who.login}) for ${terminalSafe(workspace.name)} / ${terminalSafe(project.name)}: no code, no browser.`,
      )
      return true
    }
    const code = approved.data?.error?.code
    // The server decides (from the session, not from anything this command sends) whether a tailnet
    // identity alone may approve: a workspace can want the code, the browser and a passkey.
    if (['browser_approval_required', 'reauth_required', 'passkey_required'].includes(code)) {
      out(
        approved.data.error.stepUp === 'cliApproval' || code === 'browser_approval_required'
          ? 'This workspace approves logins and agent connections in the browser, with a passkey, also from a tailnet machine:'
          : 'This workspace asks for a passkey before it approves a machine, so it is approved in the browser:',
      )
      return false
    }
    // A refusal the browser would get too (a bad name or icon, a full project): said as it is.
    throw new Error(errorOf(approved, `The server refused the approval (${approved.status}).`))
  } finally {
    await client.signOut()
  }
}

// ---- shapewall join ------------------------------------------------------------

// An invite as given: the link (https://host/invite#code) or the code alone.
export function inviteCode(value) {
  const text = String(value || '').trim()
  const hash = text.indexOf('#')
  const code = hash >= 0 ? text.slice(hash + 1) : text
  return /^[A-Za-z0-9_-]{20,100}$/.test(code) ? code : null
}

async function describeWorkspace(client, workspaceId, out) {
  const detail = await client.get(`/api/workspaces/${workspaceId}`)
  if (!detail.ok) return
  const { workspace, role, projects = [] } = detail.data
  out(`  ${terminalSafe(workspace.name)}: you are ${role === 'owner' || role === 'admin' ? 'an' : 'a'} ${role}.`)
  if (!projects.length) out('    No projects yet.')
  for (const project of projects) out(`    ${terminalSafe(project.name)}    ${client.origin}${project.boardUrl}`)
}

// `shapewall join --remote URL [--invite LINK|CODE]`. Returns the exit code.
export async function joinCommand(flags, print, { env = process.env, fetchImpl = fetch } = {}) {
  const out = safeOut(print)
  const origin = remoteOrigin(flags, env)
  const client = tailnetClient(origin, { fetchImpl })
  const invite = flags.invite === undefined ? null : inviteCode(flags.invite)
  if (flags.invite !== undefined && !invite) throw new Error('--invite: an invite link (https://.../invite#...) or its code.')
  const who = await whoAmI(client)
  if (who.mode === 'off') {
    out(`${origin} does not sign people in by tailnet identity: an account there needs a passkey, and a passkey is made in the browser.`)
    out(`Open ${invite ? `${origin}/invite#${invite}` : `the invite link an admin sent you (or ${origin}/signin if you have an account)`}.`)
    return 1
  }
  if (who.mode === 'self') {
    out(OWN_MACHINE)
    out(
      `Run shapewall join on another tailnet device of yours, or open ${invite ? `${origin}/invite#${invite}` : origin} in a browser and use a passkey.`,
    )
    return 1
  }
  if (who.mode === 'none') {
    out('The server could not tell who you are: this request did not come through the tailnet from a device that belongs to a person')
    out('(a tagged device and a node shared in without a user are never signed in). Use the invite link in a browser instead.')
    return 1
  }
  try {
    let joined = []
    if (who.mode === 'account' && invite) {
      const accepted = await client.post('/api/invites/accept', { token: invite })
      if (!accepted.ok) throw new Error(errorOf(accepted, `The invite was refused (${accepted.status}).`))
      joined = [accepted.data.workspaceId]
    } else {
      if (who.mode === 'visitor' && !invite && !who.invites.length) {
        out(`No invite is waiting for ${who.login} on ${origin}.`)
        out(
          `Ask an admin of a workspace there to invite you: shapewall admin invites create --login ${who.login} --role member --remote ${origin}`,
        )
        out('(They also see you under Members, "Arrived through the tailnet". You cannot join a workspace that did not invite you.)')
        return 1
      }
      const answer = await client.post('/auth/tailnet/join', invite ? { invite } : {})
      if (!answer.ok) throw new Error(errorOf(answer, `Joining was refused (${answer.status}).`))
      joined = answer.data.joined || (answer.data.workspaceId ? [answer.data.workspaceId] : [])
      if (who.mode === 'visitor')
        out(`Made your account on ${origin}: @${terminalSafe(answer.data.user?.handle)}, signed in by your tailnet login ${who.login}.`)
    }
    if (!joined.length) {
      out(`No invite is waiting for ${who.login} on ${origin}; nothing changed.`)
      return 1
    }
    out(`Joined as ${who.login}:`)
    for (const id of joined) await describeWorkspace(client, id, out)
    out('The role is the one the invite gave. A passkey is optional here; add one in the browser under Account and security.')
    return 0
  } finally {
    await client.signOut()
  }
}

// ---- shapewall hosted claim ---------------------------------------------------

// `shapewall hosted claim --data DIR [--workspace-name NAME] [--login LOGIN]`:
// the first account of a new tailnet server, without the browser. `setupUrl`
// is the one-time link from the data folder: only someone who can read that
// folder has it. Who the owner is comes from the request through the proxy;
// --login can only refuse another answer, never choose one.
export async function claimServer({ setupUrl, flags, out: print, fetchImpl = fetch }) {
  const out = safeOut(print)
  let url
  try {
    url = new URL(setupUrl)
  } catch {
    throw new Error('The setup link in the data folder is not a URL.')
  }
  const setup = new URLSearchParams(url.hash.slice(1)).get('setup')
  if (!setup) throw new Error('The setup link in the data folder has no setup code.')
  const origin = url.origin
  const client = tailnetClient(origin, { fetchImpl })
  const who = await whoAmI(client)
  if (who.mode === 'off') {
    out(`The server at ${origin} does not sign people in by tailnet identity (or it is not running).`)
    out('Start it with --tailscale --tailnet-sign-in, or open the setup link in a browser and make the first account with a passkey.')
    return 1
  }
  if (who.mode === 'self') {
    out(OWN_MACHINE)
    out(
      'On the server’s machine the data folder is the proof instead: shapewall hosted claim --data <dir> --login <the owner’s tailnet login>',
    )
    return 1
  }
  if (who.mode === 'none') {
    out(
      `The server at ${origin} could not tell who you are: the request must come through the tailnet from a device that belongs to a person.`,
    )
    out('Open the setup link in a browser on such a device instead (shapewall hosted setup-link).')
    return 1
  }
  if (who.mode === 'account') {
    await client.signOut()
    out(`${who.login} already has an account on this server; a server is claimed once.`)
    return 1
  }
  const wanted = typeof flags.login === 'string' ? flags.login.trim().toLowerCase() : null
  if (wanted && wanted !== who.login) {
    out(`The tailnet says you are ${who.login}, not ${terminalSafe(wanted)}. Nothing was claimed.`)
    return 1
  }
  try {
    const answer = await client.post('/auth/tailnet/join', {
      setup,
      ...(wanted ? { expectLogin: wanted } : {}),
      ...(typeof flags['workspace-name'] === 'string' ? { workspaceName: flags['workspace-name'] } : {}),
    })
    if (!answer.ok) throw new Error(errorOf(answer, `The server refused the claim (${answer.status}).`))
    out(`Claimed ${origin}.`)
    out(`  Owner: ${who.login} (account @${terminalSafe(answer.data.user?.handle)}), signed in by tailnet identity.`)
    const detail = await client.get(`/api/workspaces/${answer.data.workspaceId}`)
    if (detail.ok) out(`  Workspace: ${terminalSafe(detail.data.workspace.name)} (you are its owner).`)
    out('  The setup link is used up.')
    out(
      `No passkey was made. Add one in the browser (${origin}/account) before you need it: deleting a workspace, changing owners and a few`,
    )
    out('other things always ask for one, and a first passkey can confirm them 24 hours after it is added (it signs in at once).')
    out('Anything that runs as you on a tailnet device of yours can act as you here: your tailnet identity is per device, not per person.')
    out(`Next: shapewall admin projects create "My site" --remote ${origin}`)
    return 0
  } finally {
    await client.signOut()
  }
}

// ---- shapewall admin ------------------------------------------------------------

const ADMIN_USAGE =
  'shapewall admin projects list|create NAME, admin invites create --login LOGIN|--link [--role ROLE] [--days N], admin members list, admin agents list (each with --remote URL, and --workspace NAME when you are in several)'

const table = (rows) => {
  const widths = []
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] || 0, String(cell).length)))
  return rows.map(
    (row) =>
      `  ${row
        .map((cell, index) => String(cell).padEnd(widths[index]))
        .join('  ')
        .trimEnd()}`,
  )
}

// `shapewall admin <what> <action>`: a few of the console's admin pages from
// the command line, as the account the tailnet signs this machine's user in
// as. The server checks the role and writes the audit entry, as for the
// console. Returns the exit code.
export async function adminCommand(positional, flags, print, { env = process.env, fetchImpl = fetch } = {}) {
  const out = safeOut(print)
  const [what, action = 'list', ...rest] = positional
  const known = { projects: ['list', 'create'], invites: ['create'], members: ['list'], agents: ['list'] }
  if (!known[what] || !known[what].includes(action)) throw new Error(`Usage: ${ADMIN_USAGE}`)
  const origin = remoteOrigin(flags, env)
  const client = tailnetClient(origin, { fetchImpl })
  const who = await whoAmI(client)
  if (who.mode !== 'account') {
    if (who.mode === 'off') {
      out(
        `${origin} does not sign people in by tailnet identity, so these commands would need an admin token, and admin tokens do not exist yet.`,
      )
      out(`Use the console: ${origin}/`)
    } else if (who.mode === 'self') {
      out(OWN_MACHINE)
      out(`Run this on another tailnet device of yours, or use the console: ${origin}/`)
    } else if (who.mode === 'visitor') out(`${who.login} has no account on ${origin} yet: shapewall join --remote ${origin}`)
    else out('The server could not tell who you are: this request did not come through the tailnet from a device that belongs to a person.')
    return 1
  }
  try {
    const workspace = pickWorkspace(who.me.workspaces, flags.workspace)
    const base = `/api/workspaces/${workspace.id}`
    const refuse = (answer) => {
      throw new Error(errorOf(answer, `The server refused (${answer.status}).`))
    }
    if (what === 'projects' && action === 'create') {
      const name = rest.join(' ').trim() || (typeof flags.name === 'string' ? flags.name : '')
      if (!name) throw new Error('admin projects create NAME: the name of the project.')
      const made = await client.post(`${base}/projects`, { name })
      if (!made.ok) refuse(made)
      if (flags.json) out(JSON.stringify(made.data.project, null, 2))
      else {
        out(`Made the project "${terminalSafe(made.data.project.name)}" in ${terminalSafe(workspace.name)}.`)
        out(`  Board: ${origin}${made.data.project.boardUrl}`)
        out(`  Next: shapewall login --remote ${origin} --project ${quote(made.data.project.slug)}`)
      }
      return 0
    }
    if (what === 'invites') {
      const role = flags.role === undefined ? 'member' : String(flags.role)
      const login = typeof flags.login === 'string' ? flags.login.trim() : null
      if (Boolean(login) === Boolean(flags.link))
        throw new Error('admin invites create: --login LOGIN (for one tailnet login) or --link (a link anyone you send it to can use).')
      const days = flags.days === undefined ? undefined : Number(flags.days)
      const made = await client.post(`${base}/invites`, {
        role,
        ...(login ? { tailnetLogin: login } : {}),
        ...(days === undefined ? {} : { expiresInDays: days }),
      })
      if (!made.ok) refuse(made)
      if (flags.json) out(JSON.stringify({ invite: made.data.invite, ...(login ? {} : { url: made.data.url }) }, null, 2))
      else if (login) {
        out(
          `Invited ${terminalSafe(made.data.invite.tailnetLogin)} to ${terminalSafe(workspace.name)} as ${role}. Only that tailnet login can take it.`,
        )
        out(`  They run: shapewall join --remote ${origin}    (or open ${origin}/ in a browser on the tailnet)`)
      } else {
        out(`An invite to ${terminalSafe(workspace.name)} as ${role}. Whoever has this link can use it once:`)
        out(`  ${made.data.url}`)
      }
      return 0
    }
    const detail = await client.get(base)
    if (!detail.ok) refuse(detail)
    if (what === 'projects') {
      if (flags.json) out(JSON.stringify(detail.data.projects, null, 2))
      else if (!detail.data.projects.length)
        out(`No projects in ${terminalSafe(workspace.name)} yet. shapewall admin projects create "Name" --remote ${origin}`)
      else
        for (const line of table(detail.data.projects.map((item) => [terminalSafe(item.name), item.slug, `${origin}${item.boardUrl}`])))
          out(line)
      return 0
    }
    if (what === 'members') {
      if (flags.json) out(JSON.stringify(detail.data.members, null, 2))
      else
        for (const line of table(detail.data.members.map((item) => [terminalSafe(item.displayName), `@${item.handle}`, item.role])))
          out(line)
      return 0
    }
    const agents = await client.get(`${base}/agents`)
    if (!agents.ok) refuse(agents)
    const list = agents.data.agents || []
    if (flags.json) out(JSON.stringify(list, null, 2))
    else if (!list.length) out(`No agents in ${terminalSafe(workspace.name)} yet. shapewall agent connect --remote ${origin}`)
    else
      for (const line of table(
        list.map((item) => [
          terminalSafe(item.name),
          terminalSafe(item.projectName || ''),
          terminalSafe(item.state || ''),
          terminalSafe(item.machine || ''),
        ]),
      ))
        out(line)
    return 0
  } finally {
    await client.signOut()
  }
}
