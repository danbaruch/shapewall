// The model of the Usage dashboard's layout (src/hosted/usage-layout.js):
// what a stored layout may hold, how widgets close up and reflow, the
// default, the changes a person can make, and older stored shapes.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LAYOUT_COLS,
  LAYOUT_LIMITS,
  LAYOUT_VERSION,
  LayoutError,
  WIDGETS,
  WIDGET_TYPES,
  addItem,
  cleanLayout,
  cleanOptions,
  collides,
  colsFor,
  compact,
  defaultLayout,
  describeItem,
  duplicateItem,
  fitLayout,
  hiddenTypes,
  migrateLayout,
  moveItem,
  readLayout,
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
} from '../src/hosted/usage-layout.js'

const ids = (items) => readingOrder(items).map((item) => item.id)
const at = (layout, id) => layout.items.find((item) => item.id === id)
const place = (layout, id) => {
  const item = at(layout, id)
  return [item.x, item.y, item.w, item.h]
}
// Nothing overlaps, everything is inside the grid, and nothing could move up.
function assertTidy(items, cols = LAYOUT_COLS) {
  for (const a of items) {
    assert.ok(a.x >= 0 && a.x + a.w <= cols && a.y >= 0, `${a.id} is inside the grid`)
    for (const b of items) assert.ok(!collides(a, b), `${a.id} and ${b.id} do not overlap`)
    if (a.y > 0)
      assert.ok(
        items.some((b) => collides({ ...a, y: a.y - 1 }, b)),
        `${a.id} rests on something`,
      )
  }
}
const item = (id, x, y, w, h, extra = {}) => ({ id, type: id.replace(/-\d+$/, ''), x, y, w, h, ...extra })

test('the default: every widget once, tidy, and what cleaning gives back unchanged', () => {
  const layout = defaultLayout()
  assert.equal(layout.v, LAYOUT_VERSION)
  assert.deepEqual(layout.items.map((entry) => entry.type).sort(), [...WIDGET_TYPES].sort())
  assertTidy(layout.items)
  assert.deepEqual(cleanLayout(layout), layout, 'the default is a valid layout as it stands')
  // Three tiles to a row, the chart over time across the page, charts in pairs, four lists, the budgets.
  assert.deepEqual(place(layout, 'tile_fixes'), [4, 2, 4, 2])
  assert.deepEqual(place(layout, 'time'), [0, 4, 12, 6])
  assert.deepEqual(place(layout, 'latency'), [6, 15, 6, 5])
  assert.deepEqual(place(layout, 'top_denied'), [9, 20, 3, 4])
  assert.equal(at(layout, 'budgets').y, 24)
  // Every option has its default, and the defaults are what the page showed before it could be arranged.
  assert.deepEqual(at(layout, 'time').options, {
    metric: 'calls',
    by: 'agent',
    bucket: 'auto',
    style: 'stacked',
    legend: true,
    brush: true,
    view: 'chart',
  })
  assert.deepEqual(at(layout, 'latency').options, { percentiles: ['p50', 'p95'], log: false, view: 'chart' })
  assert.deepEqual(at(layout, 'tile_calls').options, { spark: true, compare: true })
  assert.deepEqual(at(layout, 'tile_fixes').options, { compare: true }, 'a tile with no trend has no trend option')
  assert.deepEqual(at(layout, 'budgets').options, {})
  // Two calls never share an object.
  defaultLayout().items[0].x = 9
  assert.equal(defaultLayout().items[0].x, 0)
})

test('validation: what is not a layout is refused', () => {
  for (const bad of [
    null,
    undefined,
    'layout',
    7,
    true,
    {},
    { v: 1 },
    { v: 1, items: 'none' },
    { v: 1, items: {} },
    { v: 99, items: [] },
    { items: [] },
  ]) {
    assert.throws(
      () => cleanLayout(bad),
      (error) => error instanceof LayoutError && error.code === 'invalid_layout',
      JSON.stringify(bad),
    )
    assert.equal(readLayout(bad), null)
  }
  const huge = { v: 1, items: [], pad: 'x'.repeat(LAYOUT_LIMITS.bytes) }
  assert.throws(
    () => cleanLayout(huge),
    (error) => error instanceof LayoutError && error.code === 'layout_too_large',
  )
  // Something that cannot even be written as JSON.
  const loop = { v: 1, items: [] }
  loop.self = loop
  assert.throws(() => cleanLayout(loop), LayoutError)
  assert.deepEqual(cleanLayout({ v: 1, items: [] }), { v: 1, items: [] }, 'an empty dashboard is a layout')
})

