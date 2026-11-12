// Desktop drawing mode: while a drawing tool is on, the comment's page is
// the drawing surface. The composer or thread steps aside and a labelled bar
// just above the board's tools (BoardTools.jsx) says so and holds the drawing
// tools. The view
// stays exactly where it was (wheel, Space and middle-drag still move it),
// unless the page cannot be drawn on as it stands: most of it off screen, or
// drawn too small (camera.js canDrawInPlace). Then it is fitted, and the
// camera goes back when drawing ends. Done, Escape, posting or cancelling
// ends it: one step back, to the comment being written.
import { useEffect, useRef } from 'react'
import { motionDuration } from '../lib/motion'
import { canDrawInPlace, drawingViewport } from './camera'
import { contentExtent } from './contentExtent'
import { DrawBar } from './CommentMedia'
import { useDrawing } from './drawing'
import { splitFrameKey } from './viewports'

// "owner\nkey" while a tool is on, else ''. A string, so picking another
// tool, an ink or drawing a shape never moves the camera again.
const activeOf = (value) => (value?.tool ? `${value.owner}\n${value.key}` : '')

export function useDrawingMode(enabled) {
  const active = useDrawing(activeOf)
  return enabled && Boolean(active)
}

// `focusFor(owner)`: where the pin is down its frame (0 to 1). `shotFor(pageId,
// viewport)`: the capture's URL, to fit the page's content rather than the
// empty rest of a fixed frame. Renders nothing: the bar is DrawingBar.
export function DrawingMode({ flow, canvasRef, targets, focusFor, shotFor }) {
  const active = useDrawing(activeOf)
  const saved = useRef(null)
  const latest = useRef({ targets, focusFor, shotFor, active })
  latest.current = { targets, focusFor, shotFor, active }
  useEffect(() => {
    if (!active) {
      // Only a camera this mode moved is put back.
      if (saved.current) flow.setViewport(saved.current, { duration: motionDuration(400) })
      saved.current = null
      return undefined
    }
    const [owner, key] = active.split('\n')
    const { targetId: pageId, viewport } = splitFrameKey(key)
    const target = latest.current.targets?.[pageId]
    const frame = target?.frames.find((item) => item.viewport === viewport)
    if (!frame) return undefined
    let stale = false
    contentExtent(latest.current.shotFor(pageId, viewport))
      .catch(() => 1)
      .then((extent) => {
        if (stale || latest.current.active !== active) return
        const pin = Math.min(1, Math.max(0, latest.current.focusFor(owner)))
        const share = Math.min(1, Math.max(0.25, extent, pin + 0.08))
        const frameBox = { x: target.x + frame.x, y: target.y + frame.y, width: frame.w, height: frame.h * share }
        const box = canvasRef.current?.getBoundingClientRect()
        if (canDrawInPlace(frameBox, flow.getViewport(), box)) return
        const next = drawingViewport(frameBox, box, pin / share)
        if (!next) return
        if (!saved.current) saved.current = flow.getViewport()
        flow.setViewport(next, { duration: motionDuration(450) })
      })
    return () => {
      stale = true
    }
  }, [active, flow, canvasRef])
  return null
}

// The drawing bar, while a tool is on (a child of the tool dock).
// `titleFor(pageId, viewport)`: the bar's label.
export function DrawingBar({ titleFor }) {
  const active = useDrawing(activeOf)
  if (!active) return null
  const [owner, key] = active.split('\n')
  const { targetId, viewport } = splitFrameKey(key)
  return (
    <div className="pointer-events-none relative z-30 flex max-w-full justify-center" data-sw-drawing-mode="true">
      <DrawBar owner={owner} title={titleFor?.(targetId, viewport) || ''} />
    </div>
  )
}
