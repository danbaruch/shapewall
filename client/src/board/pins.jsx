// Comment pins on a frame, Figma style: a round avatar bubble in the
// author's colour with one pointed corner on the spot it is about, a count of
// messages, a dot for unread news and a border for the thread's state.
// Hovering shows a preview; pins that would overlap on screen when zoomed out
// merge into one numbered cluster that zooms in when clicked.
import { Bot, Check } from 'lucide-react'
import { AGENT_COLOR, HoverCard, HoverCardContent, HoverCardTrigger, initials, personColor } from '../components/ui'
import { cn, formatRelative } from '../lib/utils'
import { pinSpot } from './layout'
import { MentionText } from './Mentions'
import { AuthorAvatar, AuthorLabel, commentAuthor, isAgentAuthor, repliesLabel } from './commentParts'
import { commentText } from '../../../src/comment-fields.js'

// The pin's pointed corner is on its spot (pinSpot).
const TAIL = {
  'false,false': 'rounded-bl-none',
  'true,false': 'rounded-br-none',
  'false,true': 'rounded-tl-none',
  'true,true': 'rounded-tr-none',
}
// Touch screens get an invisible 44 px hit area around the 28 px pin.
const COARSE_HIT =
  "[@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-2 [@media(pointer:coarse)]:before:content-['']"
// Pins closer than this on screen merge into a cluster (dots: DOT_CLUSTER_PX).
export const CLUSTER_PX = 30
export const DOT_CLUSTER_PX = 12
// A frame narrower than this on screen shows its pins as dots.
export const DOT_FRAME_PX = 150

// How a frame's pins look at a zoom: "dot:<scale>" (10 px dots) or
// "full:<scale>" (avatar bubbles). Scales are bucketed so a zoom re-renders a
// frame only when its pins change size. Full pins are 28 px on screen on a
// readable frame and shrink to 18 px on a small one; on touch they stay
// 28 px (their hit area is 44). The pin being written stays full size.
export function pinLookAt(zoom, frameWidth, touch, max, drafting = false) {
  const bucket = (value) => Math.round(value * 8) / 8
  const onScreen = frameWidth * zoom
  if (onScreen < DOT_FRAME_PX && !drafting) return `dot:${bucket(Math.min(60, 1 / zoom))}`
  const px = touch ? 28 : Math.max(18, Math.min(28, onScreen / 14))
  return `full:${bucket(Math.min(max, Math.max(0.3, px / 28 / zoom))) || 0.125}`
}

export function pinState(comment) {
  return comment.status === 'resolved' ? 'resolved' : comment.agentStatus || (comment.reopenCount ? 'reopened' : 'open')
}

const BORDER = {
  resolved: 'border-ok',
  'needs-human': 'border-warn',
  'branch-ready': 'border-accent',
  reopened: 'border-bad',
}

function place(spot, scale, grow = 1) {
  return {
    left: `${spot.x}%`,
    top: `${spot.y}%`,
    transform: `translate(${spot.flipX ? '-100%' : '0'}, ${spot.flipY ? '0' : '-100%'}) scale(${scale * grow})`,
    transformOrigin: `${spot.flipY ? 'top' : 'bottom'} ${spot.flipX ? 'right' : 'left'}`,
  }
}

// The first line of a comment, for previews and labels.
const firstLine = (text) => String(text || '').split('\n')[0]

function PinPreview({ comment, moved }) {
  const author = commentAuthor(comment)
  const replies = comment.replies?.length || 0
  return (
    <div data-sw-pin-preview={comment.id}>
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <AuthorAvatar {...author} size="sm" />
        <AuthorLabel {...author} />
        <span className="ml-auto shrink-0 text-xs text-faint">{formatRelative(comment.createdAt)}</span>
      </div>
      <MentionText
        text={firstLine(commentText(comment))}
        plain={Boolean(comment.authorGuest)}
        className="mt-1.5 line-clamp-2 block text-ui break-words text-fg"
      />
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
        <span>{replies ? repliesLabel(replies) : 'No replies yet'}</span>
        {comment.status === 'resolved' ? <span className="text-fg">Resolved</span> : null}
        {moved ? <span className="text-fg">Its element is not on the page anymore</span> : null}
      </p>
    </div>
  )
}

// An agent is working on the thread: a soft accent ring that pulses (still
// without motion). `working` comes from the comment's agentStatus or the
// chat's agent-focus signal (Board.jsx).
function WorkingRing({ dot = false }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute rounded-full ring-2 ring-accent motion-safe:animate-breathe',
        dot ? '-inset-1' : '-inset-1.5',
      )}
      aria-hidden="true"
      data-sw-pin-working="true"
    />
  )
}

