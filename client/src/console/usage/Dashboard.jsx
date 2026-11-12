// The Usage overview as a dashboard: a grid of widgets (widgets.jsx) that a
// person can arrange. The layout itself, and every rule about it, is in
// src/hosted/usage-layout.js; saving is in layout-state.js. This file is
// the grid, "Edit layout", and the chrome a widget wears while it is edited.
//
// Outside "Edit layout" nothing moves: the grid only places the cards.
// While editing, on 12 columns a widget is dragged by its bar and resized
// from its corner (react-grid-layout: mouse, touch and pen), or moved with
// the arrow keys and resized with Shift and the arrow keys; every change is
// spoken by a live region. On fewer columns (a narrow window, a phone) the
// same layout is shown reflowed, and widgets are put in another order with
// their up and down buttons, the arrow keys or, on 6 columns, a drag.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactGridLayout from 'react-grid-layout'
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  CircleAlert,
  Copy,
  GripVertical,
  LayoutDashboard,
  Plus,
  RotateCcw,
  Undo2,
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
  Spinner,
} from '../../components/ui'
import { cn } from '../../lib/utils'
import { USAGE_BUCKETS, USAGE_DIMENSIONS, USAGE_METRICS } from '../../../../src/hosted/usage-shape.js'
import {
  LAYOUT_COLS,
  LAYOUT_GAP,
  LAYOUT_ROW,
  WIDGETS,
  addItem,
  colsFor,
  describeItem,
  duplicateItem,
  fitLayout,
  hiddenTypes,
  moveItem,
  readingOrder,
  reflow,
  removeItem,
  reorder,
  resizeItem,
  roomFor,
  setOptions,
  stepMove,
  stepResize,
  visibleItems,
} from '../../../../src/hosted/usage-layout.js'
import { Card, LoadError } from '../components'
import { useWorkspace } from '../pages/workspace'
import { useWs } from './data'
import { defaultBucket } from './format'
import { Widget, WidgetOptions } from './widgets'

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
const GROUP_LABEL = { tile: 'Tiles', chart: 'Charts', list: 'Top lists', budgets: 'Budgets' }

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

const resizeHandle = (axis, ref) => (
  <span
    ref={ref}
    className={`react-resizable-handle react-resizable-handle-${axis} sw-resize-handle`}
    data-sw-widget-resize
    aria-hidden="true"
  />
)

