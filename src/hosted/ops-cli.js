// The `shapewall hosted` command line: run the server (modes 1 and 2), the
// operator's `admin` commands, `backup` and `restore`. Mounted from src/cli.js
// with one line; the work is in server.js, setup.js, operator.js, backup.js
// and retention.js.

import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_DATA = 'shapewall-hosted-data'
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g
const show = (value) => String(value ?? '').replace(CONTROL_RE, '')

const dataDirOf = (flags, env = process.env) => path.resolve(flags.data || env.SHAPEWALL_HOSTED_DATA || DEFAULT_DATA)

function intFlag(flags, name, { min, max, fallback }) {
  if (flags[name] === undefined) return fallback
  const value = Number(flags[name])
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name}: a whole number from ${min} to ${max}`)
  return value
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

export async function hostedCommand(positional, flags, out, err = out) {
  const [sub, ...rest] = positional
  if (!sub) return flags.setup ? setup(flags, out) : serve(flags, out)
  if (sub === 'setup-link' || sub === 'move-origin') {
    const { operatorCommand } = await import('./access-cli.js')
    await operatorCommand(sub, { dataDir: dataDirOf(flags), flags, env: process.env, out })
    return 0
  }
  if (sub === 'admin') return admin(rest, flags, out)
  if (sub === 'backup') return backupCommand(flags, out)
  if (sub === 'restore') return restoreCommand(flags, out, err)
  throw new Error(`unknown hosted command "${show(sub).slice(0, 40)}" (admin, backup, restore; or no command to run the server)`)
}

// ---- Run the server ----

async function serve(flags, out) {
  const { startHosted } = await import('./server.js')
  const env = process.env
  const port = intFlag(flags, 'port', { min: 0, max: 65535, fallback: 4700 })
  let tailscale = null
  if (flags.tailscale) {
    tailscale = {
      httpsPort: intFlag(flags, 'tailscale-port', { min: 1, max: 65535, fallback: 443 }),
      funnel: flags.funnel ? { httpsPort: intFlag(flags, 'funnel-port', { min: 1, max: 65535, fallback: 8443 }) } : null,
    }
  } else if (flags.funnel || flags['tailscale-port'] !== undefined || flags['funnel-port'] !== undefined) {
    throw new Error('--funnel, --tailscale-port and --funnel-port go with --tailscale')
  }
  const trustEnv = env.SHAPEWALL_HOSTED_TRUST_PROXY
  // "1": a proxy on this host; "uniquelocal" (Compose): one on a private network.
  const trustProxy = flags['trust-proxy'] ? true : trustEnv === '1' ? true : trustEnv === 'uniquelocal' ? 'uniquelocal' : false
  try {
    await startHosted({
      dataDir: dataDirOf(flags, env),
      port,
      host: flags.host || '127.0.0.1',
      origin: flags.origin || env.SHAPEWALL_HOSTED_ORIGIN || null,
      usercontentOrigin: flags['usercontent-origin'] || env.SHAPEWALL_USERCONTENT_ORIGIN || env.SHAPEWALL_HOSTED_USERCONTENT_ORIGIN || null,
      previousOrigin: flags['previous-origin'] || env.SHAPEWALL_HOSTED_PREVIOUS_ORIGIN || null,
      reportEmail: flags['report-email'] || env.SHAPEWALL_HOSTED_REPORT_EMAIL || null,
      ownersSeeSignIns: Boolean(flags['owners-see-sign-ins']) || env.SHAPEWALL_HOSTED_OWNERS_SEE_SIGN_INS === '1',
      signup: flags.signup || env.SHAPEWALL_HOSTED_SIGNUP || 'invite',
      trustProxy,
      tailscale,
      quotasFile: flags.quotas || env.SHAPEWALL_HOSTED_QUOTAS || null,
      retentionHours: intFlag(flags, 'retention-hours', { min: 0, max: 24 * 30, fallback: undefined }),
      retentionKeep: intFlag(flags, 'retention-keep', { min: 0, max: 100, fallback: undefined }),
      out,
    })
  } catch (error) {
    const { TailscaleError } = await import('./tailscale.js')
    if (error instanceof TailscaleError) {
      out(error.message)
      return 1
    }
    throw error
  }
  return null
}

// ---- Mode 2 setup ----

async function setup(flags, out) {
  const { SetupError, setupHosted, startCompose } = await import('./setup.js')
  let result
  try {
    result = await setupHosted({
      domain: flags.domain,
      usercontentDomain: flags['usercontent-domain'] || null,
      email: flags.email ?? null,
      dir: flags.dir || 'shapewall-hosted',
      ...(flags.source ? { source: flags.source } : {}),
      dryRun: Boolean(flags['dry-run']),
      force: Boolean(flags.force),
    })
  } catch (error) {
    if (error instanceof SetupError) {
      out(error.message)
      return 1
    }
    throw error
  }
  out(
    `${result.dryRun ? 'Would write' : 'Wrote'} ${Object.keys(result.files).join(', ')} to ${result.dir}${result.existing.length && result.dryRun ? ` (would overwrite ${result.existing.join(', ')}: pass --force)` : ''}`,
  )
  out(`  https://${result.domain}${result.usercontentDomain ? ` and https://${result.usercontentDomain} (live HTML)` : ''}`)
  for (const item of result.dns) out(`${item.ok && item.here ? 'ok  ' : item.ok ? 'note' : 'todo'} DNS: ${item.message}`)
  for (const warning of result.warnings) out(`note ${warning}`)
  if (result.dryRun) {
    out('\nDry run: nothing written. Without --dry-run the files are written; add --start to build and start it here.')
    if (flags['print']) for (const [name, text] of Object.entries(result.files)) out(`\n----- ${name} -----\n${text}`)
    return 0
  }
  if (!flags.start) {
    out('\nNext:')
    result.next.forEach((line, index) => out(`  ${index + 1}. ${line}`))
    return 0
  }
  try {
    const started = await startCompose({ dir: result.dir, out })
    if (started.setupLink) out(`\nNo accounts yet. Create the first one (works once, for 24 hours):\n  ${started.setupLink}`)
    else out(started.note)
    return 0
  } catch (error) {
    if (error instanceof SetupError) {
      out(error.message)
      return 1
    }
    throw error
  }
}

