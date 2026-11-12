// Operator commands that work on the data folder directly, from a terminal
// on the server's machine (the server may be running: SQLite in WAL mode
// handles both):
//
//   shapewall hosted setup-link [--data DIR] [--new]
//     prints the first account's one-time setup link (it is never in the
//     log); --new makes a new one, which voids the old one.
//   shapewall hosted move-origin --to https://new.example [--data DIR] [--days N]
//   shapewall hosted move-origin --status
//     records a move to a new origin and prints what to do next
//     (src/hosted/rebind.js has the whole flow).

import fs from 'node:fs'
import path from 'node:path'
import { MIN_NODE, nodeSupportsSqlite, openDatabase, quietSqliteWarning } from './db.js'
import { mintSetupLink, readSetupLink, removeSetupLink, setupFile, setupLinkUsable, userCount, writeSetupLink } from './setup-link.js'
import { sha256 } from './crypto.js'
import { transaction } from './db.js'
import { createMembership } from './membership.js'
import { createQuotas } from './quotas.js'
import { createTailnetAccounts } from './tailnet.js'
import { accounts, auditAccount, tenant } from './tenancy.js'
import { cleanTailnetLogin } from '../tailnet-proof.js'

import { MOVE_DAYS_MAX, getState, readMove, recordMove } from './rebind.js'

// A value as an error message may show it: printable ASCII only.
const show = (value) =>
  String(value ?? '')
    .replace(/[^ -~]/g, '')
    .slice(0, 80)

async function openData(dataDir) {
  if (!nodeSupportsSqlite())
    throw new Error(`shapewall hosted needs Node ${MIN_NODE.join('.')} or newer (for node:sqlite); this is ${process.versions.node}`)
  const dir = path.resolve(dataDir)
  if (!fs.existsSync(path.join(dir, 'shapewall.db')))
    throw new Error(`No hosted data in ${dir}. Start the server once, or pass --data DIR.`)
  quietSqliteWarning()
  return { dir, db: await openDatabase(path.join(dir, 'shapewall.db')) }
}

export async function operatorCommand(action, { dataDir, flags, env = process.env, out = console.log }) {
  const { dir, db } = await openData(dataDir)
  try {
    if (action === 'claim') return claimCommand({ dir, db, flags, out })
    if (action === 'setup-link') return setupLinkCommand({ dir, db, flags, env, out })
    if (action === 'move-origin') return moveOriginCommand({ db, flags, out })
  } finally {
    db.close()
  }
}

