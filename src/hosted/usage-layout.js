// The layout of the Usage dashboard, as plain values with no imports beyond
// the usage shape: the widgets there are, what each may be sized to and
// which options it takes, and every change a person can make to a layout
// (move, resize, hide, add, duplicate, reorder, reset). The server
// (usage.js), the console and the public demo all go through this file, so
// a stored layout is checked the same way wherever it is read or written.
//
// A layout is { v, items }: one item per widget on a grid of 12 columns,
// { id, type, x, y, w, h, options }. Rows are a fixed height; a widget is
// `h` rows tall. The widgets' order and sizes are the layout: their places
// follow by flowing them into the grid (flow), so nothing overlaps, nothing
// floats, and a change never leaves a hole the widgets after it fit.
// Narrower screens show the same layout reflowed to fewer columns (reflow),
// never a second stored layout.
//
// A list, a breakdown and the budgets are as tall as what they hold (so many
// rows, so many projects) until someone sizes them by hand: such an item
// carries `auto: true`, and fitLayout gives it its height.
//
// Nothing here trusts what it is given. cleanLayout drops any item whose
// type is unknown or whose size or place is out of range, and any option
// that is not one of the listed values; what is left is safe to draw.

import { USAGE_BUCKETS, USAGE_DIMENSIONS, USAGE_METRICS } from './usage-shape.js'

export const LAYOUT_VERSION = 1
export const LAYOUT_COLS = 12
export const LAYOUT_LIMITS = {
  // The stored JSON, in characters.
  bytes: 16_000,
  // Widgets on one dashboard.
  items: 40,
  // Copies of one chart.
  copies: 4,
  // The lowest row a widget may start on.
  rows: 400,
}
// The grid in pixels: a row's height and the gap between widgets.
export const LAYOUT_ROW = 56
export const LAYOUT_GAP = 16
// Columns by the width of the dashboard itself: 12 on a desktop or a
// tablet held sideways, 6 on a narrow window, 2 on a phone (tiles side by
// side, everything else one under the other).
export const LAYOUT_MODES = [
  { cols: 12, min: 840 },
  { cols: 6, min: 560 },
  { cols: 2, min: 0 },
]
export const colsFor = (width) => LAYOUT_MODES.find((mode) => width >= mode.min).cols

const clamp = (value, low, high) => Math.min(Math.max(value, low), high)
const bool = (fallback) => ({ kind: 'bool', fallback })
const pick = (values, fallback) => ({ kind: 'enum', values, fallback })
const some = (values, fallback) => ({ kind: 'set', values, fallback })

// (`oldMinW`: the least a stored layout may still hold from before the least
// was raised; it reads as the least there is now.)
const TILE = { w: 4, h: 2, minW: 3, oldMinW: 2, maxW: 4, minH: 2, maxH: 2 }
const CHART = { w: 6, h: 5, minW: 4, maxW: 12, minH: 4, maxH: 8 }
const LIST = { w: 3, h: 4, minW: 3, maxW: 6, minH: 3, maxH: 9 }
const VIEW = pick(['chart', 'table'], 'chart')
const tile = (title, spark) => ({
  title,
  group: 'tile',
  size: TILE,
  options: { ...(spark === null ? {} : { spark: bool(spark) }), compare: bool(true) },
})
// `auto(options, facts)`: the rows a widget needs for what it holds.
const list = (title) => ({
  title,
  group: 'list',
  size: LIST,
  options: { rows: pick([3, 5, 10], 5) },
  auto: (options) => ({ 3: 3, 5: 4, 10: 7 })[options.rows],
})

