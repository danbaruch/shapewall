// Mode 1: `shapewall hosted --tailscale`. The server listens on loopback and
// `tailscale serve` puts it on the tailnet at https://<machine>.<tailnet>.ts.net
// with a real certificate, so passkeys work and nothing is public.
//
// Optional, `--funnel`: a second listener that serves only what a share link
// guest needs (the share landing page, the guest board and its API, live
// HTML, the report form), published to the internet through Tailscale Funnel
// on its own port. The console, sign-in, sign-up, invites, the token API and
// member boards are never on it: those paths answer 404 there, and it never
// reads the session cookie.
//
// Both use `tailscale serve|funnel --bg`, which Tailscale keeps across
// restarts; the server removes what it added when it stops (SIGINT/SIGTERM).
// A config left behind by a crash must be removed explicitly before retrying.
// An occupied port is never taken over, even if its target happens to match.

import { execFile } from 'node:child_process'

export class TailscaleError extends Error {}

// Funnel only publishes these HTTPS ports.
export const FUNNEL_PORTS = [443, 8443, 10000]

const INSTALL_HELP = `Tailscale is not installed on this machine (no "tailscale" command on PATH).
To run hosted Shapewall on your tailnet:
  1. Install Tailscale: https://tailscale.com/download
  2. Sign in: sudo tailscale up
  3. In the admin console (DNS page) turn on MagicDNS and HTTPS certificates.
  4. Let your user configure serve: sudo tailscale set --operator=$USER
Then run shapewall hosted --tailscale again. Without Tailscale, run the server
behind your own reverse proxy instead (docs/hosted.md, "Own domain").`

export function runCommand(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') return resolve({ missing: true, code: null, stdout: '', stderr: '' })
      resolve({ missing: false, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
    })
  })
}

function explain(result, what) {
  const text = `${result.stderr || ''}${result.stdout || ''}`.trim()
  if (/access denied|permission denied|must be root|operator/i.test(text))
    return new TailscaleError(
      `${what} was refused by tailscaled: ${firstLine(text)}\nLet your user configure it once: sudo tailscale set --operator=$USER. Run Shapewall as an unprivileged user.`,
    )
  if (/funnel.*(not enabled|not available|disabled)|nodeAttr|funnel is not/i.test(text))
    return new TailscaleError(
      `${what} failed: Funnel is not allowed for this machine (${firstLine(text)}). Turn it on in the tailnet policy (nodeAttrs "funnel"), or run without --funnel.`,
    )
  if (/https.*(not enabled|disabled)|certificate|cert domains/i.test(text))
    return new TailscaleError(
      `${what} failed: HTTPS certificates are off for this tailnet (${firstLine(text)}). Turn them on in the admin console, DNS page.`,
    )
  return new TailscaleError(`${what} failed (exit ${result.code}): ${firstLine(text) || 'no output'}`)
}

const firstLine = (text) =>
  String(text || '')
    .split('\n')
    .find(Boolean)
    ?.slice(0, 300) || ''

// This machine on the tailnet: its MagicDNS name and whether it can serve.
export async function tailscaleStatus({ run = runCommand } = {}) {
  const result = await run('tailscale', ['status', '--json'])
  if (result.missing) throw new TailscaleError(INSTALL_HELP)
  if (result.code !== 0) throw explain(result, 'tailscale status')
  let status
  try {
    status = JSON.parse(result.stdout)
  } catch {
    throw new TailscaleError('tailscale status --json did not answer JSON; is tailscaled running?')
  }
  if (status.BackendState !== 'Running')
    throw new TailscaleError(`Tailscale is not connected (state: ${status.BackendState || 'unknown'}). Run: sudo tailscale up`)
  const dnsName = String(status.Self?.DNSName || '').replace(/\.$/, '')
  if (!dnsName || !/\.ts\.net$/i.test(dnsName))
    throw new TailscaleError('This machine has no MagicDNS name (*.ts.net). Turn on MagicDNS in the Tailscale admin console, DNS page.')
  const certDomains = (status.CertDomains || []).map((name) => String(name).replace(/\.$/, ''))
  if (!certDomains.includes(dnsName))
    throw new TailscaleError(
      `HTTPS certificates are off for this tailnet, so ${dnsName} cannot serve https. Turn on "HTTPS Certificates" in the admin console, DNS page.`,
    )
  return { dnsName: dnsName.toLowerCase(), version: status.Version || null }
}

