import { useViewport } from '@xyflow/react'
import { MousePointer2, Users } from 'lucide-react'
import { memo } from 'react'
import { Avatar, Button, Tooltip } from '../../components/ui'
import { usePresence } from './usePresence'

// Owns the presence connection, so peer updates re-render only this layer,
// not the whole board.
export function PresenceLayer({ touch, ...options }) {
  const presence = usePresence(options)
  return (
    <>
      <PresenceCursors presence={presence} />
      <PresenceBar presence={presence} touch={touch} />
    </>
  )
}

// The bar shows who is here, not where their cursors are: a peer's cursor
// moves many times a second and must not render it again.
const barPeer = (peer) => `${peer.id}|${peer.name}|${peer.color}|${peer.viewport ? 1 : 0}`
function sameBar(before, after) {
  const a = before.presence
  const b = after.presence
  return (
    before.touch === after.touch &&
    a.status === b.status &&
    a.count === b.count &&
    a.following === b.following &&
    a.peers.length === b.peers.length &&
    a.peers.every((peer, index) => barPeer(peer) === barPeer(b.peers[index]))
  )
}

export const PresenceBar = memo(function PresenceBar({ presence, touch }) {
  if (presence.status !== 'online') return null
  const followed = presence.peers.find((peer) => peer.id === presence.following)
  return (
    <div
      className="absolute top-14 right-2 z-30 flex max-w-[calc(100%-1rem)] flex-wrap items-center justify-end gap-1 rounded-xl border border-line bg-surface/95 p-1 shadow-pop"
      aria-label="Who is viewing"
      data-sw-presence="true"
    >
      <span className="inline-flex items-center gap-1 px-1.5 text-xs text-muted" data-sw-presence-count={presence.count}>
        <Users size={13} aria-hidden="true" />
        {presence.count} viewing
      </span>
      {presence.peers.slice(0, 5).map((peer) => (
        <Tooltip key={peer.id} content={`${peer.name}${peer.viewport ? ': follow their view' : ''}`}>
          <Button
            size={touch ? 'icon' : 'icon-sm'}
            variant={presence.following === peer.id ? 'default' : 'ghost'}
            aria-label={`Follow ${peer.name}`}
            aria-pressed={presence.following === peer.id}
            disabled={!peer.viewport}
            data-sw-presence-peer={peer.id}
            onClick={() => presence.follow(presence.following === peer.id ? null : peer.id)}
          >
            <Avatar person name={peer.name} color={peer.color} size="sm" />
          </Button>
        </Tooltip>
      ))}
      {presence.peers.length > 5 ? <span className="px-1 text-xs text-muted">+{presence.peers.length - 5}</span> : null}
      {followed ? (
        <Button size={touch ? 'touch' : 'xs'} variant="secondary" onClick={presence.stopFollowing} data-sw-stop-follow="true">
          Stop following {followed.name}
        </Button>
      ) : null}
    </div>
  )
}, sameBar)

export function PresenceCursors({ presence }) {
  const cursors = presence.peers.filter((peer) => peer.cursor && Number.isFinite(peer.cursor.x) && Number.isFinite(peer.cursor.y))
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-hidden="true" data-sw-presence-cursors="true">
      {cursors.length ? <Cursors peers={cursors} /> : null}
    </div>
  )
}

// Only mounted while a peer cursor is visible, so the viewport subscription
// (one render per pan/zoom frame) costs nothing on a solo board.
function Cursors({ peers }) {
  const { x, y, zoom } = useViewport()
  return peers.map((peer) => (
    <div
      key={peer.id}
      className="absolute top-0 left-0"
      style={{ transform: `translate(${peer.cursor.x * zoom + x}px, ${peer.cursor.y * zoom + y}px)`, color: peer.color }}
      data-sw-presence-cursor={peer.id}
      data-sw-cursor-x={peer.cursor.x}
      data-sw-cursor-y={peer.cursor.y}
    >
      <MousePointer2 size={18} fill="currentColor" stroke="white" strokeWidth={1.5} />
      <span
        className="ml-3 block max-w-36 truncate rounded px-1.5 py-0.5 text-[10px] text-white shadow-sm"
        style={{ background: peer.color }}
      >
        {peer.name}
      </span>
    </div>
  ))
}
