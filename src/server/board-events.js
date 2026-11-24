// "This board changed": a server-sent event stream per board, so an open
// board shows a comment the agent marked done, its reply, or a capture made
// by another process (the CLI, MCP, `shapewall watch`) within about a second,
// instead of on its next poll (20 to 30 s). Every one of those processes
// writes to the board's folder in the output directory: comments.json and
// status.json (an atomic rename into the folder), the captures/ folder (a
// capture swaps it in whole; `capture --only` writes into it). So the folder
// and its captures/ folder are watched (fs.watch, not recursive: versions/
// can hold thousands of folders), and a change is sent as one
// "event: changed" with no data from the board: the page refetches what it
// shows through the usual routes, with the usual access checks.
//
// One watcher per board, shared by every open stream and closed with the
// last one. A folder that cannot be watched (not there yet, out of inotify
// watches) is looked at again on the next change of its parent, and the
// board keeps polling as it always has: the stream only makes it sooner.

import fs from 'node:fs'
import path from 'node:path'

const SETTLE_MS = 150
const PING_MS = 25000

function watchDir(dir, onChange) {
  try {
    const watcher = fs.watch(dir, { persistent: false }, onChange)
    watcher.on('error', () => watcher.close())
    return watcher
  } catch {
    return null
  }
}

// Watches one board's folder; `notify(name)` after changes settle.
function boardWatcher(dir, notify) {
  let timer = null
  let names = new Set()
  let captures = null
  let top = null
  let parent = null
  const fire = () => {
    timer = null
    const changed = [...names]
    names = new Set()
    notify(changed)
  }
  const changed = (name) => {
    if (name) names.add(String(name))
    if (!timer) timer = setTimeout(fire, SETTLE_MS)
  }
  const attach = () => {
    // The board folder appears with its first capture or comment.
    if (!top) top = watchDir(dir, onTop)
    if (top && parent) {
      parent.close()
      parent = null
    }
    if (!top) {
      // Not there yet (nor, before the first capture, the output folder):
      // the nearest folder above it that is, until it appears.
      parent?.close()
      let above = path.dirname(dir)
      while (!fs.existsSync(above) && path.dirname(above) !== above) above = path.dirname(above)
      parent = watchDir(above, () => {
        attach()
        if (top) changed(null)
      })
    }
    // captures/ is replaced whole by a capture: watch the new one.
    captures?.close()
    captures = top ? watchDir(path.join(dir, 'captures'), (event, name) => changed(name && `captures/${name}`)) : null
  }
  function onTop(event, name) {
    if (name === 'captures' || String(name || '').startsWith('captures')) attach()
    changed(name)
  }
  attach()
  return {
    close() {
      clearTimeout(timer)
      top?.close()
      captures?.close()
      parent?.close()
    },
  }
}

// The route: GET /api/boards/:id/events. `dirFor(board)` is the board's folder.
export function boardEvents({ dirFor }) {
  const boards = new Map()
  const streams = new Set()
  const listen = (board, send) => {
    let entry = boards.get(board.id)
    if (!entry) {
      const listeners = new Set()
      entry = { listeners, watcher: boardWatcher(dirFor(board), (names) => listeners.forEach((fn) => fn(names))) }
      boards.set(board.id, entry)
    }
    entry.listeners.add(send)
    return () => {
      entry.listeners.delete(send)
      if (entry.listeners.size) return
      entry.watcher.close()
      boards.delete(board.id)
    }
  }
  const handler = (req, res, board) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // A retry hint, and a first event so the page knows the stream is up.
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n')
    const send = (names) => res.write(`event: changed\ndata: ${JSON.stringify({ files: names.slice(0, 20) })}\n\n`)
    const stop = listen(board, send)
    // Proxies close an idle stream; a comment line keeps it open.
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
    ping.unref?.()
    const end = () => {
      clearInterval(ping)
      stop()
      streams.delete(res)
    }
    streams.add(res)
    req.on('close', end)
    res.on('error', end)
  }
  // Server stop: end every stream, so server.close() is not held open by them.
  const close = () => {
    for (const res of [...streams]) res.end()
    streams.clear()
    for (const entry of boards.values()) entry.watcher.close()
    boards.clear()
  }
  return { handler, close }
}
