// No shell, sudo, reset, Funnel enablement, or existing-listener replacement.
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { absoluteProgram } from '../which.js'
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
  if (!noIdentity) {
    const who = JSON.parse(await call(['whois', '--json', status.TailscaleIPs[0]]))
    // Tagged/shared nodes without a user never grant identity access.
    ownerLogin = who.Node?.Tags?.length ? null : who.UserProfile?.LoginName || null
  }
  const args = ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]
  let started = false
  return {
    host,
    ownerLogin,
    noIdentity,
    url: `https://${host}${port === 443 ? '' : `:${port}`}/`,
    command: `tailscale ${args.join(' ')}`,
    async start() {
      await call(args)
      started = true
    },
    async stop() {
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
        handlers['/']?.Proxy === `http://127.0.0.1:${port}`
      )
        await call(['serve', `--https=${port}`, 'off'])
    },
  }
}
