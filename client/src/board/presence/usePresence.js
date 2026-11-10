import { useEffect, useRef, useState } from 'react'
import { useOnViewportChange } from '@xyflow/react'

// A board mode: a viewport name (any configured one, such as "phone-landscape") or 'all'.
const MODES = { includes: (mode) => typeof mode === 'string' && (mode === 'all' || /^[a-z][a-z0-9-]{0,31}$/.test(mode)) }

// The viewport is read lazily (flow.getViewport) when a state frame goes out,
// so panning never re-renders the board; only the cursor layer subscribes.
export function usePresence({ enabled, boardId, canvasRef, flow, selection, mode, onMode, onInvalidate }) {
  const [peers, setPeers] = useState([])
  const [count, setCount] = useState(0)
  const [status, setStatus] = useState('offline')
  const [following, setFollowing] = useState(null)
  const latest = useRef({ cursor: null })
  latest.current = { ...latest.current, selection, mode, onMode, onInvalidate }
  const sendRef = useRef(null)
  const stopFollowing = () => setFollowing(null)
  useOnViewportChange({ onChange: enabled ? () => sendRef.current?.() : undefined })
  useEffect(() => {
    sendRef.current?.()
  }, [selection, mode])
  useEffect(() => {
    if (!enabled) {
      setPeers([])
      setCount(0)
      setFollowing(null)
      return undefined
    }
    let ended = false
    let dispose
    import('./runtime.js')
      .then(({ connectPresence }) => {
        if (ended) return
        dispose = connectPresence({ boardId, canvasRef, flow, latest, sendRef, setPeers, setCount, setFollowing, setStatus })
      })
      .catch(() => {
        if (!ended) setStatus('offline')
      })
    return () => {
      ended = true
      dispose?.()
    }
  }, [enabled, boardId, canvasRef, flow])

  useEffect(() => {
    if (following === null) return
    const peer = peers.find((item) => item.id === following)
    if (!peer) {
      setFollowing(null)
      return
    }
    const target = peer.viewport
    if (!target || ![target.x, target.y, target.zoom].every(Number.isFinite) || !MODES.includes(peer.mode)) return
    if (latest.current.mode !== peer.mode) latest.current.onMode?.(peer.mode)
    const frame = window.requestAnimationFrame(() => {
      const current = flow.getViewport()
      if (Math.abs(current.x - target.x) > 0.01 || Math.abs(current.y - target.y) > 0.01 || Math.abs(current.zoom - target.zoom) > 0.001)
        flow.setViewport(target, { duration: 0 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [following, peers, flow])
  return { peers, count, status, following, follow: setFollowing, stopFollowing }
}
