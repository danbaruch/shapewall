import { Bot } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { useAgentIdentity } from '../../lib/agentIdentity'
import { AgentFace } from '../../chat/agentIcons'

export function initials(name) {
  const parts = String(name || '?')
    .replace(/\(guest\)/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase()
}

// Person colours for comment avatars and pins: white text on each keeps AA
// contrast (4.5:1, test/theme.test.js) in every theme, light and dark.
export const PERSON_COLORS = ['#1d4ed8', '#6d28d9', '#be185d', '#b45309', '#047857', '#0e7490', '#4338ca', '#a21caf']
export const AGENT_COLOR = '#3f3f46'

// The same person always gets the same colour, for every viewer: callers key
// it on the display name (guests never see handles).
export function personColor(key) {
  const text = String(key || '').toLowerCase()
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  return PERSON_COLORS[hash % PERSON_COLORS.length]
}

const SIZES = { xs: 'h-5 w-5 text-[9px]', sm: 'h-6 w-6 text-[10px]', md: 'h-7 w-7 text-[11px]', lg: 'h-9 w-9 text-xs' }

// Initials in a circle (decorative: the name is always next to it or in the
// control's label). With `person` the circle takes that person's colour
// (comments); `agent` shows a robot instead of initials. `color` sets the
// circle's colour outright (presence: the colour of that person's cursor).
export function Avatar({ name, src = null, className, person = false, agent = false, colorKey, color = null, size = 'lg' }) {
  if (src && !agent)
    return <AvatarPhoto key={src} src={src} name={name} className={className} person={person} colorKey={colorKey} size={size} />
  if (agent) return <AgentAvatar name={name} className={className} size={size} />
  if (person) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none',
          SIZES[size],
          className,
        )}
        style={{ background: color || personColor(colorKey || name) }}
        aria-hidden="true"
      >
        {initials(name)}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent select-none',
        className,
      )}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

// An agent as an author: the icon its owner gave it when the name is a
// connected agent's (lib/agentIdentity.js), else the robot.
function AgentAvatar({ name, className, size }) {
  const identity = useAgentIdentity(name)
  if (identity) return <AgentFace label={name} {...identity} round className={cn(SIZES[size], className)} />
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none',
        SIZES[size],
        className,
      )}
      style={{ background: AGENT_COLOR }}
      aria-hidden="true"
    >
      <Bot size={size === 'xs' ? 11 : 13} />
    </span>
  )
}

function AvatarPhoto({ src, name, className, person, colorKey, size }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Avatar name={name} className={className} person={person} colorKey={colorKey} size={size} />
  return (
    <span
      className={cn('inline-flex shrink-0 overflow-hidden rounded-full bg-surface-2', person ? SIZES[size] : 'h-9 w-9', className)}
      aria-hidden="true"
    >
      <img src={src} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} data-sw-avatar-image />
    </span>
  )
}
