// How much of the desktop board toolbar keeps its words, as a pure function of
// widths (unit-tested in test/toolbar-fit.test.js). The toolbar has two zones
// with a flexible gap between them:
//   left    the board name and switcher with the capture status, a hairline,
//           then the screen-size toggle, Views and Capture
//   right   the viewer note, Settings, then the side panel toggles
//           (Comments, Agent, Checks) on one track
// Search is not in the toolbar: it is the sidebar's field (BoardRail.jsx).
// Nor are the tools you use on the board (Select, Comment, Draw): they float
// at the bottom of the canvas (BoardTools.jsx).
// When the zones do not fit side by side, labels drop one step at a time, in
// FIT_STEPS order. Every control keeps its accessible name and tooltip at
// every step. The widths come from the controls' fixed sizes plus measured
// text, never from the rendered toolbar, so the result depends only on the
// toolbar's width and what it shows (no feedback loop, no history).
//
// While a side panel is open its toggles are the panel's header: their track
// is as wide as the panel (inside the bar's padding on both sides) and the
// three share that width, so the right zone is the panel's width and the left
// zone drops labels sooner. When even the last step cannot fit that, the
// toggles go back to their own width (`stretched` is not set).
//
// An open journey never changes the toolbar's shape: its name takes the place
// of the word on the Views button, in the same spot, as wide as the spare
// room allows up to `journeyMax`, and nothing else moves or collapses for it
// beyond what the widths ask.

// Each step adds one collapse to the ones before it.
export const FIT_STEPS = [
  'full', // everything labelled
  'panels', // Comments, Agent, Checks lose their words (the count stays)
  'view', // Views loses its word, or the open journey's name (Capture is always an icon)
  'viewport', // the screen-size toggle becomes icons with tooltips; the hairlines go
  // Last resort, for the narrowest toolbars (a 1024 px window with the
  // sidebar at its widest): tighter gaps.
  'tight',
]

export const TOOLBAR = {
  pad: 12, // header padding on each side (px-3)
  gap: 6, // between controls inside a zone (gap-1.5)
  zoneGap: 20, // the least between the zones
  tightGap: 4, // the same two at the tight step (gap-1)
  tightZoneGap: 12,
  // The room the board name's trigger (title, padding, chevron) keeps at each
  // step before the next one drops labels: a long name truncates a little at
  // a time, never below the last value (about 8 characters).
  name: [200, 176, 152, 128, 104],
  // An open journey's name on the Views button: the least it keeps at each
  // step up to 'view' (where it becomes an icon), and the most it takes when
  // there is room; past its width it truncates with an ellipsis.
  journey: [160, 112],
  journeyMax: 240,
  // Room kept on the Agent button for its activity pill (a count), so a run
  // starting never pushes a label off the toolbar.
  agentPill: 22,
}

// The side panel beside the canvas (BoardPanels.jsx): its default width, the
// least and the most it can be dragged to (never more than `share` of the
// window). The least still fits the three toggles with their words, a
// three-digit comment count and the Agent pill inside the bar's padding
// (test/toolbar-fit.test.js, and the board e2e with the real font).
export const SIDE_PANEL = { width: 384, min: 368, max: 560, share: 0.4 }

// What each step turns off. `collapsed(step).panels` is true from the panels step on.
export function collapsed(step) {
  const at = (name) => step >= FIT_STEPS.indexOf(name)
  return {
    panels: at('panels'),
    view: at('view'),
    viewport: at('viewport'),
    tight: at('tight'),
  }
}

