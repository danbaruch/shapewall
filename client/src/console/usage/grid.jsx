// The data grid of the Usage and Activity pages: TanStack Table for the
// column model (which columns show, in which order, which are pinned, how
// the table is sorted) and TanStack Virtual for the rows, so tens of
// thousands of rows scroll like a few. The rows themselves come from the
// server a page at a time, already sorted and filtered there.
//
//   columns   [{ id, header, width, align?, sort?, always?, cell(row),
//               subtotal?(group), title? }]: `sort` is the server's sort key.
//   items     what to draw, top to bottom: { type: 'row', row } |
//             { type: 'group', group, open } | { type: 'more', group, busy }
//   layout    { order, hidden, pinned }: kept by the page in its address.
//
// Keyboard: the grid is one tab stop. Up and Down (and Home, End, Page Up,
// Page Down) move the current row, Enter or Space opens it, Right and Left
// open and close a group. On a phone the grid is a list of cards.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns3,
  EyeOff,
  MoreVertical,
  Pin,
  PinOff,
  RotateCcw,
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from '../../components/ui'
import { useMediaQuery } from '../../lib/hooks'
import { cn } from '../../lib/utils'

const features = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  rowSortingFeature,
})
const NO_DATA = []

// The layout a page keeps in its address: "cols" (the visible columns, in
// order) and "pin". Missing: the columns' own defaults.
export function readLayout(columns, { cols, pin, defaults }) {
  const known = new Set(columns.map((column) => column.id))
  const shown = (cols ? cols.split(',') : defaults.shown).filter((id) => known.has(id))
  for (const column of columns) if (column.always && !shown.includes(column.id)) shown.unshift(column.id)
  const rest = columns.map((column) => column.id).filter((id) => !shown.includes(id))
  return {
    order: [...shown, ...rest],
    hidden: rest,
    pinned: (pin === undefined || pin === null ? defaults.pinned : pin.split(',')).filter((id) => shown.includes(id)),
  }
}
export const writeLayout = (layout, defaults) => {
  const shown = layout.order.filter((id) => !layout.hidden.includes(id))
  const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index])
  return {
    cols: same(shown, defaults.shown) ? null : shown.join(','),
    pin: same(layout.pinned, defaults.pinned) ? null : layout.pinned.join(',') || 'none',
  }
}

