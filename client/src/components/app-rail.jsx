// The app sidebar on a desktop (the board and the console), lg and up only;
// phones keep their own bars and sheets. Expanded, it is the whole menu with
// labels: where you can go (the board, the workspace, your account), then the
// sections of where you are (a workspace's members and settings, the board's
// pages and journeys), and you at the bottom. Collapsed, the same as icons in
// a thin rail. Ctrl/Cmd+B or the panel button toggles it; remembered in this
// browser, the same for the board and the console.
//
// items, sections: [{ id, label, icon, href | to | onSelect, active, count, shortcut, ...data attributes }]
// An item with `href` is a link (a real page change), `to` an in-app route
// rendered with the app's own `link` component (the console's router), one
// with `onSelect` a button. `active` marks where you are.

import { useCallback, useEffect, useRef, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Kbd, Tooltip } from './ui'
import { cn } from '../lib/utils'

const LAST_BOARD_KEY = 'shapewall.lastBoard'
const EXPANDED_KEY = 'shapewall.sidebar'
const WIDTH_KEY = 'shapewall.sidebarWidth'
// Expanded width: drag the right edge between these; double-click resets.
export const SIDEBAR_WIDTH = 256
const WIDTH_MIN = 208
const WIDTH_MAX = 420
const WIDTH_STEP = 16
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
export const SIDEBAR_KEY = isMac ? '⌘B' : 'Ctrl B'

// The board you last had open in this browser, so the console can take you
// back to it. Same origin only: it is a path, never a full URL.
export function rememberLastBoard(path) {
  try {
    if (typeof path === 'string' && path.startsWith('/')) window.localStorage.setItem(LAST_BOARD_KEY, path)
  } catch {
    /* not remembered */
  }
}

export function lastBoard() {
  try {
    const path = window.localStorage.getItem(LAST_BOARD_KEY)
    return path && path.startsWith('/') && !path.startsWith('//') ? path : null
  } catch {
    return null
  }
}

// As last left in this browser; until then, `fallback`.
function savedExpanded(fallback) {
  try {
    const value = window.localStorage.getItem(EXPANDED_KEY)
    return value === 'expanded' ? true : value === 'collapsed' ? false : fallback
  } catch {
    return fallback
  }
}

function clampWidth(width) {
  const max = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.floor(window.innerWidth * 0.4)))
  return Math.min(max, Math.max(WIDTH_MIN, Math.round(width)))
}

function savedWidth() {
  try {
    const value = Number(window.localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value > 0 ? clampWidth(value) : SIDEBAR_WIDTH
  } catch {
    return SIDEBAR_WIDTH
  }
}

function rememberWidth(width) {
  try {
    if (width === SIDEBAR_WIDTH) window.localStorage.removeItem(WIDTH_KEY)
    else window.localStorage.setItem(WIDTH_KEY, String(width))
  } catch {
    /* not remembered */
  }
}

// The expanded sidebar's width: drag the handle on its right edge (or arrow
// keys on the focused handle), double-click for the default. Remembered in
// this browser, the same for the board and the console.
function useSidebarWidth() {
  const [width, setWidth] = useState(savedWidth)
  const [dragging, setDragging] = useState(false)
  const drag = useRef(null)
  useEffect(() => {
    const fit = () => setWidth((current) => clampWidth(current))
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  const commit = (next) => {
    const clamped = clampWidth(next)
    setWidth(clamped)
    rememberWidth(clamped)
  }
  const handle = {
    onPointerDown: (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.clientX, width }
      setDragging(true)
    },
    onPointerMove: (event) => {
      if (drag.current) setWidth(clampWidth(drag.current.width + event.clientX - drag.current.x))
    },
    onPointerUp: (event) => {
      if (!drag.current) return
      commit(drag.current.width + event.clientX - drag.current.x)
      drag.current = null
      setDragging(false)
    },
    onDoubleClick: () => commit(SIDEBAR_WIDTH),
    onKeyDown: (event) => {
      const step = event.shiftKey ? WIDTH_STEP * 4 : WIDTH_STEP
      if (event.key === 'ArrowRight') commit(width + step)
      else if (event.key === 'ArrowLeft') commit(width - step)
      else if (event.key === 'Home') commit(SIDEBAR_WIDTH)
      else return
      event.preventDefault()
    },
  }
  handle.onPointerCancel = handle.onPointerUp
  return { width, dragging, handle }
}

const isEditable = (node) =>
  Boolean(node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.closest?.('[contenteditable="true"]')))

// Expanded or collapsed, remembered once toggled; Ctrl/Cmd+B toggles it (not
// while typing or with a dialog open). `enabled` is false where there is no
// sidebar (phones). Until someone toggles it, the board starts collapsed (the
// canvas comes first) and the console expanded (`initial`).
export function useSidebarExpanded(enabled = true, initial = true) {
  const [expanded, setExpanded] = useState(() => savedExpanded(initial))
  const toggle = useCallback(
    () =>
      setExpanded((value) => {
        try {
          window.localStorage.setItem(EXPANDED_KEY, value ? 'collapsed' : 'expanded')
        } catch {
          /* not remembered */
        }
        return !value
      }),
    [],
  )
  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return
      if (isEditable(event.target) || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, toggle])
  return [expanded, toggle, setExpanded]
}

