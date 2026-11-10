// What a capture browser may fetch, and what it starts with.
//
// - The private-host guard: a public page must not make the capture browser
//   fetch from this machine or its network (a router page, a local dev
//   server, cloud metadata). With a public root URL, requests to loopback,
//   private and internal hosts are refused. A local or private root (the usual
//   dev site) keeps them. A host counts as internal by its name or address,
//   and also when its name resolves to an internal address (a public name
//   pointed at 127.0.0.1 or cloud metadata). Lookups are cached for the run.
//   Redirect hops are not routed by the browser, so the capture also asks
//   `isInternal(url)` before it inlines a response (src/capture/live.js).
// - The block list (config `block`): analytics and other requests a capture
//   should not make. Blocked requests are aborted and remembered, so the
//   network summary does not count them as failures.
// - localStorage seeds (config `localStorage`), set before the page's own
//   scripts run, on the page's origin only.

import dns from 'node:dns'
import { isIP } from 'node:net'
import { internalHostname } from './live.js'

const LOOKUP_TTL_MS = 5 * 60 * 1000
const LOOKUP_TIMEOUT_MS = 4000
const LOOKUP_CACHE_MAX = 2000
const LOOKUP_TIMED_OUT = Symbol('lookup timed out')
// One cache per process: a capture run is one process, and each shot's
// context asks about the same few hosts.
const sharedCache = new Map()

// hostChecker() -> async (hostname) => is it internal? By name and literal
// address first (no lookup); else every address the name resolves to: one
// internal address is enough. A name that does not resolve is not internal
// (the browser cannot reach it either). A lookup that does not answer in time
// is treated as internal, and asked again next time: a slow answer must never
// be the way past the guard.
export function hostChecker({ lookup = dns.promises.lookup, cache = sharedCache, now = Date.now, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  return (hostname) => {
    let host = String(hostname || '')
      .toLowerCase()
      .replace(/\.+$/, '')
    if (!host) return Promise.resolve(false)
    if (internalHostname(host)) return Promise.resolve(true)
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    if (isIP(host)) return Promise.resolve(false)
    const hit = cache.get(host)
    if (hit && hit.until > now()) return hit.answer
    let timer = null
    const answer = Promise.race([
      Promise.resolve()
        .then(() => lookup(host, { all: true }))
        .then((found) =>
          (Array.isArray(found) ? found : [found]).some(
            (item) => item?.address && internalHostname(String(item.address).replace(/%.*$/, '')),
          ),
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), timeoutMs)
        timer.unref?.()
      }),
    ])
      .then((found) => {
        if (found !== LOOKUP_TIMED_OUT) return found
        if (cache.get(host)?.answer === answer) cache.delete(host)
        return true
      })
      .catch(() => false)
      .finally(() => clearTimeout(timer))
    if (cache.size >= LOOKUP_CACHE_MAX) cache.clear()
    cache.set(host, { answer, until: now() + LOOKUP_TTL_MS })
    return answer
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

const escapeRegExp = (value) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

// A pattern list -> url => blocked? Bare host names ("plausible.io") match
// the host and its subdomains; a pattern with "*" or "/" matches the whole
// URL, "*" standing for any run of characters.
export function blockMatcher(patterns = []) {
  const hosts = []
  const globs = []
  for (const pattern of patterns) {
    if (/[*/]/.test(pattern)) globs.push(new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i'))
    else hosts.push(pattern.toLowerCase().replace(/^\.+/, ''))
  }
  if (!hosts.length && !globs.length) return null
  return (url) => {
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      return false
    }
    if (hosts.some((item) => host === item || host.endsWith(`.${item}`))) return true
    return globs.some((glob) => glob.test(url))
  }
}

// Installs the guard and the block list on a context. Returns
// { guarded, isBlocked(request), isInternal(url) }; nothing is routed when
// neither applies. `guard: false` installs the block list alone (page
// checks). `isInternal(url)` is the guard's answer for a URL (always false
// without the guard): the capture asks it for responses the route never saw.
// `lookup` and `cache` are for tests (hostChecker).
export async function installRequestRules(context, rootUrl, { block = [], guard = true, lookup, cache } = {}) {
  const internal = hostChecker({ ...(lookup ? { lookup } : {}), ...(cache ? { cache } : {}) })
  let guarded = false
  if (guard) {
    const rootHost = hostOf(rootUrl)
    // No host (not a URL): nothing to compare with, as before.
    guarded = rootHost ? !(await internal(rootHost)) : false
  }
  const blocks = blockMatcher(block)
  const blocked = new WeakSet()
  if (guarded || blocks) {
    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = request.url()
      const host = hostOf(url)
      let refuse = Boolean(guarded && host && (await internal(host)))
      if (!refuse && blocks && host && blocks(url)) {
        blocked.add(request)
        refuse = true
      }
      // A context closed meanwhile (timeout) makes either call fail: nothing to do then.
      return (refuse ? route.abort('blockedbyclient') : route.continue()).catch(() => {})
    })
  }
  return {
    guarded,
    isBlocked: (request) => blocked.has(request),
    isInternal: async (url) => {
      const host = guarded ? hostOf(url) : null
      return Boolean(host && (await internal(host)))
    },
  }
}

// The init script that seeds localStorage on `origin` before any page script.
export function localStorageScript(origin, entries) {
  return `(() => {
  try {
    if (location.origin !== ${JSON.stringify(origin)}) return;
    const entries = ${JSON.stringify(Object.entries(entries))};
    for (const [key, value] of entries) localStorage.setItem(key, value);
  } catch {}
})();`
}

export async function seedLocalStorage(context, url, entries) {
  if (!entries || !Object.keys(entries).length) return
  let origin
  try {
    origin = new URL(url).origin
  } catch {
    return
  }
  await context.addInitScript(localStorageScript(origin, entries))
}
