// How an agent looks: the built-in avatars, the accent tints, the product
// marks of known agents, and the one tile that draws any of them.
//
// - Built-in avatars: twelve small original drawings (robots, creatures and
//   shapes; no brand, no text), each white on a tinted tile, with its eyes
//   and mouth cut in the tile's colour (`currentColor`). They are drawn on a
//   40 px grid with thick shapes so they still read at 20 px, and the tints
//   are the comment avatars' colours, which hold up in light and dark.
// - Product marks (src/agent/agent-logos.js): the default icon of a known
//   agent. Another company's trademark, so it is drawn exactly as sourced:
//   one colour (the text colour) on a neutral tile, never tinted.
// - An uploaded picture: "upload:<hash>", served by /api/agent/icons/<hash>.
// - None of these: the agent's initials, as before.
//
// The ids are shared with the server (src/agent/identity.js AGENT_ICONS;
// test/agent-identity.test.js checks every id has a drawing).

import { AGENT_ICONS, AGENT_TINTS, uploadHash } from '../../../src/agent/identity.js'
import { agentLogo } from '../../../src/agent/agent-logos.js'
import { PERSON_COLORS } from '../components/ui/avatar'
import { cn } from '../lib/utils'
import { monogram } from './profiles'

// A tint's colour, in the order of the comment avatars' palette. Looked up
// when drawn, not when this file loads: components/ui/avatar.jsx imports
// this file too (an agent's avatar on a comment thread).
export const tintColor = (tint) => PERSON_COLORS[AGENT_TINTS.indexOf(tint)] || null
export const TINT_NAMES = {
  blue: 'Blue',
  violet: 'Violet',
  pink: 'Pink',
  amber: 'Amber',
  green: 'Green',
  cyan: 'Cyan',
  indigo: 'Indigo',
  magenta: 'Magenta',
}

const W = '#fff'
const INK = 'currentColor'
const smile = (y = 26) => <path d={`M16.5 ${y}q3.5 2.8 7 0`} fill="none" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />

