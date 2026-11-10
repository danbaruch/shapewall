// The desktop board toolbar's fit: labels drop in a fixed order as it gets
// narrower, the search box stays on the toolbar's centre line, and nothing
// overlaps from a 1024 px window with the widest sidebar up to an ultrawide.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIT_STEPS, TOOLBAR, collapsed, fitToolbar, toolbarItems, zoneWidth } from '../client/src/board/toolbarFit.js'

// About the system UI font: 7 px a character at 13 px, scaled by size.
const SIZE = { name: 14, ui: 13, xs: 12, count: 11 }
const text = (value, font) => value.length * 7 * (SIZE[font] / 13)

const LONG = 'A much longer board name for the whole team'
// An open journey with a name far past the Views button's cap.
const JOURNEY = 'Upgrade from the free plan to Plus with a coupon and a team invite'
// A local board: every control the toolbar can show.
const local = (title = 'Marketing site', journey = null) =>
  toolbarItems({
    text,
    title,
    journey,
    viewports: ['Desktop', 'Tablet', 'Phone', 'All'],
    capture: true,
    comment: true,
    panels: { comments: 20, agent: true, checks: true },
    settings: true,
  })
// The demo export: no Capture, no Settings.
const demo = (journey = null) =>
  toolbarItems({
    text,
    journey,
    title: 'Acme storefront',
    viewports: ['Desktop', 'Tablet', 'Phone', 'All'],
    comment: true,
    panels: { comments: 20, agent: true, checks: true },
  })

// Toolbar widths: the window minus the app rail (56 px collapsed; expanded 256
// by default, dragged up to 420 px or 40% of the window, whichever is less).
const RAIL = 56
const railMax = (window) => Math.max(208, Math.min(420, Math.floor(window * 0.4)))
const widths = []
for (let window = 1024; window <= 2560; window += 8) for (const rail of [RAIL, 256, railMax(window)]) widths.push(window - rail)

const layout = (items, width) => {
  const fit = fitToolbar({ width, ...items })
  const off = collapsed(fit.step)
  const gap = off.tight ? TOOLBAR.tightGap : TOOLBAR.gap
  const name = Math.min(items.name, TOOLBAR.name[fit.step])
  return {
    fit,
    name,
    left: name + gap + zoneWidth(items.left, fit.step),
    right: zoneWidth(items.right, fit.step),
    centre: fit.search || TOOLBAR.search.icon,
    zoneGap: off.tight ? TOOLBAR.tightZoneGap : TOOLBAR.zoneGap,
  }
}

test('the steps drop labels in order: search, panel toggles, View, screen size, then tight', () => {
  assert.deepEqual(FIT_STEPS, ['full', 'search', 'panels', 'view', 'viewport', 'tight'])
  const none = { search: false, panels: false, view: false, viewport: false, comment: false, tight: false }
  assert.deepEqual(collapsed(0), none)
  assert.deepEqual(collapsed(1), { ...none, search: true })
  assert.deepEqual(collapsed(2), { ...none, search: true, panels: true })
  assert.deepEqual(collapsed(3), { ...none, search: true, panels: true, view: true })
  assert.deepEqual(collapsed(4), { ...none, search: true, panels: true, view: true, viewport: true })
  assert.deepEqual(collapsed(5), { search: true, panels: true, view: true, viewport: true, comment: true, tight: true })
  // Each item collapses at its own step.
  const items = local()
  const at = Object.fromEntries([...items.left, ...items.right].map((item) => [item.id, item.at || null]))
  assert.deepEqual(at, {
    viewport: 'viewport',
    view: 'view',
    capture: null,
    'capture-status': null,
    comment: 'comment',
    panels: 'panels',
    settings: null,
  })
})

test('narrowing the toolbar only ever drops more labels, never brings one back', () => {
  for (const items of [local(), demo(), local(LONG)]) {
    let previous = -1
    for (let width = 2600; width >= 400; width -= 2) {
      const { step } = fitToolbar({ width, ...items })
      assert.ok(step >= previous, 'step ' + step + ' after ' + previous + ' at ' + width)
      previous = step
    }
  }
})

test('wide toolbars keep every label and a full search box between its min and max width', () => {
  for (const width of [1440 - RAIL, 1728 - 256, 2560 - 420, 2560 - RAIL]) {
    const fit = fitToolbar({ width, ...local() })
    assert.equal(fit.step, 0, 'labels at ' + width)
    assert.equal(fit.centred, true)
    assert.ok(fit.search >= TOOLBAR.search.min && fit.search <= TOOLBAR.search.max, 'search ' + fit.search + ' at ' + width)
  }
  assert.equal(fitToolbar({ width: 2560 - RAIL, ...local() }).search, TOOLBAR.search.max)
})

test('the search box collapses before any button loses its label', () => {
  const items = local()
  let width = 2600
  while (fitToolbar({ width: width - 2, ...items }).step === 0) width -= 2
  const before = fitToolbar({ width, ...items })
  const after = fitToolbar({ width: width - 2, ...items })
  assert.ok(before.search >= TOOLBAR.search.min)
  assert.equal(after.step, 1, 'only the search box changed')
  assert.equal(after.search, 0)
})

