import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DEMO } from '../../lib/demo'
import { STATIC, elementsUrl, fileUrl, liveUrl } from '../../lib/api'
import { motionDuration } from '../../lib/motion'
import { createBoardView } from '../boardView'
import { withBarRoom } from '../camera'
import { historyCount } from '../flow'
import { isThumbnail } from '../layout'

const NO_PINS = []

// What the cards on the canvas read, in two parts (see boardView.js for why):
//
// `board` (BoardContext): what changes rarely and concerns every card: the
// captures, the journey and compare views, comment mode, the pins by card,
// and the board's actions. The actions are the same functions for the life
// of the board (they read the latest state when called), so a click never
// changes this value.
//
// `view` (BoardViewContext): what changes with every click and camera rest;
// each card reads only its own answer through a selector.
//
// Everything the actions need comes in as one `input` object from Board.jsx.
export function useBoardContext(input) {
  const latest = useRef(input)
  latest.current = input
  const {
    boardId,
    data,
    viewports,
    journeyView,
    compareView,
    commentMode,
    canComment,
    wide,
    hosted,
    imageVersion,
    pinsByTarget,
    me,
    checksCounts,
    canChecks,
    agentFocus,
    agentWorkingPages,
    setLiveReady,
    // The volatile part.
    focusedKey,
    selectingKey,
    settledZoom,
    selectedComment,
    draftSpot,
    unread,
    liveKeys,
  } = input

  const [view] = useState(() => createBoardView({ focusedKey, selectingKey, settledZoom, selectedComment, draftSpot, unread, liveKeys }))
  // Before the browser paints, so a card never shows a frame of the old state.
  useLayoutEffect(() => {
    view.set({ focusedKey, selectingKey, settledZoom, selectedComment, draftSpot, unread, liveKeys })
  }, [view, focusedKey, selectingKey, settledZoom, selectedComment, draftSpot, unread, liveKeys])

  const actions = useMemo(() => {
    const now = () => latest.current
    return {
      // Building a journey, a click adds the page as the next step.
      onFocusFrame: (targetId, viewport) => {
        const { selectedCommentId, closeThread, builder, addBuilderStep, layout, flow, setSettledZoom, canvasRef, setFocusedKey } = now()
        // A click elsewhere on the canvas closes the open thread.
        if (selectedCommentId) closeThread()
        if (builder) {
          if (!targetId.startsWith('variant:')) addBuilderStep(targetId)
          return
        }
        // A card tapped while it is a thumbnail: fly to it first, so its
        // action bar has a card to sit by (the bar hides on thumbnails).
        const target = layout.targets[targetId]
        const frame = target?.frames.find((item) => item.viewport === viewport)
        if (target && frame && isThumbnail(frame, flow.getZoom())) {
          setSettledZoom(null)
          // The frame with its card header, not the whole card (a phone frame beside a desktop one).
          flow.fitBounds(
            withBarRoom(
              { x: target.x + frame.x, y: target.y, width: frame.w, height: frame.y + frame.h },
              canvasRef.current?.getBoundingClientRect(),
              0.08,
            ),
            { padding: 0.08, duration: motionDuration(450) },
          )
        }
        setFocusedKey(`${targetId}|${viewport}`)
      },
      // A click in comment mode starts a comment there, or moves the one
      // being written while it is still empty.
      onPin: (target) => {
        const state = now()
        const { layout, flow, canvasRef } = state
        // A target is already picked and its comment has something in it
        // (text, an image, a drawing): a click elsewhere never re-aims it.
        // The composer nudges (keepDraft), so the click is not just swallowed.
        // An empty draft moves to the new spot.
        if (state.keepDraft()) return
        if (state.selectedCommentId) state.closeThread()
        // Phone: a tap on a page drawn small zooms to it first, so the page
        // can go live and the next tap pins to the element under the finger.
        const card = layout.targets[target.pageId]
        const frame = card?.frames.find((item) => item.viewport === target.viewport)
        const box = canvasRef.current?.getBoundingClientRect()
        if (!state.wide && frame && box?.width && frame.w * flow.getZoom() < box.width * 0.6) {
          state.setSettledZoom(null)
          const zoom = Math.min(4, (box.width - 16) / frame.w)
          const fy = card.y + frame.y + (frame.h * target.y) / 100
          flow.setViewport({ x: 8 - (card.x + frame.x) * zoom, y: box.height * 0.35 - fy * zoom, zoom }, { duration: motionDuration(450) })
          state.setToast({ at: Date.now(), text: 'Zoomed in: tap the spot again to pin your comment.', untilSheet: true })
          return
        }
        state.setDraft((current) => ({
          ...target,
          body: current?.body || state.checkDraft || '',
          author: current?.author ?? state.authorName(),
        }))
        state.setCheckDraft('')
      },
      onSelectComment: (comment) => now().selectComment(comment),
      onHoverComment: (id) => view.set({ hoveredId: id }),
      // "Select text": the page of this frame has the mouse (or none has).
      onReading: (key) => view.set({ readingKey: key }),
      // The chip an off-screen journey arrow ends in: go to that step.
      onJourneyStep: (step) => now().goStep(step),
      onOpenCluster: (targetId, viewport, items) => now().openCluster(targetId, viewport, items),
      onChecks: (...args) => now().openChecks(...args),
      onHistory: (pageId, viewport = null) => now().openHistory(pageId, viewport),
      onShowViewport: (viewport) => now().updateParams({ vp: viewport === now().defaultMode ? null : viewport }),
      onImageError: () => now().onImageError(),
    }
  }, [view])

  const board = useMemo(
    () => ({
      // The comment thread's "Fix with ..." sets its chat's agent (FixWithAgent.jsx).
      boardId,
      captures: data?.captures || {},
      manifest: data?.manifest || null,
      counts: data?.commentCounts || {},
      viewports,
      journey: journeyView,
      compare: compareView,
      commentMode: commentMode && canComment && !compareView,
      touch: !wide,
      imageUrl: (kind, file, version) => fileUrl(boardId, kind, file, version || imageVersion),
      liveUrl: (kind, file, version) => liveUrl(boardId, kind, file, version || imageVersion),
      elementsUrl: (kind, file, version) => elementsUrl(boardId, kind, file, version || imageVersion),
      // Captures from before element maps: only the local board may still
      // read their DOM (same-origin frame). Hosted boards, static exports and
      // the demo frame every live page with an opaque origin.
      domFallback: !STATIC && !DEMO && !hosted,
      setLiveReady,
      // The pins the list shows on a frame. The open thread keeps its pin even
      // when the filter hides it (just resolved): the frame adds that one
      // itself, from the view store.
      pinsFor: (target, viewport) => (compareView ? NO_PINS : pinsByTarget.get(`${target}|${viewport}`) || NO_PINS),
      me,
      checksCount: (pageId) => checksCounts.get(pageId) || 0,
      historyCount: (pageId) => historyCount(data?.versions, pageId),
      agentWorking: agentFocus,
      agentWorkingPages,
      onFocusFrame: actions.onFocusFrame,
      onPin: actions.onPin,
      onSelectComment: actions.onSelectComment,
      onReading: actions.onReading,
      onJourneyStep: actions.onJourneyStep,
      onHoverComment: wide ? actions.onHoverComment : null,
      onOpenCluster: actions.onOpenCluster,
      onChecks: canChecks ? actions.onChecks : null,
      onHistory: actions.onHistory,
      onShowViewport: actions.onShowViewport,
      onImageError: actions.onImageError,
    }),
    [
      actions,
      agentFocus,
      agentWorkingPages,
      boardId,
      canChecks,
      canComment,
      checksCounts,
      commentMode,
      compareView,
      data?.captures,
      data?.commentCounts,
      data?.manifest,
      data?.versions,
      hosted,
      imageVersion,
      journeyView,
      me,
      pinsByTarget,
      setLiveReady,
      viewports,
      wide,
    ],
  )
  return { board, view }
}
