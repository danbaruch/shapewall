// How much of the desktop board toolbar keeps its words, as a pure function of
// widths (unit-tested in test/toolbar-fit.test.js). The toolbar has three zones:
//   left    the board name and switcher, the screen-size toggle, Views, Capture
//           and the capture status
//   centre  "Go to page or journey", centred on the toolbar itself
//   right   Comment, the side panel toggles (Comments, Agent, Checks), Settings
// When the zones do not fit, labels drop one step at a time, in FIT_STEPS
// order. Every control keeps its accessible name and tooltip at every step.
// The widths come from the controls' fixed sizes plus measured text, never
// from the rendered toolbar, so the result depends only on the toolbar's
// width and what it shows (no feedback loop, no history).

// Each step adds one collapse to the ones before it.
export const FIT_STEPS = [
  'full', // everything labelled, search at full width
  'search', // search becomes an icon button (its shortcut stays in the tooltip)
  'panels', // Comments, Agent, Checks lose their words (the count stays)
  'view', // Views loses its word, or the open journey's name (Capture is always an icon)
  'viewport', // the screen-size toggle becomes icons with tooltips
  // Last resort, for the narrowest toolbars (a 1024 px window with the
  // sidebar at its widest): Comment as a filled icon, tighter gaps.
  'tight',
]

export const TOOLBAR = {
  pad: 12, // header padding on each side (px-3)
  gap: 6, // between controls inside a zone (gap-1.5)
  zoneGap: 20, // between zones (gap-x-5)
  tightGap: 4, // the same two at the tight step (gap-1, gap-x-3)
  tightZoneGap: 12,
  search: { min: 240, max: 320, icon: 32 }, // 240: the whole "Go to page or journey" and its Ctrl K
  // The room the board name's trigger (title, padding, chevron) keeps at each
  // step before the next one drops labels: a long name truncates a little at
  // a time, never below the last value (about 8 characters).
  name: [200, 176, 152, 128, 104, 104],
  // An open journey's name on the Views button, at each step up to 'view'
  // (where it becomes an icon): it truncates with an ellipsis past these.
  journey: [160, 128, 96],
}

// What each step turns off. `collapsed(step).panels` is true from the panels step on.
export function collapsed(step) {
  const at = (name) => step >= FIT_STEPS.indexOf(name)
  return {
    search: at('search'),
    panels: at('panels'),
    view: at('view'),
    viewport: at('viewport'),
    comment: at('tight'),
    tight: at('tight'),
  }
}

// One zone's width at a step. items: [{ full, compact, at }], where `at` is
// the FIT_STEPS name that collapses it (no `at`: always `full`). `full` may
// be a list, one width per step, for a label that shortens before it goes.
export function zoneWidth(items, step, gap = collapsed(step).tight ? TOOLBAR.tightGap : TOOLBAR.gap) {
  const shown = items.filter(Boolean)
  if (!shown.length) return 0
  const off = collapsed(step)
  const width = (item) => (item.at && off[item.at] ? item.compact : Array.isArray(item.full) ? item.full[step] : item.full)
  const sum = shown.reduce((total, item) => total + width(item), 0)
  return sum + gap * (shown.length - 1)
}

