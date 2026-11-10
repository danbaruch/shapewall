// The app sidebar on a desktop (the board and the console), lg and up only;
// phones keep their own bars and sheets. Expanded, it is the whole menu with
// labels: where you can go (the board, the workspace, your account), then the
// sections of where you are (a workspace's members and settings, the board's
// pages and journeys), and you at the bottom. Collapsed, the same as icons in
// a thin rail; an icon with more behind it (the board's pages, the sections
// of the workspace or account you are in) opens that in a flyout beside the
// rail on hover, or pinned open on a click, tap or key, instead of expanding
// the whole sidebar. Ctrl/Cmd+B or the panel button toggles it; remembered in
// this browser, the same for the board and the console.
//
// items, sections: [{ id, label, icon, href | to | onSelect, active, count, shortcut, flyout, ...data attributes }]
// An item with `href` is a link (a real page change), `to` an in-app route
// rendered with the app's own `link` component (the console's router), one
// with `onSelect` a button. `active` marks where you are. `flyout`, a render
// function ({ close }) => content, is what its icon opens while collapsed
// (the item is then a button there). Collapsed, the sections without a
// flyout of their own go into the active item's flyout.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { Kbd, Tooltip } from './ui'
import { cn } from '../lib/utils'
import { createHoverIntent, flyoutMaxHeight } from './rail-flyout'

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
      // A rail flyout is not a dialog in the way: the shortcut still expands.
      if (isEditable(event.target) || document.querySelector('[role="dialog"]:not([data-sw-rail-flyout])')) return
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

function RailItem({ item, expanded, link: LinkComponent, flyouts }) {
  const { id, label, icon: Icon, href, to, onSelect, active, count, shortcut, flyout, ...rest } = item
  if (!expanded && flyout && flyouts) return <FlyoutItem item={item} flyouts={flyouts} />
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

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const tabbables = (root) => [...root.querySelectorAll(TABBABLE)].filter((node) => node.getClientRects().length > 0)

// Focus whatever Tab reaches after `node` in the page, leaving out `skip` (the
// flyout, which lives at the end of the page).
function focusAfter(node, skip) {
  const all = tabbables(document).filter((candidate) => !skip?.contains(candidate))
  const next = all[all.indexOf(node) + 1]
  ;(next || node).focus()
}

// One collapsed rail icon with a flyout: a button that opens the panel beside
// the rail. Hover opens it (after a short rest, see rail-flyout.js), a click,
// tap, Enter, Space or ArrowRight opens it pinned and moves focus into it.
// Escape, a click outside or a choice in it closes it.
function FlyoutItem({ item, flyouts }) {
  const { id, label, icon: Icon, active, flyout } = item
  const { state, intent, width } = flyouts
  const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key.startsWith('data-')))
  const contentId = useId()
  const icon = useRef(null)
  const panel = useRef(null)
  const open = state.id === id
  const [maxHeight, setMaxHeight] = useState(null)

  useLayoutEffect(() => {
    if (!open) return undefined
    const fit = () => {
      const top = icon.current?.getBoundingClientRect().top ?? 0
      setMaxHeight(flyoutMaxHeight({ anchorTop: top, viewportHeight: window.innerHeight }))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [open])

  // A press anywhere else closes it. In the capture phase: the canvas stops
  // its pointer events before they reach the document.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (panel.current?.contains(event.target) || icon.current?.contains(event.target)) return
      intent.close()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, intent])

  // Opened by a click or a key: focus goes into the panel (the filter box,
  // or its first choice). Never on hover.
  const pinned = open && state.pinned
  useEffect(() => {
    if (!pinned) return
    const frame = requestAnimationFrame(() => {
      const node = panel.current
      if (node && !node.contains(document.activeElement)) (tabbables(node)[0] || node).focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [pinned])

  // A choice in the panel: close it, and if focus was in it, back to the icon.
  const close = useCallback(() => {
    const inside = Boolean(panel.current?.contains(document.activeElement))
    intent.close()
    if (inside) icon.current?.focus({ preventScroll: true })
  }, [intent])

  const hover = (fn) => (event) => {
    if (event.pointerType !== 'touch') fn()
  }
  const onPanelKeyDown = (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return
    const list = tabbables(panel.current)
    if (!list.length) return
    if (event.shiftKey && document.activeElement === list[0]) {
      event.preventDefault()
      icon.current?.focus()
    } else if (!event.shiftKey && document.activeElement === list[list.length - 1]) {
      // Off the end: on to what follows the icon in the rail, closed.
      event.preventDefault()
      intent.close()
      focusAfter(icon.current, panel.current)
    }
  }

  return (
    <li>
      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) intent.close()
        }}
      >
        <PopoverPrimitive.Anchor asChild>
          <button
            ref={icon}
            type="button"
            className={itemClass(false, active || open)}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? contentId : undefined}
            aria-current={active ? 'page' : undefined}
            data-sw-rail-item={id}
            data-sw-rail-flyout-trigger={id}
            data-state={open ? (state.pinned ? 'pinned' : 'open') : 'closed'}
            {...rest}
            onPointerEnter={hover(() => intent.enterIcon(id))}
            onPointerLeave={hover(() => intent.leave())}
            // detail 0: Enter or Space, not a pointer.
            onClick={(event) => intent.toggle(id, event.detail === 0 ? 'key' : 'click')}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight') return
              event.preventDefault()
              if (!pinned) intent.toggle(id, 'key')
            }}
          >
            <Icon size={19} aria-hidden="true" className={cn('shrink-0', active && 'text-accent')} />
          </button>
        </PopoverPrimitive.Anchor>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            ref={panel}
            id={contentId}
            side="right"
            align="start"
            sideOffset={12}
            collisionPadding={8}
            aria-label={label}
            tabIndex={-1}
            className={cn(
              'sw-rail-flyout z-40 flex flex-col overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-2 text-fg shadow-pop outline-none',
              '[&_[data-sw-pages-sidebar]]:border-t-0 [&_[data-sw-pages-sidebar]]:pt-0',
              state.swap && 'sw-rail-flyout-swap',
            )}
            style={{ width, maxHeight: maxHeight ?? undefined }}
            data-sw-rail-flyout={id}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              event.preventDefault()
              const back = state.pinned || panel.current?.contains(document.activeElement)
              intent.close()
              if (back) icon.current?.focus({ preventScroll: true })
            }}
            onInteractOutside={(event) => {
              // Its own icon toggles it; the click there is not "outside".
              if (icon.current?.contains(event.target)) event.preventDefault()
            }}
            onPointerEnter={hover(() => intent.enterPanel())}
            onPointerLeave={hover(() => intent.leave())}
            onKeyDown={onPanelKeyDown}
          >
            {flyout({ close })}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </li>
  )
}

