// The desktop board toolbar's fit (client/src/board/toolbarFit.js): which
// labels stay at which width, that nothing overlaps or leaves the bar, and
// that an open journey never changes the bar's shape.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIT_STEPS, SIDE_PANEL, TOOLBAR, collapsed, fitToolbar, toolbarItems, zoneWidth } from '../client/src/board/toolbarFit.js'

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
  const view = items.left.find((item) => item.id === 'view')
  // The journey's name as fitted, in place of its least width.
  const grown = fit.journey && Array.isArray(view.full) ? fit.journey - (view.full[fit.step] - 41 - 27) : 0
  return {
    fit,
    name,
    left: name + gap + zoneWidth(items.left, fit.step) + grown,
    right: zoneWidth(items.right, fit.step),
    zoneGap: off.tight ? TOOLBAR.tightZoneGap : TOOLBAR.zoneGap,
  }
}

test('the steps drop labels in order: panel toggles, Views, screen size, then tight; there is no search in the bar', () => {
  assert.deepEqual(FIT_STEPS, ['full', 'panels', 'view', 'viewport', 'tight'])
  const none = { panels: false, view: false, viewport: false, tight: false }
  assert.deepEqual(collapsed(0), none)
  assert.deepEqual(collapsed(1), { ...none, panels: true })
  assert.deepEqual(collapsed(2), { ...none, panels: true, view: true })
  assert.deepEqual(collapsed(3), { ...none, panels: true, view: true, viewport: true })
  assert.deepEqual(collapsed(4), { panels: true, view: true, viewport: true, tight: true })
  // Each item collapses at its own step.
  const items = local()
  const at = Object.fromEntries([...items.left, ...items.right].map((item) => [item.id, item.at || null]))
  assert.deepEqual(at, {
    divider: null,
    viewport: 'viewport',
    view: 'view',
    capture: null,
    'capture-status': null,
    panels: 'panels',
    settings: null,
  })
  assert.equal('searchIcon' in items, false)
  // Comment is a tool on the canvas now (BoardTools.jsx), not a toolbar control.
  assert.equal(
    items.right.some((item) => item.id === 'comment'),
    false,
  )
})

test('narrowing the toolbar only ever drops more labels, never brings one back', () => {
  for (const items of [local(), demo(), local(LONG), local(LONG, JOURNEY)]) {
    let previous = -1
    for (let width = 2600; width >= 400; width -= 2) {
      const { step } = fitToolbar({ width, ...items })
      assert.ok(step >= previous, 'step ' + step + ' after ' + previous + ' at ' + width)
      previous = step
    }
  }
})

test('with the search out of the bar every label stays from a 1280 px window up, and on the demo from 1024', () => {
  for (const width of [1280 - RAIL, 1440 - RAIL, 1440 - 256, 1728 - 256, 2560 - 420]) {
    assert.equal(fitToolbar({ width, ...local() }).step, 0, 'local labels at ' + width)
  }
  assert.equal(fitToolbar({ width: 1024 - RAIL, ...demo() }).step, 0, 'demo labels at 1024')
})

test('from 1024 px up, with the sidebar collapsed or at its widest, nothing overlaps or leaves the toolbar', () => {
  for (const items of [local(), demo(), local(LONG), local(LONG, JOURNEY), demo(JOURNEY), demo('Sign up')]) {
    for (const width of widths) {
      const { name, left, right, zoneGap } = layout(items, width)
      const inner = width - 2 * TOOLBAR.pad
      assert.ok(name >= Math.min(items.name, TOOLBAR.name.at(-1)), 'name ' + name + ' at ' + width)
      assert.ok(left + right + zoneGap <= inner + 0.5, 'zones ' + left + '+' + right + ' overflow ' + inner + ' at ' + width)
    }
  }
})

