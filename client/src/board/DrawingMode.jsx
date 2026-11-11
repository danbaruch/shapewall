// Desktop drawing mode: while a drawing tool is on, the comment's page frame
// fills the free canvas at a size to draw on (animated unless motion is
// reduced), the composer or thread steps aside and a small bar docked at the
// top of the canvas holds the tools. Done, Escape, posting or cancelling ends
// it, and the camera goes back to where it was.
import { useEffect, useRef } from 'react'
import { motionDuration } from '../lib/motion'
import { drawingViewport } from './camera'
import { contentExtent } from './contentExtent'
import { DrawBar } from './CommentMedia'
import { useDrawing } from './drawing'

// "owner\nkey" while a tool is on, else ''. A string, so picking another
// tool, an ink or drawing a shape never moves the camera again.
const activeOf = (value) => (value?.tool ? `${value.owner}\n${value.key}` : '')

export function useDrawingMode(enabled) {
  const active = useDrawing(activeOf)
  return enabled && Boolean(active)
}

// `focusFor(owner)`: where the pin is down its frame (0 to 1). `shotFor(pageId,
// viewport)`: the capture's URL, to fit the page's content rather than the
// empty rest of a fixed frame.
export function DrawingMode({ flow, canvasRef, targets, focusFor, shotFor }) {
  const active = useDrawing(activeOf)
  const saved = useRef(null)
  const latest = useRef({ targets, focusFor, shotFor, active })
  latest.current = { targets, focusFor, shotFor, active }
  useEffect(() => {
    if (!active) {
      if (saved.current) flow.setViewport(saved.current, { duration: motionDuration(400) })
      saved.current = null
      return undefined
    }
    const [owner, key] = active.split('\n')
    const cut = key.lastIndexOf('|')
    const [pageId, viewport] = [key.slice(0, cut), key.slice(cut + 1)]
    const target = latest.current.targets?.[pageId]
    const frame = target?.frames.find((item) => item.viewport === viewport)
    if (!frame) return undefined
    if (!saved.current) saved.current = flow.getViewport()
    let stale = false
    contentExtent(latest.current.shotFor(pageId, viewport))
      .catch(() => 1)
      .then((extent) => {
        if (stale || latest.current.active !== active) return
        const pin = Math.min(1, Math.max(0, latest.current.focusFor(owner)))
        const share = Math.min(1, Math.max(0.25, extent, pin + 0.08))
        const next = drawingViewport(
          { x: target.x + frame.x, y: target.y + frame.y, width: frame.w, height: frame.h * share },
          canvasRef.current?.getBoundingClientRect(),
          pin / share,
        )
        if (next) flow.setViewport(next, { duration: motionDuration(450) })
      })
    return () => {
      stale = true
    }
  }, [active, flow, canvasRef])
  if (!active) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-2" data-sw-drawing-mode="true">
      <DrawBar owner={active.split('\n')[0]} />
    </div>
  )
}