// A pin on a thumbnail: a 10 px dot in the author's colour.
function PinDot({ comment, spot, scale, selected, unread, working, onSelect, onHover, touch, label, landed = false }) {
  const author = commentAuthor(comment)
  const agent = isAgentAuthor(author)
  return (
    <button
      type="button"
      tabIndex={-1}
      className={cn(
        'nodrag nopan absolute z-10 h-2.5 w-2.5 rounded-full border border-white shadow-card',
        touch && 'pointer-events-none',
        comment.status === 'resolved' && !selected && 'opacity-60',
        selected ? 'z-20 ring-2 ring-accent' : unread ? 'ring-2 ring-accent/70' : null,
        'data-[sw-pin-hover=true]:z-20 data-[sw-pin-hover=true]:ring-2 data-[sw-pin-hover=true]:ring-accent/60',
      )}
      style={{
        left: `${spot.x}%`,
        top: `${spot.y}%`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        background: agent ? AGENT_COLOR : personColor(author.name),
      }}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(comment)
      }}
      onMouseEnter={onHover ? () => onHover(comment.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      aria-label={label}
      aria-pressed={selected}
      data-sw-pin={comment.id}
      data-sw-pin-landed={landed ? 'true' : undefined}
      data-sw-pin-look="dot"
      data-sw-pin-state={pinState(comment)}
      data-sw-pin-unread={unread ? 'true' : undefined}
    >
      {working ? <WorkingRing dot /> : null}
    </button>
  )
}