test('validation: unknown widgets, sizes and places out of range, and repeats are dropped', () => {
  const good = item('time', 0, 0, 12, 6)
  const kept = (entries) => cleanLayout({ v: 1, items: entries }).items.map((entry) => entry.id)
  assert.deepEqual(kept([good]), ['time'])
  const dropped = [
    item('clock', 0, 0, 4, 2),
    { ...good, type: 'constructor' },
    { ...good, type: '__proto__' },
    { ...good, type: 'toString' },
    { ...good, type: 7 },
    { ...good, id: 'Time' },
    { ...good, id: 'time 2' },
    { ...good, id: '' },
    { ...good, id: 'x'.repeat(40) },
    { ...good, id: 7 },
    { ...good, id: '<script>' },
    { ...good, w: 3 },
    { ...good, w: 13 },
    { ...good, h: 3 },
    { ...good, h: 11 },
    { ...good, h: 5.5 },
    { ...good, w: '12' },
    { ...good, w: NaN },
    { ...good, h: Infinity },
    { ...good, x: -1 },
    { ...good, x: 1 },
    { ...good, y: -1 },
    { ...good, y: LAYOUT_LIMITS.rows + 1 },
    { ...good, y: 1e9 },
    { ...good, x: null },
    item('tile_calls', 0, 0, 5, 2),
    item('tile_calls', 0, 0, 1, 2),
    item('tile_calls', 0, 0, 4, 3),
    item('tile_calls', 0, 0, 4, 1),
    null,
    'time',
    [],
    7,
  ]
  for (const entry of dropped) assert.deepEqual(kept([entry]), [], JSON.stringify(entry))
  // A bad item goes; the good ones around it stay.
  assert.deepEqual(kept([dropped[0], good, dropped[11]]), ['time'])
  // The same id twice: the first one holds. A tile is on the dashboard once; a chart at most four times.
  assert.deepEqual(kept([good, { ...good, y: 6 }]), ['time'])
  assert.deepEqual(kept([item('tile_calls', 0, 0, 4, 2), { ...item('tile_calls', 4, 0, 4, 2), id: 'tile_calls-2' }]), ['tile_calls'])
  const copies = [1, 2, 3, 4, 5, 6].map((n) => ({ ...item('time', 0, n * 6, 12, 6), id: n === 1 ? 'time' : `time-${n}` }))
  assert.deepEqual(kept(copies), ['time', 'time-2', 'time-3', 'time-4'])
  // More items than a dashboard holds: the rest are not read.
  const many = Array.from({ length: 200 }, (_, n) => ({ ...item('tile_calls', 0, n * 2, 4, 2), id: `t${n}` }))
  assert.ok(cleanLayout({ v: 1, items: [...many.slice(0, 60)] }).items.length <= LAYOUT_LIMITS.items)
  // Only the keys of an item are kept: nothing else rides along into storage.
  const [only] = cleanLayout({ v: 1, items: [{ ...good, static: true, html: '<img onerror=alert(1)>', __proto__: { evil: 1 } }] }).items
  assert.deepEqual(Object.keys(only).sort(), ['h', 'id', 'options', 'type', 'w', 'x', 'y'])
  assert.equal(only.evil, undefined)
})

