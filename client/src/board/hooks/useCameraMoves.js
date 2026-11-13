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
    const box = canvasRef.current?.getBoundingClientRect()
    const wanted = focusViewport({
      point,
      box,
      wide,
      zoom: flow.getZoom(),
      cardTop: targets[pendingFocus.pageId]?.y ?? null,
    })
    if (!wanted) flow.setCenter(point.x, point.y, { zoom: focusZoom(flow.getZoom()), duration: motionDuration(450) })
    // Already there: land without moving, so clicking the open comment again
    // (or its neighbour on the same card) never jolts the board.
    else flow.setViewport(wanted, { duration: settled(flow.getViewport(), wanted) ? 0 : motionDuration(450) })
    landed.current?.(pendingFocus)
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
    const timer = window.setTimeout(fitBoard, 60)
    return () => window.clearTimeout(timer)
  }, [clearFocus, fitBoard, shapeKey])
}
