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
import { mintSetupLink, readSetupLink, setupFile, setupLinkUsable, userCount, writeSetupLink } from './setup-link.js'
import { MOVE_DAYS_MAX, getState, readMove, recordMove } from './rebind.js'

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
    if (action === 'setup-link') return setupLinkCommand({ dir, db, flags, env, out })
    if (action === 'move-origin') return moveOriginCommand({ db, flags, out })
  } finally {
    db.close()
  }
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