export function DataGrid({
  label,
  columns,
  items,
  rowKey,
  layout,
  onLayout,
  sort = null,
  onSort = null,
  dense = false,
  onOpen,
  openId = null,
  onToggleGroup = null,
  onMore = null,
  hasMore = false,
  loadingMore = false,
  card,
  footer = null,
  busy = false,
}) {
  const phone = useMediaQuery('(max-width: 639px)')
  const scroll = useRef(null)
  const [active, setActive] = useState(0)
  const rowHeight = phone ? 84 : dense ? 34 : 44

  const defs = useMemo(
    () =>
      columns.map((column) => ({
        id: column.id,
        accessorFn: (row) => row,
        header: column.header,
        size: column.width,
        enableSorting: Boolean(column.sort),
        enableHiding: !column.always,
        meta: column,
      })),
    [columns],
  )
  const table = useTable({
    features,
    columns: defs,
    data: NO_DATA,
    manualSorting: true,
    enableSortingRemoval: false,
    state: {
      columnOrder: layout.order,
      columnVisibility: Object.fromEntries(layout.hidden.map((id) => [id, false])),
      columnPinning: { start: layout.pinned, end: [] },
      sorting: sort ? [{ id: columns.find((column) => column.sort === sort.id)?.id || '', desc: sort.dir === 'desc' }] : [],
    },
    onColumnOrderChange: (updater) => onLayout({ ...layout, order: typeof updater === 'function' ? updater(layout.order) : updater }),
    onColumnVisibilityChange: (updater) => {
      const before = Object.fromEntries(layout.hidden.map((id) => [id, false]))
      const next = typeof updater === 'function' ? updater(before) : updater
      const hidden = Object.keys(next).filter((id) => next[id] === false)
      onLayout({ ...layout, hidden, pinned: layout.pinned.filter((id) => !hidden.includes(id)) })
    },
    onColumnPinningChange: (updater) => {
      const next = typeof updater === 'function' ? updater({ start: layout.pinned, end: [] }) : updater
      onLayout({ ...layout, pinned: next.start || next.left || [] })
    },
    onSortingChange: (updater) => {
      const before = sort ? [{ id: columns.find((column) => column.sort === sort.id)?.id || '', desc: sort.dir === 'desc' }] : []
      const next = (typeof updater === 'function' ? updater(before) : updater)[0]
      const column = columns.find((item) => item.id === next?.id)
      if (column?.sort) onSort?.({ id: column.sort, dir: next.desc ? 'desc' : 'asc' })
    },
  })
  // Pinned columns first, then the rest, each in the chosen order.
  const visible = table.getVisibleLeafColumns()
  const ordered = [...visible.filter((column) => column.getIsPinned()), ...visible.filter((column) => !column.getIsPinned())]
  const offsets = []
  let left = 0
  for (const column of ordered) {
    offsets.push(left)
    left += column.getSize()
  }
  const total = left
  const lastPinned = ordered.filter((column) => column.getIsPinned()).length - 1

  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })
  useEffect(() => {
    virtual.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight])
  const shown = virtual.getVirtualItems()
  const lastShown = shown.at(-1)?.index ?? 0
  // Near the end of what is loaded: ask for the next page.
  useEffect(() => {
    if (hasMore && !loadingMore && items.length && lastShown >= items.length - 15) onMore?.()
  }, [hasMore, loadingMore, items.length, lastShown, onMore])
  useEffect(() => {
    if (active > items.length - 1) setActive(Math.max(0, items.length - 1))
  }, [items.length, active])

  const open = useCallback(
    (item) => {
      if (!item) return
      if (item.type === 'row') onOpen?.(item.row)
      else if (item.type === 'group') onToggleGroup?.(item.group.key)
      else if (item.type === 'more') item.load?.()
    },
    [onOpen, onToggleGroup],
  )
  const move = (index) => {
    const next = Math.min(Math.max(index, 0), items.length - 1)
    setActive(next)
    virtual.scrollToIndex(next, { align: 'auto' })
  }
  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget && event.target.closest('button, a, input, [role="menuitem"]')) return
    const item = items[active]
    const keys = {
      ArrowDown: () => move(active + 1),
      ArrowUp: () => move(active - 1),
      Home: () => move(0),
      End: () => move(items.length - 1),
      PageDown: () => move(active + 10),
      PageUp: () => move(active - 10),
      Enter: () => open(item),
      ' ': () => open(item),
      ArrowRight: () => (item?.type === 'group' && !item.open ? onToggleGroup?.(item.group.key) : null),
      ArrowLeft: () => (item?.type === 'group' && item.open ? onToggleGroup?.(item.group.key) : null),
    }
    if (!keys[event.key]) return
    event.preventDefault()
    keys[event.key]()
  }
  const idOf = (index) => `sw-grid-row-${index}`
  const keyOf = (item, index) => (item.type === 'row' ? rowKey(item.row) : `${item.type}:${item.group?.key ?? index}`)

  // ---- Phones: a list of cards ----
  if (phone) {
    return (
      <div className={cn('transition-opacity', busy && 'opacity-60')} data-sw-grid="cards">
        <ul aria-label={label} className="divide-y divide-line">
          {items.map((item, index) => (
            <li key={keyOf(item, index)}>
              {item.type === 'row' ? (
                <button
                  type="button"
                  onClick={() => onOpen?.(item.row)}
                  className="block w-full px-4 py-3 text-left outline-none active:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  data-sw-grid-row={rowKey(item.row)}
                >
                  {card(item.row)}
                </button>
              ) : item.type === 'group' ? (
                <button
                  type="button"
                  onClick={() => onToggleGroup?.(item.group.key)}
                  aria-expanded={item.open}
                  className="flex min-h-11 w-full items-center gap-2 bg-surface-2 px-4 py-2 text-left text-sm font-medium text-fg outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  data-sw-grid-group={item.group.key}
                >
                  {item.open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                  <span className="min-w-0 flex-1 truncate">{item.group.label}</span>
                  <span className="tabular text-xs font-normal text-muted">{item.summary}</span>
                </button>
              ) : (
                <div className="px-4 py-2">
                  <Button size="touch" variant="secondary" className="w-full" onClick={item.load} disabled={item.busy}>
                    {item.busy ? <Spinner /> : null} Show more
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {hasMore ? (
          <div className="border-t border-line p-3">
            <Button size="touch" variant="secondary" className="w-full" onClick={onMore} disabled={loadingMore} data-sw-grid-more>
              {loadingMore ? <Spinner /> : null} Show more
            </Button>
          </div>
        ) : null}
        {footer}
      </div>
    )
  }

  const header = table.getHeaderGroups()[0]?.headers || []
  const headerOf = new Map(header.map((item) => [item.column.id, item]))
  return (
    <div className={cn('transition-opacity', busy && 'opacity-60')} data-sw-grid="table">
      <div
        ref={scroll}
        role="grid"
        aria-label={label}
        aria-rowcount={items.length + 1}
        aria-colcount={ordered.length}
        aria-activedescendant={items.length ? idOf(active) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="group/grid relative max-h-[min(72vh,720px)] min-h-[220px] overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        data-sw-grid-scroll
      >
        <div style={{ width: total, minWidth: '100%' }}>
          <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex border-b border-line bg-surface-2">
            {ordered.map((column, index) => {
              const meta = column.columnDef.meta
              const sorted = column.getIsSorted()
              const pinned = Boolean(column.getIsPinned())
              return (
                <div
                  key={column.id}
                  role="columnheader"
                  aria-colindex={index + 1}
                  aria-sort={sorted ? (sorted === 'desc' ? 'descending' : 'ascending') : column.getCanSort() ? 'none' : undefined}
                  style={{
                    width: column.getSize(),
                    flex: index === ordered.length - 1 ? '1 0 auto' : '0 0 auto',
                    ...(pinned ? { left: offsets[index] } : {}),
                  }}
                  className={cn(
                    'flex h-9 items-center gap-0.5 bg-surface-2 pr-1 pl-3 text-xs font-medium text-muted',
                    pinned && 'sticky z-10',
                    pinned && index === lastPinned && 'border-r border-line',
                    meta.align === 'right' && 'justify-end',
                  )}
                  data-sw-grid-header={column.id}
                >
                  {column.getCanSort() ? (
                    <button
                      type="button"
                      onClick={() => column.toggleSorting(sorted ? sorted !== 'desc' : true)}
                      className={cn(
                        'inline-flex min-w-0 items-center gap-1 rounded px-1 py-1 outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent',
                        sorted && 'text-fg',
                      )}
                      title={`Sort by ${meta.title || meta.header}`}
                      data-sw-grid-sort={column.id}
                    >
                      <span className="truncate">{meta.header}</span>
                      {sorted === 'desc' ? (
                        <ArrowDown size={12} aria-hidden="true" />
                      ) : sorted === 'asc' ? (
                        <ArrowUp size={12} aria-hidden="true" />
                      ) : null}
                    </button>
                  ) : (
                    <span className="truncate px-1">{meta.header}</span>
                  )}
                  <ColumnMenu
                    column={column}
                    meta={meta}
                    index={layout.order.indexOf(column.id)}
                    layout={layout}
                    onLayout={onLayout}
                    canHide={headerOf.get(column.id)?.column.getCanHide() !== false}
                  />
                </div>
              )
            })}
          </div>
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {shown.map((slot) => {
              const item = items[slot.index]
              if (!item) return null
              const current = slot.index === active
              const base = {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: slot.size,
                transform: `translateY(${slot.start}px)`,
              }
              if (item.type === 'more')
                return (
                  <div
                    key={keyOf(item, slot.index)}
                    id={idOf(slot.index)}
                    role="row"
                    aria-rowindex={slot.index + 2}
                    style={base}
                    className="flex items-center border-b border-line/60 pl-10"
                  >
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={item.load}
                      disabled={item.busy}
                      tabIndex={-1}
                      data-sw-grid-group-more={item.group?.key}
                    >
                      {item.busy ? <Spinner /> : null} Show more of {item.group?.label}
                    </Button>
                  </div>
                )
              if (item.type === 'group') {
                // The label spans the columns before the first subtotal.
                const firstTotal = ordered.findIndex((column, index) => index > 0 && column.columnDef.meta.subtotal)
                const span = firstTotal < 0 ? ordered.length : firstTotal
                const width = ordered.slice(0, span).reduce((sum, column) => sum + column.getSize(), 0)
                return (
                  <div
                    key={keyOf(item, slot.index)}
                    id={idOf(slot.index)}
                    role="row"
                    aria-rowindex={slot.index + 2}
                    aria-expanded={item.open}
                    aria-selected={current}
                    style={base}
                    onClick={() => {
                      setActive(slot.index)
                      onToggleGroup?.(item.group.key)
                    }}
                    className={cn(
                      'flex cursor-pointer items-center border-b border-line bg-surface-2/70 text-xs font-medium text-fg hover:bg-surface-2',
                      current &&
                        'group-focus-visible/grid:outline-2 group-focus-visible/grid:-outline-offset-2 group-focus-visible/grid:outline-accent',
                    )}
                    data-sw-grid-group={item.group.key}
                  >
                    <div role="gridcell" style={{ width, flex: '0 0 auto' }} className="sticky left-0 z-10 flex items-center gap-1.5 pl-3">
                      {item.open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                      <span className="truncate">{item.group.label}</span>
                      <span className="tabular font-normal text-muted">{item.summary}</span>
                    </div>
                    {ordered.slice(span).map((column, index) => (
                      <div
                        key={column.id}
                        role="gridcell"
                        style={{ width: column.getSize(), flex: span + index === ordered.length - 1 ? '1 0 auto' : '0 0 auto' }}
                        className={cn('tabular truncate px-3', column.columnDef.meta.align === 'right' && 'text-right')}
                      >
                        {column.columnDef.meta.subtotal?.(item.group) ?? ''}
                      </div>
                    ))}
                  </div>
                )
              }
              const id = rowKey(item.row)
              return (
                <div
                  key={id}
                  id={idOf(slot.index)}
                  role="row"
                  aria-rowindex={slot.index + 2}
                  aria-selected={current}
                  style={base}
                  onClick={() => {
                    setActive(slot.index)
                    onOpen?.(item.row)
                  }}
                  className={cn(
                    'group/row flex cursor-pointer border-b border-line/60 text-xs text-fg hover:bg-surface-2',
                    openId === id && 'bg-accent/8',
                    current &&
                      'group-focus-visible/grid:outline-2 group-focus-visible/grid:-outline-offset-2 group-focus-visible/grid:outline-accent',
                  )}
                  data-sw-grid-row={id}
                >
                  {ordered.map((column, index) => {
                    const meta = column.columnDef.meta
                    const pinned = Boolean(column.getIsPinned())
                    return (
                      <div
                        key={column.id}
                        role="gridcell"
                        aria-colindex={index + 1}
                        style={{
                          width: column.getSize(),
                          flex: index === ordered.length - 1 ? '1 0 auto' : '0 0 auto',
                          ...(pinned ? { left: offsets[index] } : {}),
                        }}
                        className={cn(
                          'flex min-w-0 items-center px-3',
                          meta.align === 'right' && 'tabular justify-end',
                          pinned && 'sticky z-10 bg-surface group-hover/row:bg-surface-2',
                          pinned && openId === id && 'bg-[color-mix(in_srgb,var(--accent)_8%,var(--surface))]',
                          pinned && index === lastPinned && 'border-r border-line',
                          item.depth && index === 0 && 'pl-8',
                        )}
                        data-sw-grid-cell={column.id}
                      >
                        <span className="min-w-0 truncate">{meta.cell(item.row)}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {footer}
    </div>
  )
}

// A column's own menu: sort, pin, move, hide.
function ColumnMenu({ column, meta, index, layout, onLayout, canHide }) {
  const pinned = Boolean(column.getIsPinned())
  const shownOrder = layout.order.filter((id) => !layout.hidden.includes(id))
  const at = shownOrder.indexOf(column.id)
  const swap = (step) => {
    const other = shownOrder[at + step]
    if (!other) return
    const order = [...layout.order]
    const a = order.indexOf(column.id)
    const b = order.indexOf(other)
    order[a] = other
    order[b] = column.id
    onLayout({ ...layout, order })
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${meta.title || meta.header}: column options`}
          tabIndex={-1}
          className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-faint opacity-0 outline-none hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:opacity-100 [[role=columnheader]:hover_&]:opacity-100"
          data-sw-grid-menu={column.id}
        >
          <MoreVertical size={13} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {column.getCanSort() ? (
          <>
            <DropdownMenuItem onSelect={() => column.toggleSorting(false)}>
              <ArrowUp size={14} aria-hidden="true" /> Sort ascending
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => column.toggleSorting(true)}>
              <ArrowDown size={14} aria-hidden="true" /> Sort descending
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => column.pin(pinned ? false : 'start')} data-sw-grid-pin={column.id}>
          {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />} {pinned ? 'Unpin' : 'Pin to the left'}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={at <= 0} onSelect={() => swap(-1)}>
          <ArrowLeft size={14} aria-hidden="true" /> Move left
        </DropdownMenuItem>
        <DropdownMenuItem disabled={at < 0 || at >= shownOrder.length - 1} onSelect={() => swap(1)}>
          <ArrowRight size={14} aria-hidden="true" /> Move right
        </DropdownMenuItem>
        {canHide && !meta.always ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => column.toggleVisibility(false)} data-sw-grid-hide={column.id}>
              <EyeOff size={14} aria-hidden="true" /> Hide this column
            </DropdownMenuItem>
          </>
        ) : null}
        <span className="sr-only">Column {index + 1}</span>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Which columns show and in which order; pin from here too.
export function ColumnChooser({ columns, layout, onLayout, onReset }) {
  const byId = new Map(columns.map((column) => [column.id, column]))
  const toggle = (id) => {
    const hidden = layout.hidden.includes(id) ? layout.hidden.filter((item) => item !== id) : [...layout.hidden, id]
    // A column that comes back goes after the visible ones.
    const order = [...layout.order.filter((item) => !hidden.includes(item)), ...layout.order.filter((item) => hidden.includes(item))]
    onLayout({ order, hidden, pinned: layout.pinned.filter((item) => !hidden.includes(item)) })
  }
  const move = (id, step) => {
    const order = [...layout.order]
    const at = order.indexOf(id)
    const to = at + step
    if (to < 0 || to >= order.length) return
    ;[order[at], order[to]] = [order[to], order[at]]
    onLayout({ ...layout, order })
  }
  const pin = (id) =>
    onLayout({ ...layout, pinned: layout.pinned.includes(id) ? layout.pinned.filter((item) => item !== id) : [...layout.pinned, id] })
  return (
    <Popover history={false}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary" className="h-9" data-sw-grid-columns>
          <Columns3 size={14} aria-hidden="true" /> Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <ul className="max-h-80 overflow-y-auto" aria-label="Columns">
          {layout.order.map((id, index) => {
            const column = byId.get(id)
            if (!column) return null
            const shown = !layout.hidden.includes(id)
            return (
              <li key={id} className="flex items-center gap-0.5 rounded-md px-1 hover:bg-surface-2">
                <label className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={shown}
                    disabled={column.always}
                    onChange={() => toggle(id)}
                    className="h-4 w-4 accent-[var(--accent)]"
                    data-sw-grid-column={id}
                  />
                  <span className="truncate">{column.title || column.header}</span>
                </label>
                <IconButton
                  label={layout.pinned.includes(id) ? `Unpin ${column.header}` : `Pin ${column.header} to the left`}
                  size="icon-xs"
                  disabled={!shown}
                  onClick={() => pin(id)}
                >
                  {layout.pinned.includes(id) ? (
                    <Pin size={13} className="text-accent" aria-hidden="true" />
                  ) : (
                    <Pin size={13} aria-hidden="true" />
                  )}
                </IconButton>
                <IconButton label={`Move ${column.header} up`} size="icon-xs" disabled={index === 0} onClick={() => move(id, -1)}>
                  <ArrowUp size={13} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={`Move ${column.header} down`}
                  size="icon-xs"
                  disabled={index === layout.order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  <ArrowDown size={13} aria-hidden="true" />
                </IconButton>
              </li>
            )
          })}
        </ul>
        <div className="mt-1 border-t border-line pt-1">
          <Button size="sm" variant="ghost" className="w-full justify-start" onClick={onReset} data-sw-grid-columns-reset>
            <RotateCcw size={13} aria-hidden="true" /> Back to the usual columns
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