export const TIME_STYLES = ['stacked', 'grouped', 'lines']
export const PERCENTILES = ['p50', 'p90', 'p95', 'p99']
// Every widget type. `many`: a chart that may be on the dashboard more than
// once, each copy with its own options. `admin`: drawn for admins and
// owners only.
export const WIDGETS = {
  tile_calls: tile('Turns', true),
  tile_tokens: tile('Tokens', false),
  tile_duration: tile('Agent time', false),
  tile_cost: tile('Reported cost', false),
  tile_fixes: tile('Fixes ready', null),
  tile_failed: tile('Failed or stopped', false),
  time: {
    title: 'Usage over time',
    group: 'chart',
    many: true,
    size: { w: 12, h: 6, minW: 4, maxW: 12, minH: 4, maxH: 10 },
    options: {
      metric: pick(USAGE_METRICS, 'calls'),
      by: pick([...USAGE_DIMENSIONS, 'none'], 'agent'),
      // "auto": the bucket that suits the period.
      bucket: pick(['auto', ...USAGE_BUCKETS], 'auto'),
      style: pick(TIME_STYLES, 'stacked'),
      legend: bool(true),
      brush: bool(true),
      view: VIEW,
    },
  },
  breakdown: {
    title: 'Breakdown',
    group: 'chart',
    many: true,
    size: { w: 6, h: 5, minW: 3, maxW: 12, minH: 3, maxH: 10 },
    options: {
      by: pick(USAGE_DIMENSIONS, 'project'),
      // "chart": the measure of the first "over time" chart.
      metric: pick(['chart', ...USAGE_METRICS], 'chart'),
      rows: pick([5, 8, 12, 20], 8),
      share: bool(true),
      view: VIEW,
    },
    auto: (options) => ({ 5: 4, 8: 5, 12: 7, 20: 10 })[options.rows],
  },
  outcomes: {
    title: 'How turns ended',
    group: 'chart',
    many: true,
    size: CHART,
    options: { mode: pick(['share', 'counts'], 'share'), view: VIEW },
  },
  approvals: {
    title: 'Approvals',
    group: 'chart',
    many: true,
    size: CHART,
    options: { mode: pick(['stacked', 'separate'], 'stacked'), view: VIEW },
  },
  latency: {
    title: 'Turn duration',
    group: 'chart',
    many: true,
    size: CHART,
    options: { percentiles: some(PERCENTILES, ['p50', 'p95']), log: bool(false), view: VIEW },
  },
  top_agents: list('Busiest agents'),
  top_threads: list('Threads that used the most tokens'),
  top_slowest: list('Slowest turns'),
  top_denied: list('Most denied approvals'),
  budgets: {
    title: 'Budgets today',
    group: 'budgets',
    admin: true,
    size: { w: 12, h: 4, minW: 4, maxW: 12, minH: 3, maxH: 10 },
    options: {},
    // A row per project under the heading; from six projects on the list scrolls.
    auto: (_options, facts) =>
      Number.isInteger(facts?.budgets) ? clamp(Math.ceil((89 + Math.max(facts.budgets, 1) * 65) / 72), 3, 6) : null,
  },
}
export const WIDGET_TYPES = Object.keys(WIDGETS)
const known = (type) => typeof type === 'string' && Object.hasOwn(WIDGETS, type)
const ID = /^[a-z][a-z0-9_]{0,23}(?:-[1-9][0-9]?)?$/

export class LayoutError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---- Options ----

// A widget's options with every key present: what was stored where it is
// one of the listed values, the default where it is not. Unknown keys go.
export function cleanOptions(type, given) {
  const out = {}
  if (!known(type)) return out
  const source = given && typeof given === 'object' && !Array.isArray(given) ? given : {}
  for (const [key, spec] of Object.entries(WIDGETS[type].options)) {
    const value = Object.hasOwn(source, key) ? source[key] : undefined
    if (spec.kind === 'bool') out[key] = typeof value === 'boolean' ? value : spec.fallback
    else if (spec.kind === 'enum') out[key] = spec.values.includes(value) ? value : spec.fallback
    else {
      // A set: listed values only, in the listed order, never empty.
      const chosen = Array.isArray(value) ? spec.values.filter((item) => value.includes(item)) : []
      out[key] = chosen.length ? chosen : [...spec.fallback]
    }
  }
  return out
}

// ---- Geometry ----

