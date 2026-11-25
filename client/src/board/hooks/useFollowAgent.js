import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  ANY_AGENT,
  FOLLOW_OFF,
  agentPresence,
  captureStamps,
  currentFocus,
  followEvents,
  followLine,
  followName,
  followReducer,
  followTarget,
  heldComments,
  othersText,
} from '../followAgent'

// Follow mode on the board (followAgent.js has the state table). The address
// holds the request (`follow=<agentId>`, so a reload or a link keeps
// following); the reducer holds the rest. This hook turns the board's
// snapshots into events, and the state into moves: fly to a comment
// (focusComment), open a screen's before and after (openHistory).
//
//   enabled        follow is offered here (local boards; hosted members)
//   hosted         a hosted board: `agents` names the agents
//   request        the address's follow value, or null
//   comments       the board's comments, as this viewer sees them
//   manifest       the board view's capture manifest
//   agents         hosted: the project's agents as this member sees them; null until loaded
//   focus          local: the chat turn on this board (chat/agentFocus.js)
//   selectedCommentId, historyPageId   the address's open comment and history
export function useFollowAgent({
  enabled,
  hosted,
  boardId,
  request,
  comments,
  manifest,
  agents,
  focus,
  selectedCommentId,
  historyPageId,
  canvasRef,
  focusComment,
  openHistory,
  closeHistory,
  updateParams,
  setToast,
  titleOf,
}) {
  const [state, dispatch] = useReducer(followReducer, FOLLOW_OFF)
  const live = useRef(state)
  live.current = state
  const wanted = enabled ? followTarget(request) : null

  // The address asks, the reducer follows; a request that goes away (Stop, another board) stops it.
  useEffect(() => {
    if (wanted) dispatch({ type: 'start', agentId: wanted })
    else dispatch({ type: 'interrupt' })
  }, [wanted, boardId])
  // Stopped by the reducer (the person moved, the agent left): the address lets go too.
  const requested = useRef(request)
  requested.current = request
  const wasOn = useRef(false)
  useEffect(() => {
    const on = state.mode !== 'off'
    if (wasOn.current && !on && requested.current) updateParams({ follow: null })
    wasOn.current = on
  }, [state.mode, updateParams])

  // Snapshots of what the board knows, diffed into events. A hosted board
  // following one agent waits for the agent list before the first one.
  const agentId = state.mode === 'off' ? null : state.agentId
  const waiting = Boolean(agentId && hosted && agentId !== ANY_AGENT && !Array.isArray(agents))
  const held = useMemo(
    () => (agentId && !waiting ? heldComments({ comments, agents: hosted ? agents : null, agentId, focus: hosted ? null : focus }) : null),
    [agentId, agents, comments, focus, hosted, waiting],
  )
  const stamps = useMemo(() => captureStamps(manifest), [manifest])
  const snapshot = useRef(null)
  const seen = useRef(new Map())
  const startedFor = useRef(null)
  useEffect(() => {
    seen.current = new Map()
    snapshot.current = null
  }, [boardId])
  useEffect(() => {
    if (!held) {
      startedFor.current = null
      // Keep the capture versions current while not following, so turning
      // it on later does not read old captures as new.
      followEvents(null, { held: new Map(), stamps }, seen.current)
      snapshot.current = null
      return
    }
    const after = { held, stamps }
    if (startedFor.current !== agentId) {
      // Just started: where the agent is now, if anywhere.
      startedFor.current = agentId
      followEvents(null, after, seen.current)
      snapshot.current = after
      const now = currentFocus(held)
      if (now) dispatch({ type: 'took', commentId: now.id, pageId: now.pageId, viewport: now.viewport, at: now.at })
      return
    }
    for (const event of followEvents(snapshot.current, after, seen.current)) dispatch(event)
    snapshot.current = after
  }, [agentId, held, stamps])

  // The agent left (hosted, one agent followed).
  const presence = agentId && hosted ? agentPresence(agents, agentId) : 'unknown'
  const name = followName(agents, state.agentId || ANY_AGENT)
  const wasPresent = useRef(false)
  useEffect(() => {
    if (presence === 'present') wasPresent.current = true
    else if (presence === 'missing')
      dispatch({
        type: 'gone',
        notice: wasPresent.current ? `Stopped following: ${name} left this board.` : 'Stopped following: no such agent on this board.',
      })
    else if (presence === 'offline' && wasPresent.current) dispatch({ type: 'gone', notice: `Stopped following: ${name} is offline.` })
    if (presence === 'unknown' || presence === 'missing') wasPresent.current = false
  }, [presence, name])
  useEffect(() => {
    if (!state.notice) return
    setToast({ at: Date.now(), text: state.notice })
    dispatch({ type: 'notice-shown' })
  }, [setToast, state.notice])

  // Moves. The comment the agent took: fly there and select it (closing a
  // before and after that was open). A recapture of its screen: open the
  // before and after.
  const flewTo = useRef(null)
  const latest = useRef({})
  latest.current = { comments, focusComment, openHistory, closeHistory, historyPageId }
  const commentId = state.comment?.id ?? null
  useEffect(() => {
    if (commentId === null) {
      flewTo.current = null
      return
    }
    if (flewTo.current === commentId) return
    flewTo.current = commentId
    const { comments: list, focusComment: fly, closeHistory: close, historyPageId: open } = latest.current
    const comment = list.find((item) => Number(item.id) === commentId)
    if (open) close()
    if (comment) fly(comment)
  }, [commentId])
  const compareKey = state.compare ? `${state.compare.pageId}|${state.compare.viewport}|${state.capturedAt}` : null
  const opened = useRef(null)
  useEffect(() => {
    if (!compareKey) {
      opened.current = null
      return
    }
    if (opened.current === compareKey) return
    opened.current = compareKey
    const { pageId, viewport } = live.current.compare
    latest.current.openHistory(pageId, viewport)
  }, [compareKey])
  // The person closed the before and after: back to following.
  const historyWasOpen = useRef(false)
  useEffect(() => {
    if (historyPageId) historyWasOpen.current = true
    else if (historyWasOpen.current) {
      historyWasOpen.current = false
      dispatch({ type: 'compare-closed' })
    }
  }, [historyPageId])

  // The person takes over: another comment opened, or the canvas moved
  // (a press or the wheel on it; the follow bar itself does not count).
  const lastSelected = useRef(selectedCommentId)
  useEffect(() => {
    const before = lastSelected.current
    lastSelected.current = selectedCommentId
    if (selectedCommentId === null || selectedCommentId === before) return
    const followed = live.current.comment?.id ?? null
    if (live.current.mode !== 'off' && selectedCommentId !== followed) dispatch({ type: 'interrupt' })
  }, [selectedCommentId])
  const on = state.mode !== 'off'
  useEffect(() => {
    const canvas = canvasRef.current
    if (!on || !canvas) return undefined
    const interrupt = (event) => {
      if (event.target instanceof Element && event.target.closest('[data-sw-follow-bar]')) return
      dispatch({ type: 'interrupt' })
    }
    canvas.addEventListener('pointerdown', interrupt, true)
    canvas.addEventListener('wheel', interrupt, { capture: true, passive: true })
    return () => {
      canvas.removeEventListener('pointerdown', interrupt, true)
      canvas.removeEventListener('wheel', interrupt, { capture: true })
    }
  }, [canvasRef, on])

  const follow = useCallback((id) => updateParams({ follow: followTarget(id) || ANY_AGENT }), [updateParams])
  const stop = useCallback(() => {
    dispatch({ type: 'interrupt' })
    updateParams({ follow: null })
  }, [updateParams])
  const openOther = useCallback((screen) => {
    dispatch({ type: 'seen', pageId: screen.pageId, viewport: screen.viewport })
    latest.current.openHistory(screen.pageId, screen.viewport)
  }, [])
  return {
    state,
    name,
    line: followLine(state, { name, titleOf }),
    othersText: othersText(state.others),
    follow,
    stop,
    openOther,
  }
}
