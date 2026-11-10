// `shapewall hosted`: starts the hosted server. Data lives in one folder:
//   <data>/shapewall.db      SQLite (WAL): accounts, workspaces, comments, tokens, audit
//   <data>/secret.key        key for signed capture URLs (0600, made on first start)
//   <data>/files/<ws>/<project>/<board>/   pushed captures (the local layout)
//   <data>/staging/<push>/   pushes in progress
//   <data>/quotas.json       the operator's quotas (optional, src/hosted/quotas.js)
// Back up with `shapewall hosted backup` (src/hosted/backup.js), which takes a
// consistent copy while the server runs.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { MIN_NODE, nodeSupportsSqlite, openDatabase, quietSqliteWarning } from './db.js'
import { writeSetupLink } from './setup-link.js'

export function readSecret(dataDir, env = process.env) {
  if (env.SHAPEWALL_HOSTED_SECRET) return env.SHAPEWALL_HOSTED_SECRET
  const file = path.join(dataDir, 'secret.key')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const secret = randomBytes(32).toString('base64url')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' })
  return secret
}

// Secrets from files instead of the environment: systemd credentials
// (LoadCredential=shapewall-secret:..., resend-api-key:...; read from
// $CREDENTIALS_DIRECTORY) or NAME_FILE variables (Docker secrets). A value
// already in the environment wins. Returns the names it loaded (never values).
export const CREDENTIALS = [
  ['SHAPEWALL_HOSTED_SECRET', 'shapewall-secret'],
  ['RESEND_API_KEY', 'resend-api-key'],
]
export function loadCredentials(env = process.env) {
  const loaded = []
  for (const [name, credential] of CREDENTIALS) {
    if (env[name]) continue
    const file = env[`${name}_FILE`] || (env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, credential) : null)
    if (!file) continue
    let value
    try {
      value = fs.readFileSync(file, 'utf8').trim()
    } catch (error) {
      if (error.code === 'ENOENT' && !env[`${name}_FILE`]) continue
      throw new Error(`${name}: cannot read ${file} (${error.code || error.message})`, { cause: error })
    }
    if (value) {
      env[name] = value
      loaded.push(name)
    }
  }
  return loaded
}

// An https origin served from loopback means a reverse proxy in front; without
// --trust-proxy every client looks like 127.0.0.1 and shares one rate limit.
export function proxyWarning({ origin, host, trustProxy }) {
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(String(host).replace(/^\[|\]$/g, ''))
  if (trustProxy || !loopback || !String(origin).startsWith('https:')) return null
  return 'Warning: the origin is https but the server listens on loopback without --trust-proxy, so rate limits see every client as the proxy. Add --trust-proxy when a reverse proxy on this host forwards to it.'
}

function listen(handler, port, host) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

