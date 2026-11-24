import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from './api'
import { sameBoard } from './boardParams.js'
import { applyUpdate, failed, landed, startState, viewFor } from './resourceState.js'
import { busyStep } from './busy.js'

// Fetches `url` (and every `pollMs`). `setData` patches the cached value.
// A poll that returns the same JSON keeps the previous object (and state),
// so memos and children keyed on `data` do not churn every interval.
// A `setData` made before the first answer arrived waits for it and goes on
// top (an optimistic write must neither be lost nor throw the load away),
// and the render after `url` changes has no data (not the old url's).
export function useResource(url, { pollMs = 0 } = {}) {
  const [state, setState] = useState(() => startState(url))
  const latest = useRef(0)
  const lastJson = useRef(null)
  // setData updates made while the first load is out (null: none waiting).
  const queued = useRef(null)
  const firstLoad = useRef(true)
  const refetch = useCallback(async () => {
    if (!url) return null
    const ticket = ++latest.current
    try {
      const data = await api.get(url)
      if (ticket === latest.current) {
        const updates = queued.current
        queued.current = null
        firstLoad.current = false
        const json = updates ? null : JSON.stringify(data)
        const same = json !== null && json === lastJson.current
        lastJson.current = json
        setState((current) => landed(current, { url, data, queued: updates, same }))
      }
      return data
    } catch (error) {
      if (ticket === latest.current) {
        const updates = queued.current
        queued.current = null
        firstLoad.current = false
        setState((current) => failed(current, { url, error, queued: updates }))
      }
      return null
    }
  }, [url])
  useEffect(() => {
    lastJson.current = null
    queued.current = null
    firstLoad.current = true
    setState(startState(url))
    refetch()
    return () => {
      latest.current += 1
    }
  }, [refetch, url])
  useEffect(() => {
    if (!pollMs || !url) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refetch()
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [pollMs, refetch, url])
  const setData = useCallback(
    (update) => {
      if (url && firstLoad.current) {
        // Nothing loaded yet: it goes on top of the first answer.
        queued.current = [...(queued.current || []), update]
        return
      }
      latest.current += 1 // an in-flight poll must not overwrite this
      lastJson.current = null
      setState((current) => ({ ...current, data: applyUpdate(current.data, update) }))
    },
    [url],
  )
  return { ...viewFor(state, url), refetch, setData }
}

// A busy flag shared by several operations (lib/busy.js): `setBusy(true)`
// when one starts and `setBusy(false)` when it ends; busy while any runs.
export function useBusyCount() {
  const [count, setCount] = useState(0)
  const setBusy = useCallback((on) => setCount((current) => busyStep(current, on)), [])
  return [count > 0, setBusy]
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

// useParams for one board's view. Its writes land only while that board is
// the one open: an action that finishes after the visitor picked another
// board (a comment saved, a journey stored, a chat opened) must not write its
// ids into the new board's address (they name something else there). The
// board remounts on a switch (App.jsx keys it), so "open" is: still mounted,
// and the address still names the board it mounted with.
export function useBoardParams() {
  const [params, update] = useParams()
  // The board the address named when this view mounted (null: the first board).
  const [mountedBoard] = useState(() => new URLSearchParams(currentSearch).get('board'))
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const scoped = useCallback(
    (changes) => {
      if (!alive.current) return
      if (!sameBoard(mountedBoard, addressBoard())) return
      update(changes)
    },
    [mountedBoard, update],
  )
  return [params, scoped]
}

// The board the address names, counting a queued change (a board picked
// while an overlay's Back was still landing is queued, not yet written).
function addressBoard() {
  if (queuedParams && 'board' in queuedParams) return queuedParams.board || null
  return new URLSearchParams(currentSearch).get('board')
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
      watchBack()
    })
  }
  backSteps += 1
}

// A Back that never lands (the entry was already gone, a webview that drops
// history.go, a throttled history) would hold every later param change and
// page leave forever: after a while it counts as landed. Its popstate, if it
// still comes, is then taken as that Back's, not as the visitor's Back.
const BACK_LANDS_MS = 1000
const STRAY_POP_MS = 5000
let backWatch = null
let strayPops = 0
let strayUntil = 0
function watchBack() {
  window.clearTimeout(backWatch)
  backWatch = window.setTimeout(() => {
    backWatch = null
    if (ignorePops === 0) return
    strayPops += ignorePops
    strayUntil = Date.now() + STRAY_POP_MS
    ignorePops = 0
    backLanded()
  }, BACK_LANDS_MS)
}

// Every Back has landed: what waited for it goes now.
function backLanded() {
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

function pushEntry(entry) {
  entry.pushed = true
  window.history.pushState({ ...(window.history.state || {}), shapewallOverlay: overlays.length }, '', window.location.href)
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    // A Back given up on (watchBack) landing late: it was ours.
    if (ignorePops === 0 && strayPops > 0) {
      if (Date.now() < strayUntil) {
        strayPops -= 1
        if (listeners.size) writeSearch(currentSearch)
        return
      }
      strayPops = 0
    }
    // Only this hook's own overlay traversal keeps edits to board parameters.
    // Ordinary history and the hosted console router own their landed URL.
    if (listeners.size && (ignorePops > 0 || overlays.length)) writeSearch(currentSearch)
    else {
      currentSearch = window.location.search
      notify()
    }
    if (ignorePops > 0) {
      ignorePops -= 1
      if (ignorePops === 0) {
        window.clearTimeout(backWatch)
        backWatch = null
        backLanded()
      } else watchBack()
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