test('validation: options keep listed values only, everything else is the default', () => {
  assert.deepEqual(
    cleanOptions('time', { metric: 'tokens', by: 'model', bucket: 'week', style: 'lines', legend: false, brush: false, view: 'table' }),
    {
      metric: 'tokens',
      by: 'model',
      bucket: 'week',
      style: 'lines',
      legend: false,
      brush: false,
      view: 'table',
    },
  )
  assert.deepEqual(
    cleanOptions('time', { metric: 'secrets', by: ['agent'], bucket: 7, style: '<b>', legend: 'yes', brush: 1, view: null, extra: 'x' }),
    defaultLayout().items.find((entry) => entry.id === 'time').options,
  )
  for (const junk of [null, undefined, 'x', 7, [], [{ metric: 'tokens' }]])
    assert.deepEqual(cleanOptions('breakdown', junk), cleanOptions('breakdown', {}))
  assert.deepEqual(cleanOptions('breakdown', { rows: 12, share: false, metric: 'cost', by: 'kind' }), {
    by: 'kind',
    metric: 'cost',
    rows: 12,
    share: false,
    view: 'chart',
  })
  assert.equal(cleanOptions('breakdown', { rows: 500 }).rows, 8)
  assert.equal(cleanOptions('breakdown', { rows: '12' }).rows, 8, 'a number written as text is not a listed value')
  assert.equal(cleanOptions('top_agents', { rows: 10 }).rows, 10)
  assert.equal(cleanOptions('top_agents', { rows: 11 }).rows, 5)
  assert.equal(cleanOptions('outcomes', { mode: 'counts' }).mode, 'counts')
  assert.equal(cleanOptions('approvals', { mode: 'separate' }).mode, 'separate')
  // A set: listed values in the listed order, never empty.
  assert.deepEqual(cleanOptions('latency', { percentiles: ['p99', 'p50', 'p1', 'p99'], log: true }), {
    percentiles: ['p50', 'p99'],
    log: true,
    view: 'chart',
  })
  assert.deepEqual(cleanOptions('latency', { percentiles: [] }).percentiles, ['p50', 'p95'])
  assert.deepEqual(cleanOptions('latency', { percentiles: 'p99' }).percentiles, ['p50', 'p95'])
  assert.deepEqual(cleanOptions('tile_cost', { spark: true, compare: false }), { spark: true, compare: false })
  assert.deepEqual(cleanOptions('clock', { anything: 1 }), {}, 'an unknown widget has no options')
  // Inherited keys are not options.
  assert.deepEqual(cleanOptions('time', Object.create({ metric: 'tokens' })).metric, 'calls')
  // Through a whole layout.
  const cleaned = cleanLayout({
    v: 1,
    items: [{ ...item('latency', 0, 0, 6, 5), options: { percentiles: ['p90'], log: 'true', nope: 1 } }],
  })
  assert.deepEqual(cleaned.items[0].options, { percentiles: ['p90'], log: false, view: 'chart' })
})

test('compaction: widgets close up, never overlap, and a tidy layout stays as it is', () => {
  // Gaps close.
  const gappy = compact([item('tile_calls', 0, 5, 4, 2), item('time', 0, 20, 12, 6), item('tile_tokens', 4, 9, 4, 2)])
  assertTidy(gappy)
  assert.deepEqual(
    gappy.map((entry) => [entry.id, entry.x, entry.y]),
    [
      ['tile_calls', 0, 0],
      ['tile_tokens', 4, 0],
      ['time', 0, 2],
    ],
  )
  // Overlaps are pulled apart: the one that reads first keeps its place.
  const piled = compact([item('time', 0, 0, 12, 6), item('breakdown', 0, 0, 6, 5), item('outcomes', 3, 2, 6, 5)])
  assertTidy(piled)
  assert.deepEqual(
    ids(piled),
    ['breakdown', 'time', 'outcomes'].sort((a, b) => piled.find((e) => e.id === a).y - piled.find((e) => e.id === b).y),
  )
  // A widget slides up beside a tall neighbour, not only under it.
  const beside = compact([item('time', 0, 0, 6, 8), item('tile_calls', 6, 6, 4, 2), item('tile_tokens', 6, 9, 4, 2)])
  assert.deepEqual(
    beside.map((entry) => entry.y),
    [0, 0, 2],
  )
  // Idempotent, and the input is not changed.
  const before = defaultLayout().items
  const copy = JSON.parse(JSON.stringify(before))
  assert.deepEqual(compact(before), before)
  assert.deepEqual(before, copy)
  assert.deepEqual(compact(compact(piled)), piled)
  // What cleanLayout stores is always tidy, whatever came in.
  const stored = cleanLayout({
    v: 1,
    items: [item('time', 0, 300, 12, 6), item('breakdown', 0, 300, 6, 5), item('tile_calls', 2, 300, 4, 2)],
  })
  assertTidy(stored.items)
  assert.equal(Math.min(...stored.items.map((entry) => entry.y)), 0)
})

