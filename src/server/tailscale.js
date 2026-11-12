// No shell, sudo, reset, Funnel enablement, or existing-listener replacement.
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { absoluteProgram } from '../which.js'
import {
  createTailnetGate,
  hostFacts,
  newServeSecret,
  procPeerProof,
  proofSelfTest,
  selfFromStatus,
  serveProblem,
  serveTarget,
  tailscaledProblem,
  whoisAnswer,
} from '../tailnet-proof.js'
const execute = promisify(execFile)

export function lanAccess(value, { interfaces = os.networkInterfaces(), hostname = os.hostname() } = {}) {
  let host = value === true ? '0.0.0.0' : String(value)
  if (interfaces[host]) {
    const address = interfaces[host].find((item) => item.family === 'IPv4' && !item.internal)
    if (!address) throw new Error('--lan interface needs an IPv4 address.')
    host = address.address
  }
  // Bind only a local interface, never an arbitrary DNS hostname.
  const addresses = Object.values(interfaces)
    .flat()
    .filter((item) => !item.internal)
    .map((item) => item.address.toLowerCase())
  if (host !== '0.0.0.0' && !addresses.includes(host.toLowerCase())) throw new Error('--lan needs a local interface name or IP address.')
  return {
    host,
    hosts: new Set([
      '127.0.0.1',
      'localhost',
      '[::1]',
      '::1',
      hostname.toLowerCase(),
      `${hostname.toLowerCase()}.local`,
      ...addresses.map((address) => (address.includes(':') ? `[${address}]` : address)),
    ]),
  }
}

