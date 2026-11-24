// Probe one link without downloading its body. Check each redirect and bind
// the address check to the lookup that actually opens the connection.
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { privateAddress } from '../agent/starter/egress-proxy.js'
import { internalHostname } from './live.js'
import { isIP } from 'node:net'
import { Cookie, CookieJar } from 'tough-cookie'

const nonPublicAddress = (address) => privateAddress(address) || internalHostname(address)

function publicLookup(host, options, callback) {
  dns.lookup(host, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error)
    if (!addresses.length || addresses.some(({ address }) => nonPublicAddress(address))) {
      return callback(new Error('Private link target blocked'))
    }
    if (options.all) return callback(null, addresses)
    return callback(null, addresses[0].address, addresses[0].family)
  })
}

export async function linkRequester(context, baseUrl) {
  const base = new URL(baseUrl)
  // Resolve the configured origin once. A private development origin may
  // use those addresses only; every other origin must resolve publicly.
  const host = base.hostname.replace(/^\[|\]$/g, '')
  const originAddresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.promises.lookup(host, { all: true })
  if (
    originAddresses.some(({ address }) => nonPublicAddress(address)) &&
    !originAddresses.every(({ address }) => internalHostname(address))
  )
    throw new Error('Link check origin has a non-public address')
  const originLookup = (_host, options, callback) => {
    const addresses = originAddresses.filter(({ family }) => !options.family || family === options.family)
    if (!addresses.length) return callback(new Error('No matching address for the configured origin'))
    if (options.all) return callback(null, addresses)
    return callback(null, addresses[0].address, addresses[0].family)
  }
  const jar = new CookieJar()
  for (const cookie of await context.cookies()) {
    if (cookie.partitionKey) continue
    await jar.store.putCookie(
      new Cookie({
        key: cookie.name,
        value: cookie.value,
        domain: cookie.domain.replace(/^\./, ''),
        hostOnly: !cookie.domain.startsWith('.'),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expires: cookie.expires > 0 ? new Date(cookie.expires * 1000) : 'Infinity',
      }),
    )
  }
  return async (href) => {
    let url = new URL(href)
    const signal = AbortSignal.timeout(15000)
    for (let hop = 0; hop <= 10; hop++) {
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported link target')
      const sameOrigin = url.origin === base.origin
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (!sameOrigin && (internalHostname(host) || (isIP(host) && privateAddress(host)))) throw new Error('Private link target blocked')
      const headers = {}
      if (sameOrigin) {
        const cookies = await jar.getCookieString(url.href)
        if (cookies) headers.cookie = cookies
      }
      const transport = url.protocol === 'https:' ? https : http
      const { status, location, cookies } = await new Promise((resolve, reject) => {
        const req = transport.get(url, { agent: false, signal, lookup: sameOrigin ? originLookup : publicLookup, headers }, (res) => {
          resolve({ status: res.statusCode, location: res.headers.location, cookies: res.headers['set-cookie'] || [] })
          res.destroy()
        })
        req.on('error', reject)
      })
      if (sameOrigin) {
        for (const cookie of cookies) await jar.setCookie(cookie, url.href, { ignoreError: true })
      }
      if (![301, 302, 303, 307, 308].includes(status) || !location) return { status }
      url = new URL(location, url)
    }
    throw new Error('Too many redirects')
  }
}
