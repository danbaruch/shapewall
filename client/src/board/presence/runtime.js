import { Doc } from 'yjs'
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness.js'

const PROTOCOL = 'shapewall-presence-v1'

// Loaded only for hosted boards, keeping awareness out of the local board entry.
export function connectPresence({ boardId, canvasRef, flow, latest, sendRef, setPeers, setCount, setFollowing, setStatus }) {
  const doc = new Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalState(null)
  let socket
  let ended = false
  let ownId = null
  let countsOnly = false
  let retry = null
  let retryMs = 1000
  let timer = null
  let invalidate = null
  let lastSent = 0
  const update = () =>
    setPeers(
      [...awareness.getStates()]
        .filter(([id]) => id !== ownId)
        .slice(0, 50)
        .map(([id, state]) => ({ ...state, id }))
        .filter((peer) => typeof peer.name === 'string' && peer.name.length <= 80 && /^#[a-f0-9]{6}$/i.test(peer.color)),
    )
  awareness.on('change', update)
  const send = () => {
    if (ended || countsOnly || ownId === null || socket?.readyState !== WebSocket.OPEN) return
    if (timer) return
    timer = window.setTimeout(
      () => {
        timer = null
        if (socket?.readyState !== WebSocket.OPEN) return
        lastSent = performance.now()
        const current = latest.current
        socket.send(
          JSON.stringify({
            type: 'state',
            cursor: current.cursor,
            viewport: flow.getViewport(),
            selection: current.selection || null,
            mode: current.mode,
          }),
        )
      },
      Math.max(0, 50 - (performance.now() - lastSent)),
    )
  }
  sendRef.current = send
  const connect = () => {
    if (ended) return
    const url = new URL(`api/boards/${encodeURIComponent(boardId)}/presence`, window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url, PROTOCOL)
    socket.binaryType = 'arraybuffer'
    setStatus('connecting')
    socket.onmessage = (event) => {
      if (ended) return
      try {
        if (event.data instanceof ArrayBuffer) {
          if (!countsOnly) applyAwarenessUpdate(awareness, new Uint8Array(event.data), socket)
          return
        }
        const value = JSON.parse(event.data)
        if (value.type === 'ready') {
          ownId = value.id
          countsOnly = value.countsOnly
          retryMs = 1000
          setStatus('online')
          update()
          send()
        } else if (value.type === 'count' && Number.isInteger(value.count) && value.count >= 0 && value.count <= 50) setCount(value.count)
        else if (value.type === 'agents') {
          // A hosted board: a shared chat thread got a turn or an answer, or an
          // agent came or went. Ids only; whoever shows them refetches.
          window.dispatchEvent(
            new CustomEvent('shapewall:hosted-agents', { detail: typeof value.thread === 'string' ? { thread: value.thread } : {} }),
          )
        } else if (value.type === 'invalidate' && !countsOnly) {
          if (!invalidate)
            invalidate = window.setTimeout(() => {
              invalidate = null
              latest.current.onInvalidate?.()
            }, 100)
        }
      } catch {
        /* Ignore a malformed server frame. */
      }
    }
    socket.onerror = () => {
      /* close handles the offline state */
    }
    socket.onclose = () => {
      if (ended) return
      ownId = null
      setPeers([])
      setCount(0)
      setFollowing(null)
      setStatus('offline')
      removeAwarenessStates(awareness, [...awareness.getStates().keys()], socket)
      retry = window.setTimeout(connect, retryMs)
      retryMs = Math.min(30000, retryMs * 2)
    }
  }
  connect()
  const canvas = canvasRef.current
  const move = (event) => {
    latest.current.cursor = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    send()
  }
  const leave = () => {
    latest.current.cursor = null
    send()
  }
  const interrupt = () => setFollowing(null)
  const visibility = () => {
    if (document.visibilityState !== 'visible') leave()
    else send()
  }
  canvas?.addEventListener('pointermove', move)
  canvas?.addEventListener('pointerleave', leave)
  canvas?.addEventListener('pointerdown', interrupt, true)
  canvas?.addEventListener('wheel', interrupt, true)
  document.addEventListener('visibilitychange', visibility)
  const heartbeat = window.setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}')
  }, 20000)
  return () => {
    ended = true
    sendRef.current = null
    window.clearTimeout(retry)
    window.clearTimeout(timer)
    window.clearTimeout(invalidate)
    window.clearInterval(heartbeat)
    canvas?.removeEventListener('pointermove', move)
    canvas?.removeEventListener('pointerleave', leave)
    canvas?.removeEventListener('pointerdown', interrupt, true)
    canvas?.removeEventListener('wheel', interrupt, true)
    document.removeEventListener('visibilitychange', visibility)
    socket?.close()
    awareness.destroy()
    doc.destroy()
  }
}
