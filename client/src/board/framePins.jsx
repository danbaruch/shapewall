// The pin layer of a frame, in one place so every frame that shows a page
// draws its comments the same way: the page's own frame (Frame) and, in
// compare mode, the environment frame beside it (CompareFrame). Same look,
// same sizes at a zoom, same clustering, same selected pin and the same
// arrival ring after "jump to comment".
import { useContext, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import { pinSpot } from './layout'
import { useBoardView } from './boardView'
import { BoardContext } from './boardContext'
import { DOT_CLUSTER_PX, Pin, PinCluster, clusterPins, pinLookAt } from './pins'

const NONE = []

// An agent is working on this comment: its own status, or the chat's
// "agent focus" store (chat/agentFocus.js).
export function isWorking(board, comment) {
  return comment.agentStatus === 'working' || Boolean(board.agentWorking?.has(comment.id))
}

// The comments this frame draws: the ones the filter shows, plus the open
// thread's own, which keeps its pin even when the filter hides it (just
// resolved). `shows` is false on a frame that must stay bare -- compare
// mode's second environment, which carries the diff overlay instead.
export function useFramePins(board, targetId, viewport, shows = true) {
  const openHere = useBoardView((state) => {
    const open = state.selectedComment
    return shows && open && open.pageId === targetId && open.viewport === viewport ? open : null
  })
  const listed = shows ? board.pinsFor(targetId, viewport) : NONE
  const pins = useMemo(() => (openHere && !listed.includes(openHere) ? [...listed, openHere] : listed), [listed, openHere])
  return { pins, openHere, selectedCommentId: openHere?.id ?? null }
}

// How big the pins are drawn at this zoom, and whether they are dots. Pins
// keep roughly the same size on screen at any zoom: 28 px on a readable
// frame, down to 18 px on a small one, and a 10 px dot once the frame is a
// thumbnail. On touch they never shrink below their 44 px hit area.
// `active` is false on a frame with nothing to draw, which then skips the
// zoom subscription so zooming does not re-render it.
export function usePinLook(board, frame, { active = true, drafting = false } = {}) {
  const pinMax = board.touch ? 50 : 6
  const look = useStore((state) => (active ? pinLookAt(state.transform[2], frame.w, board.touch, pinMax, drafting) : 'full:1'))
  return { pinScale: Number(look.slice(look.indexOf(':') + 1)), compactPins: look.startsWith('dot:') }
}

// This frame's pins grouped for the zoom. `positions` are live-page anchors
// resolved on the document, when the frame has one; a screenshot frame
// passes null and every pin sits at its stored spot.
export function useFrameClusters({ pins, positions = null, frame, compact = false, selectedCommentId = null }) {
  // This frame's unread pins as one string, so reading a thread elsewhere
  // changes nothing here.
  const unreadIds = useBoardView((state) =>
    pins.length
      ? pins
          .filter((comment) => state.unread.has(comment.id))
          .map((comment) => comment.id)
          .join(',')
      : '',
  )
  // Clusters are worked out per zoom step, not on every frame of a zoom (and
  // never for fewer than two pins, where the zoom does not matter).
  const clusterZoom = useStore((state) => (pins.length > 1 ? Math.round(state.transform[2] * 20) / 20 : 1))
  return useMemo(() => {
    const unread = new Set(unreadIds ? unreadIds.split(',') : [])
    return clusterPins(
      pins.map((comment) => {
        const position = positions?.get(comment.id) || null
        return { comment, position, spot: pinSpot(comment, position), unread: unread.has(String(comment.id)) }
      }),
      frame,
      clusterZoom,
      selectedCommentId,
      compact ? DOT_CLUSTER_PX : undefined,
    )
  }, [pins, positions, unreadIds, frame, clusterZoom, selectedCommentId, compact])
}

// The pin the board has just flown to, when it is one of this frame's: a
// frame that does not hold it answers null and never re-renders.
export function useLandedPin(pins) {
  return useBoardView((state) => (state.landedId !== null && pins.some((comment) => comment.id === state.landedId) ? state.landedId : null))
}

// The pins themselves, one bubble per comment and a numbered bubble where
// several merge.
export function FramePins({ targetId, viewport, clusters, scale, compact = false, selectedCommentId = null, landedId = null }) {
  const board = useContext(BoardContext)
  return clusters.map((group) =>
    group.items.length === 1 ? (
      <Pin
        key={group.items[0].comment.id}
        comment={group.items[0].comment}
        position={group.items[0].position}
        scale={scale}
        compact={compact}
        selected={selectedCommentId === group.items[0].comment.id}
        unread={group.items[0].unread}
        working={isWorking(board, group.items[0].comment)}
        landed={landedId === group.items[0].comment.id}
        onSelect={board.onSelectComment}
        onHover={board.onHoverComment}
        touch={board.touch}
      />
    ) : (
      <PinCluster
        key={`cluster-${group.items[0].comment.id}`}
        items={group.items}
        compact={compact}
        touch={board.touch}
        working={group.items.some((item) => isWorking(board, item.comment))}
        scale={scale}
        onOpen={(items) => board.onOpenCluster(targetId, viewport, items)}
      />
    ),
  )
}