// ---- Operator commands ----

async function openExisting(flags) {
  const dir = dataDirOf(flags)
  const file = path.join(dir, 'shapewall.db')
  if (!fs.existsSync(file)) throw new Error(`no hosted database at ${file} (pass --data, the server's data folder)`)
  const { openDatabase, quietSqliteWarning } = await import('./db.js')
  quietSqliteWarning()
  return { dir, db: await openDatabase(file) }
}

const ADMIN_HELP = `shapewall hosted admin <command> --data DIR   (on the server's machine)
  list                         workspaces with usage, owners, open reports
  suspend WS --reason TEXT     read-only, share links off, tokens refused (the reason is shown to its admins)
  resume WS [--note TEXT]
  delete WS --confirm NAME     everything in it, files included (type its name)
  export WS --out FILE.zip     the same zip as the console's "Download a copy"
  reports [--all]              abuse reports (open ones; --all with closed)
  reports close ID [--note TEXT]
  retention WS --keep N|default   older versions kept per page and viewport
  retention WS --usage-days N|default   how long usage records are kept (400 days by default)
  retention --run [--dry-run]  prune now (the server also does it every 6 hours)
  log [--limit N]              the operator log
  --operator NAME              who you are in the operator log (default user@host)
  --json                       machine-readable output`