export async function startHosted({
  dataDir,
  port = 4700,
  host = '127.0.0.1',
  origin = null,
  signup = 'invite',
  usercontentOrigin = null,
  trustProxy = false,
  previousOrigin = null,
  reportEmail = null,
  // Mode 1 (src/hosted/tailscale.js): { httpsPort, funnel: { httpsPort, localPort } | null, run }
  tailscale = null,
  quotasFile = null,
  retentionHours = undefined,
  retentionKeep = undefined,
  env = process.env,
  out = console.log,
  exitOnStop = true,
}) {
  if (!nodeSupportsSqlite())
    throw new Error(`shapewall hosted needs Node ${MIN_NODE.join('.')} or newer (for node:sqlite); this is ${process.versions.node}`)
  if (!['invite', 'open'].includes(signup)) throw new Error('--signup must be invite or open')
  quietSqliteWarning()
  const dir = path.resolve(dataDir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const loaded = loadCredentials(env)
  if (loaded.length) out(`Secrets from credential files: ${loaded.join(', ')}`)
  const { legalSettings } = await import('./operator.js')
  const legal = legalSettings(env)
  const { createQuotas } = await import('./quotas.js')
  const quotaPath = quotasFile
    ? path.resolve(quotasFile)
    : fs.existsSync(path.join(dir, 'quotas.json'))
      ? path.join(dir, 'quotas.json')
      : null
  const quotas = createQuotas({ file: quotaPath, log: (line) => out(line) })
  if (quotaPath) out(`Quotas from ${quotaPath}`)
  if (tailscale && host !== '127.0.0.1')
    throw new Error('--tailscale listens on 127.0.0.1 only (tailscale serve forwards to it); drop --host')
  if (tailscale && origin) throw new Error('--tailscale sets the origin itself (https://<machine>.<tailnet>.ts.net); drop --origin')
  const db = await openDatabase(path.join(dir, 'shapewall.db'))
  const cleanup = []
  const stopAll = async () => {
    for (const step of cleanup.reverse()) await step()
    cleanup.length = 0
  }
  try {
    const { createHostedApp } = await import('./app.js')
    const { createMailer } = await import('./mail.js')
    const { turnstileFromEnv } = await import('./turnstile.js')
    const { createRateLimiter } = await import('./ratelimit.js')
    const { startRetention } = await import('./retention.js')
    // Invite emails through Resend when RESEND_API_KEY and SHAPEWALL_EMAIL_FROM
    // are set; otherwise admins copy the link.
    const mailer = createMailer({ env, log: (line) => out(line) })
    const turnstile = turnstileFromEnv(env, { log: (line) => out(line) })
    if (Boolean(env.SHAPEWALL_TURNSTILE_SITE_KEY) !== Boolean(env.SHAPEWALL_TURNSTILE_SECRET))
      out('Warning: Turnstile needs both SHAPEWALL_TURNSTILE_SITE_KEY and SHAPEWALL_TURNSTILE_SECRET; it stays off.')
    const secret = readSecret(dir, env)
    const rateLimiter = createRateLimiter()

    // Mode 1: listen on loopback first (port 0 picks one), then point
    // tailscale serve at it; the origin is only known after that.
    const holder = { app: null, share: null }
    const server = await listen((req, res) => (holder.app ? holder.app(req, res) : res.writeHead(503).end()), port, host)
    cleanup.push(() => new Promise((resolve) => server.close(() => resolve())))
    const localPort = server.address().port
    let publicOrigin = origin || `http://${host.includes(':') ? `[${host}]` : host}:${localPort}`
    let shareOrigin = null
    let shareServer = null
    if (tailscale) {
      const ts = await import('./tailscale.js')
      let funnel = null
      if (tailscale.funnel) {
        shareServer = await listen((req, res) => (holder.share ? holder.share(req, res) : res.writeHead(503).end()), 0, '127.0.0.1')
        cleanup.push(() => new Promise((resolve) => shareServer.close(() => resolve())))
        funnel = { httpsPort: tailscale.funnel.httpsPort, localPort: shareServer.address().port }
      }
      const served = await ts.startTailscale({
        localPort,
        httpsPort: tailscale.httpsPort ?? 443,
        funnel,
        ...(tailscale.run ? { run: tailscale.run } : {}),
      })
      cleanup.push(async () => {
        const ok = await served.stop()
        out(
          ok
            ? 'Removed the tailscale serve config this server added.'
            : 'Could not remove the tailscale serve config; check tailscale serve status.',
        )
      })
      publicOrigin = served.origin
      shareOrigin = served.shareOrigin
      trustProxy = true
      out(`On your tailnet: ${publicOrigin} (tailscale serve, not public)`)
      if (shareOrigin) out(`Share links are public through Tailscale Funnel: ${shareOrigin} (share pages only; the console is not there)`)
    }

    const warning = proxyWarning({ origin: publicOrigin, host, trustProxy })
    if (warning) out(warning)
    const common = {
      db,
      dataDir: dir,
      signup,
      trustProxy,
      secret,
      rateLimiter,
      quotas,
      legal,
      usercontentOrigin,
      turnstile,
      reportEmail,
      log: (line) => out(line),
    }
    const app = createHostedApp({ ...common, origin: publicOrigin, shareOrigin, previousOrigin, mailer: mailer.configured ? mailer : null })
    app.locals.presence.attach(server)
    holder.app = app
    cleanup.push(() => app.locals.close())
    if (shareServer) {
      const { shareOnly } = await import('./tailscale.js')
      const shareApp = createHostedApp({
        ...common,
        origin: shareOrigin,
        shareOrigin,
        guestOnly: true,
        sweepEveryMs: 0,
        eventBus: app.locals.events,
        presenceHub: app.locals.presence.hub,
      })
      shareApp.locals.presence.attach(shareServer)
      holder.share = shareOnly(shareApp)
      cleanup.push(() => shareApp.locals.close())
    }
    const stopRetention = startRetention({
      db,
      dataDir: dir,
      hours: retentionHours,
      keepDefault: retentionKeep,
      log: (line) => out(line),
    })
    cleanup.push(() => stopRetention())

    out(`Shapewall hosted is listening on ${host}:${localPort} for ${publicOrigin} (sign-up: ${signup})`)
    out(
      !mailer.configured
        ? 'Invite emails: off (set RESEND_API_KEY and SHAPEWALL_EMAIL_FROM to send them)'
        : signup === 'open'
          ? 'Invite emails: off (not with --signup open)'
          : 'Invite emails: on (Resend)',
    )
    if (!legal.terms || !legal.privacy)
      out('Legal links: not set (SHAPEWALL_HOSTED_TERMS_URL, SHAPEWALL_HOSTED_PRIVACY_URL); set them before inviting people.')
    const setup = app.locals.setupLink()
    if (setup) {
      writeSetupLink(dir, setup)
      out(`No accounts yet. The one-time setup link is in ${path.join(dir, 'setup-link')} (0600); read it privately on this machine.`)
    }
    let stopping = null
    const stop = () => {
      stopping ||= (async () => {
        const force = setTimeout(() => exitOnStop && process.exit(0), 8000)
        force.unref()
        server.closeAllConnections?.()
        shareServer?.closeAllConnections?.()
        await stopAll()
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        db.close()
        if (exitOnStop) process.exit(0)
      })()
      return stopping
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    return { server, shareServer, app, db, origin: publicOrigin, shareOrigin, stop }
  } catch (error) {
    await stopAll().catch(() => {})
    db.close()
    throw error
  }
}
