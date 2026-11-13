// The Usage overview as a dashboard: a grid of widgets (widgets.jsx) that a
// person can arrange. The layout itself, and every rule about it, is in
// src/hosted/usage-layout.js; saving is in layout-state.js. This file is
// the grid, "Edit layout", the panel widgets are added back from, and the
// little set of tools a widget wears while it is edited.
//
// The widgets flow into the grid in order (usage-layout.js), so the grid
// never has a hole another widget fits. Outside "Edit layout" nothing
// moves. While editing, a widget is dragged by any part of its card: the
// others make room around a tinted place where it will land, and close up
// behind it. On 12 columns it is resized from its right edge, its bottom
// edge or its corner. The keyboard does the same: the arrow keys move a
// widget past its neighbour, Shift and the arrow keys resize it, and every
// change is spoken by a live region. On fewer columns (a narrow window, a
// phone) the same layout is shown reflowed: there a drag (6 columns) or the
// up and down buttons put widgets in another order.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactGridLayout from 'react-grid-layout'
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  CircleAlert,
  CircleDollarSign,
  Coins,
  Copy,
  Gauge,
  GripVertical,
  Hourglass,
  LayoutDashboard,
  ListOrdered,
  MessagesSquare,
  PieChart,
  Plus,
  RotateCcw,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Undo2,
  Wrench,
  X,
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from '../../components/ui'
import { cn } from '../../lib/utils'
import { USAGE_BUCKETS, USAGE_DIMENSIONS, USAGE_METRICS } from '../../../../src/hosted/usage-shape.js'
import {
  LAYOUT_COLS,
  LAYOUT_GAP,
  LAYOUT_SUB,
  LAYOUT_SUB_PITCH,
  LAYOUT_SUB_ROW,
  WIDGETS,
  addItem,
  colsFor,
  describeItem,
  dropBefore,
  duplicateItem,
  fitLayout,
  hiddenTypes,
  placeBefore,
  readingOrder,
  fill,
  fitsContent,
  flow,
  reflow,
  removeItem,
  reorder,
  resizeItem,
  roomFor,
  setOptions,
  settle,
  stepMove,
  subRowsFor,
  visibleItems,
} from '../../../../src/hosted/usage-layout.js'
import { Card, ConfirmDialog, LoadError } from '../components'
import { useWorkspace } from '../pages/workspace'
import { useWs } from './data'
import { defaultBucket } from './format'
import { Widget, WidgetOptions, optionRows } from './widgets'

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
const STEP = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }
const GROUP_LABEL = { tile: 'Tiles', chart: 'Charts', list: 'Top lists', budgets: 'Budgets' }
// What the panel of widgets to add says about each, and its icon.
const ABOUT = {
  tile_calls: [MessagesSquare, 'How many agent turns, with a trend line'],
  tile_tokens: [Coins, 'Tokens the agents reported, in and out'],
  tile_duration: [Timer, 'Time the agents spent, with the median turn'],
  tile_cost: [CircleDollarSign, 'What the agents reported it cost'],
  tile_fixes: [Wrench, 'Fixes asked for, and how many were made'],
  tile_failed: [TriangleAlert, 'Share of turns that failed or were stopped'],
  time: [BarChart3, 'Turns, tokens or cost over time, split as you like'],
  breakdown: [PieChart, 'The biggest projects, agents, people or models'],
  outcomes: [Activity, 'How turns ended, over time'],
  approvals: [ShieldCheck, 'Approvals asked for, given and denied'],
  latency: [Hourglass, 'How long turns took: median and slowest'],
  top_agents: [ListOrdered, 'The agents that took the most turns'],
  top_threads: [ListOrdered, 'The threads that used the most tokens'],
  top_slowest: [ListOrdered, 'The turns that took longest'],
  top_denied: [ListOrdered, 'Who had the most approvals denied'],
  budgets: [Gauge, 'Each project’s daily budgets and today’s use'],
}
// Which edges a widget is resized by: a tile has one height.
const HANDLES = { tile: ['e'], chart: ['s', 'e', 'se'], list: ['s', 'e', 'se'], budgets: ['s', 'e', 'se'] }
// Where a widget that comes back goes: after the last of its kind (a tile among the tiles), else last.
function addBefore(layout, type) {
  const order = readingOrder(layout.items)
  const group = WIDGETS[type].group
  const last = order.findLastIndex((item) => WIDGETS[item.type].group === group)
  return last < 0 ? null : (order[last + 1]?.id ?? null)
}

// The width of an element, kept up to date. A change is taken up on the
// next frame (never inside the observer's own callback), so a grid that
// re-lays itself out for the new width cannot loop with the observer.
// The element may come and go (the page shows one plain empty state when there is nothing to chart): the width follows
// whichever element holds the ref now.
function useWidth() {
  const ref = useRef(null)
  const [node, setNode] = useState(null)
  const hold = useCallback((element) => {
    ref.current = element
    setNode(element)
  }, [])
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!node) return undefined
    setWidth(Math.floor(node.getBoundingClientRect().width))
    let frame = 0
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[entries.length - 1].contentRect.width)
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => setWidth((current) => (current === next ? current : next)))
    })
    observer.observe(node)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [node])
  return [hold, node ? width : 0, ref]
}