const whole = (value) => Number.isInteger(value)
export const collides = (a, b) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const byPlace = (a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const firstHit = (placed, item) => placed.find((other) => collides(other, item))
// The widgets from the top left, row by row: the order a narrow screen, a
// printed page and a screen reader take them in.
export const readingOrder = (items) => [...items].sort(byPlace)

// The widgets flowed into the grid in the order given, like words on a
// page: each goes to the first place after the one before it (row by row
// from the top, left to right) where it fits. So nothing overlaps, nothing
// floats, and a widget that is hidden, moved or resized never leaves a hole
// that the widgets after it fit: they close up. The order is the layout;
// the places follow from it, so flowing a flowed layout changes nothing.
export function flow(items, cols = LAYOUT_COLS) {
  const placed = []
  let from = { x: 0, y: 0 }
  for (const given of items) {
    const w = Math.min(given.w, cols)
    let spot = null
    for (let y = from.y; !spot; y += 1)
      for (let x = y === from.y ? from.x : 0; x + w <= cols && !spot; x += 1) {
        const at = { ...given, w, x, y }
        if (!firstHit(placed, at)) spot = at
      }
    placed.push(spot)
    // The next one starts after this one (on its row, to its right).
    from = { x: spot.x + 1, y: spot.y }
  }
  return placed
}
// A layout's items tidied: flowed in their reading order. (A tidy layout
// comes out as it went in, so what is stored reads back the same.)
export const compact = (items, cols = LAYOUT_COLS) => flow(readingOrder(items), cols)

// Where a widget dragged to a point of the grid (in columns and rows, the
// pointer's place) goes in the order: in front of the widget under the
// point when it is dragged back, after it when it is dragged on; over empty
// space, after every widget that starts before that place. Returns the id
// of the widget it goes in front of (null: last). `items`: the widgets
// where they are drawn.
export function dropBefore(items, id, px, py) {
  const order = readingOrder(items)
  const self = order.find((item) => item.id === id)
  if (!self) return null
  const others = order.filter((item) => item.id !== id)
  const under = others.find((item) => px >= item.x && px < item.x + item.w && py >= item.y && py < item.y + item.h)
  if (under) {
    const on = order.indexOf(under) > order.indexOf(self)
    return on ? (others[others.indexOf(under) + 1]?.id ?? null) : under.id
  }
  const x = Math.floor(px)
  const y = Math.floor(py)
  return others.find((item) => item.y > y || (item.y === y && item.x > x))?.id ?? null
}

const sizeOf = (type) => WIDGETS[type].size
// A size inside what the widget's type allows, and inside the grid.
export function fitSize(type, w, h, x = 0) {
  const size = sizeOf(type)
  return { w: clamp(w, size.minW, Math.min(size.maxW, LAYOUT_COLS - x)), h: clamp(h, size.minH, size.maxH) }
}

// ---- Reading a stored layout ----

// Older shapes of a stored layout, brought to the current one. Before a
// layout carried a version it was a bare list of grid items keyed `i`.
// A version this build does not know reads as no layout at all.
export function migrateLayout(stored) {
  if (Array.isArray(stored))
    return {
      v: LAYOUT_VERSION,
      items: stored.map((item) =>
        item && typeof item === 'object'
          ? {
              id: item.i,
              type: typeof item.i === 'string' ? item.i.replace(/-[0-9]+$/, '') : undefined,
              x: item.x,
              y: item.y,
              w: item.w,
              h: item.h,
              options: item.options,
            }
          : item,
      ),
    }
  if (!stored || typeof stored !== 'object') return null
  if (stored.v !== LAYOUT_VERSION) return null
  return stored
}

function cleanItem(given, seen, counts) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return null
  const { id, type, x, y, w, h } = given
  if (!known(type) || typeof id !== 'string' || !ID.test(id) || seen.has(id)) return null
  const size = sizeOf(type)
  if (![x, y, w, h].every(whole)) return null
  if (w < (size.oldMinW ?? size.minW) || w > size.maxW || h < size.minH || h > size.maxH) return null
  if (x < 0 || x + w > LAYOUT_COLS || y < 0 || y > LAYOUT_LIMITS.rows) return null
  const count = counts.get(type) || 0
  if (count >= (WIDGETS[type].many ? LAYOUT_LIMITS.copies : 1)) return null
  counts.set(type, count + 1)
  seen.add(id)
  const item = { id, type, x, y, w: Math.max(w, size.minW), h, options: cleanOptions(type, given.options) }
  // Whether its height still follows what it holds. A layout stored before this was kept: it does while it has the default height.
  if (WIDGETS[type].auto) item.auto = typeof given.auto === 'boolean' ? given.auto : h === size.h
  return item
}

