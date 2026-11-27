// What the solo engine's capture browser may reach (G3): the board's app
// origin, and nothing else. The same boundary as the agent browser since
// 1.4.0 (src/agent/browser-egress.js), for a capture the engine runs in its
// own process because someone pressed "Capture now" or an agent called
// recapture_pages over HTTP:
//
// - Chromium sends every request through a loopback proxy (loopback
//   included: --proxy-bypass-list=<-loopback>), resolves no name itself
//   (--host-resolver-rules), and keeps WebRTC to proxied UDP. The proxy
//   opens a connection only to the app origin's host and port, at the
//   address looked up once when the capture starts (pinned: DNS rebinding
//   after that changes nothing), redirects, WebSockets and preconnects
//   included.
// - The app origin itself is refused when it is the engine: its own origin
//   or its usercontent origin (any *.shapewall.localhost name), or any
//   loopback address on the engine's port (127.0.0.1:<port> reaches the
//   engine whatever the name). Browser and Node debugging ports are refused
//   too (DENIED_LOOPBACK_PORTS).
// - Never this machine's LAN or tailnet addresses: an app origin that is (or
//   resolves to) one of this machine's own non-loopback addresses is
//   refused; the dev server is captured on localhost instead. A public name
//   that resolves to a private, loopback or link-local address is refused
//   (pinHost), as for the agent browser.
//
// Other origins the app loads from (a font host, a CDN) are refused too, so
// a capture from the engine shows the app without them. The capture's own
// link check runs in Node (src/capture/link-request.js) and asks only the
// app origin (external links are not checked here).
import os from 'node:os'
import { DENIED_LOOPBACK_PORTS } from '../../agent/agent-browser.js'
import { addressKind, hostPort, isOwnAddress, ownAddresses, pinHost, startEgressProxy } from '../../agent/browser-egress.js'
import { HttpError } from '../http.js'

// After the launch's own arguments, so no earlier flag can widen them.
export const CAPTURE_EGRESS_ARGS = Object.freeze([
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-background-networking',
  '--proxy-bypass-list=<-loopback>',
])

const ENGINE_NAME_RE = /(^|\.)shapewall\.localhost$/

const refuse = (why) => new HttpError(400, 'capture_origin_refused', `The engine does not capture ${why}.`)

// The app origin of a board's baseUrl, checked and pinned. -> { origin,
// host, port, protocol, address }, or throws HttpError 400
// capture_origin_refused. `engine`: { origins: [its origin, its usercontent
// origin], port }. `lookup` and `interfaces` are for tests.
export async function pinAppOrigin(baseUrl, { engine, lookup = undefined, interfaces = os.networkInterfaces() } = {}) {
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw refuse('this board: its baseUrl is not a URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw refuse(`${url.protocol} pages, only http and https`)
  const { host, port, protocol } = hostPort(url.origin)
  const shown = url.origin
  if (ENGINE_NAME_RE.test(host)) throw refuse(`its own origin or another Shapewall engine (${shown})`)
  for (const value of engine?.origins || []) {
    if (!value) continue
    if (new URL(value).origin === url.origin) throw refuse(`its own origin (${shown})`)
  }
  const own = ownAddresses(interfaces)
  const pin = await pinHost(host, { ...(lookup ? { lookup } : {}), own, allowOwn: false })
  if (pin.refused) throw refuse(`${shown}: ${pin.refused}`)
  const address = pin.address
  const loopback = addressKind(address) === 'loopback'
  if (loopback && Number.isInteger(engine?.port) && port === engine.port)
    throw refuse(`${shown}: port ${port} on this machine is the engine itself`)
  if (loopback && DENIED_LOOPBACK_PORTS.includes(port)) throw refuse(`${shown}: port ${port} on this machine is a debugging port`)
  if (!loopback && isOwnAddress(address, own))
    throw refuse(`${shown}: ${address} is one of this machine's own network addresses (LAN or tailnet); use http://localhost:${port}`)
  return { origin: url.origin, host, port, protocol, address }
}

// The proxy for one capture and a Playwright `chromium` stand-in whose
// launch() goes through it (runCapture's `chromium` option). -> { chromium,
// blocked, close() }. `real`: the Playwright chromium (tests pass a stub).
export async function captureEgress(app, { real, onBlock = () => {} } = {}) {
  const blocked = []
  const target = (host, port, tunnel) => {
    if (host !== app.host || port !== app.port) return null
    // A plain request is for an http origin; a tunnel is TLS for https, or a WebSocket to either.
    if (!tunnel && app.protocol !== 'http:') return null
    return app.address
  }
  const proxy = await startEgressProxy({
    target,
    onBlock: (entry) => {
      if (blocked.length < 200) blocked.push(entry.url)
      onBlock(entry)
    },
  })
  const browsers = new Set()
  const engine = real || (await import('playwright')).chromium
  const chromium = {
    executablePath: () => engine.executablePath(),
    async launch(options = {}) {
      const browser = await engine.launch({
        ...options,
        proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>' },
        args: [...(options.args || []), ...CAPTURE_EGRESS_ARGS],
      })
      browsers.add(browser)
      browser.on?.('disconnected', () => browsers.delete(browser))
      return browser
    },
  }
  return {
    chromium,
    blocked,
    proxyPort: proxy.port,
    // Closes the browsers first (a capture still running ends: its shots fail), then the proxy.
    async close() {
      for (const browser of [...browsers]) await browser.close().catch(() => {})
      await proxy.close()
    },
  }
}