function itemClass(expanded, on) {
  return cn(
    'relative flex items-center rounded-md outline-none transition-colors focus-visible:outline-2 focus-visible:outline-accent',
    expanded ? 'h-8 w-full gap-2.5 px-2.5 text-left text-[13px] font-medium' : 'h-10 w-10 justify-center rounded-lg',
    on ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
  )
}

function RailItem({ item, expanded, link: LinkComponent }) {
  const { id, label, icon: Icon, href, to, onSelect, active, count, shortcut, ...rest } = item
  const body = (
    <>
      <Icon size={expanded ? 16 : 19} aria-hidden="true" className={cn('shrink-0', active && 'text-accent')} />
      {expanded ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
      {expanded && count ? <span className="shrink-0 text-xs font-normal text-faint tabular">{count}</span> : null}
    </>
  )
  const common = {
    className: itemClass(expanded, active),
    'aria-label': expanded ? undefined : label,
    'aria-current': active ? 'page' : undefined,
    'data-sw-rail-item': id,
    ...rest,
  }
  const control =
    to && LinkComponent ? (
      <LinkComponent to={to} {...common}>
        {body}
      </LinkComponent>
    ) : href ? (
      <a href={href} {...common}>
        {body}
      </a>
    ) : (
      <button type="button" onClick={onSelect} {...common}>
        {body}
      </button>
    )
  const tip = shortcut ? (
    <span className="inline-flex items-center gap-2">
      {label}
      <Kbd>{shortcut}</Kbd>
    </span>
  ) : (
    label
  )
  return (
    <li>
      {expanded ? (
        control
      ) : (
        <Tooltip content={tip} side="right">
          {control}
        </Tooltip>
      )}
    </li>
  )
}

function ItemList({ items, expanded, link, label }) {
  if (!items.length) return null
  return (
    <div className="w-full border-t border-line pt-2">
      {expanded && label ? <p className="px-2.5 pb-1 text-xs font-semibold text-faint">{label}</p> : null}
      <ul className={cn('flex flex-col', expanded ? 'gap-0.5' : 'items-center gap-1')}>
        {items.map((item) => (
          <RailItem key={item.id} item={item} expanded={expanded} link={link} />
        ))}
      </ul>
    </div>
  )
}

// title: the name beside the logo when expanded (the project, the workspace).
// sections / sectionsLabel: the sections of where you are. children: more of
// it when expanded only (the board's page tree), in the scrolling middle.
// profile: a render function, (expanded) => the profile menu.
export function AppRail({
  expanded,
  onToggle,
  home,
  homeTo,
  homeLabel = 'Shapewall',
  title,
  logo,
  items = [],
  sections = [],
  sectionsLabel,
  link,
  profile,
  children,
  className,
}) {
  const HomeTag = homeTo && link ? link : 'a'
  const homeProps = homeTo && link ? { to: homeTo } : { href: home }
  const toggleLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar'
  const { width, dragging, handle } = useSidebarWidth()
  return (
    <div className={cn('relative flex shrink-0', className)}>
      <nav
        aria-label="Shapewall"
        className={cn(
          'flex flex-col gap-2 overflow-hidden border-r border-line bg-surface py-2',
          expanded ? 'px-2' : 'w-[52px] items-center',
        )}
        style={expanded ? { width } : undefined}
        data-sw-app-rail={expanded ? 'expanded' : 'collapsed'}
      >
        <div className={cn('flex shrink-0 items-center gap-1', expanded ? 'h-10' : 'flex-col')}>
          <Tooltip content={expanded ? null : homeLabel} side="right">
            <HomeTag
              {...homeProps}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={homeLabel}
              data-sw-rail-home="true"
            >
              {logo}
            </HomeTag>
          </Tooltip>
          {expanded ? (
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" data-sw-rail-title="true">
              {title || 'Shapewall'}
            </span>
          ) : null}
          <Tooltip
            content={
              <span className="inline-flex items-center gap-2">
                {toggleLabel}
                <Kbd>{SIDEBAR_KEY}</Kbd>
              </span>
            }
            side="right"
          >
            <button
              type="button"
              onClick={onToggle}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={toggleLabel}
              aria-expanded={expanded}
              data-sw-sidebar-toggle="true"
            >
              {expanded ? <PanelLeftClose size={17} aria-hidden="true" /> : <PanelLeftOpen size={17} aria-hidden="true" />}
            </button>
          </Tooltip>
        </div>
        <ItemList items={items} expanded={expanded} link={link} />
        {/* Classic scrollbars: the middle's reserved gutter goes out over the
            nav's right padding, so its rows end where the items above do. */}
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-2',
            expanded ? 'overflow-y-auto in-[.sw-scrollbars]:mr-[calc(-1*var(--scrollbar-size))]' : 'w-full',
          )}
        >
          <ItemList items={sections} expanded={expanded} link={link} label={sectionsLabel} />
          {expanded ? children : null}
        </div>
        {profile ? (
          <div className={cn('w-full shrink-0 border-t border-line pt-2', !expanded && 'flex justify-center')}>{profile(expanded)}</div>
        ) : null}
      </nav>
      {expanded ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={WIDTH_MIN}
          aria-valuemax={WIDTH_MAX}
          tabIndex={0}
          aria-description="Drag or use the arrow keys to resize. Double-click or press Home to reset."
          className="group absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none outline-none"
          data-sw-sidebar-handle="true"
          {...handle}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-focus-visible:opacity-100',
              dragging && 'opacity-100',
            )}
          />
        </div>
      ) : null}
      {dragging ? <div className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" /> : null}
    </div>
  )
}