function ItemList({ items, expanded, link, label, flyouts, flush }) {
  if (!items.length) return null
  return (
    <div className={cn('w-full', !flush && 'border-t border-line pt-2')}>
      {expanded && label ? <p className="px-2.5 pb-1 text-xs font-semibold text-faint">{label}</p> : null}
      <ul className={cn('flex flex-col', expanded ? 'gap-0.5' : 'items-center gap-1')}>
        {items.map((item) => (
          <RailItem key={item.id} item={item} expanded={expanded} link={link} flyouts={flyouts} />
        ))}
      </ul>
    </div>
  )
}

// The open flyout, if any, for the whole rail: one at a time.
function useFlyouts(expanded, width) {
  const [state, setState] = useState(() => ({ id: null, pinned: false, via: null, swap: false }))
  const intent = useRef(null)
  if (!intent.current) intent.current = createHoverIntent({ onChange: setState })
  useEffect(() => () => intent.current.dispose(), [])
  // Expanding (the button, Ctrl+B) shows it all in place: close the flyout.
  useEffect(() => {
    if (expanded) intent.current.close()
  }, [expanded])
  return { state, intent: intent.current, width }
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
  const flyouts = useFlyouts(expanded, width)
  // Collapsed, the sections with no flyout of their own (a workspace's or
  // the account's) open from the active item's icon instead of each taking
  // a row of the rail.
  const folded = expanded ? [] : sections.filter((item) => !item.flyout)
  const owner = folded.length ? items.find((item) => item.active) : null
  const railItems = owner
    ? items.map((item) =>
        item === owner
          ? {
              ...item,
              flyout: ({ close }) => (
                <div
                  onClick={(event) => {
                    // After the click has done its navigation.
                    if (event.target.closest?.('[data-sw-rail-item]')) setTimeout(close, 0)
                  }}
                >
                  <ItemList items={folded} expanded link={link} label={sectionsLabel || item.label} flush />
                </div>
              ),
            }
          : item,
      )
    : items
  const railSections = owner ? sections.filter((item) => item.flyout) : sections
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
        <ItemList items={railItems} expanded={expanded} link={link} flyouts={flyouts} />
        {/* Classic scrollbars: the middle's reserved gutter goes out over the
            nav's right padding, so its rows end where the items above do. */}
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-2',
            expanded ? 'overflow-y-auto in-[.sw-scrollbars]:mr-[calc(-1*var(--scrollbar-size))]' : 'w-full',
          )}
        >
          <ItemList items={railSections} expanded={expanded} link={link} label={sectionsLabel} flyouts={flyouts} />
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
