import { useEffect, useRef } from 'react'
import { pinPoint } from '../layout'
import { FIT_OPTIONS } from '../camera'
import { motionDuration } from '../../lib/motion'

// Screen pixels kept free above a card on a phone for its title row (24 px
// at any zoom) and a little air, so the header never sits under the toolbar.
const PHONE_HEADER_ROOM = 40

// A comment waiting to be shown (`pendingFocus`): once its pin is on the board,
// fly to it. A phone puts the pin in the upper part, above the thread sheet.
export function useFlyToPending({ pendingFocus, setPendingFocus, targets, viewports, flow, canvasRef, wide, setSettledZoom }) {
  useEffect(() => {
    if (!pendingFocus) return
    const point = pinPoint(targets, pendingFocus)
    if (!point) {
      // Gone for good (removed page or variant, unknown viewport): stop waiting.
      if (!targets[pendingFocus.pageId] || !viewports[pendingFocus.viewport]) setPendingFocus(null)
      return
    }
    setPendingFocus(null)
    setSettledZoom(null)
    const zoom = Math.max(flow.getZoom(), 1.2)
    const box = canvasRef.current?.getBoundingClientRect()
    const target = targets[pendingFocus.pageId]
    if (wide || !box?.width || !target) {
      flow.setCenter(point.x, point.y, { zoom, duration: motionDuration(450) })
      return
    }
    // Phone: the thread sheet covers the lower part of the screen, so the pin
    // goes in the upper part (28% down the canvas). When that would push the
    // card's title row above the canvas (under the toolbar), the card comes
    // down until its header shows, as long as the pin stays in the upper half.
    let y = box.height * 0.28 - point.y * zoom
    if (target.y * zoom + y < PHONE_HEADER_ROOM) y = Math.min(PHONE_HEADER_ROOM - target.y * zoom, box.height * 0.45 - point.y * zoom)
    flow.setViewport({ x: box.width / 2 - point.x * zoom, y, zoom }, { duration: motionDuration(450) })
  }, [canvasRef, flow, targets, pendingFocus, setPendingFocus, setSettledZoom, viewports, wide])
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