// The button in the page's header: "Edit layout", and "Done" while editing.
export function EditLayoutButton({ editing, onEditing, disabled = false, why = null }) {
  return (
    <Button
      size="touch"
      variant={editing ? 'default' : 'secondary'}
      className="lg:h-9"
      onClick={() => onEditing(!editing)}
      disabled={disabled}
      title={disabled ? why : undefined}
      aria-pressed={editing}
      data-sw-layout-edit={editing ? 'on' : 'off'}
    >
      {editing ? <Check size={15} aria-hidden="true" /> : <LayoutDashboard size={15} aria-hidden="true" />}
      {editing ? 'Done' : 'Edit layout'}
    </Button>
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
  const shown = useMemo(() => reflow(items, cols), [items, cols])
  const ordered = useMemo(() => readingOrder(shown), [shown])
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
    const item = reflow(visibleItems(next, { admin: isAdmin }), cols).find((other) => other.id === id)
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
    setNotice({ text: 'Layout saved', undo: true })
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
    const { layout: next, id } = addItem(layout, type)
    if (!id) return
    change(next)
    added.current = id
    setNotice({ text: `${WIDGETS[type].title} added at the bottom`, undo: true })
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
  const onKey = (event, item) => {
    const direction = ARROWS[event.key]
    if (!direction || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    if (!wide) {
      if (event.shiftKey) say('Widgets are resized on a wider screen.')
      else moveInOrder(item, direction === 'left' || direction === 'up' ? -1 : 1)
      return
    }
    if (event.shiftKey)
      apply(item.id, (current) => stepResize(current, item.id, direction), {
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
  // The grid library reports where a drag or a resize ended.
  const onDragStop = (grid, _old, moved) => {
    if (!moved) return
    if (wide) apply(moved.i, (current) => moveItem(current, moved.i, moved.x, moved.y), { verb: 'moved to' })
    else {
      const order = [...grid].sort((a, b) => a.y - b.y || a.x - b.x).map((entry) => entry.i)
      apply(moved.i, (current) => reorder(current, moved.i, order.indexOf(moved.i)), { verb: 'moved to' })
    }
  }
  const onResizeStop = (_grid, _old, sized) => {
    if (sized) apply(sized.i, (current) => resizeItem(current, sized.i, sized.w, sized.h), { verb: 'resized:' })
  }

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
      shown.map((item) => {
        const size = WIDGETS[item.type].size
        return wide
          ? { i: item.id, x: item.x, y: item.y, w: item.w, h: item.h, minW: size.minW, maxW: size.maxW, minH: size.minH, maxH: size.maxH }
          : { i: item.id, x: item.x, y: item.y, w: item.w, h: item.h }
      }),
    [shown, wide],
  )

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
  const canDrag = editing && cols > 2
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
          className="sticky top-2 z-30 mb-3 flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-accent/50 bg-surface px-3 py-2 shadow-pop print:hidden"
          role="toolbar"
          aria-label="Edit layout"
          data-sw-layout-bar
        >
          <p className="mr-auto min-w-0 flex-[1_1_14rem] text-sm text-fg" id="sw-layout-help">
            <strong className="font-semibold">Editing the layout.</strong>{' '}
            <span className="text-muted">
              {wide
                ? 'Drag a widget by its bar and resize it from its corner, or use the arrow keys (with Shift to resize).'
                : cols > 2
                  ? 'Drag a widget by its bar, or use its arrows, to put it in another place. Resize on a wider screen.'
                  : 'Use a widget’s arrows to move it up or down. Drag and resize on a wider screen.'}
            </span>
          </p>
          <span
            className={cn('inline-flex items-center gap-1 text-xs', failed ? 'text-bad' : 'text-muted')}
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
          <Button size="sm" variant="secondary" onClick={board.undo} disabled={!board.canUndo} data-sw-layout-undo>
            <Undo2 size={14} aria-hidden="true" /> Undo
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" data-sw-layout-add>
                <Plus size={14} aria-hidden="true" /> Add widget
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-64"
              onCloseAutoFocus={(event) => {
                if (!added.current) return
                event.preventDefault()
                setFocusId(added.current)
                added.current = null
              }}
              data-sw-layout-add-menu
            >
              {hidden.length ? (
                Object.keys(GROUP_LABEL)
                  .filter((group) => hidden.some((type) => WIDGETS[type].group === group))
                  .map((group) => (
                    <div key={group}>
                      <DropdownMenuLabel>{GROUP_LABEL[group]}</DropdownMenuLabel>
                      {hidden
                        .filter((type) => WIDGETS[type].group === group)
                        .map((type) => (
                          <DropdownMenuItem key={type} onSelect={() => add(type)} data-sw-layout-add-item={type}>
                            <Plus size={14} aria-hidden="true" /> {WIDGETS[type].title}
                          </DropdownMenuItem>
                        ))}
                    </div>
                  ))
              ) : (
                <p className="px-2.5 py-2 text-xs text-muted" data-sw-layout-add-none>
                  Every widget is on the dashboard. Hide one with its ×, or duplicate a chart from its bar.
                </p>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary" data-sw-layout-reset-menu>
                <RotateCcw size={14} aria-hidden="true" /> Reset
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-72">
              <DropdownMenuItem
                disabled={!board.customised}
                onSelect={() => {
                  board.reset()
                  setNotice({ text: board.hasDefault ? 'Back to the workspace’s layout' : 'Back to the default layout', undo: true })
                  say('The layout is back to the default.')
                }}
                data-sw-layout-reset
              >
                <RotateCcw size={14} aria-hidden="true" /> Reset to default
              </DropdownMenuItem>
              {board.canSetDefault ? (
                <>
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
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="default" onClick={() => onEditing(false)} data-sw-layout-done>
            Done
          </Button>
        </div>
      ) : null}

      {/* The tiles and the top lists are widgets among the others now: both names stay on the grid that holds them. */}
      <div ref={holdGrid} className="sw-layout" data-sw-layout data-sw-usage-tiles data-sw-usage-top>
        {width ? (
          <ReactGridLayout
            layout={grid}
            width={width}
            gridConfig={{ cols, rowHeight: LAYOUT_ROW, margin: [LAYOUT_GAP, LAYOUT_GAP], containerPadding: [0, 0] }}
            dragConfig={{
              enabled: canDrag,
              handle: '[data-sw-widget-handle]',
              cancel: 'button, a, input, [data-sw-no-drag]',
              threshold: 4,
            }}
            resizeConfig={{ enabled: editing && wide, handles: ['se'], handleComponent: resizeHandle }}
            onDragStop={onDragStop}
            onResizeStop={onResizeStop}
          >
            {ordered.map((item, index) => {
              const title = titleOf(item)
              const options = optionsOf(item)
              const menu = <WidgetOptions item={item} options={options} onChange={(changes) => saveOptions(item, changes)} title={title} />
              return (
                <div
                  key={item.id}
                  className="sw-widget"
                  style={{ '--sw-w': item.w }}
                  data-sw-widget={item.id}
                  data-sw-widget-type={item.type}
                  data-sw-widget-place={`${item.x},${item.y},${item.w},${item.h}`}
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
                  <div className="flex h-full min-w-0 flex-col">
                    {editing ? (
                      <div className="sw-widget-bar" data-sw-widget-bar>
                        <span
                          className={cn('sw-widget-grip', canDrag && 'sw-widget-grip-on')}
                          {...(canDrag ? { 'data-sw-widget-handle': '' } : {})}
                          title={canDrag ? 'Drag to move' : undefined}
                        >
                          {canDrag ? <GripVertical size={15} className="shrink-0 text-muted" aria-hidden="true" /> : null}
                          <span className="truncate">{title}</span>
                        </span>
                        {wide ? null : (
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
                        {/* A tile on a phone is too narrow for more than its name, its arrows and its ×. */}
                        {cols === 2 && WIDGETS[item.type].group === 'tile' ? null : menu}
                        {WIDGETS[item.type].many ? (
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
                    <div className="sw-widget-body min-h-0 min-w-0 flex-1" inert={editing}>
                      <Widget
                        item={item}
                        options={options}
                        setOptions={(changes) => saveOptions(item, changes)}
                        ctx={ctx}
                        // While editing, the options are on the widget's bar (false: a widget with no button of its own).
                        menu={editing ? false : menu}
                        editing={editing}
                      />
                    </div>
                  </div>
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
