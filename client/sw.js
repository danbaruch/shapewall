// The board's service worker (built into dist/client/sw.js by vite.config.js,
// which fills in BUILD and SHELL). It caches the app shell only: the page,
// its hashed scripts and styles, the icons and the manifest, so the board
// opens fast and installs as an app. API responses, board data (data/ in a
// static export) and live HTML always come from the network, never from
// here, so nothing captured can go stale in a cache.
/* global __SHAPEWALL_SHELL__ */

const BUILD = '__SHAPEWALL_BUILD__'
const SHELL = __SHAPEWALL_SHELL__
const scope = () => new URL(self.registration.scope)
// Named after the scope: a board under a sub-path (shapewall.com/demo/) must
// not drop the caches of another service worker on the same origin.
const PREFIX = `shapewall-board-shell:${scope().pathname}:`
const CACHE = `${PREFIX}${BUILD}`
const absolute = (path) => new URL(path, scope()).href

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(absolute(path), { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  const base = scope()
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return
  const path = url.pathname.slice(base.pathname.length)
  // The API, live HTML and a static export's board data: network only.
  if (path.startsWith('api/') || path.startsWith('data/')) return
  if (request.mode === 'navigate') {
    if (request.destination && request.destination !== 'document') return
    // Network first, so a new build shows at once; the cached shell offline.
    event.respondWith(fetch(request).catch(() => caches.match(absolute('./')).then((hit) => hit || Response.error())))
    return
  }
  if (SHELL.includes(path)) {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)))
  }
})