// `landed`: the board has just flown to this pin ("jump to comment"), so it
// rings for a moment. The frame reads it from the view store (Frame.jsx).
export function Pin({
  comment,
  position,
  scale,
  compact = false,
  selected,
  unread,
  working = false,
  landed = false,
  onSelect,
  onHover,
  touch,
}) {
  const spot = pinSpot(comment, position)
  // In live mode an anchored comment whose element is gone sits at its stored
  // spot with a dashed ring: "this moved".
  const moved = Boolean(position?.moved)
  const author = commentAuthor(comment)
  const agent = isAgentAuthor(author)
  const state = pinState(comment)
  const messages = 1 + (comment.replies?.length || 0)
  const resolved = comment.status === 'resolved'
  // Badges sit on the corners away from the pointed one.
  const badgeSide = spot.flipX ? '-left-1.5' : '-right-1.5'
  const badgeEdge = spot.flipY ? '-bottom-1.5' : '-top-1.5'
  const dotSide = spot.flipX ? '-right-0.5' : '-left-0.5'
  const label = `Comment ${comment.id} by ${author.name}${messages > 1 ? `, ${repliesLabel(messages - 1)}` : ''}${resolved ? ', resolved' : ''}${unread ? ', unread' : ''}${moved ? ' (its element moved)' : ''}${working ? ', an agent is working on it' : ''}: ${commentText(comment).slice(0, 60)}`
  const pin = compact ? (
    <PinDot
      comment={comment}
      spot={spot}
      scale={scale}
      selected={selected}
      unread={unread}
      working={working}
      onSelect={onSelect}
      onHover={onHover}
      touch={touch}
      label={label}
      landed={landed}
    />
  ) : (
    <button
      type="button"
      tabIndex={-1}
      className={cn(
        'nodrag nopan absolute z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[11px] leading-none font-semibold text-white shadow-pop transition-[box-shadow,opacity] select-none',
        TAIL[`${spot.flipX},${spot.flipY}`],
        BORDER[state],
        COARSE_HIT,
        moved && 'outline-2 outline-offset-2 outline-warn outline-dashed',
        resolved && !selected && 'opacity-75',
        selected
          ? 'z-20 ring-[3px] ring-accent'
          : 'data-[sw-pin-hover=true]:z-20 data-[sw-pin-hover=true]:ring-[3px] data-[sw-pin-hover=true]:ring-accent/60',
      )}
      style={{ ...place(spot, scale, selected ? 1.15 : 1), background: agent ? AGENT_COLOR : personColor(author.name) }}
      onClick={(event) => {
        event.stopPropagation()
        onSelect(comment)
      }}
      onMouseEnter={onHover ? () => onHover(comment.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      aria-label={label}
      aria-pressed={selected}
      data-sw-pin={comment.id}
      data-sw-pin-landed={landed ? 'true' : undefined}
      data-sw-pin-state={state}
      data-sw-pin-anchor={comment.anchor ? (position ? (moved ? 'moved' : 'element') : 'xy') : 'none'}
      data-sw-pin-unread={unread ? 'true' : undefined}
      data-sw-pin-count={messages}
      data-sw-pin-look="full"
    >
      {working ? <WorkingRing /> : null}
      {agent ? <Bot size={14} aria-hidden="true" /> : <span aria-hidden="true">{initials(author.name)}</span>}
      {resolved ? (
        <span
          className={cn(
            'absolute flex h-4 w-4 items-center justify-center rounded-full border border-white bg-ok text-ok-fg',
            badgeSide,
            badgeEdge,
          )}
          aria-hidden="true"
        >
          <Check size={10} strokeWidth={3} />
        </span>
      ) : messages > 1 ? (
        <span
          className={cn(
            'absolute flex h-4 min-w-4 items-center justify-center rounded-full border border-white bg-fg px-1 text-[9px] font-bold text-surface tabular',
            badgeSide,
            badgeEdge,
          )}
          aria-hidden="true"
        >
          {messages}
        </span>
      ) : null}
      {unread ? (
        <span
          className={cn(
            'absolute h-2.5 w-2.5 rounded-full border-2 border-white bg-accent',
            dotSide,
            spot.flipY ? '-bottom-0.5' : '-top-0.5',
          )}
          aria-hidden="true"
          data-sw-pin-dot="true"
        />
      ) : null}
    </button>
  )
  // The preview is for the mouse; on touch a tap opens the thread itself.
  if (touch || selected) return pin
  return (
    <HoverCard>
      <HoverCardTrigger asChild>{pin}</HoverCardTrigger>
      <HoverCardContent side={spot.flipX ? 'left' : 'right'} align="start" data-sw-pin-preview={comment.id}>
        <PinPreview comment={comment} moved={moved} />
      </HoverCardContent>
    </HoverCard>
  )
}

// Several pins too close to tell apart at this zoom: one bubble with the
// count. Clicking zooms in on them.
export function PinCluster({ items, scale, compact = false, touch = false, working = false, onOpen }) {
  const spot = items[0].spot
  const unread = items.some((item) => item.unread)
  if (compact) {
    return (
      <button
        type="button"
        tabIndex={-1}
        className={cn(
          'tabular nodrag nopan absolute z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-white bg-fg px-0.5 text-[8px] leading-none font-bold text-surface shadow-card',
          touch && 'pointer-events-none',
          unread && 'ring-2 ring-accent/70',
        )}
        style={{ left: `${spot.x}%`, top: `${spot.y}%`, transform: `translate(-50%, -50%) scale(${scale})` }}
        onClick={(event) => {
          event.stopPropagation()
          onOpen(items)
        }}
        aria-label={`${items.length} comments here${unread ? ', some unread' : ''}: zoom in`}
        data-sw-pin-cluster={items.map((item) => item.comment.id).join(',')}
        data-sw-pin-look="dot"
      >
        {items.length}
        {working ? <WorkingRing dot /> : null}
      </button>
    )
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      className={cn(
        'nodrag nopan absolute z-10 flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-white bg-fg px-1.5 text-xs font-bold text-surface shadow-pop tabular',
        TAIL[`${spot.flipX},${spot.flipY}`],
        COARSE_HIT,
      )}
      style={place(spot, scale)}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(items)
      }}
      aria-label={`${items.length} comments here${unread ? ', some unread' : ''}: zoom in`}
      data-sw-pin-cluster={items.map((item) => item.comment.id).join(',')}
    >
      {items.length}
      {working ? <WorkingRing /> : null}
      {unread ? (
        <span className="absolute -top-0.5 -left-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-accent" aria-hidden="true" />
      ) : null}
    </button>
  )
}

// Groups pins whose spots are under CLUSTER_PX apart on screen. `keep` (the
// open thread) always stands alone.
export function clusterPins(items, frame, zoom, keep = null, distance = CLUSTER_PX) {
  const groups = []
  for (const item of items) {
    const px = (item.spot.x / 100) * frame.w * zoom
    const py = (item.spot.y / 100) * frame.h * zoom
    if (item.comment.id === keep) {
      groups.push({ items: [item], px, py, alone: true })
      continue
    }
    const near = groups.find((group) => !group.alone && Math.hypot(group.px - px, group.py - py) < distance)
    if (near) near.items.push(item)
    else groups.push({ items: [item], px, py, alone: false })
  }
  return groups
}

// Where a new comment will go, while it is being written: your own bubble.
export function DraftPin({ draft, scale, name, colorKey }) {
  const spot = pinSpot(draft)
  return (
    <span
      className={cn(
        'pointer-events-none absolute z-20 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white shadow-pop ring-[3px] ring-accent',
        TAIL[`${spot.flipX},${spot.flipY}`],
      )}
      style={{ ...place(spot, scale), background: personColor(colorKey || name || 'you') }}
      aria-hidden="true"
      data-sw-draft-pin="true"
    >
      {initials(name || 'You')}
    </span>
  )
}