// A layout as it may be stored and drawn, from anything at all. Throws a
// LayoutError for something that is not a layout (or is too large to be
// one); drops the items and options it does not know.
export function cleanLayout(given) {
  let size
  try {
    size = JSON.stringify(given)?.length ?? 0
  } catch {
    throw new LayoutError('invalid_layout', 'layout: an object with its widgets.')
  }
  if (size > LAYOUT_LIMITS.bytes) throw new LayoutError('layout_too_large', `A layout holds at most ${LAYOUT_LIMITS.bytes} characters.`)
  const layout = migrateLayout(given)
  if (!layout || !Array.isArray(layout.items)) throw new LayoutError('invalid_layout', 'layout: { v, items } as the page saves it.')
  const seen = new Set()
  const counts = new Map()
  const items = []
  for (const item of layout.items) {
    if (items.length >= LAYOUT_LIMITS.items) break
    const clean = cleanItem(item, seen, counts)
    if (clean) items.push(clean)
  }
  return { v: LAYOUT_VERSION, items: compact(items) }
}
// The same, for a reader: anything that is not a layout reads as none.
export function readLayout(given) {
  try {
    return given === null || given === undefined ? null : cleanLayout(given)
  } catch {
    return null
  }
}

// ---- The default ----

const at = (type, x, y, extra = {}) => ({
  id: type,
  type,
  x,
  y,
  w: sizeOf(type).w,
  h: sizeOf(type).h,
  options: cleanOptions(type, {}),
  ...(WIDGETS[type].auto ? { auto: true } : {}),
  ...extra,
})
// The dashboard as it is before anyone changes it: six tiles, usage over
// time, four charts in pairs, the top lists, the budgets.
export function defaultLayout() {
  return {
    v: LAYOUT_VERSION,
    items: [
      at('tile_calls', 0, 0),
      at('tile_tokens', 4, 0),
      at('tile_duration', 8, 0),
      at('tile_cost', 0, 2),
      at('tile_fixes', 4, 2),
      at('tile_failed', 8, 2),
      at('time', 0, 4),
      at('breakdown', 0, 10),
      at('outcomes', 6, 10),
      at('approvals', 0, 15),
      at('latency', 6, 15),
      at('top_agents', 0, 20),
      at('top_threads', 3, 20),
      at('top_slowest', 6, 20),
      at('top_denied', 9, 20),
      at('budgets', 0, 24),
    ],
  }
}
export const sameLayout = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// What a reader may see of a layout: the admin-only widgets leave (and the
// rest close up) for everyone else.
export function visibleItems(layout, { admin = false } = {}) {
  const items = layout.items.filter((item) => admin || !WIDGETS[item.type].admin)
  return items.length === layout.items.length ? layout.items : compact(items)
}

// The layout with every widget whose height follows its content at the
// height that content needs now. `facts`: what only the page knows
// ({ budgets: how many projects have budgets }); a height that cannot be
// worked out yet stays as stored. The same layout when nothing changes.
export function fitLayout(layout, facts = {}) {
  let changed = false
  const items = layout.items.map((item) => {
    if (!item.auto) return item
    const wanted = WIDGETS[item.type].auto(item.options, facts)
    const size = sizeOf(item.type)
    const h = Number.isInteger(wanted) ? clamp(wanted, size.minH, size.maxH) : item.h
    if (h === item.h) return item
    changed = true
    return { ...item, h }
  })
  return changed ? { v: LAYOUT_VERSION, items: compact(items) } : layout
}

// ---- Changes ----

const withItems = (layout, items) => ({ v: LAYOUT_VERSION, items })
const find = (layout, id) => layout.items.find((item) => item.id === id)