test('hiding leaves no gap; adding puts a widget back at the bottom; duplicating copies a chart with its options', () => {
  let layout = defaultLayout()
  layout = removeItem(layout, 'time')
  assertTidy(layout.items)
  assert.equal(at(layout, 'breakdown').y, 4, 'the charts under the hidden one moved up')
  assert.deepEqual(hiddenTypes(layout, { admin: true }), ['time'])
  layout = removeItem(layout, 'tile_tokens')
  layout = removeItem(layout, 'budgets')
  assert.deepEqual(hiddenTypes(layout, { admin: true }), ['tile_tokens', 'time', 'budgets'])
  assert.deepEqual(hiddenTypes(layout), ['tile_tokens', 'time'], 'a member is never offered the budgets')
  assert.equal(removeItem(layout, 'nothing').items.length, layout.items.length)

  const added = addItem(layout, 'time')
  assert.equal(added.id, 'time')
  assertTidy(added.layout.items)
  const back = at(added.layout, 'time')
  assert.deepEqual([back.x, back.w, back.h], [0, 12, 6])
  assert.equal(
    back.y,
    Math.max(...added.layout.items.filter((entry) => entry.id !== 'time').map((entry) => entry.y + entry.h)),
    'at the bottom',
  )
  assert.deepEqual(back.options, cleanOptions('time', {}))
  // What cannot be added: an unknown widget, a second tile.
  assert.equal(addItem(added.layout, 'clock').id, null)
  assert.equal(addItem(added.layout, 'tile_calls').id, null)
  assert.equal(roomFor(added.layout, 'tile_calls'), 0)
  assert.equal(roomFor(added.layout, 'tile_tokens'), 1)
  assert.equal(roomFor(added.layout, 'time'), LAYOUT_LIMITS.copies - 1)

  // A chart half the page wide: its copy sits beside it, with the same options.
  layout = resizeItem(defaultLayout(), 'time', 6, 6)
  layout = setOptions(layout, 'time', { metric: 'tokens', style: 'lines' })
  const twin = duplicateItem(layout, 'time')
  assert.equal(twin.id, 'time-2')
  assertTidy(twin.layout.items)
  assert.deepEqual(place(twin.layout, 'time'), [0, 4, 6, 6])
  assert.deepEqual(place(twin.layout, 'time-2'), [6, 4, 6, 6])
  assert.deepEqual(at(twin.layout, 'time-2').options, at(twin.layout, 'time').options)
  // The copy's options are its own.
  const changed = setOptions(twin.layout, 'time-2', { metric: 'cost', by: 'model', bucket: 'week' })
  assert.equal(at(changed, 'time').options.metric, 'tokens')
  assert.deepEqual(
    [at(changed, 'time-2').options.metric, at(changed, 'time-2').options.by, at(changed, 'time-2').options.bucket],
    ['cost', 'model', 'week'],
  )
  assert.equal(setOptions(changed, 'time-2', { metric: 'nonsense' }).items.find((entry) => entry.id === 'time-2').options.metric, 'calls')
  // A chart as wide as the page: its copy goes under it.
  const under = duplicateItem(defaultLayout(), 'time')
  assert.deepEqual(place(under.layout, 'time-2'), [0, 10, 12, 6])
  assert.equal(at(under.layout, 'breakdown').y, 16)
  assertTidy(under.layout.items)
  // Four copies at most; a tile is never duplicated.
  let full = defaultLayout()
  for (let n = 0; n < 6; n += 1) full = duplicateItem(full, 'time').layout
  assert.equal(full.items.filter((entry) => entry.type === 'time').length, LAYOUT_LIMITS.copies)
  assert.equal(duplicateItem(full, 'time').id, null)
  assert.equal(duplicateItem(defaultLayout(), 'tile_calls').id, null)
  assert.deepEqual(cleanLayout(full), full, 'what the changes make is always a valid layout')
})