async function admin(positional, flags, out) {
  const [action, target, extra] = positional
  if (!action || action === 'help') {
    out(ADMIN_HELP)
    return action ? 0 : 1
  }
  const ops = await import('./operator.js')
  const { dir, db } = await openExisting(flags)
  const operator = ops.operatorName(flags.operator)
  const json = (value) => {
    out(JSON.stringify(value, null, 2))
    return 0
  }
  const say = (text) => {
    out(text)
    return 0
  }
  try {
    switch (action) {
      case 'list': {
        ops.recordOperatorRead(db, { action: 'list', operator })
        const { createQuotas } = await import('./quotas.js')
        const quotaFile = flags.quotas || (fs.existsSync(path.join(dir, 'quotas.json')) ? path.join(dir, 'quotas.json') : null)
        const rows = ops.listWorkspaces(db, { quotas: createQuotas({ file: quotaFile }) })
        if (flags.json) return json(rows)
        if (!rows.length) return say('No workspaces yet.')
        for (const row of rows) {
          const state = row.suspendedAt ? `SUSPENDED ${row.suspendedAt.slice(0, 10)}: ${show(row.suspendedReason)}` : 'active'
          out(
            `${row.id}  ${show(row.name)}  [${state}]\n    owners ${row.owners.map(show).join(', ') || 'none'}; ${row.members} people, ${row.projects} projects, ${row.boards} boards, ` +
              `${mb(row.bytes)} of ${mb(row.storageQuotaBytes)}; last push ${row.lastPushAt || 'never'}${row.openReports ? `; ${row.openReports} open reports` : ''}`,
          )
        }
        return 0
      }
      case 'suspend': {
        const result = ops.suspendWorkspace(db, { workspaceId: target, reason: flags.reason, operator })
        if (flags.json) return json(result)
        out(
          `Suspended ${result.id} (${show(result.name)}): read-only, share links off, tokens refused. Undo: shapewall hosted admin resume ${result.id}`,
        )
        return 0
      }
      case 'resume': {
        const result = ops.resumeWorkspace(db, { workspaceId: target, note: flags.note, operator })
        if (flags.json) return json(result)
        out(`Resumed ${result.id} (${show(result.name)}).`)
        return 0
      }
      case 'delete': {
        const result = ops.deleteWorkspace(db, dir, { workspaceId: target, confirm: flags.confirm, operator })
        if (flags.json) return json(result)
        out(
          `Deleted ${result.id} (${show(result.name)}) with ${result.projects} projects and their files. Backups keep it until they age out.`,
        )
        return 0
      }
      case 'export': {
        if (!flags.out) throw new ops.OperatorError('--out FILE.zip: where to write the export')
        const result = await ops.exportWorkspace(db, dir, { workspaceId: target, out: flags.out, operator })
        if (flags.json) return json(result)
        out(`Exported ${result.id} (${show(result.name)}): ${result.files} files, ${mb(result.bytes)} in ${result.file} (mode 0600)`)
        return 0
      }
      case 'reports': {
        if (target === 'close') {
          const result = ops.closeReport(db, { id: extra, note: flags.note, operator })
          if (flags.json) return json(result)
          out(`Closed ${result.id}.`)
          return 0
        }
        if (target) throw new ops.OperatorError(`unknown reports action "${show(target).slice(0, 40)}" (close)`)
        ops.recordOperatorRead(db, { action: 'reports', operator })
        const rows = ops.listReports(db, { all: Boolean(flags.all) })
        if (flags.json) return json(rows)
        if (!rows.length) return say(flags.all ? 'No reports.' : 'No open reports.')
        for (const row of rows) {
          out(
            `${row.id}  ${row.createdAt.slice(0, 16).replace('T', ' ')}  ${row.reason}${row.workspace ? `  workspace ${row.workspace}` : ''}${row.closedAt ? '  (closed)' : ''}\n    ${show(row.url)}` +
              `${row.details ? `\n    ${show(row.details).slice(0, 300)}` : ''}${row.contact ? `\n    contact: ${show(row.contact)}` : ''}`,
          )
        }
        return 0
      }
      case 'retention': {
        if (flags.run) {
          const { runRetention } = await import('./retention.js')
          const dryRun = Boolean(flags['dry-run'])
          const result = runRetention({
            db,
            dataDir: dir,
            dryRun,
            ...(flags.keep !== undefined ? { keepDefault: intFlag(flags, 'keep', { min: 0, max: 100 }) } : {}),
          })
          ops.recordRetentionRun(db, { operator, result, dryRun })
          if (flags.json) return json(result)
          out(
            `${dryRun ? 'Would remove' : 'Removed'} ${result.files} old version files (${mb(result.bytes)}) from ${result.boards} boards in ${result.workspaces} workspaces.`,
          )
          if (result.usageRows) out(`${dryRun ? 'Would remove' : 'Removed'} ${result.usageRows} old usage records.`)
          return 0
        }
        if (target && flags['usage-days'] !== undefined) {
          const days = flags['usage-days'] === 'default' ? null : intFlag(flags, 'usage-days', { min: 1, max: 3650 })
          const result = ops.setUsageRetentionFor(db, { workspaceId: target, days, operator })
          if (flags.json) return json(result)
          out(
            `${result.id} (${show(result.name)}) keeps usage records for ${result.usageDays} days${result.own ? '' : ' (the server default)'}.`,
          )
          return 0
        }
        if (!target || flags.keep === undefined)
          throw new ops.OperatorError(
            'usage: hosted admin retention WS --keep N|default, hosted admin retention WS --usage-days N|default, or hosted admin retention --run [--dry-run]',
          )
        const keep = flags.keep === 'default' ? null : intFlag(flags, 'keep', { min: 0, max: 100 })
        const result = ops.setRetention(db, { workspaceId: target, keep, operator })
        if (flags.json) return json(result)
        out(
          `${result.id} (${show(result.name)}) keeps ${keep === null ? 'the server default number of' : keep} older versions per page and viewport.`,
        )
        return 0
      }
      case 'log': {
        ops.recordOperatorRead(db, { action: 'log', operator })
        const rows = ops.operatorLog(db, { limit: intFlag(flags, 'limit', { min: 1, max: 10_000, fallback: 50 }) })
        if (flags.json) return json(rows)
        if (!rows.length) return say('The operator log is empty.')
        for (const row of rows)
          out(
            `${row.at.slice(0, 19).replace('T', ' ')}  ${show(row.operator)}  ${row.action}${row.target ? ` ${row.target}` : ''}  ${show(JSON.stringify(row.detail))}`,
          )
        return 0
      }
      default:
        throw new ops.OperatorError(`unknown admin command "${show(action).slice(0, 40)}"\n\n${ADMIN_HELP}`)
    }
  } catch (error) {
    if (error instanceof ops.OperatorError) {
      out(error.message)
      return 1
    }
    throw error
  } finally {
    db.close()
  }
}