// The toolbar's controls as fitToolbar input, from their fixed sizes (the
// Tailwind classes in BoardToolbar.jsx) and text(string, font) for the words,
// font one of: name (14 px semibold), ui (13 px medium), xs (12 px medium),
// count (11 px semibold). Widths are rounded up, with a pixel to spare.
export function toolbarItems({
  text,
  title,
  viewports = [],
  capture = false, // the Capture button (local boards)
  status = { kind: 'dot' }, // the capture status: { kind: 'dot' | 'running' | 'failed', progress }
  viewer = false,
  comment = false,
  panels = { comments: 0, agent: false, checks: false },
  settings = false,
  journey = null, // the open journey's name: Views shows it, with a clear button
}) {
  const t = (value, font) => Math.ceil(text(String(value), font)) + 1
  const ICON = 32
  const items = { left: [], right: [] }
  if (viewports.length > 1) {
    // A bordered track (1 px + 2 px padding a side); items px-2.5 around a word, px-2 around a 14 px icon.
    items.left.push({
      id: 'viewport',
      full: 6 + viewports.reduce((sum, label) => sum + 20 + t(label, 'xs'), 0),
      compact: 6 + viewports.length * 30,
      at: 'viewport',
    })
  }
  // Views: px-2.5, a 15 px icon, gap-1.5 and its word. With a journey open:
  // the journey's name (capped per step) and a 28 px clear button joined to it (1 px
  // overlap); collapsed, an icon with a dot and no clear button.
  items.left.push({
    id: 'view',
    full: journey
      ? FIT_STEPS.map((name, step) => 41 + Math.min(t(journey, 'ui'), TOOLBAR.journey[Math.min(step, TOOLBAR.journey.length - 1)]) + 27)
      : 41 + t('Views', 'ui'),
    compact: ICON,
    at: 'view',
  })
  // Capture is an icon button at every width (its tooltip says what it does),
  // so the search box keeps its room on local boards.
  if (capture) items.left.push({ id: 'capture', full: ICON })
  items.left.push({
    id: 'capture-status',
    full:
      status.kind === 'running'
        ? 18 + t(status.progress || 'Capturing', 'xs')
        : status.kind === 'failed'
          ? 28 + t('Capture failed', 'xs')
          : 16,
  })
  if (viewer) items.right.push({ id: 'viewer', full: 40 + t('Viewer', 'xs') })
  if (comment) items.right.push({ id: 'comment', full: 45 + t('Comment', 'ui'), compact: ICON, at: 'comment' })
  // One group, 2 px between its buttons: px-2.5, a 14 px icon, gap-1.5.
  const badge = 12 + t(panels.comments, 'count')
  const buttons = [{ full: 46 + t('Comments', 'ui') + badge, compact: 40 + badge }]
  if (panels.agent) buttons.push({ full: 40 + t('Agent', 'ui'), compact: 34 })
  if (panels.checks) buttons.push({ full: 40 + t('Checks', 'ui'), compact: 34 })
  const gaps = 2 * (buttons.length - 1)
  items.right.push({
    id: 'panels',
    full: buttons.reduce((sum, item) => sum + item.full, gaps),
    compact: buttons.reduce((sum, item) => sum + item.compact, gaps),
    at: 'panels',
  })
  if (settings) items.right.push({ id: 'settings', full: ICON })
  // The name trigger: px-2.5, the title, gap-1.5 and a 14 px chevron.
  return { name: 40 + t(title, 'name'), left: items.left, right: items.right }
}

// The step to render. width: the toolbar's width. name: the name trigger's
// natural width. left/right: the other controls in each zone (see zoneWidth).
// Returns { step, centred, search } with `search` the search box's width
// (0 when it is an icon): the first step at which both side zones fit their
// half of the toolbar beside the centred search. When even the last step
// cannot keep the search on the centre line, centred is false and the search
// icon simply sits between the zones. Narrower never means a smaller step.
export function fitToolbar({ width, name, left = [], right = [], config = TOOLBAR }) {
  const inner = Math.max(0, width - 2 * config.pad)
  const last = FIT_STEPS.length - 1
  const sides = (step) => {
    const tight = collapsed(step).tight
    const gap = tight ? config.tightGap : config.gap
    const rest = zoneWidth(left, step, gap)
    const nameWidth = Math.min(name, config.name[step])
    return {
      left: nameWidth + (rest ? gap + rest : 0),
      right: zoneWidth(right, step, gap),
      zoneGap: tight ? config.tightZoneGap : config.zoneGap,
    }
  }
  for (let step = 0; step <= last; step += 1) {
    const side = sides(step)
    // Centred: each side zone gets the same half of what the search leaves.
    const room = inner - 2 * (Math.max(side.left, side.right) + side.zoneGap)
    if (step === 0) {
      if (room >= config.search.min) return { step, centred: true, search: Math.min(config.search.max, room) }
    } else if (room >= config.search.icon) return { step, centred: true, search: 0 }
  }
  return { step: last, centred: false, search: 0 }
}
