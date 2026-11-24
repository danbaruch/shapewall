import { useCallback, useEffect, useRef, useState } from 'react'
import { motionDuration } from '../../lib/motion'

// Live HTML iframes are heavy (a full-width document each): at most this many at once.
const MAX_LIVE = 2

function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

// Live HTML: a frame goes live (its screenshot swaps for the sanitized
// captured HTML) when it is drawn at least 40% of its native width, or half
// the canvas width, whichever is smaller; or when "Open live" pinned it. At
// most MAX_LIVE at once, nearest the middle of the canvas first. Recomputed
// when the camera rests, never during a move, so the overview never loads
// HTML. Also which live frames have loaded (`readyKeys`), and "Open live"
// (fly to a frame and keep it live).
export function useLiveFrames({ canvasRef, flow, targets, viewports, settledZoom, setSettledZoom, comparePair, captures, variantsById }) {
  const pinnedLive = useRef(null)
  const [liveKeys, setLiveKeys] = useState(() => new Set())
  const [readyKeys, setReadyKeys] = useState(() => new Set())
  const setLiveReady = useCallback((key, ready) => {
    setReadyKeys((previous) => {
      if (previous.has(key) === ready) return previous
      const next = new Set(previous)
      if (ready) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const liveFileFor = useCallback(
    (targetId, viewport) => {
      // Compare mode shows screenshots only.
      if (comparePair) return null
      if (targetId.startsWith('variant:')) return variantsById.get(targetId)?.files?.[viewport]?.live || null
      return captures?.[targetId]?.[viewport]?.live || null
    },
    [comparePair, captures, variantsById],
  )
  const recomputeLive = useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect()
    if (!box?.width || !settledZoom) {
      setLiveKeys((previous) => (previous.size ? new Set() : previous))
      return
    }
    const { x: tx, y: ty, zoom } = flow.getViewport()
    const candidates = []
    for (const [targetId, target] of Object.entries(targets)) {
      for (const frame of target.frames) {
        if (!liveFileFor(targetId, frame.viewport)) continue
        const left = (target.x + frame.x) * zoom + tx
        const top = (target.y + frame.y) * zoom + ty
        const width = frame.w * zoom
        const height = frame.h * zoom
        if (left > box.width || top > box.height || left + width < 0 || top + height < 0) continue
        const key = `${targetId}|${frame.viewport}`
        const pinned = pinnedLive.current === key
        const threshold = Math.min((viewports[frame.viewport]?.width || 1440) * 0.4, box.width * 0.5)
        if (width < (pinned ? threshold / 2 : threshold)) continue
        candidates.push({ key, rank: pinned ? -1 : Math.hypot(left + width / 2 - box.width / 2, top + height / 2 - box.height / 2) })
      }
    }
    candidates.sort((a, b) => a.rank - b.rank)
    const next = new Set(candidates.slice(0, MAX_LIVE).map((item) => item.key))
    if (pinnedLive.current && !next.has(pinnedLive.current)) pinnedLive.current = null
    setLiveKeys((previous) => (sameSet(previous, next) ? previous : next))
  }, [canvasRef, flow, targets, liveFileFor, settledZoom, viewports])
  useEffect(() => {
    recomputeLive()
  }, [recomputeLive])
  // "Open live": fly to the frame (full width, its top) and keep it live.
  const openLive = useCallback(
    (targetId, viewport) => {
      const target = targets[targetId]
      const frame = target?.frames.find((item) => item.viewport === viewport)
      const box = canvasRef.current?.getBoundingClientRect()
      if (!frame || !box?.width) return
      pinnedLive.current = `${targetId}|${viewport}`
      setSettledZoom(null)
      flow.fitBounds(
        { x: target.x + frame.x, y: target.y + frame.y, width: frame.w, height: Math.min(frame.h, frame.w * (box.height / box.width)) },
        { padding: 0.04, duration: motionDuration(450) },
      )
    },
    [canvasRef, flow, targets, setSettledZoom],
  )
  return { liveKeys, readyKeys, setLiveReady, liveFileFor, recomputeLive, openLive }
}