// Puts a widget in front of another in the order (null: last); everything
// flows again from there.
export function placeBefore(layout, id, before) {
  const order = readingOrder(layout.items)
  const item = order.find((other) => other.id === id)
  if (!item || before === id) return layout
  const rest = order.filter((other) => other.id !== id)
  const at = before === null ? rest.length : rest.findIndex((other) => other.id === before)
  if (at < 0) return layout
  rest.splice(at, 0, item)
  const items = flow(rest)
  return sameLayout(items, layout.items) ? layout : withItems(layout, items)
}
// A widget dragged by its top left corner to a column and a row: it goes
// where dropBefore says for that corner.
export function moveItem(layout, id, x, y) {
  return find(layout, id) ? placeBefore(layout, id, dropBefore(layout.items, id, x + 0.5, y + 0.5)) : layout
}
// Sizes a widget, inside what its type allows; the ones after it flow again.
export function resizeItem(layout, id, w, h) {
  const item = find(layout, id)
  if (!item) return layout
  // (Never past the right edge from where it is: a corner dragged there stops there.)
  const next = { ...item, ...fitSize(item.type, Math.round(w), Math.round(h), item.x) }
  if (next.w === item.w && next.h === item.h) return layout
  // A height set by hand stays as it was set.
  if (item.auto && next.h !== item.h) next.auto = false
  const changed = new Map([[id, next]])
  // A row stays whole: the widget just to its right gives or takes the width
  // (when its own sizes allow), and the widgets beside it that were as tall
  // take the new height, so a resize never opens a hole beside or under it.
  const row = layout.items.filter((other) => other.id !== id && other.y === item.y)
  const dw = next.w - item.w
  // The tiles are one row of numbers: they share one width (three or four to a row).
  const tile = WIDGETS[item.type]?.group === 'tile'
  if (dw && tile)
    for (const other of layout.items)
      if (other.id !== id && WIDGETS[other.type]?.group === 'tile') changed.set(other.id, { ...other, w: next.w })
  const right = dw && !tile ? row.find((other) => other.x === item.x + item.w) : null
  // The last of a full row made narrower: the one to its left takes the width (else the row would be drawn across again
  // and the widget would look stuck at its width).
  const left = dw < 0 && !tile && !right && item.x + item.w === LAYOUT_COLS ? row.find((other) => other.x + other.w === item.x) : null
  for (const other of [right, left]) {
    if (!other) continue
    const size = sizeOf(other.type)
    const w2 = other.w - dw
    if (w2 >= size.minW && w2 <= size.maxW) changed.set(other.id, { ...other, w: w2 })
  }
  let items = flow(readingOrder(layout.items).map((other) => changed.get(other.id) ?? other))
  if (next.h !== item.h) {
    // (Beside it once it has its new width: a neighbour that went on to the next row keeps its height.)
    const placed = items.find((other) => other.id === id)
    const beside = (other) => {
      const size = sizeOf(other.type)
      // (A widget as tall as what it holds keeps its own height: only the ones sized like it follow.)
      return other.id !== id && !other.auto && other.y === placed.y && other.h === item.h && next.h >= size.minH && next.h <= size.maxH
    }
    if (items.some(beside))
      items = flow(items.map((other) => (beside(other) ? { ...other, h: next.h, ...(other.auto ? { auto: false } : {}) } : other)))
  }
  return withItems(layout, items)
}
const overlapsColumns = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w
// One step with an arrow key. Left and right: one place back or on in the
// order (beside it, they change places). Up and down: in front of the
// widget above it, or after the widget below it.
export function stepMove(layout, id, direction) {
  const order = readingOrder(layout.items)
  const at = order.findIndex((other) => other.id === id)
  if (at < 0) return layout
  const item = order[at]
  if (direction === 'left') return at > 0 ? placeBefore(layout, id, order[at - 1].id) : layout
  if (direction === 'right') return at < order.length - 1 ? placeBefore(layout, id, order[at + 2]?.id ?? null) : layout
  const others = order.filter((other) => other.id !== id && overlapsColumns(other, item))
  const other =
    direction === 'up'
      ? others.filter((one) => one.y + one.h <= item.y).sort((a, b) => b.y + b.h - (a.y + a.h) || a.x - b.x)[0]
      : others.filter((one) => one.y >= item.y + item.h).sort((a, b) => a.y - b.y || a.x - b.x)[0]
  if (!other) return layout
  // The two change places in the order.
  const swapped = [...order]
  swapped[at] = other
  swapped[order.indexOf(other)] = item
  return withItems(layout, flow(swapped))
}
// One step with Shift and an arrow key: a column wider or narrower, a row
// taller or shorter.
export function stepResize(layout, id, direction) {
  const item = find(layout, id)
  if (!item) return layout
  const dw = direction === 'right' ? 1 : direction === 'left' ? -1 : 0
  const dh = direction === 'down' ? 1 : direction === 'up' ? -1 : 0
  return resizeItem(layout, id, item.w + dw, item.h + dh)
}