// One zone's width at a step. items: [{ full, compact, at, gone }], where
// `at` is the FIT_STEPS name that collapses it (no `at`: always `full`) and
// `gone` the one from which it is not shown at all (a hairline). `full` may
// be a list, one width per step, for a label that shortens before it goes.
export function zoneWidth(items, step, gap = collapsed(step).tight ? TOOLBAR.tightGap : TOOLBAR.gap) {
  const off = collapsed(step)
  const shown = items.filter((item) => item && !(item.gone && off[item.gone]))
  if (!shown.length) return 0
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
  panels = { comments: 0, agent: false, checks: false },
  settings = false,
  journey = null, // the open journey's name: Views shows it, with a clear button
}) {
  const t = (value, font) => Math.ceil(text(String(value), font)) + 1
  const ICON = 32
  const items = { left: [], right: [] }
  // The hairline between the name and the view controls. Once the screen
  // sizes are icons the bar is short of room, and the hairlines go.
  const divider = (id) => ({ id, full: 1, gone: 'viewport' })
  items.left.push(divider('divider'))
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
  // `grow`: how much wider the name may get at each step when the bar has room.
  const name = journey ? t(journey, 'ui') : 0
  const least = (step) => Math.min(name, TOOLBAR.journey[Math.min(step, TOOLBAR.journey.length - 1)])
  items.left.push({
    id: 'view',
    full: journey ? FIT_STEPS.map((_, step) => 41 + least(step) + 27) : 41 + t('Views', 'ui'),
    ...(journey ? { grow: FIT_STEPS.map((_, step) => Math.max(0, Math.min(name, TOOLBAR.journeyMax) - least(step))) } : {}),
    compact: ICON,
    at: 'view',
  })
  // Capture is an icon button at every width (its tooltip says what it does).
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
  if (settings) items.right.push({ id: 'settings', full: ICON })
  // One track (1 px border + 2 px padding a side), its buttons side by side:
  // px-2.5 (px-2 once the words are gone), a 14 px icon, gap-1.5. The Agent
  // button keeps room for its activity pill while it has its word.
  const badge = 12 + t(panels.comments, 'count')
  const buttons = [{ full: 46 + t('Comments', 'ui') + badge, compact: 36 + badge }]
  if (panels.agent) buttons.push({ full: 40 + t('Agent', 'ui') + TOOLBAR.agentPill, compact: 30 })
  if (panels.checks) buttons.push({ full: 40 + t('Checks', 'ui'), compact: 30 })
  const gaps = 6
  items.right.push({
    id: 'panels',
    full: buttons.reduce((sum, item) => sum + item.full, gaps),
    compact: buttons.reduce((sum, item) => sum + item.compact, gaps),
    at: 'panels',
  })
  // The name trigger: px-2.5, the title, gap-1.5 and a 14 px chevron.
  return { name: 40 + t(title, 'name'), left: items.left, right: items.right }
}

// The journey name's room at a step: its least width plus what the bar has
// spare, up to its `grow` (0 when collapsed or no journey).
function journeyRoom(left, step, spare) {
  const item = left.find((entry) => entry.id === 'view' && entry.grow)
  if (!item || collapsed(step).view) return 0
  const least = Array.isArray(item.full) ? item.full[step] - 41 - 27 : 0
  return least + Math.max(0, Math.min(item.grow[step], Math.floor(spare)))
}

// The first step at which the two zones fit side by side, or null.
function firstFit({ inner, name, left, right, config }) {
  for (let step = 0; step < FIT_STEPS.length; step += 1) {
    const tight = collapsed(step).tight
    const gap = tight ? config.tightGap : config.gap
    const rest = zoneWidth(left, step, gap)
    const leftWidth = Math.min(name, config.name[step]) + (rest ? gap + rest : 0)
    const spare = inner - leftWidth - zoneWidth(right, step, gap) - (tight ? config.tightZoneGap : config.zoneGap)
    if (spare >= 0) return { step, journey: journeyRoom(left, step, spare) }
  }
  return null
}

// The step to render. width: the toolbar's width. name: the name trigger's
// natural width. left/right: the other controls in each zone (see zoneWidth).
// panel: the open side panel's width (null: none open).
// Returns { step, journey }: the first step at which the two zones fit side
// by side with the least gap between them, and the open journey's name width
// there (0: none, or collapsed), which takes the spare room up to its `grow`.
// Narrower never means a smaller step.
// With a panel open it first tries the panel toggles as wide as the panel
// (their track `panel` less the padding on each side, the words kept), and
// returns that with `stretched: true` when some step fits it.
export function fitToolbar({ width, name, left = [], right = [], panel = null, config = TOOLBAR }) {
  const inner = Math.max(0, width - 2 * config.pad)
  const last = FIT_STEPS.length - 1
  const toggles = panel ? right.find((item) => item.id === 'panels') : null
  const track = toggles ? panel - 2 * config.pad : 0
  if (toggles && toggles.full <= track) {
    // The track and the padding on its left; the bar's own padding is on its right.
    const wide = right.map((item) => (item === toggles ? { id: 'panels', full: track + config.pad } : item))
    const fit = firstFit({ inner, name, left, right: wide, config })
    if (fit) return { ...fit, stretched: true }
  }
  return firstFit({ inner, name, left, right, config }) || { step: last, journey: journeyRoom(left, last, 0) }
}
