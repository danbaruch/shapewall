// Plain http under --remote is allowed to the solo engine's own host name
// only (<project>-<random>.shapewall.localhost, SOLO_HOST_RE), and a
// connection to such a name always goes to this machine (127.0.0.1),
// whatever the system resolver, /etc/hosts or the network's DNS says: the
// token is sent in the clear, so it must never leave the machine.
//
// Node's fetch resolves names with the system resolver, which does not treat
// *.localhost specially everywhere. pinSoloLoopback() puts a connection pool
// in front of every fetch in this process whose lookup answers 127.0.0.1 for
// those names and asks the system for every other name. remoteOrigin()
// (src/remote/remote.js) refuses an http solo origin until it is in place,
// so a token never goes to one unpinned.
import dns from 'node:dns'
import { SOLO_HOST_RE } from '../net.js'

const DISPATCHER = Symbol.for('undici.globalDispatcher.1')
let pinned = false

export const soloHost = (name) => SOLO_HOST_RE.test(String(name || '').toLowerCase())

// The lookup the pool connects with (exported for the tests).
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

// Installs the pinned pool once. Returns whether it is in place.
export async function pinSoloLoopback() {
  if (pinned) return true
  // Node makes its fetch's pool on first use; a data: URL makes it without a network request.
  if (!globalThis[DISPATCHER]) await fetch('data:,').catch(() => {})
  const Pool = globalThis[DISPATCHER]?.constructor
  if (typeof Pool !== 'function') return false
  try {
    globalThis[DISPATCHER] = new Pool({ connect: { lookup: pinnedLookup } })
  } catch {
    return false
  }
  pinned = true
  return true
}

export const soloLoopbackPinned = () => pinned

// Whether a --remote value (or $SHAPEWALL_REMOTE) names the solo engine over http.
export function soloHttpRemote(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' && soloHost(url.hostname)
  } catch {
    return false
  }
}