export function setOptions(layout, id, changes) {
  return withItems(
    layout,
    layout.items.map((item) => (item.id === id ? { ...item, options: cleanOptions(item.type, { ...item.options, ...changes }) } : item)),
  )
}
export const removeItem = (layout, id) => withItems(layout, compact(layout.items.filter((item) => item.id !== id)))
const bottomOf = (items) => items.reduce((low, item) => Math.max(low, item.y + item.h), 0)
function freeId(layout, type) {
  if (!find(layout, type)) return type
  for (let n = 2; n < 100; n += 1) if (!find(layout, `${type}-${n}`)) return `${type}-${n}`
  return null
}
// How many more of a type the dashboard takes.
export function roomFor(layout, type) {
  if (!known(type) || layout.items.length >= LAYOUT_LIMITS.items) return 0
  const have = layout.items.filter((item) => item.type === type).length
  return Math.max(0, (WIDGETS[type].many ? LAYOUT_LIMITS.copies : 1) - have)
}
// The types not on the dashboard: what "Add widget" lists.
export const hiddenTypes = (layout, { admin = false } = {}) =>
  WIDGET_TYPES.filter((type) => (admin || !WIDGETS[type].admin) && !layout.items.some((item) => item.type === type))

// Adds a widget at its default size, after the last one (`before`: in
// front of that widget instead). Returns { layout, id } (the same layout
// and no id when there is no room for one).
export function addItem(layout, type, options = {}, { before = null } = {}) {
  const id = roomFor(layout, type) ? freeId(layout, type) : null
  if (!id) return { layout, id: null }
  const item = { ...at(type, 0, bottomOf(layout.items)), id, options: cleanOptions(type, options) }
  const order = readingOrder(layout.items)
  const index = before === null ? -1 : order.findIndex((other) => other.id === before)
  order.splice(index < 0 ? order.length : index, 0, item)
  return { layout: withItems(layout, flow(order)), id }
}
// A second copy of a chart, with the same options, right after the first:
// beside it where there is room, under it where there is not.
export function duplicateItem(layout, id) {
  const item = find(layout, id)
  if (!item || !WIDGETS[item.type].many || !roomFor(layout, item.type)) return { layout, id: null }
  const copy = { ...item, id: freeId(layout, item.type), options: cleanOptions(item.type, item.options) }
  const order = readingOrder(layout.items)
  order.splice(order.indexOf(item) + 1, 0, copy)
  return { layout: withItems(layout, flow(order)), id: copy.id }
}

// ---- Narrower screens ----

// How wide a widget is on a grid of fewer columns.
function narrowWidth(item, cols) {
  if (cols >= LAYOUT_COLS) return item.w
  const group = WIDGETS[item.type].group
  if (cols === 2) return group === 'tile' ? 1 : 2
  const least = group === 'tile' ? 2 : group === 'list' ? 3 : cols
  return clamp(Math.round((item.w * cols) / LAYOUT_COLS), least, cols)
}
// The layout on a grid of `cols` columns: the same widgets in reading
// order, at the widths that grid allows. 12 columns: the layout itself.
export function reflow(items, cols = LAYOUT_COLS) {
  if (cols >= LAYOUT_COLS) return items
  return flow(
    readingOrder(items).map((item) => ({ ...item, w: narrowWidth(item, cols) })),
    cols,
  )
}

