// The Usage dashboard's layout as the page holds it: what the server has
// (a person's own layout, else the workspace's default, else the built-in
// one), every change made on top of it, and the saving of those changes.
//
// A change shows at once and is saved a moment later (one request for a run
// of quick changes: a drag, a few arrow keys). Each change can be undone.
// A save that fails keeps the change on the page and says so; "Try again"
// sends it once more. A layout that came with a shared view is only shown:
// nothing is saved until its reader chooses "Use this layout".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { defaultLayout, readLayout, sameLayout } from '../../../../src/hosted/usage-layout.js'
import { api, wsUrl } from '../lib/api'

// How long after the last change a save goes out.
const SAVE_AFTER_MS = 350

export function useDashboardLayout(workspaceId, { viewId = null } = {}) {
  const client = useQueryClient()
  const url = wsUrl(workspaceId, '/usage/layout')
  const stored = useQuery({ queryKey: [url], queryFn: () => api.get(url), staleTime: Infinity })
  const viewUrl = viewId ? wsUrl(workspaceId, `/views/${encodeURIComponent(viewId)}/layout`) : null
  const shared = useQuery({
    queryKey: [viewUrl],
    queryFn: () => api.get(viewUrl),
    enabled: Boolean(viewUrl),
    staleTime: Infinity,
    retry: false,
  })

  // `own`: undefined until the server answered, then the person's own layout or null.
  const [own, setOwn] = useState(undefined)
  const [status, setStatus] = useState('idle') // idle | saving | saved | failed
  const [failure, setFailure] = useState(null)
  // What came before each change, newest last (a ref: undo reads it when pressed); `undoable` redraws the button.
  const history = useRef([])
  const [undoable, setUndoable] = useState(0)
  const keep = (before) => {
    history.current = [...history.current.slice(-19), before ?? null]
    setUndoable(history.current.length)
  }
  // What a shared view's layout looks like after this reader's own switches (never saved).
  const [tried, setTried] = useState(null)
  const fallback = useMemo(() => readLayout(stored.data?.default) || defaultLayout(), [stored.data])
  useEffect(() => {
    if (!stored.data || own !== undefined) return
    const mine = readLayout(stored.data.layout)
    latest.current.saved = mine
    setOwn(mine)
  }, [stored.data, own])
  useEffect(() => setTried(null), [viewId])

  const latest = useRef({ own, saved: undefined, timer: null, busy: false, again: false, lastKey: null, lastAt: 0 })
  latest.current.own = own
  const remember = useCallback((next) => client.setQueryData([url], (data) => (data ? { ...data, layout: next } : data)), [client, url])

  const send = useCallback(async () => {
    const box = latest.current
    if (box.busy) {
      box.again = true
      return
    }
    box.busy = true
    const next = box.own
    setStatus('saving')
    try {
      if (next === null) await api.delete(url)
      else await api.put(url, { layout: next })
      box.saved = next
      remember(next)
      setFailure(null)
      setStatus('saved')
    } catch (error) {
      setFailure(error)
      setStatus('failed')
    } finally {
      box.busy = false
      if (box.again) {
        box.again = false
        send()
      }
    }
  }, [url, remember])
  const schedule = useCallback(() => {
    const box = latest.current
    window.clearTimeout(box.timer)
    box.timer = window.setTimeout(send, SAVE_AFTER_MS)
  }, [send])
  // A change still waiting when the page is left goes out at once.
  useEffect(() => {
    const box = latest.current
    return () => {
      window.clearTimeout(box.timer)
      if (box.own !== undefined && box.saved !== undefined && !sameLayout(box.own, box.saved)) send()
    }
  }, [send])

  // `mine`: the reader's own view (it is shown quietly), or one somebody shared.
  const preview = useMemo(
    () => (shared.data?.view ? { id: shared.data.view.id, name: shared.data.view.name, mine: Boolean(shared.data.view.mine) } : null),
    [shared.data],
  )
  const sharedLayout = useMemo(() => (shared.data?.view ? readLayout(shared.data.view.layout) : null), [shared.data])
  const base = own ?? fallback
  const layout = preview && sharedLayout ? (tried ?? sharedLayout) : base

  // change(next | (current) => next, { key }): `key` names a run of changes
  // that undo as one (every step of one widget's move).
  const change = useCallback(
    (given, { key = null } = {}) => {
      if (preview && sharedLayout) {
        setTried((current) => (typeof given === 'function' ? given(current ?? sharedLayout) : given))
        return
      }
      const box = latest.current
      const before = box.own
      const current = before ?? fallback
      const next = typeof given === 'function' ? given(current) : given
      if (next === null ? before === null || before === undefined : sameLayout(next, current)) return
      const at = Date.now()
      const run = key !== null && key === box.lastKey && at - box.lastAt < 1500
      box.lastKey = key
      box.lastAt = at
      if (!run) keep(before)
      box.own = next
      setOwn(next)
      setStatus('saving')
      schedule()
    },
    [fallback, preview, sharedLayout, schedule],
  )
  const undo = useCallback(() => {
    const box = latest.current
    if (!history.current.length) return
    const previous = history.current[history.current.length - 1]
    history.current = history.current.slice(0, -1)
    setUndoable(history.current.length)
    box.own = previous
    box.lastKey = null
    setOwn(previous)
    setStatus('saving')
    schedule()
  }, [schedule])
  const reset = useCallback(() => change(null), [change])
  const retry = useCallback(() => send(), [send])

  // "Use this layout": the shared view's layout becomes this reader's own.
  const adopt = useCallback(() => {
    const next = tried ?? sharedLayout
    if (!next) return
    const box = latest.current
    keep(box.own)
    box.own = next
    box.lastKey = null
    setOwn(next)
    setStatus('saving')
    schedule()
  }, [tried, sharedLayout, schedule])

  // Owners: the layout everyone without their own starts from.
  const setDefault = useCallback(async () => {
    const answer = await api.put(`${url}/default`, { layout: latest.current.own ?? fallback })
    client.setQueryData([url], (data) => (data ? { ...data, default: answer.default } : data))
  }, [url, client, fallback])
  const clearDefault = useCallback(async () => {
    await api.delete(`${url}/default`)
    client.setQueryData([url], (data) => (data ? { ...data, default: null } : data))
  }, [url, client])

  return {
    ready: own !== undefined && (!viewUrl || !shared.isLoading),
    error: stored.error,
    refetch: stored.refetch,
    layout,
    // Whether the reader has a layout of their own (false: they see the default).
    customised: Boolean(own),
    hasDefault: Boolean(stored.data?.default),
    canSetDefault: Boolean(stored.data?.canSetDefault),
    preview: preview && sharedLayout ? preview : null,
    previewMissing: Boolean(viewUrl && shared.error),
    status,
    failure,
    canUndo: undoable > 0 && !(preview && sharedLayout),
    change,
    undo,
    reset,
    retry,
    adopt,
    setDefault,
    clearDefault,
  }
}
