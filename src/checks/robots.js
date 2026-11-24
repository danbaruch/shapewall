// Bounded Googlebot rule observation, not a crawler or an indexing verdict.
// Google robots specification and RFC 9309 are linked in docs/page-checks.md.
export const ROBOTS_MAX_BYTES = 500 * 1024
const MAX_LINES = 10000
const MAX_PATH = 4096

function normalizeOctets(value) {
  return [...value]
    .map((c) => (c.charCodeAt(0) > 127 ? encodeURIComponent(c) : c))
    .join('')
    .replace(/%[a-f0-9]{2}/gi, (encoded) => {
      const c = String.fromCharCode(parseInt(encoded.slice(1), 16))
      return /[A-Za-z0-9._~-]/.test(c) ? c : encoded.toUpperCase()
    })
}

// Greedy wildcard matching avoids a backtracking regular expression made from
// untrusted patterns. A rule without a final dollar matches a path prefix.
function matches(pattern, value, budget) {
  const exact = pattern.endsWith('$')
  if (exact) pattern = pattern.slice(0, -1)
  let p = 0,
    v = 0,
    star = -1,
    restart = 0
  while (v < value.length) {
    if (--budget.remaining < 0) return null
    if (p === pattern.length && !exact) return true
    if (pattern[p] === '*') {
      star = p++
      restart = v
    } else if (pattern[p] === value[v]) {
      p++
      v++
    } else if (star >= 0) {
      p = star + 1
      v = ++restart
    } else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

export function robotsDecision(body, path) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > ROBOTS_MAX_BYTES || typeof path !== 'string' || path.length > MAX_PATH)
    return { state: 'unsupported' }
  const lines = body.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  if (lines.length > MAX_LINES || lines.some((line) => line.length > MAX_PATH)) return { state: 'unsupported' }
  const groups = []
  let group = null,
    hasRules = false
  for (const line of lines) {
    const clean = line.split('#')[0].trim()
    const colon = clean.indexOf(':')
    if (colon < 0) continue
    const key = clean.slice(0, colon).trim().toLowerCase()
    const value = clean.slice(colon + 1).trim()
    if (key === 'user-agent') {
      if (!group || hasRules) {
        group = { agents: [], rules: [] }
        groups.push(group)
        hasRules = false
      }
      // Google ignores suffixes such as version or wildcard on crawler tokens.
      const agent = value.toLowerCase().match(/^(\*|[a-z_-]+)/)?.[0]
      if (agent) group.agents.push(agent)
    } else if (group && (key === 'allow' || key === 'disallow')) {
      hasRules = true
      if (value.startsWith('/')) group.rules.push({ allow: key === 'allow', path: normalizeOctets(value) })
    }
  }
  const specific = groups.filter((g) => g.agents.includes('googlebot'))
  const selected = specific.length ? specific : groups.filter((g) => g.agents.includes('*'))
  const target = normalizeOctets(path)
  let winner = null
  const budget = { remaining: 2000000 }
  for (const rule of selected.flatMap((g) => g.rules)) {
    const matched = matches(rule.path, target, budget)
    if (matched === null) return { state: 'unsupported' }
    if (!matched) continue
    const length = rule.path.length
    if (!winner || length > winner.length || (length === winner.length && rule.allow)) winner = { length, allow: rule.allow }
  }
  return { state: winner && !winner.allow ? 'blocked' : 'allowed' }
}