export async function tailscaleAccess({
  port,
  noIdentity = false,
  env = process.env,
  run = execute,
  command = absoluteProgram('tailscale', env),
  // The identity proof's parts (tests): the peer check and what the machine says about tailscaled.
  proof = procPeerProof(),
  facts = hostFacts,
  log = () => {},
} = {}) {
  if (!command) throw new Error('Tailscale is not installed. Install it, sign in, then run serve --tailscale again.')
  const call = async (args) => {
    try {
      return (await run(command, args, { cwd: os.tmpdir(), env, timeout: 10000, maxBuffer: 1024 * 1024, shell: false })).stdout
    } catch {
      throw new Error(`Tailscale ${args[0]} failed. Check tailscale status and that your user may manage Serve.`)
    }
  }
  const status = JSON.parse(await call(['status', '--json']))
  if (status.BackendState !== 'Running' || !status.Self?.DNSName || !status.TailscaleIPs?.length)
    throw new Error('Tailscale is not logged in. Run tailscale up, then try again.')
  const host = status.Self.DNSName.replace(/\.$/, '').toLowerCase()
  if (!/^[a-z0-9.-]+\.ts\.net$/.test(host)) throw new Error('Tailscale did not return a valid ts.net hostname.')
  const config = JSON.parse((await call(['serve', 'status', '--json'])) || '{}')
  const funnel = JSON.parse((await call(['funnel', 'status', '--json'])) || '{}')
  const configs = (data) => [data, ...Object.values(data.Foreground || {})]
  const funnelOn = (data) => Object.entries(data.AllowFunnel || {}).some(([key, enabled]) => enabled && key.endsWith(`:${port}`))
  if (configs(config).some(funnelOn) || configs(funnel).some(funnelOn))
    throw new Error(`Funnel is on for port ${port}. Turn it off first: this local board must not be public.`)
  if (configs(config).some((entry) => entry.TCP?.[port] || Object.keys(entry.Web || {}).some((key) => key.endsWith(`:${port}`))))
    throw new Error(`Tailscale port ${port} is already configured. Choose another --port; Shapewall will not replace it.`)
  let ownerLogin = null
  let ownerUserId = null
  if (!noIdentity) {
    const who = JSON.parse(await call(['whois', '--json', status.TailscaleIPs[0]]))
    // Tagged/shared nodes without a user never grant identity access.
    ownerLogin = who.Node?.Tags?.length ? null : who.UserProfile?.LoginName || null
    // Tailscale's own id of the owner: a device is the owner's by that, not by a login that reads the same.
    ownerUserId = ownerLogin ? whoisAnswer(JSON.stringify(who))?.userId || null : null
  }
  // The owner's other devices are let in by their tailnet identity only when
  // a request can be proven to come through the serve entry made here: the
  // same proof as the hosted server's tailnet sign-in (src/tailnet-proof.js:
  // a secret path in the entry, the owner of the connection's other end,
  // tailscaled's own whois, and a tailscaled that can be believed). Where it
  // cannot be proven the board still serves: every other device pairs.
  let identityOff = null
  // This node: a request that comes from this machine itself is never the owner by identity
  // (any local program can ask tailscaled for the serve URL; src/tailnet-proof.js).
  let here = selfFromStatus(status)
  if (ownerLogin)
    identityOff =
      proof.problem?.() || tailscaledProblem(status, facts()) || (here ? null : 'tailscale status does not say which node this machine is')
  const secret = ownerLogin && !identityOff ? newServeSecret() : null
  const target = secret ? serveTarget(port, secret) : `http://127.0.0.1:${port}`
  const whois = async (address) => {
    try {
      return whoisAnswer(
        (await run(command, ['whois', '--json', address], { cwd: os.tmpdir(), env, timeout: 10000, maxBuffer: 1024 * 1024, shell: false }))
          .stdout,
      )
    } catch {
      return null
    }
  }
  const gate = secret ? createTailnetGate({ secret, proof, whois, self: () => here, log }) : null
  const verify = async () => {
    try {
      const now = JSON.parse(await call(['status', '--json']))
      const config = JSON.parse((await call(['serve', 'status', '--json'])) || '{}')
      here = selfFromStatus(now)
      return (
        tailscaledProblem(now, facts()) ||
        (here ? null : 'tailscale status does not say which node this machine is') ||
        serveProblem(config, { dnsName: host, httpsPort: port, localPort: port, target })
      )
    } catch {
      here = null
      return 'tailscale status could not be read'
    }
  }
  const args = ['serve', '--bg', `--https=${port}`, target]
  let started = false
  let timer = null
  return {
    host,
    ownerLogin,
    ownerUserId,
    noIdentity,
    // null: no identity proof (pairing only); else admit(req, res) and identityOf(req).
    gate,
    identityOff,
    url: `https://${host}${port === 443 ? '' : `:${port}`}/`,
    // What `--tailscale=print` shows: never the secret.
    command: `tailscale serve --bg --https=${port} http://127.0.0.1:${port}${secret ? '/_ts/<a secret made at each start>' : ''}`,
    // `server`: the listening board server, for the proof's self test.
    async start(server = null, { watchMs = 30_000 } = {}) {
      // A self test that failed stays failed: the peer check does not work on this machine, and nothing
      // the watch below can see changes that. Identity stays off until the board is started again.
      let failedSelfTest = null
      if (gate && server) {
        failedSelfTest = await proofSelfTest(server, proof)
        if (failedSelfTest) {
          gate.suspend(failedSelfTest)
          log('Tailscale identity is off (pairing still works): ' + failedSelfTest + '.')
        }
      }
      await call(args)
      started = true
      if (!gate) return
      // The entry must stay the only way to the port, and tailscaled one that
      // can be believed: checked now and every half minute; nobody is let in
      // by identity while it is not so.
      const watch = async () => {
        const problem = failedSelfTest || (await verify())
        if (problem && !gate.suspended()) log(`Tailscale identity is suspended (pairing still works): ${problem}.`)
        if (problem) gate.suspend(problem)
        else if (gate.suspended()) gate.resume()
      }
      if (!gate.suspended()) await watch()
      timer = watchMs ? setInterval(() => watch().catch(() => {}), watchMs) : null
      timer?.unref()
    },
    async stop() {
      if (timer) clearInterval(timer)
      if (!started) return
      started = false
      // Remove only our port, and only while it still points at our target.
      const current = JSON.parse((await call(['serve', 'status', '--json'])) || '{}')
      const handlers = current.Web?.[`${host}:${port}`]?.Handlers
      if (
        !configs(current).some(funnelOn) &&
        !Object.keys(current.Foreground || {}).length &&
        handlers &&
        Object.keys(handlers).length === 1 &&
        handlers['/']?.Proxy === target
      )
        await call(['serve', `--https=${port}`, 'off'])
    },
  }
}