// `shapewall hosted claim --data DIR --login LOGIN [--workspace-name NAME]`:
// the first account of a server with tailnet sign-in, made on the server's
// own machine without a browser.
//
// The proof is the data folder. Whoever can read it has the setup link (the
// one-time secret that makes the first account), the database and the
// signing secret: they control the server already. Who the owner is cannot
// be asked of the tailnet from here: a request from the server's own machine
// names the machine's owner whoever sends it, so the server never takes an
// identity from this machine (src/tailnet-proof.js). So the owner's tailnet
// login is said with --login, and it is the operator's word: the account is
// linked to that login, and whoever arrives through the tailnet as that
// login from another device is its owner. (From another tailnet device, the
// setup link opened in a browser claims by identity instead.)
function claimCommand({ dir, db, flags, out }) {
  if (userCount(db) > 0)
    throw new Error(
      'This server is claimed already: it has accounts. The setup link is only for the first one; admins invite everyone else.',
    )
  const link = readSetupLink(dir)
  if (!link || !setupLinkUsable(db, link))
    throw new Error(
      `No usable setup link in ${dir}. Start the server (it writes one when it has no accounts), or run "shapewall hosted setup-link --new".`,
    )
  if (typeof flags.login !== 'string' || !flags.login.trim())
    throw new Error(
      'claim: say whose server this is with --login <tailnet login> (like ada@example.com: the name the owner signs in to Tailscale with; "tailscale whois $(tailscale ip -4)" on one of their devices shows it).',
    )
  const login = cleanTailnetLogin(flags.login)
  if (!login) throw new Error(`--login: "${show(flags.login)}" is not a tailnet login (user@domain, plain letters and digits).`)
  const iso = () => new Date().toISOString()
  const q = accounts(db)
  const code = new URLSearchParams(new URL(link).hash.slice(1)).get('setup') || ''
  const { createWorkspace } = createMembership({ db, quotas: createQuotas(), iso, auditOf: () => {} })
  const made = transaction(db, () => {
    const used = q.run('UPDATE setup_codes SET used_at = :at WHERE code_hash = :hash AND used_at IS NULL AND expires_at > :at', {
      at: iso(),
      hash: sha256(code),
    })
    if (!used.changes) throw new Error('The setup link was used or expired meanwhile. Nothing was claimed.')
    const user = createTailnetAccounts({ db, iso, now: () => new Date() }).createUser({ login, name: login.split('@')[0] }, {})
    const workspaceName =
      typeof flags['workspace-name'] === 'string' && flags['workspace-name'].trim()
        ? flags['workspace-name']
        : `${user.display_name}'s workspace`
    const workspaceId = createWorkspace(user, workspaceName, null)
    auditAccount(db, {
      userId: user.id,
      action: 'account_created',
      ip: null,
      at: iso(),
      detail: { via: 'setup', signIn: 'tailnet', tailnet: login, by: 'hosted claim on the server' },
    })
    auditAccount(db, {
      userId: user.id,
      action: 'tailnet_linked',
      ip: null,
      at: iso(),
      detail: { tailnet: login, by: 'hosted claim on the server' },
    })
    const workspace = tenant(db, workspaceId).get('SELECT name FROM workspaces WHERE workspace_id = :ws')
    return { user, workspaceName: workspace.name }
  })
  removeSetupLink(dir)
  const origin = new URL(link).origin
  out(`Claimed ${origin}.`)
  out(`  Owner account: @${made.user.handle}, linked to the tailnet login ${login}.`)
  out(`  Workspace: ${made.workspaceName} (that account owns it).`)
  out('  The setup link is used up.')
  out(`Whoever arrives through the tailnet as ${login}, from another device than this server, is signed in as the owner.`)
  out(
    'That login was taken from --login on your word; it was not checked against the tailnet. If it is wrong, delete the data folder and start again.',
  )
  out('This machine itself is never signed in by its tailnet identity: here, use a passkey.')
  out(
    `No passkey was made. Add one in the browser (${origin}/account, from another tailnet device) before you need it: deleting a workspace,`,
  )
  out('changing owners and a few other things always ask for one, and a first passkey can confirm them 24 hours after it is added.')
  out('The server must run with --tailscale --tailnet-sign-in for that login to sign in.')
  return 0
}

function setupLinkCommand({ dir, db, flags, env, out }) {
  if (userCount(db) > 0)
    throw new Error('This server has accounts already. The setup link is only for the first one; admins invite everyone else.')
  const existing = readSetupLink(dir)
  if (existing && !flags.new && setupLinkUsable(db, existing)) {
    out(existing)
    return
  }
  const origin = flags.origin || env.SHAPEWALL_HOSTED_ORIGIN || getState(db, 'origin')?.origin
  if (!origin) throw new Error('Pass --origin URL (the server has not recorded its origin yet).')
  const url = mintSetupLink(db, new URL(origin).origin)
  writeSetupLink(dir, url)
  out(url)
  out(`(Works once, for 24 hours. Also saved in ${setupFile(dir)}.)`)
}

function moveOriginCommand({ db, flags, out }) {
  const current = readMove(db)
  if (flags.status || !flags.to) {
    if (!flags.status && !flags.to) throw new Error('usage: shapewall hosted move-origin --to https://new.example [--days N] | --status')
    if (!current) return out('No move recorded.')
    const open = current.endsAt > new Date().toISOString()
    out(`Move from ${current.from} to ${current.to}, started ${current.startedAt}, ${open ? 'open until' : 'ended'} ${current.endsAt}.`)
    return
  }
  const from = getState(db, 'origin')?.origin
  if (!from) throw new Error('The server has not recorded its origin yet: start it once with --origin.')
  const days = flags.days === undefined ? MOVE_DAYS_MAX : Number(flags.days)
  const move = recordMove(db, { from, to: flags.to, days })
  out(`Recorded the move from ${move.from} to ${move.to} (open until ${move.endsAt}).`)
  out('')
  out('Next:')
  out(`  1. Point ${new URL(move.to).host} at this server (DNS and your reverse proxy), next to ${new URL(move.from).host}.`)
  out(`  2. Restart it with: --origin ${move.to} --previous-origin ${move.from}`)
  out(`  3. People see "This server is moving" on ${move.from} and move their sign-in with one passkey check.`)
  out(`     Anyone who misses it signs in on ${move.to} with their handle and a recovery code.`)
  out(`  4. ${move.from}/.well-known/webauthn lists the new origin, so some browsers can use old passkeys there too.`)
  out(`  After ${move.endsAt} the old origin only redirects. API tokens keep working on both during the move;`)
  out(`  point --remote at ${move.to} before it ends.`)
}