// The layout as it is drawn: a row that stops short of the right edge, with
// nothing that could fill the rest, shares the rest among its widgets (the
// ones that end the row and are as tall as its last). Only the drawing:
// what is stored keeps its own widths, so a widget added back or moved finds
// the room it had.
export function fill(items, cols = LAYOUT_COLS) {
  const out = items.map((item) => ({ ...item }))
  const taken = (c, top, bottom, skip) =>
    out.some((other) => !skip.has(other) && other.x <= c && c < other.x + other.w && other.y < bottom && top < other.y + other.h)
  for (const y of [...new Set(out.map((item) => item.y))].sort((a, b) => a - b)) {
    const row = out.filter((item) => item.y === y).sort((a, b) => a.x - b.x)
    const last = row[row.length - 1]
    // The run of widgets side by side that ends the row, all as tall as the last.
    const run = [last]
    for (let at = row.length - 2; at >= 0; at--) {
      const one = row[at]
      if (one.x + one.w !== run[0].x || one.h !== last.h) break
      run.unshift(one)
    }
    const skip = new Set(run)
    let spare = 0
    while (last.x + last.w + spare < cols && !taken(last.x + last.w + spare, y, y + last.h, skip)) spare++
    if (!spare) continue
    let x = run[0].x
    run.forEach((item, index) => {
      item.w += Math.floor(spare / run.length) + (index < spare % run.length ? 1 : 0)
      item.x = x
      x += item.w
    })
  }
  return out
}

// ---- Drawn heights ----
//
// A widget as tall as what it holds (a list, a breakdown, the budgets, while
// nobody sized it by hand) is drawn at the height of its content, measured
// on the page, not at the rows it is stored with: a breakdown of two
// projects is no taller than two rows of bars. So the grid is drawn on finer
// rows, LAYOUT_SUB to a row: a stored height of h is drawn h * LAYOUT_SUB
// fine rows tall, the same pixels as ever.
export const LAYOUT_SUB = 4
// A fine row's pitch in pixels (one fine row and the gap after it), and the
// height a fine row is given to the grid so that h fine rows and the gaps
// between them come to the same pixels as a stored row.
export const LAYOUT_SUB_PITCH = (LAYOUT_ROW + LAYOUT_GAP) / LAYOUT_SUB
export const LAYOUT_SUB_ROW = LAYOUT_SUB_PITCH - LAYOUT_GAP
// The fine rows a widget whose card is `px` tall takes (never fewer than a heading needs).
export const subRowsFor = (px) => Math.max(6, Math.ceil((px + LAYOUT_GAP) / LAYOUT_SUB_PITCH))
// Whether a widget is drawn at the height of its content.
export const fitsContent = (item) => Boolean(item.auto && WIDGETS[item.type]?.auto)

// The widgets as drawn, in fine rows: each at its own height (`fitted`:
// { id: fine rows } for the widgets that are as tall as their content; the
// rest at their stored height). The stored layout is taken a band at a time
// (rows no widget reaches across, grouped as below: the tiles, the charts in
// pairs, the top lists, the budgets): in a band the widgets flow in
// reading order as the stored layout does, so a widget under a shorter one
// moves up into the room it leaves, and a chart that ends a column short of
// the band's bottom reaches down to it. A widget as tall as its content that
// still ends short of the band, with nothing that fits under it, reaches down
// last, so a band never leaves a hole and always ends on one line (a Top 5
// beside a Top 10 is as tall as it, its rows at its top). Bands stay in line
// with each other, so a row of lists keeps one top edge, and the lists side
// by side in a row, set to the same number of rows, are as tall as the
// tallest of them.
export function settle(items, cols = LAYOUT_COLS, fitted = {}) {
  const order = readingOrder(items)
  // (Never taller than the rows it is given for what it holds: past those it scrolls, as it always has.)
  const own = (item) => (fitsContent(item) && Number.isInteger(fitted[item.id]) ? Math.min(fitted[item.id], item.h * LAYOUT_SUB) : null)
  const heights = new Map(order.map((item) => [item.id, own(item) ?? item.h * LAYOUT_SUB]))
  for (const item of order) {
    if (WIDGETS[item.type].group !== 'list' || own(item) === null) continue
    const run = order.filter(
      (other) => other.y === item.y && other.h === item.h && WIDGETS[other.type].group === 'list' && own(other) !== null,
    )
    heights.set(item.id, Math.max(...run.map((other) => own(other))))
  }
  // Rows: the runs no widget reaches across. A row joins the band above it when it is split into the same columns
  // (charts in pairs, row after row, are two columns), or when it holds charts only: they can take up what the
  // band above leaves uneven.
  const rows = []
  let bottom = -1
  for (const item of order) {
    if (item.y >= bottom) rows.push([])
    rows[rows.length - 1].push(item)
    bottom = Math.max(bottom, item.y + item.h)
  }
  const stretches = (item) => WIDGETS[item.type].group === 'chart' && !WIDGETS[item.type].auto
  const columnsOf = (row) => row.map((item) => `${item.x}:${item.w}`).join(' ')
  const bands = []
  rows.forEach((row, index) => {
    if (index && (columnsOf(row) === columnsOf(rows[index - 1]) || row.every(stretches))) bands[bands.length - 1].push(...row)
    else bands.push([...row])
  })
  const out = []
  let top = 0
  for (const band of bands) {
    // The band drawn with its widgets as tall as their content, then (should that leave a hole no widget can
    // reach into, as when the charts under a short widget are split into other columns than the row above)
    // with one of them, or none, kept at its stored height: the first with the fewest empty cells wins.
    const fits = band.filter((item) => heights.get(item.id) !== item.h * LAYOUT_SUB)
    let best = null
    for (const tall of [null, ...fits.map((item) => item.id), ...(fits.length > 1 ? ['*'] : [])]) {
      const height = (item) => (tall === '*' || tall === item.id ? item.h * LAYOUT_SUB : heights.get(item.id))
      const fitted = new Set(band.filter((item) => height(item) !== item.h * LAYOUT_SUB).map((item) => item.id))
      const tried = settleBand(
        band.map((item) => ({ ...item, h: height(item) })),
        cols,
        stretches,
        fitted,
      )
      if (!best || tried.holes < best.holes) best = tried
      if (!best.holes) break
    }
    for (const item of best.placed) out.push({ ...item, y: item.y + top })
    top += best.end
  }
  return out
}