// ---- Backup and restore ----

async function backupCommand(flags, out) {
  if (!flags.to) throw new Error('usage: shapewall hosted backup --to DIR [--data DIR] [--keep-days N]')
  const { backup } = await import('./backup.js')
  const result = await backup({
    dataDir: dataDirOf(flags),
    to: flags.to,
    keepDays: intFlag(flags, 'keep-days', { min: 1, max: 3650, fallback: null }),
  })
  if (flags.json) {
    out(JSON.stringify({ dir: result.dir, manifest: result.manifest, pruned: result.pruned }, null, 2))
    return 0
  }
  const { counts, files } = result.manifest
  out(`Backed up to ${result.dir}`)
  out(
    `  ${counts.users} accounts, ${counts.workspaces} workspaces, ${counts.projects} projects, ${counts.boards} boards, ${counts.comments} comments; ${files.files} files (${mb(files.bytes)})`,
  )
  if (result.pruned.length) out(`  Removed ${result.pruned.length} backups older than ${flags['keep-days']} days`)
  out('  It holds everything, the signing key included: keep it as private as the server.')
  return 0
}

async function restoreCommand(flags, out) {
  if (!flags.from)
    throw new Error('usage: shapewall hosted restore --from BACKUP --data NEW_DIR, or --from BACKUP --check (the restore drill)')
  const { BackupError, restore, restoreDrill } = await import('./backup.js')
  try {
    if (flags.check) {
      out('Restore drill: restoring into a scratch folder and starting a server on it...')
      const result = await restoreDrill({ from: flags.from, out })
      out(result.ok ? `Restore drill passed for ${result.backup}` : `Restore drill FAILED for ${result.backup}`)
      return result.ok ? 0 : 1
    }
    if (!flags.data) throw new BackupError('--data NEW_DIR: an empty folder to restore into (never the live one)')
    const result = await restore({ from: flags.from, data: flags.data })
    out(`Restored ${result.from} into ${result.data} (schema ${result.schema}, ${result.files.files} files)`)
    out(`Start the server on it: shapewall hosted --data ${result.data} ...  (same --origin as before, or passkeys stop working)`)
    return 0
  } catch (error) {
    if (error instanceof BackupError) {
      out(error.message)
      return 1
    }
    throw error
  }
}