// { id: { name, tint, art } }: the name read to a screen reader, the tint it
// wears until the owner picks one, and the drawing.
export const BUILT_IN_ICONS = {
  boxy: {
    name: 'Square robot',
    tint: 'blue',
    art: (
      <>
        <path d="M20 13V8" stroke={W} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="20" cy="7" r="2.6" fill={W} />
        <rect x="5.5" y="18.5" width="4" height="7" rx="2" fill={W} opacity=".75" />
        <rect x="30.5" y="18.5" width="4" height="7" rx="2" fill={W} opacity=".75" />
        <rect x="9" y="12.5" width="22" height="19" rx="5.5" fill={W} />
        <circle cx="15.5" cy="20.5" r="2.3" fill={INK} />
        <circle cx="24.5" cy="20.5" r="2.3" fill={INK} />
        <rect x="15.5" y="25.5" width="9" height="2.2" rx="1.1" fill={INK} />
      </>
    ),
  },
  dot: {
    name: 'Round robot',
    tint: 'green',
    art: (
      <>
        <path d="M13.5 13.5 11 8.5M26.5 13.5 29 8.5" stroke={W} strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="10.6" cy="7.6" r="2.2" fill={W} />
        <circle cx="29.4" cy="7.6" r="2.2" fill={W} />
        <circle cx="20" cy="22" r="11.5" fill={W} />
        <rect x="11.5" y="17" width="17" height="8" rx="4" fill={INK} />
        <circle cx="16.3" cy="21" r="1.7" fill={W} />
        <circle cx="23.7" cy="21" r="1.7" fill={W} />
      </>
    ),
  },
  cyclops: {
    name: 'One-eyed robot',
    tint: 'violet',
    art: (
      <>
        <rect x="8" y="8.5" width="24" height="24" rx="9" fill={W} />
        <circle cx="20" cy="18.5" r="6.2" fill={INK} />
        <circle cx="20" cy="18.5" r="2.6" fill={W} />
        <rect x="16" y="27.3" width="8" height="2" rx="1" fill={INK} />
      </>
    ),
  },
  ghost: {
    name: 'Ghost',
    tint: 'indigo',
    art: (
      <>
        <path d="M9 32V19a11 11 0 0 1 22 0v13l-3.7-3.2-3.6 3.2-3.7-3.2-3.7 3.2-3.6-3.2z" fill={W} />
        <ellipse cx="15.8" cy="18.8" rx="2.2" ry="2.9" fill={INK} />
        <ellipse cx="24.2" cy="18.8" rx="2.2" ry="2.9" fill={INK} />
      </>
    ),
  },
  cat: {
    name: 'Cat',
    tint: 'amber',
    art: (
      <>
        <path d="M8.5 8.5 16 13.2h8l7.5-4.7V23a11.5 9.5 0 0 1-23 0z" fill={W} />
        <circle cx="15.3" cy="21" r="2.2" fill={INK} />
        <circle cx="24.7" cy="21" r="2.2" fill={INK} />
        <path d="M18.3 25.2h3.4L20 27.2z" fill={INK} />
      </>
    ),
  },
  owl: {
    name: 'Owl',
    tint: 'cyan',
    art: (
      <>
        <path d="M9 9.5 15 13h10l6-3.5V22a11 11 0 0 1-22 0z" fill={W} />
        <circle cx="15" cy="19.5" r="4.6" fill={INK} />
        <circle cx="25" cy="19.5" r="4.6" fill={INK} />
        <circle cx="15" cy="19.5" r="1.9" fill={W} />
        <circle cx="25" cy="19.5" r="1.9" fill={W} />
        <path d="M18.2 24.6h3.6L20 28z" fill={INK} />
      </>
    ),
  },
  bear: {
    name: 'Bear',
    tint: 'pink',
    art: (
      <>
        <circle cx="10.8" cy="12" r="4.6" fill={W} />
        <circle cx="29.2" cy="12" r="4.6" fill={W} />
        <circle cx="20" cy="21.5" r="11" fill={W} />
        <circle cx="15.3" cy="19.5" r="2" fill={INK} />
        <circle cx="24.7" cy="19.5" r="2" fill={INK} />
        <ellipse cx="20" cy="25.6" rx="4.4" ry="3.2" fill={INK} opacity=".28" />
        <ellipse cx="20" cy="24.4" rx="1.9" ry="1.4" fill={INK} />
      </>
    ),
  },
  alien: {
    name: 'Alien',
    tint: 'green',
    art: (
      <>
        <path d="M20 7.5c7 0 11.5 4.6 11.5 11 0 7-6 14-11.5 14S8.5 25.5 8.5 18.5c0-6.4 4.5-11 11.5-11z" fill={W} />
        <ellipse cx="14.9" cy="19" rx="2.9" ry="4.3" transform="rotate(-24 14.9 19)" fill={INK} />
        <ellipse cx="25.1" cy="19" rx="2.9" ry="4.3" transform="rotate(24 25.1 19)" fill={INK} />
        <rect x="18" y="27" width="4" height="1.8" rx=".9" fill={INK} />
      </>
    ),
  },
  // Not a four-pointed star: that shape is another product's mark.
  cloud: {
    name: 'Cloud',
    tint: 'magenta',
    art: (
      <>
        <circle cx="13.5" cy="22.5" r="6.5" fill={W} />
        <circle cx="20.5" cy="17" r="8.5" fill={W} />
        <circle cx="27.5" cy="22" r="6.5" fill={W} />
        <rect x="7" y="20.5" width="27" height="9" rx="4.5" fill={W} />
        <circle cx="16.5" cy="20.5" r="1.9" fill={INK} />
        <circle cx="24" cy="20.5" r="1.9" fill={INK} />
        <path d="M17 24.6q3.3 2.6 6.6 0" fill="none" stroke={INK} strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  planet: {
    name: 'Planet',
    tint: 'indigo',
    art: (
      <>
        <ellipse cx="20" cy="21" rx="15.5" ry="4.8" transform="rotate(-18 20 21)" fill="none" stroke={W} strokeWidth="2.4" opacity=".7" />
        <circle cx="20" cy="20" r="9.5" fill={W} />
        <path
          d="M5.6 25.7c3.2 1.4 10-.2 17.4-2.6 5.2-1.7 9.3-3.7 11.4-5.5"
          fill="none"
          stroke={W}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx="16.5" cy="17.3" r="1.8" fill={INK} />
        <circle cx="23.3" cy="16.3" r="1.8" fill={INK} />
      </>
    ),
  },
  hex: {
    name: 'Hexagon',
    tint: 'cyan',
    art: (
      <>
        <path d="M20 5.5 32.6 12.7v14.6L20 34.5 7.4 27.3V12.7z" fill={W} stroke={W} strokeWidth="2" strokeLinejoin="round" />
        <circle cx="15.5" cy="18.5" r="2.2" fill={INK} />
        <circle cx="24.5" cy="18.5" r="2.2" fill={INK} />
        {smile(24)}
      </>
    ),
  },
  drop: {
    name: 'Drop',
    tint: 'blue',
    art: (
      <>
        <path d="M20 5c5.5 7.3 11 11.7 11 18a11 11 0 0 1-22 0c0-6.3 5.5-10.7 11-18z" fill={W} />
        <circle cx="15.8" cy="21.5" r="2.1" fill={INK} />
        <circle cx="24.2" cy="21.5" r="2.1" fill={INK} />
        {smile(26.5)}
      </>
    ),
  },
}

// The built-in ids in the server's order (src/agent/identity.js).
export const ICON_IDS = AGENT_ICONS

// Where an uploaded icon is served from (relative, like every API call).
export const uploadIconUrl = (icon) => {
  const hash = uploadHash(icon)
  return hash ? `api/agent/icons/${hash}` : null
}

const TILE = {
  xs: 'h-4 w-4 rounded-[4px] text-[8px]',
  sm: 'h-5 w-5 rounded-[5px] text-[9px]',
  md: 'h-7 w-7 rounded-md text-[11px]',
  lg: 'h-10 w-10 rounded-lg text-sm',
  xl: 'h-14 w-14 rounded-xl text-lg',
}

// An agent's tile. `icon`: a built-in id, "upload:<hash>" or null. `logo`:
// the product mark it shows while `icon` is null (a known agent), else its
// initials. `tint` colours a built-in avatar or the initials, never a mark.
// `round`: a circle, beside people's avatars on a comment thread.
// `src`: a picture not saved yet (the edit dialog's preview of an upload).
export function AgentFace({ label, icon = null, tint = null, logo = null, size = 'md', round = false, src = null, className, ...props }) {
  const shape = cn(
    'relative inline-flex shrink-0 items-center justify-center overflow-hidden select-none',
    TILE[size],
    round && 'rounded-full',
  )
  const upload = src || uploadIconUrl(icon)
  const builtIn = !upload && icon ? BUILT_IN_ICONS[icon] : null
  const mark = !upload && !builtIn && !icon ? agentLogo(logo) : null
  const kind = upload ? 'upload' : builtIn ? icon : mark ? `logo:${mark.id}` : 'initials'
  const hooks = { 'aria-hidden': 'true', 'data-sw-agent-avatar': kind, ...props }
  if (upload) {
    return (
      <span className={cn(shape, 'bg-surface-2', className)} {...hooks}>
        <img src={upload} alt="" className="h-full w-full object-cover" draggable="false" />
      </span>
    )
  }
  if (builtIn) {
    const color = tintColor(tint) || tintColor(builtIn.tint)
    return (
      <span className={cn(shape, className)} style={{ background: color, color }} {...hooks}>
        <svg viewBox="0 0 40 40" className="h-full w-full" focusable="false">
          {builtIn.art}
        </svg>
      </span>
    )
  }
  if (mark) {
    return (
      <span className={cn(shape, 'border border-line bg-surface-2 text-fg', className)} {...hooks}>
        <svg viewBox={mark.viewBox} className="h-[62%] w-[62%]" fill="currentColor" focusable="false">
          <path d={mark.path} />
        </svg>
      </span>
    )
  }
  const color = tintColor(tint)
  return (
    <span
      className={cn(shape, 'font-semibold', color ? 'text-white' : 'border border-line bg-surface-2 text-fg', className)}
      style={color ? { background: color } : undefined}
      {...hooks}
    >
      {monogram(label)}
    </span>
  )
}

// The icon, tint and mark of an agent as the server describes it (a
// profile, /api/agent/status, a thread's `agent`): AgentFace's props.
export const faceOf = (agent) => ({ icon: agent?.icon || null, tint: agent?.tint || null, logo: agent?.logo || null })
