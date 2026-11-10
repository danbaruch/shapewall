// Pure helpers for journeys, link arrows, compare mode and before/after.
// No React and no imports, so they run in the Node unit tests too.

// Page id -> its 1-based step numbers in a journey (a page can appear twice).
export function stepMap(steps) {
  const map = new Map()
  ;(steps || []).forEach((pageId, index) => {
    if (!map.has(pageId)) map.set(pageId, [])
    map.get(pageId).push(index + 1)
  })
  return map
}

// The arrows to draw. Journey arrows (step i -> i + 1) always show while a
// journey is open. Link arrows only with "Show links": all of them, quiet,
// when no card is active; only the active card's own (out: accent, in:
// muted) when one is hovered or selected. That keeps a 100-page board
// readable. On a big board (more than `idleMax` links) nothing is drawn
// until a card is active. `present` is the set of page ids on the canvas.
export const IDLE_LINKS_MAX = 150

export function countLinks(links, present, hide = null) {
  let count = 0
  for (const [source, targets] of Object.entries(links || {})) {
    if (present.has(source)) count += targets.filter((target) => present.has(target) && !hide?.has(target)).length
  }
  return count
}

// Pages linked from (almost) every page: the nav bar and the footer. Their
// arrows say nothing about a page and bury the rest, so they are hidden
// until asked for. A target counts when at least half the pages with links
// (and three or more) point at it.
export function globalTargets(links, present) {
  const sources = Object.entries(links || {}).filter(([source, targets]) => present.has(source) && targets.some((t) => present.has(t)))
  if (sources.length < 3) return new Set()
  const counts = new Map()
  for (const [source, targets] of sources) {
    for (const target of new Set(targets)) if (target !== source && present.has(target)) counts.set(target, (counts.get(target) || 0) + 1)
  }
  const needed = Math.max(3, Math.ceil(sources.length * 0.5))
  return new Set([...counts].filter(([, count]) => count >= needed).map(([target]) => target))
}

//
// `hideTargets` (from globalTargets) drops link arrows into those pages.
// An open journey comes as `journeyRoute`: its graph (journeyGraph) and the
// keys of the path being stepped through (resolvePath). Arrows on that path
// carry step numbers (and the branch label where they enter a branch);
// arrows of the other branches are drawn dashed with their branch label.
// `journeySteps` (a plain list of page ids) is the journey being built.
export function flowEdges({
  links = {},
  showLinks = false,
  activePage = null,
  journeySteps = null,
  journeyRoute = null,
  currentStep = 0,
  present,
  idleMax = IDLE_LINKS_MAX,
  hideTargets = null,
}) {
  // Journey arrows are drawn last, over link arrows (no z-index: labels must stay above their arrows).
  const edges = []
  const linkEdges = []
  const has = (id) => present.has(id)
  const journeyPairs = new Set()
  if (journeyRoute) {
    const pageOf = new Map(journeyRoute.graph.nodes.map((node) => [node.key, node.pageId]))
    const onPath = new Map()
    journeyRoute.path.forEach((key, index) => {
      if (index) onPath.set(`${journeyRoute.path[index - 1]}>${key}`, index)
    })
    const alternatives = []
    for (const edge of journeyRoute.graph.edges) {
      const source = pageOf.get(edge.from)
      const target = pageOf.get(edge.to)
      if (source === target || !has(source) || !has(target)) continue
      const index = onPath.get(`${edge.from}>${edge.to}`)
      journeyPairs.add(`${source}>${target}`)
      const base = { source, target, sourceHandle: 'right', targetHandle: 'left', type: 'flow' }
      if (index === undefined) {
        alternatives.push({
          ...base,
          id: `journey-alt:${edge.from}>${edge.to}`,
          data: { tone: 'alt', ...(edge.label ? { branch: edge.label } : {}), bend: 0.22 },
        })
        continue
      }
      edges.push({
        ...base,
        id: `journey:${index}`,
        data: {
          tone: currentStep && index + 1 <= currentStep ? 'done' : 'journey',
          label: String(index + 1),
          ...(edge.label ? { branch: edge.label } : {}),
          bend: 0.16,
        },
      })
    }
    // Other branches under the chosen path.
    edges.unshift(...alternatives)
  } else if (journeySteps?.length) {
    for (let index = 0; index < journeySteps.length - 1; index += 1) {
      const source = journeySteps[index]
      const target = journeySteps[index + 1]
      if (source === target || !has(source) || !has(target)) continue
      journeyPairs.add(`${source}>${target}`)
      edges.push({
        id: `journey:${index + 1}`,
        source,
        target,
        sourceHandle: 'right',
        targetHandle: 'left',
        type: 'flow',
        data: { tone: currentStep && index + 2 <= currentStep ? 'done' : 'journey', label: String(index + 2), bend: 0.16 },
      })
    }
  }
  if (showLinks && (activePage || countLinks(links, present, hideTargets) <= idleMax)) {
    for (const [source, targets] of Object.entries(links)) {
      if (!has(source)) continue
      for (const target of targets) {
        if (!has(target) || journeyPairs.has(`${source}>${target}`) || hideTargets?.has(target)) continue
        let tone = 'idle'
        if (activePage) {
          if (source === activePage) tone = 'out'
          else if (target === activePage) tone = 'in'
          else continue
        }
        linkEdges.push({
          id: `link:${source}>${target}`,
          source,
          target,
          sourceHandle: 'right',
          targetHandle: 'left',
          type: 'flow',
          data: { tone },
        })
      }
    }
  }
  return [...linkEdges, ...edges]
}

