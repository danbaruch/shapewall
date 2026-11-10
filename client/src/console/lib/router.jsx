// A small path router: pushState navigation, links that stay in the app,
// and the current path as React state. Board pages (/w/:ws/p/:pid/ and
// /s/:sid/) are a different app and load normally.
//
// Dialogs own a history entry (Back closes them; see useOverlayEntry), which
// lands back on the same URL: a popstate to the path we already show changes
// nothing here.
//
// The public demo is static files under a sub-path (shapewall.com/demo/),
// so there the route lives in the fragment: console.html#/w/<ws>/members.
// A fragment survives a reload on any static host. A route's own fragment
// (/w/<ws>/access#roles) follows a second '#'.

import { useCallback, useSyncExternalStore } from 'react'
import { DEMO } from '../../lib/demo'

const listeners = new Set()
const notify = () => listeners.forEach((listener) => listener())
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify)
  if (DEMO) window.addEventListener('hashchange', notify)
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The route in the fragment (demo): "/w/x/access#roles" -> path and hash.
function demoRoute() {
  const raw = window.location.hash.slice(1)
  const route = raw.startsWith('/') ? raw : '/'
  const hashAt = route.indexOf('#')
  const beforeHash = hashAt >= 0 ? route.slice(0, hashAt) : route
  return {
    path: beforeHash.split('?')[0] || '/',
    search: beforeHash.includes('?') ? beforeHash.slice(beforeHash.indexOf('?')) : '',
    hash: hashAt >= 0 ? route.slice(hashAt) : '',
  }
}

export const currentPath = () => (DEMO ? demoRoute().path : window.location.pathname)
// The route's own fragment ("#roles") and query string.
export const currentHash = () => (DEMO ? demoRoute().hash : window.location.hash)
export const currentSearch = () => (DEMO ? demoRoute().search : window.location.search)

export function usePath() {
  return useSyncExternalStore(subscribe, currentPath, () => '/')
}

const isAppPath = (pathname) => !/^\/(w\/[^/]+\/p|s)\//.test(pathname) && !pathname.startsWith('/_console/')
// Demo: routes are absolute paths ("/w/..."); anything else (index.html?...) is the board.
const isDemoRoute = (to) => typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') && isAppPath(to.split(/[?#]/)[0])

export function navigate(to, { replace = false } = {}) {
  if (DEMO) {
    if (!isDemoRoute(to)) {
      window.location.assign(new URL(to, window.location.href).href)
      return
    }
    const next = `#${to}`
    if (replace) window.history.replaceState(null, '', next)
    else if (next !== window.location.hash) window.history.pushState(null, '', next)
    window.scrollTo(0, 0)
    notify()
    return
  }
  const url = new URL(to, window.location.origin)
  if (url.origin !== window.location.origin || !isAppPath(url.pathname)) {
    window.location.assign(url.href)
    return
  }
  const next = url.pathname + url.search + url.hash
  if (replace) window.history.replaceState(null, '', next)
  else if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.pushState(null, '', next)
  window.scrollTo(0, 0)
  notify()
}

// A full page load of an app path, after something that changes the session
// (leaving or deleting a workspace, signing out). The demo has no sign-in
// page: it goes to its home instead.
export function leaveTo(path) {
  if (!DEMO) {
    window.location.assign(path)
    return
  }
  window.location.hash = `#${path === '/signin' ? '/' : path}`
  window.location.reload()
}

// Navigation from inside a menu or dialog: closing it goes Back one history
// entry, asynchronously, and a push made before that lands would be undone.
// So this waits for that Back (or a short timeout when there is none).
export function navigateSoon(to) {
  let done = false
  const go = () => {
    if (done) return
    done = true
    window.removeEventListener('popstate', go)
    window.setTimeout(() => navigate(to), 0)
  }
  window.addEventListener('popstate', go)
  window.setTimeout(go, 400)
}

// <Link to="/w/..."> renders an <a> that navigates in the app (new tabs and
// modified clicks behave as links do).
export function Link({ to, onClick, children, ...props }) {
  const handle = useCallback(
    (event) => {
      onClick?.(event)
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (DEMO ? !isDemoRoute(to) : !isAppPath(new URL(to, window.location.origin).pathname)) return
      event.preventDefault()
      navigate(to)
    },
    [onClick, to],
  )
  return (
    <a href={DEMO && isDemoRoute(to) ? `#${to}` : to} onClick={handle} {...props}>
      {children}
    </a>
  )
}

// A URL with one more query parameter.
export const withParam = (url, key, value) => `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`

// A "next" path from a query string, only if it is a path on this site.
export function safeNext(value) {
  return typeof value === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(value) ? value : '/'
}
