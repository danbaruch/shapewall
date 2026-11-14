import { useEffect, useRef } from 'react'
import { pinPoint } from '../layout'
import { FIT_OPTIONS } from '../camera'
import { focusViewport, focusZoom, settled } from '../commentFocus'
import { motionDuration } from '../../lib/motion'

// How long a pin that has not appeared is waited for. Long enough for a card
// that is still being laid out, short enough that a comment the current view
// hides says so instead of hanging.
export const FOCUS_WAIT_MS = 700
// How long the pin keeps its arrival ring.
export const LANDED_MS = 1600

// The phone's thread sheet (BoardPanels.jsx) is a bottom sheet: it covers the
// bottom of the canvas, and how much depends on the comment in it -- a short
// one is a strip, one carrying an image and a thread is more than half the
// screen. The pin has to land above whichever it is, so the sheet is measured
// here and handed to commentFocus.js.
//
// Its height, not the top of its box: the sheet slides up as it opens
// (animate-sheet-in is a translate), so its box is still moving while this
// runs, and it is pinned to the bottom of the window, so the height is the
// honest measure. The answer is in canvas pixels from the canvas's top, to
// match the rest of the focus arithmetic.
//
// Null when there is no sheet: a desktop, a jump that opens none, or one
// that is not in the page yet (see SHEET_FRAMES).
export function sheetTopIn(box) {
  if (!box) return null
  const panel = document.querySelector('[data-sw-thread-sheet]')?.closest('[role="dialog"]')
  const height = panel?.offsetHeight
  if (!height) return null
  return window.innerHeight - height - box.top
}

// The sheet is portalled in a tick after the click that opens it, so the
// first look often finds nothing. Rather than fly on a guess and correct it
// afterwards (two moves for one click), the jump waits up to this many frames
// for the sheet to arrive and then makes its one move. A few frames is under
// the eye's threshold; past them the jump goes anyway, on the fallback.
export const SHEET_FRAMES = 5

// A comment waiting to be shown (`pendingFocus`): once its pin is on the
// board, fly to it (commentFocus.js decides where it lands) and tell
// `onLanded`, which rings the pin so a short hop still reads as an arrival.
// `onHidden` is told when the pin cannot be shown at all, so the board can
// say so rather than sit on a focus that never resolves -- a stale
// `pendingFocus` also stops the refit when the screen size changes
// (useRefitOnChange).
export function useFlyToPending({
  pendingFocus,
  setPendingFocus,
  targets,
  viewports,
  mode,
  flow,
  canvasRef,
  wide,
  setSettledZoom,
  onHidden = null,
  onLanded = null,
}) {
  const hidden = useRef(onHidden)
  hidden.current = onHidden
  const landed = useRef(onLanded)
  landed.current = onLanded
  // The frame a jump is waiting on for its sheet (below). Held outside the
  // effect so that re-running it for another comment, or leaving the board,
  // drops the old wait instead of letting two jumps race.
  const waiting = useRef(0)
  useEffect(() => () => window.cancelAnimationFrame(waiting.current), [])
  useEffect(() => {
    if (!pendingFocus) return undefined
    const point = pinPoint(targets, pendingFocus)
    if (!point) {
      // Gone for good (removed page or variant, unknown viewport): stop at once.
      if (!targets[pendingFocus.pageId] || !viewports[pendingFocus.viewport]) {
        setPendingFocus(null)
        hidden.current?.(pendingFocus)
        return undefined
      }
      // Still on its way: the board is changing to the screen size this
      // comment lives on, so its frame has not been laid out yet. The change
      // re-runs this effect.
      if (mode !== 'all' && mode !== pendingFocus.viewport) return undefined
      // The board is showing that screen size and the pin is still not
      // there. Give it a moment for the layout, then stop waiting. A comment
      // on a page the view hides (a variant while comparing, a page left out
      // by "Changed pages only") never gets a pin, and waiting for one left
      // the click doing nothing at all -- and the stale focus also stopped
      // the next refit.
      const timer = window.setTimeout(() => {
        setPendingFocus(null)
        hidden.current?.(pendingFocus)
      }, FOCUS_WAIT_MS)
      return () => window.clearTimeout(timer)
    }
    setPendingFocus(null)
    setSettledZoom(null)
    window.cancelAnimationFrame(waiting.current)
    // A comment opened on a phone brings its thread sheet up with it, and the
    // pin has to land clear of the sheet, which is as tall as the comment in
    // it makes it. The sheet is not in the page on this tick, so the jump
    // waits a few frames for it, then moves once, with the real measurement.
    // Everything else (a desktop, a jump to a page or a parked draft, which
    // open no sheet) goes straight away, as it always did.
    const sheetWanted = !wide && pendingFocus.id != null
    let frames = 0
    const fly = () => {
      const box = canvasRef.current?.getBoundingClientRect()
      const sheetTop = wide ? null : sheetTopIn(box)
      if (sheetWanted && sheetTop === null && frames < SHEET_FRAMES) {
        frames += 1
        waiting.current = window.requestAnimationFrame(fly)
        return
      }
      const wanted = focusViewport({
        point,
        box,
        wide,
        zoom: flow.getZoom(),
        cardTop: targets[pendingFocus.pageId]?.y ?? null,
        sheetTop,
      })
      if (!wanted) flow.setCenter(point.x, point.y, { zoom: focusZoom(flow.getZoom()), duration: motionDuration(450) })
      // Already there: land without moving, so clicking the open comment again
      // (or its neighbour on the same card) never jolts the board.
      else flow.setViewport(wanted, { duration: settled(flow.getViewport(), wanted) ? 0 : motionDuration(450) })
      landed.current?.(pendingFocus)
    }
    fly()
    return undefined
  }, [canvasRef, flow, mode, targets, pendingFocus, setPendingFocus, setSettledZoom, viewports, wide])
}