// One band of settle(): flowed, then every column reaches down to the band's end where nothing is under it.
// Returns the places, the band's end and how many cells of it are left empty. `fitted`: the ids drawn shorter
// than stored, at their content's height (a widget sized by hand keeps the height it was given).
function settleBand(items, cols, stretches, fitted) {
  const placed = flow(items, cols)
  const end = placed.reduce((low, item) => Math.max(low, item.y + item.h), 0)
  const taken = (c, row, self) =>
    placed.some((other) => other !== self && other.x <= c && c < other.x + other.w && other.y <= row && row < other.y + other.h)
  const reach = (item) => {
    const under = (other) => other !== item && other.y >= item.y + item.h && other.x < item.x + item.w && item.x < other.x + other.w
    const below = Math.min(end, ...placed.filter(under).map((other) => other.y))
    const free = (row) => !Array.from({ length: item.w }, (_, at) => item.x + at).some((c) => taken(c, row, item))
    while (item.y + item.h < below && free(item.y + item.h)) item.h += 1
  }
  // The charts first (a plot can take the room). Then whatever still ends short of the band (a short list
  // beside a longer one, a breakdown with nothing that fits under it) reaches down too, so no hole is left
  // and the band ends on one line: its card ends there, what it holds stays at its top.
  for (const item of placed) if (stretches(item)) reach(item)
  for (const item of placed) if (!stretches(item) && fitted.has(item.id)) reach(item)
  const used = new Set(placed.map((item) => item.x + item.w))
  const right = Math.max(...used)
  let holes = 0
  for (let c = 0; c < right; c += 1) for (let row = 0; row < end; row += 1) if (!taken(c, row, null)) holes += 1
  return { placed, end, holes }
}

// Moves a widget to a place in the reading order (what the up and down
// buttons of a narrow screen do, and a drag on fewer columns).
export function reorder(layout, id, index) {
  const order = readingOrder(layout.items)
  const from = order.findIndex((item) => item.id === id)
  if (from < 0) return layout
  const to = clamp(index, 0, order.length - 1)
  if (to === from) return layout
  const rest = order.filter((item) => item.id !== id)
  return placeBefore(layout, id, rest[to]?.id ?? null)
}

// What a screen reader hears after a move or a resize.
export function describeItem(item) {
  return `row ${item.y + 1}, column ${item.x + 1}; ${item.w} wide, ${item.h} tall`
}