// What `tailscale serve` already does on `port`: null (free), or the local
// target(s) it proxies to and whether Funnel is on there.
export async function servedOn(port, { run = runCommand, dnsName } = {}) {
  const result = await run('tailscale', ['serve', 'status', '--json'])
  if (result.missing) throw new TailscaleError(INSTALL_HELP)
  if (result.code !== 0) throw explain(result, 'tailscale serve status')
  let config = {}
  try {
    config = JSON.parse(result.stdout || '{}') || {}
  } catch (error) {
    throw new TailscaleError('tailscale serve status returned invalid JSON; refusing to change its configuration', { cause: error })
  }
  const tcp = config.TCP?.[String(port)]
  if (!tcp) return null
  const web = config.Web?.[`${dnsName}:${port}`] || Object.entries(config.Web || {}).find(([key]) => key.endsWith(`:${port}`))?.[1]
  const targets = Object.values(web?.Handlers || {}).map((handler) => handler.Proxy || handler.Path || handler.Text || 'something')
  if (tcp.TCPForward) targets.push(`tcp ${tcp.TCPForward}`)
  const funnel = Object.entries(config.AllowFunnel || {}).some(([key, on]) => on && key.endsWith(`:${port}`))
  return { targets, funnel }
}

const localTarget = (port) => `http://127.0.0.1:${port}`

async function claim(kind, httpsPort, localPort, { run, dnsName }) {
  const current = await servedOn(httpsPort, { run, dnsName })
  const target = localTarget(localPort)
  if (current) {
    throw new TailscaleError(
      `Tailscale already serves port ${httpsPort} on this machine (${current.targets.join(', ') || 'another service'}${current.funnel ? ', public through Funnel' : ''}). ` +
        `Pick another port (${kind === 'funnel' ? `--funnel-port, one of ${FUNNEL_PORTS.join(', ')}` : '--tailscale-port 8443'}) or remove it first: tailscale ${kind} --https=${httpsPort} off`,
    )
  }
  const result = await run('tailscale', [kind, '--bg', `--https=${httpsPort}`, target])
  if (result.code !== 0) throw explain(result, `tailscale ${kind} --https=${httpsPort}`)
  return async () => {
    const active = await servedOn(httpsPort, { run, dnsName })
    if (!active) return true
    if (active.targets.length !== 1 || active.targets[0] !== target || active.funnel !== (kind === 'funnel')) return false
    const off = await run('tailscale', [kind, `--https=${httpsPort}`, 'off'])
    return off.code === 0
  }
}

// Puts the server on the tailnet. Returns { origin, shareOrigin, stop }:
// `stop()` removes what was added.
export async function startTailscale({ localPort, httpsPort = 443, funnel = null, run = runCommand }) {
  const { dnsName } = await tailscaleStatus({ run })
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) throw new TailscaleError('--tailscale-port: a port number')
  if (funnel) {
    if (!FUNNEL_PORTS.includes(funnel.httpsPort))
      throw new TailscaleError(`--funnel-port: Funnel publishes only ports ${FUNNEL_PORTS.join(', ')}`)
    if (funnel.httpsPort === httpsPort) throw new TailscaleError('--funnel-port must differ from --tailscale-port')
  }
  const undo = []
  const stop = async () => {
    const results = []
    for (const step of undo.reverse()) results.push(await step().catch(() => false))
    undo.length = 0
    return results.every(Boolean)
  }
  try {
    undo.push(await claim('serve', httpsPort, localPort, { run, dnsName }))
    let shareOrigin = null
    if (funnel) {
      undo.push(await claim('funnel', funnel.httpsPort, funnel.localPort, { run, dnsName }))
      shareOrigin = originFor(dnsName, funnel.httpsPort)
    }
    // For tailnet sign-in: why the identity headers on this server's port
    // cannot be believed right now, or null (see serveProblem).
    const verify = async () => {
      const result = await run('tailscale', ['serve', 'status', '--json'])
      if (result.missing || result.code !== 0) return 'tailscale serve status could not be read'
      try {
        return serveProblem(JSON.parse(result.stdout || '{}') || {}, { dnsName, httpsPort, localPort })
      } catch {
        return 'tailscale serve status did not answer JSON'
      }
    }
    return { origin: originFor(dnsName, httpsPort), shareOrigin, dnsName, stop, verify }
  } catch (error) {
    await stop()
    throw error
  }
}