// The first view on a phone: two cards of the first group across, not the
// whole board drawn tiny.
export function usePhoneStartView({ wide, nodesReady, initialCamera, selectedCommentId, canvasRef, nodes, flow, setSettledZoom }) {
  const phoneStart = useRef(false)
  useEffect(() => {
    if (wide || phoneStart.current || !nodesReady) return
    // Only the first view: not after a link to a thread or a camera, and
    // never again later in the visit.
    phoneStart.current = true
    if (initialCamera.current || selectedCommentId) return
    const box = canvasRef.current?.getBoundingClientRect()
    const group = nodes.find((node) => node.type === 'groupFrame')
    const first = group && nodes.find((node) => node.type === 'page' && node.data?.page?.group === group.data.group)
    if (!box?.width || !group || !first) {
      flow.fitView(FIT_OPTIONS)
      return
    }
    // Two cards across, or the whole group when it is narrower.
    const span = Math.min(group.width, first.width * 2 + 72 + 2 * (first.position.x - group.position.x))
    const zoom = Math.min(1.5, Math.max(0.05, (box.width - 16) / span))
    const label = 12 + 44 * Math.max(zoom, 0.45)
    setSettledZoom(null)
    flow.setViewport({ x: 8 - group.position.x * zoom, y: label - group.position.y * zoom, zoom })
  }, [canvasRef, flow, initialCamera, nodes, nodesReady, selectedCommentId, setSettledZoom, wide])
}

// Refit the board when its shape changes: switching viewport mode changes
// every node's size (unless the switch came from opening a comment, which
// pans to the pin instead), and entering or leaving compare mode, or
// filtering to changed pages, reshapes it (`shapeKey`).
export function useRefitOnChange({ mode, pendingFocus, shapeKey, clearFocus, fitBoard }) {
  const previousMode = useRef(mode)
  useEffect(() => {
    if (previousMode.current === mode) return undefined
    previousMode.current = mode
    clearFocus()
    if (pendingFocus) return undefined
    const timer = window.setTimeout(fitBoard, 60)
    return () => window.clearTimeout(timer)
  }, [clearFocus, fitBoard, mode, pendingFocus])

  const previousShape = useRef(shapeKey)
  useEffect(() => {
    if (previousShape.current === shapeKey) return undefined
    previousShape.current = shapeKey
    clearFocus()
    // A jump that left compare mode, or turned "Changed pages only" off, to
    // reveal a comment reshapes the board on its way to the pin: refitting
    // the whole board 60 ms later would throw the camera straight back off
    // it. The pin is the point of the move, so the fly wins, exactly as it
    // does for a viewport switch above.
    if (pendingFocus) return undefined
    const timer = window.setTimeout(fitBoard, 60)
    return () => window.clearTimeout(timer)
  }, [clearFocus, fitBoard, pendingFocus, shapeKey])
}