// The step to show: 1..length, from a query string value.
export function clampStep(value, length) {
  const step = Math.round(Number(value))
  if (!length) return 0
  if (!Number.isFinite(step) || step < 1) return 1
  return Math.min(step, length)
}

// The version id of a manifest entry, as the server computes it (captures
// from before versions use the run's time).
export function entryVersion(entry, manifest) {
  if (entry?.status !== 'ok') return null
  if (typeof entry.version === 'string') return entry.version
  const time = Date.parse(manifest?.capturedAt || '')
  if (!Number.isFinite(time)) return null
  return new Date(time)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z')
}

// The shapes drawn on a thread (the comment and its replies) on `version`.
function drawnOn(comment, version) {
  return [comment, ...(comment.replies || [])]
    .filter((item) => item?.drawing?.shapes?.length && item.drawing.captureVersion === version)
    .flatMap((item) => item.drawing.shapes)
}

// The newest capture version a drawing in the thread was made on, other
// than `current`; null when every drawing is on the current capture.
function olderDrawingVersion(comment, current) {
  const made = [comment, ...(comment.replies || [])]
    .filter((item) => item?.drawing?.shapes?.length && item.drawing.captureVersion && item.drawing.captureVersion !== current)
    .map((item) => item.drawing.captureVersion)
    .sort()
  return made.at(-1) || null
}

// Before and after for a resolved comment, or for a thread drawn on a
// capture the page has since moved on from (the drawing belongs to that
// capture, so it shows over "before", never over the new page): the capture
// it was made on and the current one. Returns null when there is nothing to
// show, else { before, after, reason, drawn? } where before/after are
// { kind, file, version } or null, reason explains a missing side and
// drawn lists the shapes drawn on the before capture.
export function beforeAfter(comment, { manifest, captures, versions }) {
  if (!comment || String(comment.pageId).startsWith('variant:')) return null
  const { pageId, viewport } = comment
  const currentEntry = manifest?.pages?.[pageId]?.[viewport]
  const currentVersion = entryVersion(currentEntry, manifest)
  const settled = comment.status === 'resolved' || comment.agentStatus === 'done'
  const olderDrawing = olderDrawingVersion(comment, currentVersion)
  const beforeVersion = settled ? comment.captureVersion : olderDrawing
  if (!beforeVersion) return null
  const currentFile = captures?.[pageId]?.[viewport]?.file || null
  const current = currentFile ? { kind: 'captures', file: currentFile, version: currentVersion || 'current' } : null
  if (beforeVersion === currentVersion) {
    return { before: current, after: null, reason: 'not-recaptured' }
  }
  const old = (versions?.[pageId]?.[viewport] || []).find((item) => item.version === beforeVersion)
  const drawn = drawnOn(comment, beforeVersion)
  return {
    before: old ? { kind: 'versions', file: old.file, version: old.version } : null,
    after: current,
    reason: old ? null : 'pruned',
    ...(drawn.length ? { drawn } : {}),
  }
}

// A crop of a frame (native size) around a point given in percent, for
// zooming in near a pin: { left, top, width, height } in native pixels.
export function cropAround(native, xPercent, yPercent, { minWidth = 320, share = 0.45, aspect = 0.66 } = {}) {
  const width = Math.min(native.width, Math.max(minWidth, Math.round(native.width * share)))
  const height = Math.min(native.height, Math.round(width * aspect))
  const cx = (native.width * xPercent) / 100
  const cy = (native.height * yPercent) / 100
  const left = Math.round(Math.max(0, Math.min(native.width - width, cx - width / 2)))
  const top = Math.round(Math.max(0, Math.min(native.height - height, cy - height / 2)))
  return { left, top, width, height }
}