test('moving and resizing: inside the grid, inside what the type allows, pushing what was there down', () => {
  const layout = defaultLayout()
  // The duration chart up beside the first row of tiles: the tiles it lands on move down.
  const moved = moveItem(layout, 'latency', 6, 0)
  assertTidy(moved.items)
  assert.deepEqual(place(moved, 'latency'), [6, 0, 6, 5])
  assert.deepEqual(place(moved, 'tile_calls'), [0, 0, 4, 2])
  assert.ok(at(moved, 'tile_tokens').y >= 5 && at(moved, 'tile_duration').y >= 5)
  assert.deepEqual(cleanLayout(moved), moved)
  // Out of range: clamped to the grid.
  assert.equal(at(moveItem(layout, 'latency', 99, 0), 'latency').x, 6)
  assert.equal(at(moveItem(layout, 'latency', -5, 0), 'latency').x, 0)
  assertTidy(moveItem(layout, 'latency', 3, 9999).items)
  assert.equal(moveItem(layout, 'nothing', 0, 0), layout)

  // Sizes stop at the type's least and most.
  assert.deepEqual(place(resizeItem(layout, 'tile_calls', 1, 9), 'tile_calls').slice(2), [2, 2])
  assert.deepEqual(place(resizeItem(layout, 'tile_calls', 9, 1), 'tile_calls').slice(2), [4, 2])
  assert.deepEqual(place(resizeItem(layout, 'time', 1, 1), 'time').slice(2), [4, 4], 'a chart cannot be made too small to read')
  assert.deepEqual(place(resizeItem(layout, 'time', 40, 40), 'time').slice(2), [12, 10])
  // Never past the right edge.
  assert.deepEqual(place(resizeItem(layout, 'outcomes', 12, 5), 'outcomes'), [6, 10, 6, 5])
  // A taller chart pushes what is under it down.
  const taller = resizeItem(layout, 'breakdown', 6, 8)
  assertTidy(taller.items)
  assert.equal(at(taller, 'approvals').y, 18)
  for (const type of WIDGET_TYPES) {
    const size = WIDGETS[type].size
    assert.ok(size.minW <= size.w && size.w <= size.maxW && size.minH <= size.h && size.h <= size.maxH, type)
  }
  assert.deepEqual([WIDGETS.tile_calls.size.minW, WIDGETS.tile_calls.size.maxW], [2, 4], 'a tile has three widths and one height')
})

test('arrow keys: a column at a time sideways, past the neighbour up and down; Shift resizes', () => {
  const layout = defaultLayout()
  // Up: the duration chart changes places with the outcomes chart above it.
  const up = stepMove(layout, 'latency', 'up')
  assertTidy(up.items)
  assert.deepEqual(place(up, 'latency'), [6, 10, 6, 5])
  assert.deepEqual(place(up, 'outcomes'), [6, 15, 6, 5])
  // And down again is where it started.
  assert.deepEqual(stepMove(up, 'latency', 'down'), layout)
  // At the top and at the bottom there is nowhere to go.
  assert.equal(stepMove(layout, 'tile_calls', 'up'), layout)
  assert.equal(stepMove(layout, 'budgets', 'down'), layout)
  // Sideways: one column, stopping at the edges.
  const narrow = resizeItem(layout, 'breakdown', 4, 5)
  assert.equal(at(stepMove(narrow, 'breakdown', 'right'), 'breakdown').x, 1)
  assert.deepEqual(stepMove(layout, 'tile_calls', 'left'), layout)
  assert.deepEqual(stepMove(layout, 'tile_duration', 'right'), layout)
  assertTidy(stepMove(layout, 'tile_tokens', 'left').items)
  // Shift: a column or a row at a time, inside the limits.
  assert.deepEqual(place(stepResize(layout, 'latency', 'left'), 'latency').slice(2), [5, 5])
  assert.deepEqual(place(stepResize(layout, 'latency', 'down'), 'latency').slice(2), [6, 6])
  assert.deepEqual(place(stepResize(layout, 'latency', 'up'), 'latency').slice(2), [6, 4])
  assert.deepEqual(stepResize(layout, 'latency', 'right'), layout, 'already at the right edge')
  assert.deepEqual(stepResize(layout, 'tile_calls', 'down'), layout, 'a tile has one height')
  assert.equal(describeItem(at(up, 'latency')), 'row 11, column 7; 6 wide, 5 tall')
})

