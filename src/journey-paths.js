// Branching journeys: a journey's `steps` is a list of page ids, and any
// item after a page may instead be a fork that splits into named branches:
//
//   ["home", "signup", { "branches": [
//     { "id": "link-ok", "label": "Link works", "steps": ["verify"] },
//     { "id": "link-expired", "label": "Link expired", "steps": ["verify-expired", "verify"] }
//   ] }, "welcome"]
//
// Every branch rejoins at the item after the fork, unless it has
// `end: true` (the journey stops there, e.g. "card declined"). Branches may
// fork again, up to FORK_DEPTH_MAX deep. A list of plain page ids is a
// linear journey, exactly as before branches existed.
//
// Pure functions with no imports, so the server, the CLI, the MCP server and
// the board client all read journeys the same way.

export const BRANCHES_MIN = 2
export const BRANCHES_MAX = 6
export const BRANCH_LABEL_MAX = 60
export const FORK_DEPTH_MAX = 3
export const JOURNEY_PATHS_MAX = 64
const BRANCH_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isFork(item) {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.branches)
}

export function isBranching(steps) {
  return Array.isArray(steps) && steps.some(isFork)
}

function slug(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'branch'
  )
}

// Validates and normalizes a journey's steps (linear or branching). Pushes
// one message per problem, each prefixed with `where`; returns the clean
// steps, or null if there was any problem. `stepsMax` caps the page
// references across every branch.
export function checkSteps(raw, pageIds, where, problems, { stepsMax = 50 } = {}) {
  const before = problems.length
  let pages = 0
  const list = (items, at, depth, hasNext) => {
    if (!Array.isArray(items)) {
      problems.push(`${at}: a list of page ids and forks`)
      return []
    }
    return items.map((item, index) => {
      const here = `${at}[${index}]`
      if (typeof item === 'string') {
        if (!pageIds.has(item)) problems.push(`${here}: no page ${JSON.stringify(item)} on this board`)
        pages += 1
        return item
      }
      if (!isFork(item)) {
        problems.push(`${here}: no page ${JSON.stringify(item)} on this board`)
        return item
      }
      return fork(item, here, depth + 1, index, items, hasNext)
    })
  }
  const fork = (item, here, depth, index, items, hasNext) => {
    if (typeof items[index - 1] !== 'string') problems.push(`${here}: a fork follows a page (it cannot come first or right after a fork)`)
    if (depth > FORK_DEPTH_MAX) problems.push(`${here}: forks nest at most ${FORK_DEPTH_MAX} deep`)
    const { branches } = item
    if (branches.length < BRANCHES_MIN || branches.length > BRANCHES_MAX) {
      problems.push(`${here}.branches: ${BRANCHES_MIN} to ${BRANCHES_MAX} branches`)
    }
    const followed = index < items.length - 1 || hasNext
    const ids = new Set()
    const clean = branches.map((branch, at) => {
      const where = `${here}.branches[${at}]`
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) {
        problems.push(`${where}: a branch is an object with label and steps`)
        return null
      }
      const label = typeof branch.label === 'string' ? branch.label.replace(/\s+/g, ' ').trim() : ''
      if (!label || label.length > BRANCH_LABEL_MAX) problems.push(`${where}.label: 1 to ${BRANCH_LABEL_MAX} characters`)
      const id = branch.id === undefined ? slug(label) : branch.id
      if (typeof id !== 'string' || !BRANCH_ID_RE.test(id)) {
        problems.push(`${where}.id: lowercase letters, digits and dashes (got ${JSON.stringify(branch.id)})`)
      } else if (ids.has(id)) {
        problems.push(`${where}.id: "${id}" is used by another branch of this fork`)
      }
      ids.add(id)
      if (branch.end !== undefined && typeof branch.end !== 'boolean') problems.push(`${where}.end: true or false`)
      const end = branch.end === true
      if (!Array.isArray(branch.steps)) {
        problems.push(`${where}.steps: a list of page ids (empty to skip straight to the step after the fork)`)
        return null
      }
      if (!branch.steps.length && (end || !followed)) {
        problems.push(`${where}.steps: an empty branch needs a step after the fork to go to`)
      }
      const steps = list(branch.steps, `${where}.steps`, depth, !end && followed)
      return { id, label, steps, ...(end ? { end: true } : {}) }
    })
    if (clean.length && clean.every((branch) => branch?.end) && index < items.length - 1) {
      problems.push(`${here}: every branch ends, so nothing can follow this fork`)
    }
    return { branches: clean }
  }
  if (!Array.isArray(raw)) {
    problems.push(`${where}: 2 to ${stepsMax} page ids, in order`)
    return null
  }
  const steps = list(raw, where, 0, false)
  if (problems.length > before) return null
  if (pages < 2 || pages > stepsMax) {
    problems.push(`${where}: 2 to ${stepsMax} page ids, in order${isBranching(steps) ? ' (counting every branch)' : ''}`)
    return null
  }
  if (countPaths(steps) > JOURNEY_PATHS_MAX) {
    problems.push(`${where}: at most ${JOURNEY_PATHS_MAX} different paths through the forks`)
    return null
  }
  return steps
}

