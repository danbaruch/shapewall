// Plain helpers for in-page links (no React, so test/links.test.js runs them in Node).

import { routeFor } from './routes.js'

// The path to hand to the router for a link inside the docs markdown, or null to let the browser load it
// itself: only pages this site's router owns. Anything else under the same origin (the live demo at /demo/,
// downloads, images) is a separate document, and the router would show its 404 for it.
export function routerHref(href) {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return null
  const pathname = href.split(/[?#]/)[0]
  // Files (the PDF download) load as themselves, not as a route.
  if (/\.[a-z0-9]+$/i.test(pathname)) return null
  return routeFor(pathname) ? href : null
}

// The element id a location hash ("#getting-started") points at, or null. A malformed escape (a copied or
// cut link: "#%E0%A4%A") is not an id on the page, and must not throw while the page mounts.
export function hashId(hash) {
  if (typeof hash !== 'string' || hash.length < 2) return null
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return null
  }
}
