import { useCallback, useEffect, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'

// The zoom once the camera stops moving. Image sharpness and live HTML are
// decided from this, never from the transient zoom of an animation. Zooming
// out by more than 20% lowers it at once (newly visible nodes must not inherit
// a stale high zoom); rises wait until the camera rests.
export function useSettledZoom(ready) {
  const store = useStoreApi()
  const [zoom, setZoomState] = useState(null)
  const current = useRef(null)
  const setZoom = useCallback((value) => {
    current.current = value
    setZoomState(value)
  }, [])
  useEffect(() => {
    if (!ready) return undefined
    let timer = null
    const settle = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setZoom(store.getState().transform[2]), 300)
    }
    settle()
    let last = store.getState().transform[2]
    const unsubscribe = store.subscribe((state) => {
      const next = state.transform[2]
      if (next === last) return
      last = next
      if (current.current !== null && next < current.current * 0.8) setZoom(next)
      settle()
    })
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [ready, setZoom, store])
  return [zoom, setZoom]
}