// Tailnet sign-in believes the identity headers only on requests that
// tailscaled's HTTP proxy sent (src/hosted/tailnet-identity.js). The proxy
// removes whatever identity headers a client sent and sets its own; a raw
// TCP forward does neither, so a tailnet device could write any login
// through one. This says what in a serve config (`tailscale serve status
// --json`) breaks that, or null when the only thing that reaches this
// server's local port is the one HTTPS entry this process added:
//   - a TCP forward (plain or TLS-terminated) to the local port;
//   - any other serve entry that proxies to it (another port or path, a
//     foreground session, a service);
//   - Funnel switched on for the tailnet port;
//   - the entry itself gone or changed.
export function serveProblem(config, { dnsName, httpsPort, localPort }) {
  const target = localTarget(localPort)
  const reachesUs = (value) => {
    const text = String(value || '')
      .toLowerCase()
      .replace(/^[a-z+]+:\/\//, '')
      .replace(/\/.*$/, '')
    return [`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`].includes(text) || text === String(localPort)
  }
  const own = `${dnsName}:${httpsPort}`
  let ours = 0
  const entries = [config, ...Object.values(config?.Foreground || {}), ...Object.values(config?.Services || {})]
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    for (const [port, tcp] of Object.entries(entry.TCP || {}))
      if (tcp?.TCPForward && reachesUs(tcp.TCPForward))
        return `a raw TCP forward on tailnet port ${port} points at this server, and a TCP forward passes identity headers through unchecked`
    for (const [key, web] of Object.entries(entry.Web || {}))
      for (const [mount, handler] of Object.entries(web?.Handlers || {})) {
        if (!handler?.Proxy || !reachesUs(handler.Proxy)) continue
        if (entry === config && key === own && mount === '/' && handler.Proxy === target) ours += 1
        else return `another tailscale serve entry (${key}${mount}) points at this server`
      }
    for (const [key, on] of Object.entries(entry.AllowFunnel || {})) if (on && key === own) return `Funnel is on for ${own}`
  }
  if (ours !== 1) return 'the tailscale serve entry this server added is gone or was changed'
  return null
}

export const originFor = (dnsName, port) => `https://${dnsName}${port === 443 ? '' : `:${port}`}`

// ---- The share-only listener ----------------------------------------------------

// What the Funnel listener answers. Everything else is a plain 404, so the
// console, sign-in and member APIs do not exist on the public port.
export function shareOnlyAllowed(method, pathname) {
  const read = method === 'GET' || method === 'HEAD'
  if (read && (pathname === '/share' || pathname === '/share/')) return true
  if (read && pathname.startsWith('/_console/')) return true
  if (method === 'POST' && (pathname === '/api/shares/preview' || pathname === '/api/shares/open')) return true
  if (/^\/s\/sh_[a-f0-9]{24}(?:\/|$)/.test(pathname)) return true
  if (read && pathname.startsWith('/uc/')) return true
  if ((read || method === 'POST') && pathname === '/report') return true
  if (read && (pathname === '/api/legal' || pathname === '/api/health')) return true
  return false
}

// Wraps a hosted app (made with the Funnel origin) for the public listener.
// The console asks /auth/me on every page; here it is always signed out.
export function shareOnly(app) {
  return (req, res) => {
    const pathname = (req.url || '/').split('?')[0]
    if (req.method === 'GET' && pathname === '/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      return res.end(JSON.stringify({ user: null, signup: 'invite' }))
    }
    if (!shareOnlyAllowed(req.method, pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' })
      return res.end('Not found')
    }
    // Browsers may send same-host cookies across ports. Never pass the member
    // session or ceremony cookie to hosted authentication on this listener.
    if (req.headers.cookie) {
      req.headers.cookie = req.headers.cookie
        .split(';')
        .filter((part) => !/^\s*(__Host-)?sw_(session|ceremony)=/.test(part))
        .join(';')
    }
    // Funnel traffic never carries a tailnet identity; whatever claims one is dropped here too.
    for (const name of Object.keys(req.headers)) if (name.startsWith('tailscale-')) delete req.headers[name]
    return app(req, res)
  }
}