test('reflow: fewer columns show the same widgets in reading order, with no overlaps and no gaps', () => {
  const layout = defaultLayout()
  assert.equal(reflow(layout.items, 12), layout.items, '12 columns: the layout itself')
  const medium = reflow(layout.items, 6)
  assertTidy(medium, 6)
  assert.deepEqual(ids(medium), ids(layout.items), 'the same order')
  // Tiles three to a row, charts one to a row, lists two to a row.
  assert.deepEqual(
    medium.filter((entry) => entry.type.startsWith('tile_')).map((entry) => [entry.x, entry.y, entry.w]),
    [
      [0, 0, 2],
      [2, 0, 2],
      [4, 0, 2],
      [0, 2, 2],
      [2, 2, 2],
      [4, 2, 2],
    ],
  )
  for (const id of ['time', 'breakdown', 'outcomes', 'approvals', 'latency', 'budgets'])
    assert.equal(medium.find((entry) => entry.id === id).w, 6)
  assert.deepEqual(
    medium.filter((entry) => entry.type.startsWith('top_')).map((entry) => [entry.x, entry.w]),
    [
      [0, 3],
      [3, 3],
      [0, 3],
      [3, 3],
    ],
  )
  // A phone: tiles in pairs, everything else one under the other.
  const phone = reflow(layout.items, 2)
  assertTidy(phone, 2)
  assert.deepEqual(ids(phone), ids(layout.items))
  assert.deepEqual(
    phone.slice(0, 7).map((entry) => [entry.x, entry.w]),
    [
      [0, 1],
      [1, 1],
      [0, 1],
      [1, 1],
      [0, 1],
      [1, 1],
      [0, 2],
    ],
  )
  // Deterministic, heights kept, the input untouched.
  assert.deepEqual(reflow(layout.items, 6), medium)
  assert.deepEqual(
    phone.map((entry) => entry.h),
    readingOrder(layout.items).map((entry) => entry.h),
  )
  assert.deepEqual(layout, defaultLayout())
  // A hidden widget leaves no gap on any grid; an arranged layout reflows tidily too.
  const arranged = moveItem(removeItem(removeItem(layout, 'time'), 'tile_fixes'), 'latency', 6, 0)
  for (const cols of [6, 2]) {
    const out = reflow(arranged.items, cols)
    assertTidy(out, cols)
    assert.deepEqual(ids(out), ids(arranged.items))
  }
  // Which grid a width gets.
  assert.deepEqual([1400, 840, 839, 560, 559, 390, 0].map(colsFor), [12, 12, 6, 6, 2, 2, 2])
})