// How many different paths the forks allow (stops counting past the cap).
function countPaths(steps) {
  const count = (items) => {
    let total = 1
    for (const item of items) {
      if (!isFork(item)) continue
      total *= item.branches.reduce((sum, branch) => sum + count(branch.steps), 0)
      if (total > JOURNEY_PATHS_MAX) return JOURNEY_PATHS_MAX + 1
    }
    return total
  }
  return count(steps)
}

// Every page id the journey visits on any branch, once each, in order.
export function journeyPages(steps) {
  const seen = new Set()
  const walk = (items) => {
    for (const item of items || []) {
      if (typeof item === 'string') seen.add(item)
      else if (isFork(item)) for (const branch of item.branches) walk(branch.steps)
    }
  }
  walk(steps)
  return [...seen]
}

// Every step as a node (a page can be visited at several positions) and
// every arrow between them. Node keys are positions: "3" is the 4th item,
// "2:1:0" the first step of the 2nd branch of the fork at item 2. Arrows
// into a branch carry its label. { nodes: [{ key, pageId }], edges: [{ from,
// to, label, branch }] }
export function journeyGraph(steps) {
  const nodes = []
  const edges = []
  // `pending`: where arrows to the next step come from (a page node, maybe
  // with the label of the branch it enters).
  const walk = (items, prefix, pending) => {
    let from = pending
    items.forEach((item, index) => {
      const key = prefix ? `${prefix}:${index}` : String(index)
      if (typeof item === 'string') {
        nodes.push({ key, pageId: item })
        for (const source of from) {
          edges.push({ from: source.key, to: key, label: source.label || null, branch: source.branch || null })
        }
        from = [{ key }]
        return
      }
      if (!isFork(item)) return
      const next = []
      item.branches.forEach((branch, at) => {
        const entering = from.map((source) => ({ key: source.key, label: branch.label, branch: branch.id }))
        const out = walk(branch.steps, `${key}:${at}`, entering)
        if (!branch.end) next.push(...out)
      })
      from = next
    })
    return from
  }
  walk(steps || [], '', [])
  return { nodes, edges }
}

// One way through the journey: at the n-th fork reached, take the branch
// with id choices[n] (the first branch when missing or unknown).
// Returns { steps: [{ key, pageId, branch }], forks: [{ afterStep, options,
// chosen }], ended }: `branch` is the label of the branch a step is on (the
// innermost), `afterStep` the 1-based step whose page the fork leaves from,
// `ended` whether the path stopped in a branch marked `end`.
export function resolvePath(steps, choices = []) {
  const path = []
  const forks = []
  let ended = false
  const walk = (items, prefix, branchLabel) => {
    for (let index = 0; index < items.length; index += 1) {
      if (ended) return
      const item = items[index]
      const key = prefix ? `${prefix}:${index}` : String(index)
      if (typeof item === 'string') {
        path.push({ key, pageId: item, branch: branchLabel })
        continue
      }
      if (!isFork(item) || !item.branches.length) continue
      const wanted = choices[forks.length]
      const at = Math.max(
        0,
        item.branches.findIndex((branch) => branch.id === wanted),
      )
      const branch = item.branches[at]
      forks.push({
        afterStep: path.length,
        options: item.branches.map((option) => ({ id: option.id, label: option.label, end: Boolean(option.end) })),
        chosen: branch.id,
      })
      walk(branch.steps, `${key}:${at}`, branch.label)
      if (branch.end) ended = true
    }
  }
  walk(steps || [], '', null)
  return { steps: path, forks, ended }
}

// The choices for a new pick: keep what was chosen before fork `ordinal`,
// take `id` there, and let later forks fall back to their first branch.
export function chooseBranch(route, ordinal, id) {
  return [...route.forks.slice(0, ordinal).map((fork) => fork.chosen), id]
}

// Every path through the forks (at most JOURNEY_PATHS_MAX): { choices,
// labels, steps: [pageId], ended }.
export function journeyPaths(steps) {
  const out = []
  const visit = (prefix) => {
    if (out.length >= JOURNEY_PATHS_MAX) return
    const route = resolvePath(steps, prefix)
    if (route.forks.length > prefix.length) {
      for (const option of route.forks[prefix.length].options) visit([...prefix, option.id])
      return
    }
    out.push({
      choices: route.forks.map((fork) => fork.chosen),
      labels: route.forks.map((fork) => fork.options.find((option) => option.id === fork.chosen).label),
      steps: route.steps.map((step) => step.pageId),
      ended: route.ended,
    })
  }
  visit([])
  return out
}

// Drops steps whose page is not in `keep` (a page that left the config).
// A fork left with one branch becomes that branch's steps; one left with
// none disappears. The result may be invalid (a fork right at the start);
// callers check it again.
export function pruneSteps(steps, keep) {
  const prune = (items) => {
    const out = []
    for (const item of items) {
      if (typeof item === 'string') {
        if (keep.has(item)) out.push(item)
        continue
      }
      if (!isFork(item)) continue
      const branches = item.branches
        .map((branch) => ({ ...branch, steps: prune(branch.steps || []) }))
        .filter((branch) => branch.steps.length || !branch.end)
      if (branches.length >= 2) out.push({ branches })
      else if (branches.length === 1) {
        out.push(...branches[0].steps)
        if (branches[0].end) return out
      }
    }
    return out
  }
  return prune(Array.isArray(steps) ? steps : [])
}
