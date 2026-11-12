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
import { SECRET_PREFIX, hostFacts, selfFromStatus, serveProblem, serveTarget, tailscaledProblem, whoisAnswer } from '../tailnet-proof.js'

export { reachesLocalPort, serveProblem } from '../tailnet-proof.js'

export class TailscaleError extends Error {}
// Tailnet sign-in cannot be switched on with this tailscaled (the message says why).
export class TailnetSignInRefused extends Error {}
const NO_SELF =
  'tailscale status does not say which node this machine is (its id and own tailnet addresses), so a request from this machine itself could not be told apart'

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
  return { dnsName: dnsName.toLowerCase(), version: status.Version || null, status }
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

// A target as an error message may show it: never the secret path of a serve entry.
const shown = (target) => {
  const at = String(target).indexOf(SECRET_PREFIX)
  return at < 0 ? target : `${String(target).slice(0, at + SECRET_PREFIX.length)}...`
}

async function claim(kind, httpsPort, localPort, { run, dnsName, secret = null }) {
  const current = await servedOn(httpsPort, { run, dnsName })
  // With tailnet sign-in the entry points at a secret path (src/tailnet-proof.js).
  const target = secret ? serveTarget(localPort, secret) : localTarget(localPort)
  if (current) {
    throw new TailscaleError(
      `Tailscale already serves port ${httpsPort} on this machine (${current.targets.map(shown).join(', ') || 'another service'}${current.funnel ? ', public through Funnel' : ''}). ` +
        `Pick another port (${kind === 'funnel' ? `--funnel-port, one of ${FUNNEL_PORTS.join(', ')}` : '--tailscale-port 8443'}) or remove it first: tailscale ${kind} --https=${httpsPort} off`,
    )
  }
  const result = await run('tailscale', [kind, '--bg', `--https=${httpsPort}`, target])
  if (result.code !== 0) {
    const error = explain(result, `tailscale ${kind} --https=${httpsPort}`)
    // tailscale may quote its arguments back: the secret never reaches a log.
    if (secret) error.message = error.message.split(secret).join('...')
    throw error
  }
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
// `secret`: tailnet sign-in; the serve entry then carries it, and `verify`
// and `whois` are what the identity proof asks while the server runs.
// `facts`: what the machine says about tailscaled (tests).
export async function startTailscale({ localPort, httpsPort = 443, funnel = null, run = runCommand, secret = null, facts = hostFacts }) {
  const { dnsName, status } = await tailscaleStatus({ run })
  // This node (its stable id and own tailnet addresses): an identity that comes from it is never honoured.
  let here = selfFromStatus(status)
  if (secret) {
    // Before anything is put on the tailnet.
    const problem = tailscaledProblem(status, facts())
    if (problem) throw new TailnetSignInRefused(problem)
    if (!here) throw new TailnetSignInRefused(NO_SELF)
  }
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
    undo.push(await claim('serve', httpsPort, localPort, { run, dnsName, secret }))
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
      let problem
      try {
        problem = serveProblem(JSON.parse(result.stdout || '{}') || {}, {
          dnsName,
          httpsPort,
          localPort,
          ...(secret ? { target: serveTarget(localPort, secret) } : {}),
        })
      } catch {
        return 'tailscale serve status did not answer JSON'
      }
      if (problem || !secret) return problem
      // And tailscaled itself: still one whose connections can be believed.
      const now = await run('tailscale', ['status', '--json'])
      if (now.missing || now.code !== 0) return 'tailscale status could not be read'
      try {
        const status = JSON.parse(now.stdout)
        here = selfFromStatus(status)
        return tailscaledProblem(status, facts()) || (here ? null : NO_SELF)
      } catch {
        here = null
        return 'tailscale status did not answer JSON'
      }
    }
    // tailscaled's own word on who owns a tailnet address (LocalAPI whois, through the CLI).
    const whois = async (address) => {
      const result = await run('tailscale', ['whois', '--json', address])
      return result.missing || result.code !== 0 ? null : whoisAnswer(result.stdout)
    }
    return { origin: originFor(dnsName, httpsPort), shareOrigin, dnsName, stop, verify, whois, self: () => here }
  } catch (error) {
    await stop()
    throw error
  }
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