test('the bar is never tight at 768 px or wider', () => {
  for (const width of widths.filter((value) => value >= 768)) {
    assert.ok(fitToolbar({ width, ...local() }).step < FIT_STEPS.indexOf('tight'), 'local not tight at ' + width)
    assert.ok(fitToolbar({ width, ...demo() }).step < FIT_STEPS.indexOf('tight'), 'demo not tight at ' + width)
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

test('below every supported width: the last step', () => {
  assert.deepEqual(fitToolbar({ width: 200, ...local(LONG) }), { step: FIT_STEPS.length - 1, journey: 0 })
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
  assert.ok(panels.compact > 36 && panels.compact < panels.full)
  // The Agent button keeps room for its activity pill, so a run starting moves nothing.
  const withAgent = toolbarItems({ text, title: 'x', panels: { comments: 1, agent: true } }).right.find((item) => item.id === 'panels')
  const without = toolbarItems({ text, title: 'x', panels: { comments: 1 } }).right.find((item) => item.id === 'panels')
  assert.equal(withAgent.full - without.full, 40 + Math.ceil(text('Agent', 'ui')) + 1 + TOOLBAR.agentPill)
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

test('an open journey never changes the shape of the bar: at most one more label step, and nothing else collapses for it', () => {
  for (const [before, after] of [
    [local(), local('Marketing site', JOURNEY)],
    [demo(), demo(JOURNEY)],
    [demo(), demo('Sign up')],
    [local(LONG), local(LONG, JOURNEY)],
  ]) {
    for (const width of widths) {
      const was = fitToolbar({ width, ...before })
      const now = fitToolbar({ width, ...after })
      assert.ok(now.step >= was.step && now.step <= was.step + 1, 'step ' + was.step + ' to ' + now.step + ' at ' + width)
    }
  }
  // From a 1280 px window up (the sidebar collapsed) a journey costs no label at all.
  for (const window of [1280, 1440, 1728, 2560]) {
    assert.equal(fitToolbar({ width: window - RAIL, ...demo(JOURNEY) }).step, 0, 'demo with a long journey at ' + window)
    assert.equal(
      fitToolbar({ width: window - RAIL, ...local('Marketing site', JOURNEY) }).step,
      0,
      'local with a long journey at ' + window,
    )
  }
})

test("an open journey's name takes the spare room up to its cap and never more than its own width", () => {
  const items = local('Marketing site', JOURNEY)
  const name = text(JOURNEY, 'ui')
  let previous = { step: -1, journey: Infinity }
  for (const width of [...new Set(widths)].sort((a, b) => b - a)) {
    const fit = fitToolbar({ width, ...items })
    assert.ok(fit.journey <= TOOLBAR.journeyMax, 'capped at ' + width)
    // Within a step, narrower never widens the name (a later step frees room).
    if (fit.step === previous.step) assert.ok(fit.journey <= previous.journey, 'narrower never widens the name, at ' + width)
    previous = fit
    if (collapsed(fit.step).view) {
      assert.equal(fit.journey, 0)
      continue
    }
    assert.ok(fit.journey >= Math.min(name, TOOLBAR.journey[Math.min(fit.step, TOOLBAR.journey.length - 1)]), 'least at ' + width)
  }
  // Wide: the whole cap. A short name is shown whole and never wider than itself.
  assert.equal(fitToolbar({ width: 2504, ...items }).journey, TOOLBAR.journeyMax)
  const short = local('Marketing site', 'Sign up')
  const shortFit = fitToolbar({ width: 2504, ...short })
  assert.equal(shortFit.journey, short.left.find((item) => item.id === 'view').full[shortFit.step] - 41 - 27)
  assert.equal(fitToolbar({ width: 2504, ...local() }).journey, 0)
})

// The side panel as dragged: its least, its default, and its most in a window.
const panelMax = (window) => Math.max(SIDE_PANEL.min, Math.min(SIDE_PANEL.max, Math.floor(window * SIDE_PANEL.share)))
const togglesOf = (items) => items.right.find((item) => item.id === 'panels')

test('the side panel is never narrower than its toggles need: the least and the default fit them with a long count', () => {
  const busy = toolbarItems({ text, title: 'x', panels: { comments: 124, agent: true, checks: true }, settings: true })
  const need = togglesOf(busy).full + 2 * TOOLBAR.pad
  assert.ok(need <= SIDE_PANEL.min, 'the toggles need ' + need + ', the least is ' + SIDE_PANEL.min)
  assert.ok(SIDE_PANEL.min <= SIDE_PANEL.width && SIDE_PANEL.width <= SIDE_PANEL.max)
  assert.equal(SIDE_PANEL.width, 384, 'the default stays')
  // The least is reachable at the narrowest desktop window.
  assert.ok(Math.floor(1024 * SIDE_PANEL.share) >= SIDE_PANEL.min)
})

test('a panel open: its toggles span the panel wherever the bar fits them, and nothing overlaps or leaves the bar', () => {
  for (const items of [local(), demo(), local(LONG), local(LONG, JOURNEY), demo(JOURNEY)]) {
    for (let window = 1024; window <= 2560; window += 8) {
      for (const rail of [RAIL, 256, railMax(window)]) {
        for (const panel of [SIDE_PANEL.min, SIDE_PANEL.width, panelMax(window)]) {
          const width = window - rail
          const fit = fitToolbar({ width, panel, ...items })
          const off = collapsed(fit.step)
          const gap = off.tight ? TOOLBAR.tightGap : TOOLBAR.gap
          const view = items.left.find((item) => item.id === 'view')
          const grown = fit.journey && Array.isArray(view.full) ? fit.journey - (view.full[fit.step] - 41 - 27) : 0
          const left = Math.min(items.name, TOOLBAR.name[fit.step]) + gap + zoneWidth(items.left, fit.step) + grown
          const others = items.right.filter((item) => item.id !== 'panels')
          // Stretched: the others, then the panel's column less the bar's own padding on its right.
          const right = fit.stretched ? zoneWidth([...others, { full: panel - TOOLBAR.pad }], fit.step) : zoneWidth(items.right, fit.step)
          const inner = width - 2 * TOOLBAR.pad
          const zoneGap = off.tight ? TOOLBAR.tightZoneGap : TOOLBAR.zoneGap
          const where = ' at ' + window + ' rail ' + rail + ' panel ' + panel
          assert.ok(left + right + zoneGap <= inner + 0.5, 'zones ' + left + '+' + right + ' overflow ' + inner + where)
          // It falls back to the toggles' own width only when no step fits the panel's.
          if (!fit.stretched) assert.deepEqual(fit, fitToolbar({ width, ...items }), 'the compact fit' + where)
        }
      }
    }
  }
})

test('a panel open: stretched from a 1280 px window up, sidebar open or not; compact at 1024 with the sidebar open; no panel, no stretch', () => {
  for (const items of [local(), demo()]) {
    for (const [window, rail] of [
      [1280, RAIL],
      [1280, 256],
      [1440, RAIL],
      [1440, 256],
      [1920, 420],
    ]) {
      for (const panel of [SIDE_PANEL.min, SIDE_PANEL.width, panelMax(window)]) {
        const fit = fitToolbar({ width: window - rail, panel, ...items })
        assert.equal(fit.stretched, true, 'stretched at ' + window + ' rail ' + rail + ' panel ' + panel)
      }
    }
    // The default panel costs no label at 1440 with the sidebar collapsed.
    assert.equal(fitToolbar({ width: 1440 - RAIL, panel: SIDE_PANEL.width, ...items }).step, 0)
    assert.equal(fitToolbar({ width: 1024 - RAIL, panel: SIDE_PANEL.width, ...items }).stretched, true, '1024, sidebar collapsed')
    assert.equal('stretched' in fitToolbar({ width: 1440 - RAIL, ...items }), false)
    assert.equal('stretched' in fitToolbar({ width: 1440 - RAIL, panel: null, ...items }), false)
  }
  assert.equal('stretched' in fitToolbar({ width: 1024 - 256, panel: SIDE_PANEL.width, ...local() }), false, 'no room: the compact toggles')
  // A count too long for the panel: the toggles keep their own width rather than lose their words.
  const huge = toolbarItems({ text, title: 'x', panels: { comments: 123456789012, agent: true, checks: true } })
  assert.equal('stretched' in fitToolbar({ width: 1440 - RAIL, panel: SIDE_PANEL.min, ...huge }), false)
})