// The corner and the two edges a widget is resized by: quiet until the widget is pointed at.
const resizeHandle = (axis, ref) => (
  <span
    ref={ref}
    className={`react-resizable-handle react-resizable-handle-${axis} sw-resize sw-resize-${axis}`}
    {...(axis === 'se' ? { 'data-sw-widget-resize': '' } : { 'data-sw-widget-resize-edge': axis })}
    aria-hidden="true"
  />
)

// The button in the page's header that starts "Edit layout" (the bar it opens has the one way out: Done).
export function EditLayoutButton({ editing, onEditing, disabled = false, why = null }) {
  if (editing) return null
  return (
    <Button
      size="touch"
      variant="secondary"
      className="lg:h-9"
      onClick={() => onEditing(true)}
      disabled={disabled}
      title={disabled ? why : undefined}
      data-sw-layout-edit="off"
    >
      <LayoutDashboard size={15} aria-hidden="true" />
      Edit layout
    </Button>
  )
}

// The widgets that are not on the dashboard, to add back with a press.
function AddPanel({ hidden, onAdd, onAdded }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen} history={false}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary" data-sw-layout-add>
          <Plus size={14} aria-hidden="true" /> Add widget
          {hidden.length ? (
            <span
              className="tabular -mr-1 ml-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] leading-none font-semibold text-accent-fg"
              data-sw-layout-add-count={hidden.length}
            >
              {hidden.length}
              <span className="sr-only"> not on the dashboard</span>
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
        onCloseAutoFocus={(event) => {
          if (onAdded()) event.preventDefault()
        }}
        data-sw-layout-add-menu
      >
        <div className="border-b border-line px-3.5 py-2.5">
          <p className="text-sm font-semibold text-fg">Add a widget</p>
          <p className="text-xs text-muted">
            {hidden.length ? 'Not on your dashboard. Pick one to put it back.' : 'Hidden widgets wait here.'}
          </p>
        </div>
        {hidden.length ? (
          <div className="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5">
            {Object.keys(GROUP_LABEL)
              .filter((group) => hidden.some((type) => WIDGETS[type].group === group))
              .map((group) => (
                <div key={group} className="pb-1">
                  <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{GROUP_LABEL[group]}</p>
                  <ul>
                    {hidden
                      .filter((type) => WIDGETS[type].group === group)
                      .map((type) => {
                        const [Icon, about] = ABOUT[type]
                        return (
                          <li key={type}>
                            <button
                              type="button"
                              onClick={() => {
                                onAdd(type)
                                setOpen(false)
                              }}
                              className="group/add flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                              data-sw-layout-add-item={type}
                            >
                              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted group-hover/add:border-accent/40 group-hover/add:text-accent">
                                <Icon size={17} aria-hidden="true" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-fg">{WIDGETS[type].title}</span>
                                <span className="line-clamp-2 block text-xs text-muted">{about}</span>
                              </span>
                              <Plus size={16} className="shrink-0 text-faint group-hover/add:text-accent" aria-hidden="true" />
                            </button>
                          </li>
                        )
                      })}
                  </ul>
                </div>
              ))}
          </div>
        ) : (
          <div className="flex flex-col items-center px-6 py-7 text-center" data-sw-layout-add-none>
            <span className="mb-2.5 inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-accent">
              <Check size={18} aria-hidden="true" />
            </span>
            <p className="text-sm font-medium text-fg">Every widget is on the dashboard</p>
            <p className="mt-1 text-xs text-muted">Hide one with its × and it waits here to come back. Charts can also be duplicated.</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function Dashboard({ filter, isAdmin, board, editing, onEditing }) {
  const { workspaceId } = useWorkspace()
  const { get, set, period } = filter
  const query = filter.query
  const [holdGrid, width, gridRef] = useWidth()
  const cols = width ? colsFor(width) : LAYOUT_COLS
  const wide = cols === LAYOUT_COLS
  const [live, setLive] = useState({ text: '', n: 0 })
  const [notice, setNotice] = useState(null) // what the bar at the bottom says about the last change
  const [focusId, setFocusId] = useState(null)
  // A widget added from the menu takes the focus once the menu has closed (the menu would otherwise hand it to its button).
  const added = useRef(null)
  const { change } = board
  // A list, a breakdown and the budgets are as tall as what they hold until someone sizes them by hand.
  const budgets = useWs(workspaceId, '/usage/budgets', { enabled: isAdmin, keep: false })
  const projects = budgets.data ? budgets.data.projects.length : null
  const layout = useMemo(() => fitLayout(board.layout, { budgets: projects }), [board.layout, projects])

  const summary = useWs(workspaceId, `/usage/summary?${query}`)
  const now = summary.data?.current

  // ---- What is drawn ----

  const items = useMemo(() => visibleItems(layout, { admin: isAdmin }), [layout, isAdmin])
  // As drawn: the layout on this many columns, short rows filled. A phone being edited shows one column, a list to reorder.
  const drawnOf = useCallback(
    (list) =>
      editing && cols <= 2
        ? flow(
            readingOrder(list).map((item) => ({ ...item, w: cols })),
            cols,
          )
        : fill(reflow(list, cols), cols),
    [editing, cols],
  )
  const shown = useMemo(() => drawnOf(items), [items, drawnOf])
  const ordered = useMemo(() => readingOrder(shown), [shown])
  // The fine rows each widget that is as tall as its content needs, measured on the page (usage-layout.js, settle).
  // (Kept in this browser between visits, so a reload draws them at once instead of shrinking them once the data is in.)
  const fitKey = `sw-usage-fit:${workspaceId}`
  const [fitted, setFitted] = useState(() => {
    try {
      const kept = JSON.parse(window.localStorage.getItem(fitKey) || '{}')
      return kept && typeof kept === 'object' && !Array.isArray(kept)
        ? Object.fromEntries(Object.entries(kept).filter(([, rows]) => Number.isInteger(rows) && rows > 0 && rows < 200))
        : {}
    } catch {
      return {}
    }
  })
  const fittedRef = useRef(fitted)
  fittedRef.current = fitted
  // What the grid draws: every widget at its own height, in fine rows.
  const drawn = useMemo(() => settle(shown, cols, fitted), [shown, cols, fitted])
  const titleOf = useCallback(
    (item) => {
      const copies = ordered.filter((other) => other.type === item.type)
      const base = WIDGETS[item.type].title
      return copies.length > 1 ? `${base} ${copies.indexOf(copies.find((other) => other.id === item.id)) + 1}` : base
    },
    [ordered],
  )

  // The first chart over time sets what the page's other charts follow: its
  // bucket (outcomes, approvals, duration, trend lines) and its measure (a
  // breakdown set to "same as the chart"). Links from before the dashboard
  // could be arranged name those switches in the address: they still apply
  // to that first chart (and the first breakdown) until its own switch is used.
  const firstTime = ordered.find((item) => item.type === 'time')
  const firstBreakdown = ordered.find((item) => item.type === 'breakdown')
  const autoBucket = defaultBucket(period)
  const optionsOf = useCallback(
    (item) => {
      if (item.id === firstTime?.id)
        return {
          ...item.options,
          metric: pick(get('metric'), USAGE_METRICS, item.options.metric),
          by: pick(get('by'), [...USAGE_DIMENSIONS, 'none'], item.options.by),
          bucket: pick(get('bucket'), USAGE_BUCKETS, item.options.bucket),
        }
      if (item.id === firstBreakdown?.id) return { ...item.options, by: pick(get('bd'), USAGE_DIMENSIONS, item.options.by) }
      return item.options
    },
    [firstTime, firstBreakdown, get],
  )
  const lead = firstTime ? optionsOf(firstTime) : null
  const bucket = lead && lead.bucket !== 'auto' ? lead.bucket : autoBucket
  const metric = lead ? lead.metric : 'calls'

  // A press on a mark or a legend entry narrows the whole page to it (again: undoes it).
  const toggle = useCallback(
    (dimension) => (key) => {
      const value = key === '' ? '~' : key
      // From the address as it is when the press lands, not as it was drawn.
      set({ [dimension]: (current) => (current.length === 1 && current[0] === value ? [] : [value]) }, { push: true })
    },
    [set],
  )
  const ctx = useMemo(
    () => ({ workspaceId, filter, query, isAdmin, period, bucket, autoBucket, metric, toggle }),
    [workspaceId, filter, query, isAdmin, period, bucket, autoBucket, metric, toggle],
  )

  // ---- Changes ----

  // The same words twice in a row are still said twice (the count keys the node).
  const say = useCallback((text) => setLive((current) => ({ text, n: current.n + 1 })), [])
  const placeOf = (next, id) => {
    const item = drawnOf(visibleItems(next, { admin: isAdmin })).find((other) => other.id === id)
    return item ? describeItem(item) : ''
  }
  // Applies a change to the layout and says what came of it.
  const apply = (id, make, { verb, key = null, unchanged = null }) => {
    const item = layout.items.find((other) => other.id === id)
    if (!item) return
    const next = make(layout)
    const title = titleOf(item)
    if (next === layout || JSON.stringify(next.items) === JSON.stringify(layout.items)) {
      if (unchanged) say(`${title} ${unchanged}`)
      return
    }
    change(next, { key })
    // (No note for a move or a resize: the bar says "Saved", and its Undo takes it back.)
    say(`${title} ${verb} ${placeOf(next, id)}`)
  }
  const saveOptions = (item, changes) => {
    // The switch now holds what the address used to say for it.
    const legacy = { metric: 'metric', by: item.type === 'breakdown' ? 'bd' : 'by', bucket: 'bucket' }
    const stale = Object.keys(changes)
      .map((key) => legacy[key])
      .filter((key) => key && get(key))
    change((current) => setOptions(current, item.id, { ...optionsOf(item), ...changes }), { key: `options:${item.id}` })
    if (stale.length && (item.id === firstTime?.id || item.id === firstBreakdown?.id))
      set(Object.fromEntries(stale.map((key) => [key, null])))
    // (A layout on show from a shared view is only tried, never saved.)
    if (!board.preview) setNotice({ text: 'Saved for this widget', undo: true })
  }
  const hide = (item) => {
    const title = titleOf(item)
    change((current) => removeItem(current, item.id))
    setNotice({ text: `${title} is hidden`, undo: true })
    say(`${title} hidden. Add widget brings it back.`)
  }
  const add = (type) => {
    const { layout: next, id } = addItem(layout, type, {}, { before: addBefore(layout, type) })
    if (!id) return
    change(next)
    added.current = id
    setNotice({ text: `${WIDGETS[type].title} added`, undo: true })
    say(`${WIDGETS[type].title} added at ${placeOf(next, id)}`)
  }
  const duplicate = (item) => {
    const { layout: next, id } = duplicateItem(layout, item.id)
    if (!id) return
    // The copy starts with what the first one shows now, switches from the address included.
    change(setOptions(next, id, optionsOf(item)))
    setFocusId(id)
    setNotice({ text: `${WIDGETS[item.type].title} duplicated`, undo: true })
    say(`${WIDGETS[item.type].title} duplicated. The copy is at ${placeOf(next, id)}`)
  }
  const moveInOrder = (item, step) => {
    const at = ordered.findIndex((other) => other.id === item.id)
    apply(item.id, (current) => reorder(current, item.id, at + step), {
      verb: 'moved to',
      key: `move:${item.id}`,
      unchanged: step < 0 ? 'is already first' : 'is already last',
    })
  }
  // One step of Shift and an arrow: on to the next size the widget is drawn at. (A row
  // that cannot take what a narrower widget leaves is drawn full, so a step there shows nothing.)
  const sizeStep = (current, item, direction) => {
    const [dw, dh] = STEP[direction]
    const stored = current.items.find((other) => other.id === item.id)
    let last = current
    for (let n = 1; n <= LAYOUT_COLS; n += 1) {
      const next = resizeItem(current, item.id, stored.w + dw * n, stored.h + dh * n)
      const mine = next.items.find((other) => other.id === item.id)
      const was = last.items.find((other) => other.id === item.id)
      if (mine.w === was.w && mine.h === was.h) return last
      const drawn = drawnOf(visibleItems(next, { admin: isAdmin })).find((other) => other.id === item.id)
      if (drawn && (drawn.w !== item.w || drawn.h !== item.h)) return next
      last = next
    }
    return last
  }
  const onKey = (event, item) => {
    const direction = ARROWS[event.key]
    if (!direction || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    if (!wide) {
      const tall = direction === 'up' || direction === 'down'
      if (event.shiftKey && cols > 2 && tall) {
        // (A medium screen: the height only; the widths are the wide layout's.)
        apply(item.id, (current) => sizeStep(current, item, direction), {
          verb: 'resized:',
          key: `size:${item.id}`,
          unchanged: direction === 'up' ? 'is as small as it goes' : 'is as large as it goes',
        })
      } else if (event.shiftKey) say(cols > 2 ? 'Widths are set on a wider screen.' : 'Widgets are resized on a wider screen.')
      else moveInOrder(item, direction === 'left' || direction === 'up' ? -1 : 1)
      return
    }
    if (event.shiftKey)
      apply(item.id, (current) => sizeStep(current, item, direction), {
        verb: 'resized:',
        key: `size:${item.id}`,
        unchanged: direction === 'left' || direction === 'up' ? 'is as small as it goes' : 'is as large as it goes',
      })
    else
      apply(item.id, (current) => stepMove(current, item.id, direction), {
        verb: 'moved to',
        key: `move:${item.id}`,
        unchanged: `cannot move further ${direction}`,
      })
  }
  // ---- A drag or a resize with the mouse, a finger or a pen ----
  //
  // While a widget is dragged or resized, the grid library asks its
  // "compactor" where every widget goes. The answer is the layout model's
  // own (usage-layout.js): the change applied to the layout as it was when
  // the drag began, then flowed. So the tinted place shown while dragging is
  // exactly where the widget lands, nothing ever overlaps, and what is saved
  // is what was shown. Outside a drag the compactor moves nothing: the
  // layout it is given is already flowed.
  const gesture = useRef(null) // { kind: 'drag' | 'resize', id, base, drawn, point, next, startH }
  // The layout with the widget resized to what the grid holds (`entry`: its width in columns, its height in fine rows).
  // The height is stored in whole rows: the nearest, unless that is no change in the direction the edge went (a widget
  // as tall as its content is often between two rows).
  const resizedTo = (now, entry) => {
    const stored = now.base.items.find((one) => one.id === now.id)
    const w = now.wide ? entry.w : stored.w
    let h = stored.h
    let chosen = false
    if (entry.h !== now.startH) {
      const rows = Math.round(entry.h / LAYOUT_SUB)
      const bigger = entry.h > now.startH
      if (bigger ? rows * LAYOUT_SUB > now.startH : rows * LAYOUT_SUB < now.startH) {
        h = rows
        chosen = true
      }
    }
    const next = resizeItem(now.base, now.id, w, h)
    // A widget drawn at its content's height and given the rows it is stored with: those rows are its height now.
    if (!chosen || !next.items.find((one) => one.id === now.id)?.auto) return next
    return { ...next, items: next.items.map((one) => (one.id === now.id ? { ...one, auto: false } : one)) }
  }
  const shownOf = useRef(null)
  // (As the grid draws it: fine rows, each widget at its own height.)
  shownOf.current = (next) => settle(drawnOf(visibleItems(next, { admin: isAdmin })), cols, fittedRef.current)
  const compactor = useMemo(
    () => ({
      type: 'vertical',
      allowOverlap: false,
      compact(given) {
        const now = gesture.current
        if (!now) return given.map((entry) => ({ ...entry }))
        const entry = given.find((one) => one.i === now.id)
        if (now.kind === 'resize' && entry) now.next = resizedTo(now, entry)
        else if (now.kind === 'drag' && now.point)
          now.next = placeBefore(now.base, now.id, dropBefore(now.drawn, now.id, now.point.x, now.point.y))
        const places = new Map(shownOf.current(now.next || now.base).map((item) => [item.id, item]))
        return given.map((one) => {
          const place = places.get(one.i)
          return place ? { ...one, x: place.x, y: place.y, w: place.w, h: place.h, moved: false } : { ...one }
        })
      },
    }),
    [],
  )
  // Where the pointer is, in columns and rows of the grid.
  const pointOf = (event) => {
    const box = gridRef.current?.getBoundingClientRect()
    const at = event?.touches?.[0] || event?.changedTouches?.[0] || event
    if (!box || !at || typeof at.clientX !== 'number') return null
    const column = (width - LAYOUT_GAP * (cols - 1)) / cols + LAYOUT_GAP
    return { x: (at.clientX - box.left) / column, y: (at.clientY - box.top) / LAYOUT_SUB_PITCH }
  }
  const startGesture = (kind) => (_grid, _old, item) => {
    if (!item) return
    const start = drawn.find((one) => one.id === item.i)
    gesture.current = { kind, id: item.i, base: layout, drawn, wide, point: null, next: null, startH: start?.h ?? item.h }
  }
  const onDrag = (_grid, _old, _item, _placeholder, event) => {
    if (gesture.current) gesture.current.point = pointOf(event) ?? gesture.current.point
  }
  // The tinted place while resizing is where the widget will be drawn (a row it alone ends is drawn across).
  const onResize = (_grid, _old, item, placeholder) => {
    const now = gesture.current
    if (!now || !item || !placeholder) return
    const place = shownOf.current(resizedTo(now, item)).find((one) => one.id === now.id)
    if (place) Object.assign(placeholder, { x: place.x, y: place.y, w: place.w, h: place.h })
  }
  const endGesture = (verb) => () => {
    const done = gesture.current
    gesture.current = null
    if (!done?.next || done.next === done.base) return
    apply(done.id, () => done.next, { verb })
  }

  // ---- Heights that follow the content ----
  //
  // A list, a breakdown or the budgets (while nobody sized them by hand) is
  // as tall as what it shows. Its card's growing part ([data-sw-fit]) takes
  // whatever room the card has; what it holds is measured from its children,
  // so the height a card needs is found whatever height it is drawn at, and
  // drawing it at that height measures the same again (no loop).
  const measure = useCallback(() => {
    const root = gridRef.current
    // (Before the grid has drawn its widgets there is nothing to measure: what was kept stays.)
    if (!root || !root.querySelector('[data-sw-widget]')) return
    const now = fittedRef.current
    const next = {}
    for (const node of root.querySelectorAll('[data-sw-widget]')) {
      const id = node.getAttribute('data-sw-widget')
      const item = shown.find((one) => one.id === id)
      if (!item || !fitsContent(item)) continue
      const card = node.querySelector('.sw-widget-body > *')
      if (!card) continue
      // Still loading: it keeps the height it had (or had the last time the page was open), so nothing jumps.
      if (card.querySelector('[data-sw-fit-wait]')) {
        if (Number.isInteger(now[id])) next[id] = now[id]
        continue
      }
      const grows = card.querySelector('[data-sw-fit]')
      if (!grows) continue
      const box = grows.getBoundingClientRect()
      const frame = card.getBoundingClientRect()
      let natural
      if (grows.hasAttribute('data-sw-fit-end')) {
        // A line that ends the card (a list with nothing in it): the card ends under it.
        const style = getComputedStyle(card)
        natural = box.bottom - frame.top + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0)
      } else {
        const bottom = Math.max(box.top, ...Array.from(grows.children, (child) => child.getBoundingClientRect().bottom))
        const content = bottom - box.top + grows.scrollTop + (parseFloat(getComputedStyle(grows).paddingBottom) || 0)
        natural = frame.height - grows.clientHeight + content
      }
      next[id] = subRowsFor(Math.ceil(natural - 0.5))
    }
    setFitted((current) => {
      const keys = Object.keys(next)
      return keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key]) ? current : next
    })
  }, [shown, gridRef])
  useEffect(() => {
    try {
      window.localStorage.setItem(fitKey, JSON.stringify(fitted))
    } catch {
      // (Only a convenience: without it a reload measures again.)
    }
  }, [fitted, fitKey])
  useLayoutEffect(() => {
    measure()
  })
  useEffect(() => {
    const root = gridRef.current
    if (!root) return undefined
    // A widget's data arrives on its own: look again when anything in the grid changes (once a frame).
    let frame = 0
    const later = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measure)
    }
    const observer = new MutationObserver(later)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [measure, gridRef, width])

  // ---- Edit mode ----

  useEffect(() => {
    if (!editing) return undefined
    // Escape leaves "Edit layout", unless a menu, a panel or a list is open: then the key is theirs. Heard on its way down,
    // while whatever it will close is still there to be seen.
    const onEscape = (event) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[data-radix-popper-content-wrapper] :is([role="menu"], [role="dialog"], [role="listbox"])')) return
      onEditing(false)
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [editing, onEditing])
  // A widget that was just added or duplicated takes the focus as soon as the grid has drawn it (a frame or two
  // later; found in the page, since the grid library keeps each widget's ref for itself). Once, then never again.
  useEffect(() => {
    if (!focusId) return undefined
    let frame = 0
    let tries = 0
    const look = () => {
      const node = gridRef.current?.querySelector(`[data-sw-widget="${focusId}"]`)
      if (node) {
        node.scrollIntoView({ block: 'nearest' })
        node.focus({ preventScroll: true })
      } else if ((tries += 1) < 30) {
        frame = window.requestAnimationFrame(look)
        return
      }
      setFocusId(null)
    }
    look()
    return () => window.cancelAnimationFrame(frame)
  }, [focusId, gridRef])
  // What the bar at the bottom says goes away by itself; a failed save stays.
  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(null), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const failed = board.status === 'failed'

  const grid = useMemo(
    () =>
      drawn.map((item) => {
        const size = WIDGETS[item.type].size
        const group = WIDGETS[item.type].group
        if (cols <= 2) return { i: item.id, x: item.x, y: item.y, w: item.w, h: item.h }
        // (A widget drawn across a short row may be wider or taller than its type goes: the limits make room for that.)
        return {
          i: item.id,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          minW: wide ? size.minW : item.w,
          maxW: wide ? Math.max(size.maxW, item.w) : item.w,
          minH: Math.min(size.minH * LAYOUT_SUB, item.h),
          maxH: Math.max(size.maxH * LAYOUT_SUB, item.h),
          resizeHandles: wide ? HANDLES[group] : group === 'tile' ? [] : ['s'],
        }
      }),
    [drawn, wide, cols],
  )
  const [confirmReset, setConfirmReset] = useState(false)
  const resetNow = () => {
    setConfirmReset(false)
    board.reset()
    setNotice({ text: board.hasDefault ? 'Back to the workspace’s layout' : 'Back to the default layout', undo: true })
    say('The layout is back to the default.')
  }

  if (summary.error && !summary.data)
    return (
      <div data-sw-usage-error>
        <LoadError error={summary.error} onRetry={summary.refetch} />
      </div>
    )
  // Nothing at all in the period: one clear empty state, not six empty charts.
  // (Someone who arranged the dashboard, or whose workspace has a layout of its own, keeps the dashboard: its widgets say
  // there is nothing yet, and it can still be arranged.)
  if (now && now.calls === 0 && !editing && !board.customised && !board.hasDefault && !board.preview)
    return (
      <Card data-sw-usage-empty>
        <EmptyState icon={BarChart3} size="lg" title="No agent turns in this period">
          {filter.active.length
            ? 'Nothing matches these filters. Clear one, or choose a longer period.'
            : 'When someone chats with a connected agent, or an agent takes a comment, each turn shows up here: who asked, how it ended, and what the agent reported.'}
        </EmptyState>
      </Card>
    )

  const hidden = hiddenTypes(layout, { admin: isAdmin })
  // Where the grid draws a widget, in fine rows (",fit": its height follows its content).
  const drawnPlace = (id) => {
    const one = drawn.find((item) => item.id === id)
    return one ? `${one.x},${one.y},${one.w},${one.h}${fitsContent(one) && Number.isInteger(fitted[id]) ? ',fit' : ''}` : ''
  }
  const canDrag = editing && cols > 2
  const coarse = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches)
  // How much of a widget's heading its tools cover (they sit over its top right corner).
  const toolsWidth = (item) => {
    const tile = WIDGETS[item.type].group === 'tile'
    let room = canDrag ? 20 : 56
    if (!(cols === 2 && tile) && optionRows(item.type).length) room += 28
    if (WIDGETS[item.type].many && cols > 2) room += 28
    return room + 28 + 22
  }
  return (
    <div
      data-sw-usage-overview
      data-sw-layout-cols={cols}
      data-sw-layout-mode={editing ? 'edit' : 'view'}
      data-sw-layout-state={board.status}
      className={cn(editing && 'sw-layout-editing')}
    >
      {/* A view's layout is only ever shown: the reader's own layout stays as it is until they say otherwise. Their own
          view says so with a small chip; a view somebody shared, with a note and the choice to make it theirs. */}
      {board.preview?.mine ? (
        <p
          className="mb-3 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface-2 py-1 pr-1 pl-3 text-xs text-fg print:hidden"
          role="status"
          data-sw-layout-view-chip={board.preview.id}
        >
          <LayoutDashboard size={13} className="shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 truncate">
            View: <strong className="font-semibold">{board.preview.name}</strong>
          </span>
          <Button size="xs" variant="ghost" className="rounded-full" onClick={() => set({ view: null })} data-sw-layout-dismiss>
            Back to my layout
          </Button>
        </p>
      ) : board.preview ? (
        <div
          className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent/40 bg-accent/8 px-4 py-2.5 text-sm text-fg print:hidden"
          role="status"
          data-sw-layout-preview={board.preview.id}
        >
          <LayoutDashboard size={15} className="shrink-0 text-accent" aria-hidden="true" />
          <p className="min-w-0 flex-[1_1_16rem]">
            This is the layout of the view <strong className="font-semibold">{board.preview.name}</strong>. Your own layout is unchanged.
          </p>
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              board.adopt()
              set({ view: null })
              setNotice({ text: 'This is your layout now', undo: true })
            }}
            data-sw-layout-adopt
          >
            Use this layout
          </Button>
          <Button size="sm" variant="secondary" onClick={() => set({ view: null })} data-sw-layout-dismiss>
            Back to my layout
          </Button>
        </div>
      ) : null}

      {editing ? (
        <div
          className="sticky top-2 z-30 mb-3 flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-line bg-surface py-2 pr-2 pl-3.5 shadow-pop print:hidden"
          role="toolbar"
          aria-label="Edit layout"
          data-sw-layout-bar
        >
          {/* The help and whether the layout is saved share a line (on a phone too: the status never wraps on its own). */}
          <div className="mr-auto flex min-w-0 flex-[1_1_16rem] items-center gap-3">
            <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg" id="sw-layout-help">
              <LayoutDashboard size={15} className="shrink-0 text-accent" aria-hidden="true" />
              <span className="min-w-0">
                <strong className="font-semibold">Editing layout</strong>
                <span className="text-muted">
                  {' · '}
                  {wide
                    ? 'Drag a widget to move it, drag an edge to resize.'
                    : cols > 2
                      ? 'Drag a widget to move it, its bottom edge to resize.'
                      : 'Use the arrows to reorder.'}
                </span>
                <span className="sr-only"> The arrow keys move the widget in focus; with Shift, they resize it.</span>
              </span>
            </p>
            <span
              className={cn(
                'inline-flex shrink-0 items-center justify-end gap-1 text-xs whitespace-nowrap',
                failed ? 'text-bad' : 'text-muted',
              )}
              role="status"
              data-sw-layout-status={board.status}
            >
              {board.status === 'saving' ? (
                <>
                  <Spinner /> Saving
                </>
              ) : board.status === 'saved' ? (
                <>
                  <Check size={13} aria-hidden="true" /> Saved
                </>
              ) : failed ? (
                <>
                  <CircleAlert size={13} aria-hidden="true" /> Not saved
                </>
              ) : null}
            </span>
          </div>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-2">
            <span className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={board.undo} disabled={!board.canUndo} data-sw-layout-undo>
                <Undo2 size={14} aria-hidden="true" /> Undo
              </Button>
              <AddPanel
                hidden={hidden}
                onAdd={add}
                onAdded={() => {
                  if (!added.current) return false
                  setFocusId(added.current)
                  added.current = null
                  return true
                }}
              />
              {board.canSetDefault ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="secondary" data-sw-layout-reset-menu>
                      <RotateCcw size={14} aria-hidden="true" /> Reset
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuItem disabled={!board.customised} onSelect={() => setConfirmReset(true)} data-sw-layout-reset>
                      <RotateCcw size={14} aria-hidden="true" /> {board.hasDefault ? 'Reset to the workspace layout' : 'Reset to default'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>For the workspace</DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={async () => {
                        try {
                          await board.setDefault()
                          setNotice({ text: 'Everyone without a layout of their own now starts from this one' })
                        } catch (error) {
                          setNotice({ text: `The default was not set: ${error.message}`, bad: true })
                        }
                      }}
                      data-sw-layout-set-default
                    >
                      <LayoutDashboard size={14} aria-hidden="true" /> Set as default for everyone
                    </DropdownMenuItem>
                    {board.hasDefault ? (
                      <DropdownMenuItem
                        onSelect={async () => {
                          try {
                            await board.clearDefault()
                            setNotice({ text: 'The workspace has no layout of its own any more' })
                          } catch (error) {
                            setNotice({ text: `The default was not removed: ${error.message}`, bad: true })
                          }
                        }}
                        data-sw-layout-clear-default
                      >
                        <X size={14} aria-hidden="true" /> Remove the workspace default
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!board.customised}
                  title={board.customised ? undefined : 'This is already the default layout'}
                  onClick={() => setConfirmReset(true)}
                  data-sw-layout-reset
                >
                  <RotateCcw size={14} aria-hidden="true" /> Reset
                </Button>
              )}
              <Button size="sm" variant="default" className="min-w-16" onClick={() => onEditing(false)} data-sw-layout-done>
                Done
              </Button>
            </span>
          </span>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the layout?"
        confirmLabel="Reset"
        onConfirm={resetNow}
      >
        <p className="text-sm text-muted">
          {board.hasDefault
            ? 'Your dashboard goes back to the layout your workspace starts everyone from. Undo brings yours back.'
            : 'Your dashboard goes back to the layout everyone starts from. Undo brings yours back.'}
        </p>
      </ConfirmDialog>

      {/* The tiles and the top lists are widgets among the others now: both names stay on the grid that holds them. */}
      <div ref={holdGrid} className="sw-layout" data-sw-layout data-sw-usage-tiles data-sw-usage-top>
        {width ? (
          <ReactGridLayout
            layout={grid}
            width={width}
            gridConfig={{ cols, rowHeight: LAYOUT_SUB_ROW, margin: [LAYOUT_GAP, LAYOUT_GAP], containerPadding: [0, 0] }}
            dragConfig={{
              enabled: canDrag,
              // (A finger drags by the grip only, so it can still scroll the page from anywhere else.)
              ...(coarse ? { handle: '[data-sw-widget-handle]' } : {}),
              cancel: 'button, a, input, [role="menu"], .react-resizable-handle',
              threshold: 4,
            }}
            resizeConfig={{ enabled: editing && cols > 2, handles: ['s', 'e', 'se'], handleComponent: resizeHandle }}
            compactor={compactor}
            onDragStart={startGesture('drag')}
            onDrag={onDrag}
            onDragStop={endGesture('moved to')}
            onResizeStart={startGesture('resize')}
            onResize={onResize}
            onResizeStop={endGesture('resized:')}
          >
            {ordered.map((item, index) => {
              const title = titleOf(item)
              const options = optionsOf(item)
              const menu = <WidgetOptions item={item} options={options} onChange={(changes) => saveOptions(item, changes)} title={title} />
              return (
                <div
                  key={item.id}
                  className={cn('sw-widget', canDrag && !coarse && 'sw-widget-drag')}
                  style={{ '--sw-w': item.w, ...(editing ? { '--sw-tools': `${toolsWidth(item)}px` } : {}) }}
                  data-sw-widget={item.id}
                  data-sw-widget-type={item.type}
                  data-sw-widget-place={`${item.x},${item.y},${item.w},${item.h}`}
                  data-sw-widget-drawn={drawnPlace(item.id)}
                  {...(editing
                    ? {
                        tabIndex: 0,
                        role: 'group',
                        'aria-label': `${title}: ${describeItem(item)}`,
                        'aria-describedby': 'sw-layout-help',
                        onKeyDown: (event) => onKey(event, item),
                      }
                    : {})}
                >
                  <div className="sw-widget-body h-full min-w-0" inert={editing}>
                    <Widget
                      item={item}
                      options={options}
                      setOptions={(changes) => saveOptions(item, changes)}
                      ctx={ctx}
                      // While editing, the widget's tools sit where its options button was (false: no button of its own).
                      menu={editing ? false : menu}
                    />
                  </div>
                  {editing ? (
                    // The tools of a widget being edited, in its top right corner: hold it, its options, a copy, hide it.
                    <div className="sw-widget-tools" data-sw-widget-bar>
                      {canDrag ? (
                        <span className="sw-widget-grip" data-sw-widget-handle title="Drag to move" aria-hidden="true">
                          <GripVertical size={14} />
                        </span>
                      ) : (
                        <>
                          <IconButton
                            label={`Move ${title} up`}
                            size="icon-xs"
                            disabled={index === 0}
                            onClick={() => moveInOrder(item, -1)}
                            data-sw-widget-up
                          >
                            <ArrowUp size={14} aria-hidden="true" />
                          </IconButton>
                          <IconButton
                            label={`Move ${title} down`}
                            size="icon-xs"
                            disabled={index === ordered.length - 1}
                            onClick={() => moveInOrder(item, 1)}
                            data-sw-widget-down
                          >
                            <ArrowDown size={14} aria-hidden="true" />
                          </IconButton>
                        </>
                      )}
                      {menu}
                      {WIDGETS[item.type].many && cols > 2 ? (
                        <IconButton
                          label={roomFor(layout, item.type) ? `Duplicate ${title}` : `No more copies of ${WIDGETS[item.type].title} fit`}
                          size="icon-xs"
                          disabled={!roomFor(layout, item.type)}
                          onClick={() => duplicate(item)}
                          data-sw-widget-duplicate
                        >
                          <Copy size={14} aria-hidden="true" />
                        </IconButton>
                      ) : null}
                      <IconButton label={`Hide ${title}`} size="icon-xs" onClick={() => hide(item)} data-sw-widget-hide>
                        <X size={15} aria-hidden="true" />
                      </IconButton>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </ReactGridLayout>
        ) : null}
        {width && !ordered.length ? (
          <Card data-sw-layout-empty>
            <EmptyState icon={LayoutDashboard} title="Every widget is hidden">
              {editing ? 'Add one back with Add widget, or reset the layout.' : 'Press Edit layout to add widgets back.'}
            </EmptyState>
          </Card>
        ) : null}
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-sw-layout-live>
        <span key={live.n}>{live.text}</span>
      </p>
      {notice || failed ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-16 z-[70] flex justify-center px-4 print:hidden">
          <div
            className={cn(
              'pointer-events-auto flex max-w-lg items-center gap-3 rounded-lg border px-4 py-2 text-sm shadow-pop',
              failed || notice?.bad ? 'border-bad/40 bg-surface text-bad' : 'border-line bg-fg text-surface',
            )}
            role={failed ? 'alert' : 'status'}
            data-sw-layout-toast={failed ? 'failed' : 'ok'}
          >
            <span>
              {failed
                ? `The layout could not be saved${board.failure?.message ? ` (${board.failure.message})` : ''}. Your change is kept on this page until you leave it.`
                : notice.text}
            </span>
            {failed ? (
              <Button size="xs" variant="secondary" onClick={board.retry} data-sw-layout-retry>
                Try again
              </Button>
            ) : notice.undo && board.canUndo ? (
              <Button
                size="xs"
                variant="inverse"
                className="underline underline-offset-2"
                onClick={() => {
                  board.undo()
                  setNotice({ text: 'Undone' })
                  say('Undone.')
                }}
                data-sw-layout-toast-undo
              >
                Undo
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