test('reorder (the up and down buttons of a narrow screen): the order asked for, on the stored 12 columns', () => {
  const layout = defaultLayout()
  const order = ids(layout.items)
  const expect = (from, to) => {
    const next = [...order]
    next.splice(to, 0, next.splice(from, 1)[0])
    return next
  }
  // One step down, one step up, to the very end, to the very start.
  for (const [id, to] of [
    ['tile_calls', 1],
    ['tile_tokens', 0],
    ['time', 7],
    ['time', 5],
    ['latency', 9],
    ['tile_calls', order.length - 1],
    ['budgets', 0],
    ['top_denied', 11],
  ]) {
    const moved = reorder(layout, id, to)
    assertTidy(moved.items)
    assert.deepEqual(ids(moved.items), expect(order.indexOf(id), to), `${id} to ${to}`)
    assert.deepEqual(cleanLayout(moved), moved)
    // And a narrow screen shows that order.
    assert.deepEqual(ids(reflow(moved.items, 2)), ids(moved.items))
  }
  assert.equal(reorder(layout, 'time', order.indexOf('time')), layout, 'already there')
  assert.equal(reorder(layout, 'nothing', 0), layout)
  assert.deepEqual(ids(reorder(layout, 'tile_calls', -5).items), order, 'before the first is the first')
  assert.deepEqual(ids(reorder(layout, 'budgets', 99).items), order, 'after the last is the last')
  // Many steps in a row keep a tidy layout with every widget.
  let walked = layout
  for (let step = 0; step < order.length + 3; step += 1) {
    const now = ids(walked.items)
    walked = reorder(walked, 'tile_calls', Math.min(now.indexOf('tile_calls') + 1, now.length - 1))
    assertTidy(walked.items)
  }
  assert.equal(ids(walked.items).at(-1), 'tile_calls')
  assert.equal(walked.items.length, layout.items.length)
})

test('who sees what: the budgets are drawn for admins only, and the rest closes up', () => {
  const layout = moveItem(defaultLayout(), 'budgets', 0, 0)
  assert.equal(visibleItems(layout, { admin: true }), layout.items)
  const member = visibleItems(layout)
  assert.ok(!member.some((entry) => entry.type === 'budgets'))
  assertTidy(member)
  assert.equal(member.find((entry) => entry.id === 'tile_calls').y, 0)
  const without = removeItem(layout, 'budgets')
  assert.equal(visibleItems(without), without.items)
})

test('an older stored shape: a bare list of grid items is read as a layout; a newer version as none', () => {
  // Before a layout carried a version: the grid library's own items, keyed `i`.
  const old = [
    { i: 'tile_calls', x: 0, y: 0, w: 4, h: 2 },
    { i: 'time', x: 0, y: 2, w: 12, h: 6, options: { metric: 'tokens' } },
    { i: 'time-2', x: 0, y: 8, w: 6, h: 6, moved: true, static: false },
    { i: 'clock', x: 0, y: 14, w: 4, h: 2 },
    { i: 'outcomes', x: 6, y: 8, w: 99, h: 5 },
    { x: 0, y: 0, w: 4, h: 2 },
    null,
  ]
  const migrated = migrateLayout(old)
  assert.equal(migrated.v, LAYOUT_VERSION)
  const layout = cleanLayout(old)
  assert.deepEqual(
    layout.items.map((entry) => [entry.id, entry.type, entry.x, entry.y, entry.w, entry.h]),
    [
      ['tile_calls', 'tile_calls', 0, 0, 4, 2],
      ['time', 'time', 0, 2, 12, 6],
      ['time-2', 'time', 0, 8, 6, 6],
    ],
    'what it knows is kept; the unknown widget and the impossible size are dropped',
  )
  assert.equal(at(layout, 'time').options.metric, 'tokens')
  assert.equal(at(layout, 'time-2').options.metric, 'calls')
  assert.deepEqual(readLayout(old), layout)
  assert.deepEqual(cleanLayout(layout), layout, 'once migrated it is a current layout')
  // A layout written by a later build: not guessed at.
  assert.equal(migrateLayout({ v: LAYOUT_VERSION + 1, items: [] }), null)
  assert.equal(readLayout({ v: LAYOUT_VERSION + 1, items: old }), null)
  assert.equal(migrateLayout('[]'), null)
  assert.equal(readLayout(null), null)
})

