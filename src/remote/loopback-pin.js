// Plain http under --remote is allowed to this machine only: a loopback
// address or name, or the solo engine's own host name
// (<project>-<random>.shapewall.localhost, SOLO_HOST_RE). The token is sent
// in the clear, so a connection to such a name must go straight to this
// machine: never to whatever the system resolver, /etc/hosts or the
// network's DNS says, and never through a proxy (HTTP_PROXY with
// NODE_USE_ENV_PROXY or --use-env-proxy would otherwise tunnel it to the
// proxy).
//
// pinSoloLoopback() puts a router in front of every fetch in this process.
// Requests to a solo or loopback name go to a plain connection pool (undici's
// Agent, which never reads proxy settings) whose lookup answers 127.0.0.1 for
// solo names; every other request goes to the pool Node made, unchanged.
// remoteOrigin() (src/remote/remote.js) refuses an http solo origin until the
// router is in place, so a token never goes to one unpinned.
import dns from 'node:dns'
import { isLoopback, SOLO_HOST_RE } from '../net.js'

const DISPATCHER = Symbol.for('undici.globalDispatcher.1')
let pinned = false

export const soloHost = (name) => SOLO_HOST_RE.test(String(name || '').toLowerCase())
// The names the plain pool takes: the solo names and this machine's loopback names.
export const directHost = (name) => soloHost(name) || isLoopback(name)

// The lookup the plain pool connects with (exported for the tests).
export function pinnedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  if (!soloHost(hostname)) return dns.lookup(hostname, options, callback)
  const address = { address: '127.0.0.1', family: 4 }
  if (options?.all) return process.nextTick(callback, null, [address])
  return process.nextTick(callback, null, address.address, address.family)
}

// undici's plain Agent class: the pool Node made when it is one, else the
// no-proxy pool inside the env proxy agent. null when neither is there (an
// unknown pool: the caller refuses).
export function plainAgentClass(pool) {
  if (!pool || typeof pool !== 'object') return null
  if (pool.constructor?.name === 'Agent') return pool.constructor
  for (const key of Object.getOwnPropertySymbols(pool)) {
    const value = pool[key]
    if (value && typeof value === 'object' && value.constructor?.name === 'Agent') return value.constructor
  }
  return null
}

const originHost = (origin) => {
  try {
    return new URL(String(origin)).hostname
  } catch {
    return ''
  }
}

// Installs the router once. Returns whether it is in place.
export async function pinSoloLoopback() {
  if (pinned) return true
  // Node makes its fetch's pool on first use; a data: URL makes it without a network request.
  if (!globalThis[DISPATCHER]) await fetch('data:,').catch(() => {})
  const original = globalThis[DISPATCHER]
  const Plain = plainAgentClass(original)
  if (typeof Plain !== 'function') return false
  let direct
  try {
    direct = new Plain({ connect: { lookup: pinnedLookup } })
  } catch {
    return false
  }
  const dispatch = (options, handler) => (directHost(originHost(options?.origin)) ? direct : original).dispatch(options, handler)
  globalThis[DISPATCHER] = new Proxy(original, {
    get(target, key) {
      if (key === 'dispatch') return dispatch
      if (key === 'close' || key === 'destroy') return (...args) => Promise.all([direct[key](...args), target[key](...args)])
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  pinned = true
  return true
}

export const soloLoopbackPinned = () => pinned

// Whether a --remote value (or $SHAPEWALL_REMOTE) names this machine over http
// (the solo engine's name or a loopback name): the CLI pins before running.
export function soloHttpRemote(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' && directHost(url.hostname)
  } catch {
    return false
  }
}
