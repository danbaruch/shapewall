import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from './api'

// Fetches `url` (and every `pollMs`). `setData` patches the cached value.
// A poll that returns the same JSON keeps the previous object (and state),
// so memos and children keyed on `data` do not churn every interval.
export function useResource(url, { pollMs = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const latest = useRef(0)
  const lastJson = useRef(null)
  const refetch = useCallback(async () => {
    if (!url) return null
    const ticket = ++latest.current
    try {
      const data = await api.get(url)
      if (ticket === latest.current) {
        const json = JSON.stringify(data)
        const same = json === lastJson.current
        lastJson.current = json
        setState((current) => (same && !current.error && !current.loading ? current : { data, error: null, loading: false }))
      }
      return data
    } catch (error) {
      if (ticket === latest.current) setState((current) => ({ data: current.data, error, loading: false }))
      return null
    }
  }, [url])
  useEffect(() => {
    lastJson.current = null
    setState({ data: null, error: null, loading: true })
    refetch()
  }, [refetch])
  useEffect(() => {
    if (!pollMs || !url) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refetch()
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [pollMs, refetch, url])
  const setData = useCallback((update) => {
    latest.current += 1 // an in-flight poll must not overwrite this
    lastJson.current = null
    setState((current) => ({ ...current, data: typeof update === 'function' ? update(current.data) : update }))
  }, [])
  return { ...state, refetch, setData }
}

// True from the first time `open` is true: a lazy dialog mounts (and loads
// its chunk) on first open, then stays mounted so it can animate closed.
export function useOpened(open) {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  return opened || open
}

export function useMediaQuery(query) {
  const subscribe = useCallback(
    (notify) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

// ---- URL state ----------------------------------------------------------------
// Board, viewport mode, filter, selected comment and camera live in the query
// string, so a copied link reopens the same view. Changes replace the current
// history entry; only overlays (below) add entries.

const listeners = new Set()
const notify = () => listeners.forEach((listener) => listener())
// Closing an overlay goes Back one entry, which lands asynchronously. A param
// change made meanwhile would be written to the entry being left, so it waits
// until the Back has landed (see the popstate handler below).
let queuedParams = null
// The view's own idea of its query string. Overlay entries are not real
// navigation, so Back keeps it (a filter changed while a sheet was open stays).
let currentSearch = typeof window !== 'undefined' ? window.location.search : ''

function writeSearch(search) {
  currentSearch = search
  if (window.location.search !== search) window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}`)
  notify()
}

function applyParams(changes) {
  if (ignorePops > 0) {
    queuedParams = { ...(queuedParams || {}), ...changes }
    return
  }
  const next = new URLSearchParams(currentSearch)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') next.delete(key)
    else next.set(key, String(value))
  }
  const query = next.toString()
  writeSearch(query ? `?${query}` : '')
}

export function useParams() {
  const search = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => currentSearch,
    () => '',
  )
  const params = new URLSearchParams(search)
  const update = useCallback((changes) => applyParams(changes), [])
  return [params, update]
}

// ---- Back closes the topmost overlay ----------------------------------------
// Each open overlay (dialog, sheet, selected card) owns a history entry, so
// the Android Back button (or browser Back) closes the topmost one and only
// leaves the board when nothing is open.

const overlays = []
let ignorePops = 0
// An overlay opened while a Back is still landing (one closed and another
// opened in the same moment, say the menu closing as a journey opens) must
// push its entry after the Back lands: a browser picks the Back's target when
// it is asked, so an entry pushed meanwhile would be skipped over.
let pendingPushes = []

// Overlays that close in the same moment (a select inside a sheet, both
// closing on a pick) go back together in one step: two back() calls in a row
// are not reliably two traversals, and each would wait for its own popstate.
let backSteps = 0
function goBack() {
  if (backSteps === 0) {
    ignorePops += 1
    queueMicrotask(() => {
      const steps = backSteps
      backSteps = 0
      window.history.go(-steps)
    })
  }
  backSteps += 1
}

function pushEntry(entry) {
  entry.pushed = true
  window.history.pushState({ ...(window.history.state || {}), shapewallOverlay: overlays.length }, '', window.location.href)
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    writeSearch(currentSearch)
    if (ignorePops > 0) {
      ignorePops -= 1
      if (ignorePops === 0) {
        if (queuedParams) {
          const changes = queuedParams
          queuedParams = null
          applyParams(changes)
        }
        const pushes = pendingPushes
        pendingPushes = []
        for (const entry of pushes) if (overlays.includes(entry)) pushEntry(entry)
        const leaving = afterBack
        afterBack = []
        for (const go of leaving) go()
      }
      return
    }
    const top = overlays.pop()
    if (top) top.close()
  })
}

// Leaving the page from inside an overlay (a menu item that opens another
// page): the overlay's Back would cancel the navigation, so it waits for the
// Back to land.
let afterBack = []
export function leavePage(go) {
  const leave = typeof go === 'string' ? () => window.location.assign(go) : go
  setTimeout(() => {
    if (ignorePops > 0 || backSteps > 0) afterBack.push(leave)
    else leave()
  }, 30)
}

export function useOverlayEntry(open, onClose) {
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    if (!open) return undefined
    const entry = { close: () => closeRef.current(), pushed: false }
    overlays.push(entry)
    if (ignorePops > 0) pendingPushes.push(entry)
    else pushEntry(entry)
    return () => {
      const index = overlays.indexOf(entry)
      if (index < 0) return // Back already removed it
      overlays.splice(index, 1)
      if (!entry.pushed) {
        // Never pushed (a Back was still landing): nothing to go back over.
        pendingPushes = pendingPushes.filter((item) => item !== entry)
        return
      }
      goBack()
    }
  }, [open])
}