// The largest changed share of a page across its viewports, or null.
export function pageChange(compare, pageId) {
  const viewports = compare?.pages?.[pageId]
  if (!viewports) return null
  const values = Object.values(viewports)
    .filter((item) => item.status === 'ok')
    .map((item) => item.percent)
  return values.length ? Math.max(...values) : null
}

// The most changed viewport of a page: { viewport, percent }, or null. The
// card header names it, so its share never reads as the frame's own.
export function pageChangeAt(compare, pageId) {
  const viewports = compare?.pages?.[pageId]
  if (!viewports) return null
  let best = null
  for (const [viewport, item] of Object.entries(viewports)) {
    if (item?.status === 'ok' && (!best || item.percent > best.percent)) best = { viewport, percent: item.percent }
  }
  return best
}

// The time a version id stands for ("20261104T200417123Z-ab12"), or null.
export function versionTime(version) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(String(version || ''))
  if (!match) return null
  const [, y, mo, d, h, mi, s, ms] = match
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms))
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

// Every kept capture of one page and viewport, newest first: the current
// one, then the archived versions. [{ version, kind, file, thumb, current, at }]
export function pageHistory({ pageId, viewport, manifest, captures, versions }) {
  const list = []
  const currentFile = captures?.[pageId]?.[viewport]
  const currentEntry = manifest?.pages?.[pageId]?.[viewport]
  if (currentFile?.file) {
    const version = entryVersion(currentEntry, manifest) || 'current'
    list.push({
      version,
      kind: 'captures',
      file: currentFile.file,
      thumb: currentFile.thumb || currentFile.file,
      current: true,
      at: currentEntry?.capturedAt || versionTime(version) || manifest?.capturedAt || null,
    })
  }
  for (const item of versions?.[pageId]?.[viewport] || []) {
    if (!item.file || list.some((entry) => entry.version === item.version)) continue
    list.push({
      version: item.version,
      kind: 'versions',
      file: item.file,
      thumb: item.thumb || item.file,
      current: false,
      at: versionTime(item.version),
    })
  }
  return list
}

// How many earlier captures a page has (the most of any viewport).
export function historyCount(versions, pageId) {
  const byViewport = versions?.[pageId]
  if (!byViewport) return 0
  return Math.max(0, ...Object.values(byViewport).map((list) => list.length))
}

// Comment states the board can narrow to, besides open/resolved.
export const COMMENT_STATES = [
  { id: 'agent-queued', label: 'Agent queued' },
  { id: 'agent-working', label: 'Agent working' },
  { id: 'agent-done', label: 'Agent done' },
  { id: 'agent-branch', label: 'Fix ready on branch' },
  { id: 'needs-human', label: 'Needs a person' },
  { id: 'reopened', label: 'Reopened' },
  { id: 'replies', label: 'With replies' },
  { id: 'unanchored', label: 'Pinned by position' },
]

export function commentInState(comment, state) {
  switch (state) {
    case 'agent-queued':
      return comment.agentStatus === 'queued'
    case 'agent-working':
      return comment.agentStatus === 'working'
    case 'agent-done':
      return comment.agentStatus === 'done'
    case 'agent-branch':
      return comment.agentStatus === 'branch-ready'
    case 'needs-human':
      return comment.agentStatus === 'needs-human'
    case 'reopened':
      return comment.status === 'open' && comment.reopenCount > 0
    case 'replies':
      return (comment.replies?.length || 0) > 0
    case 'unanchored':
      return !comment.anchor
    default:
      return true
  }
}

// Search, state and mention narrowing for the comment list. `query` matches
// the text, replies, author, page title (titleOf) and "#12".
export function narrowComments(comments, { query = '', state = null, mention = null, titleOf = () => '' } = {}) {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return comments.filter((comment) => {
    if (state && !commentInState(comment, state)) return false
    if (mention && !(comment.mentions || []).includes(mention)) return false
    if (!words.length) return true
    const haystack = [
      `#${comment.id}`,
      comment.body,
      comment.author,
      comment.viewport,
      titleOf(comment.pageId),
      comment.resolution,
      comment.fixRef,
      ...(comment.replies || []).flatMap((reply) => [reply.body, reply.author]),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}