test('a list, a breakdown and the budgets are as tall as what they hold, until they are sized by hand', () => {
  const layout = defaultLayout()
  // Which widgets follow their content, and that the default heights are the fitted ones.
  assert.deepEqual(
    layout.items.filter((entry) => entry.auto).map((entry) => entry.id),
    ['breakdown', 'top_agents', 'top_threads', 'top_slowest', 'top_denied', 'budgets'],
  )
  assert.ok(!('auto' in at(layout, 'time')) && !('auto' in at(layout, 'tile_calls')))
  assert.equal(fitLayout(layout), layout, 'nothing to change: the same layout')
  assert.equal(fitLayout(layout, { budgets: 3 }), layout, 'three projects are what the default height holds')
  // More rows: taller, and what is under it moves down. Fewer: shorter, and it moves up.
  const ten = fitLayout(setOptions(layout, 'top_agents', { rows: 10 }))
  assertTidy(ten.items)
  assert.deepEqual(place(ten, 'top_agents'), [0, 20, 3, 7])
  assert.equal(at(ten, 'budgets').y, 27)
  assert.deepEqual(place(ten, 'top_threads'), [3, 20, 3, 4], 'its neighbours keep their own height')
  const three = fitLayout(setOptions(ten, 'top_agents', { rows: 3 }))
  assert.deepEqual(place(three, 'top_agents'), [0, 20, 3, 3])
  assert.equal(at(three, 'budgets').y, 24)
  assert.deepEqual(
    [5, 8, 12, 20].map((rows) => at(fitLayout(setOptions(layout, 'breakdown', { rows })), 'breakdown').h),
    [4, 5, 7, 10],
  )
  // The budgets: a row per project, never a blank band, and a list that scrolls from six projects on.
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 10, 40].map((budgets) => at(fitLayout(layout, { budgets }), 'budgets').h),
    [3, 3, 4, 4, 5, 6, 6, 6, 6],
  )
  assert.equal(at(fitLayout(layout, { budgets: null }), 'budgets').h, 4, 'not known yet: as stored')
  assert.equal(at(fitLayout(layout, {}), 'budgets').h, 4)
  // Sized by hand: the height stays whatever the content does. A change of width alone is not that.
  const wider = resizeItem(layout, 'top_agents', 4, 4)
  assert.equal(at(wider, 'top_agents').auto, true)
  const byHand = resizeItem(layout, 'top_agents', 3, 6)
  assert.equal(at(byHand, 'top_agents').auto, false)
  assert.deepEqual(place(fitLayout(setOptions(byHand, 'top_agents', { rows: 10 })), 'top_agents'), [0, 20, 3, 6])
  assert.equal(at(stepResize(layout, 'budgets', 'down'), 'budgets').auto, false)
  assert.equal(at(fitLayout(stepResize(layout, 'budgets', 'down'), { budgets: 1 }), 'budgets').h, 5)
  assert.equal(at(stepResize(layout, 'budgets', 'left'), 'budgets').auto, true)
  // It is stored, checked like everything else, and a copy starts by following its content again.
  assert.deepEqual(cleanLayout(byHand), byHand)
  const junk = cleanLayout({
    v: 1,
    items: [
      { ...at(layout, 'top_agents'), auto: 'yes' },
      { ...at(layout, 'time'), auto: true },
      { ...at(layout, 'breakdown'), h: 7, auto: undefined },
    ],
  })
  assert.equal(at(junk, 'top_agents').auto, true, 'not a yes or a no: it follows while it has the default height')
  assert.ok(!('auto' in at(junk, 'time')), 'a chart over time has no such switch')
  assert.equal(at(junk, 'breakdown').auto, false, 'a stored height that is not the default was set by hand')
  assert.equal(at(duplicateItem(resizeItem(layout, 'breakdown', 6, 7), 'breakdown').layout, 'breakdown-2').auto, false, 'a copy is a copy')
  assert.equal(at(addItem(removeItem(byHand, 'top_agents'), 'top_agents').layout, 'top_agents').auto, true)
  // Fitting never leaves an overlap or a gap, whatever is fitted.
  let busy = layout
  for (const id of ['top_agents', 'top_threads', 'top_slowest', 'top_denied']) busy = setOptions(busy, id, { rows: id.length % 2 ? 10 : 3 })
  assertTidy(fitLayout(setOptions(busy, 'breakdown', { rows: 20 }), { budgets: 9 }).items)
  assert.deepEqual(layout, defaultLayout(), 'the layout given is never changed')
})