test('from 1024 px up, with the sidebar collapsed or at its widest, nothing overlaps or leaves the toolbar', () => {
  for (const items of [local(), demo(), local(LONG), local(LONG, JOURNEY), demo(JOURNEY)]) {
    for (const width of widths) {
      const { fit, name, left, right, centre, zoneGap } = layout(items, width)
      const inner = width - 2 * TOOLBAR.pad
      assert.ok(name >= Math.min(items.name, TOOLBAR.name.at(-1)), 'name ' + name + ' at ' + width)
      if (fit.centred) {
        // Each side fits its half of the toolbar beside the centred search box.
        const half = (inner - centre) / 2 - zoneGap
        assert.ok(Math.max(left, right) <= half, 'sides ' + left + '/' + right + ' over ' + half + ' at ' + width)
      } else {
        assert.ok(left + right + centre + 2 * zoneGap <= inner, 'zones ' + left + '+' + right + ' overflow ' + inner + ' at ' + width)
      }
    }
  }
})

test('the search box stays centred whenever the toolbar is 768 px or wider', () => {
  for (const width of widths.filter((value) => value >= 768)) {
    assert.equal(fitToolbar({ width, ...demo() }).centred, true, 'demo centred at ' + width)
    const fit = fitToolbar({ width, ...local() })
    assert.equal(fit.centred, true, 'local centred at ' + width)
    assert.ok(fit.step < FIT_STEPS.indexOf('tight'), 'local not tight at ' + width)
  }
})

test('a long board name truncates a step at a time, never below its readable minimum', () => {
  for (let step = 1; step < TOOLBAR.name.length; step += 1) assert.ok(TOOLBAR.name[step] <= TOOLBAR.name[step - 1])
  assert.equal(TOOLBAR.name.length, FIT_STEPS.length)
  assert.ok(TOOLBAR.name.at(-1) >= 104, 'about 8 characters stay')
  // A name past the first cap costs no more labels than one exactly at it.
  const long = local(LONG)
  const atCap = { ...local(), name: TOOLBAR.name[0] }
  for (const width of widths) {
    const fit = fitToolbar({ width, ...long })
    assert.equal(fit.step, fitToolbar({ width, ...atCap }).step, 'long name at ' + width)
    assert.ok(fitToolbar({ width, ...local('Site') }).step <= fit.step)
  }
})

test('below every supported width: the last step, not centred, the search an icon', () => {
  assert.deepEqual(fitToolbar({ width: 200, ...local(LONG) }), { step: FIT_STEPS.length - 1, centred: false, search: 0 })
})

test('item widths follow the controls: a running capture and a failed one widen the status', () => {
  const statusOf = (status) => toolbarItems({ text, title: 'x', status }).left.find((item) => item.id === 'capture-status').full
  const dot = statusOf(undefined)
  assert.equal(dot, 16)
  assert.ok(statusOf({ kind: 'running', progress: '3/12' }) > dot)
  assert.ok(statusOf({ kind: 'failed' }) > statusOf({ kind: 'running', progress: '3/12' }))
  // One viewport: no toggle at all.
  assert.equal(
    toolbarItems({ text, title: 'x', viewports: ['Desktop'] }).left.some((item) => item.id === 'viewport'),
    false,
  )
  // Compact panel toggles keep the comment count.
  const panels = toolbarItems({ text, title: 'x', panels: { comments: 120 } }).right.find((item) => item.id === 'panels')
  assert.ok(panels.compact > 40 && panels.compact < panels.full)
})

test('an open journey: Views carries its name up to the cap and a clear button, collapsed it is one icon', () => {
  const view = (journey) => local('Marketing site', journey).left.find((item) => item.id === 'view')
  const plain = view(null)
  const short = view('Sign up')
  const long = view(JOURNEY)
  assert.equal(long.full.length, FIT_STEPS.length, 'one width per step')
  assert.ok(short.full[0] > plain.full, 'the name and clear button are wider than the word')
  assert.ok(long.full[0] > short.full[0])
  // The name stops at each step's cap: icon and padding (41), the name, the clear button (27).
  TOOLBAR.journey.forEach((cap, step) => assert.equal(long.full[step], 41 + cap + 27))
  for (let step = 1; step < FIT_STEPS.length; step += 1) assert.ok(long.full[step] <= long.full[step - 1], 'shortens at ' + step)
  assert.deepEqual(view('A' + JOURNEY).full, long.full, 'a longer name costs nothing more')
  // A short name never truncates.
  assert.equal(new Set(short.full).size, 1)
  assert.equal(long.compact, plain.compact)
  assert.equal(long.at, 'view')
})

test('an open journey keeps the search centred wherever it was centred before, and costs at most two steps', () => {
  for (const [before, after] of [
    [local(), local('Marketing site', JOURNEY)],
    [demo(), demo(JOURNEY)],
    [local(LONG), local(LONG, JOURNEY)],
  ]) {
    for (const width of widths) {
      const was = fitToolbar({ width, ...before })
      const now = fitToolbar({ width, ...after })
      if (was.centred) assert.equal(now.centred, true, 'centred at ' + width)
      assert.ok(now.step >= was.step && now.step <= was.step + 2, 'step ' + was.step + ' to ' + now.step + ' at ' + width)
    }
  }
  for (const width of widths.filter((value) => value >= 768)) {
    assert.equal(fitToolbar({ width, ...local('Marketing site', JOURNEY) }).centred, true, 'centred at ' + width)
  }
})
