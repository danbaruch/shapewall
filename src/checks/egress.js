// Chromium does its own DNS and follows redirects below Playwright's route
// handlers. For public checks, every HTTP request or HTTPS tunnel must pass
// an address check on the socket the proxy actually opens.
import dns from 'node:dns/promises'
import { once } from 'node:events'
import { isIP } from 'node:net'
import { createForwardProxy, privateAddress } from '../agent/starter/egress-proxy.js'
import { internalHostname } from '../capture/live.js'

const cleanHost = (host) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
const denied = { reason: 'not a permitted address' }

async function addresses(host, lookup) {
  if (isIP(host)) return [host]
  let timer
  try {
    const found = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Page check DNS lookup timed out')), 4000)
        timer.unref()
      }),
    ])
    const result = found.map(({ address }) => address)
    if (!result.length || result.some((address) => !isIP(address))) throw new Error('No address for page check host')
    return result
  } finally {
    clearTimeout(timer)
  }
}

// Local/private board URLs keep their usual browser behavior. A custom DNS
// name can also identify a development origin: grant exactly the addresses,
// protocol and port the configured origin used at the beginning of the run.
export async function checkResolver(baseUrl, lookup = dns.lookup) {
  const base = new URL(baseUrl)
  const originHost = cleanHost(base.hostname)
  if (internalHostname(originHost)) return null
  const originPort = Number(base.port || (base.protocol === 'https:' ? 443 : 80))
  const initial = await addresses(originHost, lookup)
  const devOrigin = initial.every((address) => internalHostname(address))
  if (!devOrigin && initial.some(privateAddress)) throw new Error('Page check origin has a non-public address')
  return async (hostname, port, protocol) => {
    const host = cleanHost(hostname)
    const sameOrigin = host === originHost && port === originPort && protocol === base.protocol
    if (sameOrigin) return { address: initial[0] }
    if (internalHostname(host) || !host) return denied
    try {
      const found = await addresses(host, lookup)
      return found.some(privateAddress) ? denied : { address: found[0] }
    } catch {
      return denied
    }
  }
}

export async function checkBrowser(browser, baseUrl, lookup) {
  if (!browser) throw new Error('Page check browser unavailable')
  const resolve = await checkResolver(baseUrl, lookup)
  if (!resolve) return { browser }
  const server = createForwardProxy({ resolve, verifyServerName: false, log: () => {} })
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const proxy = { server: `http://127.0.0.1:${server.address().port}`, bypass: '<-loopback>' }
  return {
    browser: {
      version: () => browser.version(),
      newContext: (options) => browser.newContext({ ...options, proxy }),
    },
    close: () =>
      new Promise((done) => {
        server.close(done)
        for (const socket of sockets) socket.destroy()
      }),
  }
}
