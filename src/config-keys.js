// Keys a config does not use. A typo ("viewport", "conccurency", a page's
// "titel") was silently ignored and the setting fell back to its default, so
// every key the loader does not read is reported, with the key it probably
// meant. They are warnings, never errors: a config with an extra key still
// loads. "$schema" (an editor's JSON schema pointer) is allowed anywhere.

export const TOP_LEVEL_KEYS = [
  'title',
  'id',
  'baseUrl',
  'publicUrl',
  'outputDir',
  'concurrency',
  'capturePacing',
  'viewports',
  'timeouts',
  'block',
  'reducedMotion',
  'localStorage',
  'setup',
  'liveHtml',
  'keepVersions',
  'boardUrl',
  'environments',
  'journeys',
  'auth',
  'browser',
  'groups',
  'pages',
  'boards',
  'notifications',
  'github',
  'agent',
  'starterAgent',
  'commands',
  'sitemap',
  'ci',
  'checks',
  'agentDocs',
]
export const BOARD_KEYS = [
  'id',
  'title',
  'baseUrl',
  'publicUrl',
  'environments',
  'viewports',
  'groups',
  'pages',
  'journeys',
  'sitemap',
  'block',
  'reducedMotion',
  'auth',
  'localStorage',
  'setup',
]
export const PAGE_KEYS = [
  'id',
  'path',
  'title',
  'group',
  'note',
  'waitFor',
  'actions',
  'viewports',
  'expectStatus',
  'errorSelectors',
  'seo',
  'timeout',
  'localStorage',
  'frameHeight',
]
export const ENVIRONMENT_KEYS = ['id', 'title', 'baseUrl', 'publicUrl']
export const TIMEOUT_KEYS = ['page', 'settle']
const ALLOWED_ANYWHERE = new Set(['$schema'])
// Old top-level spellings still read through 1.x (src/config.js warns about each
// itself), so they are not unknown keys: "versions" is now "keepVersions".
export const RENAMED_TOP_LEVEL_KEYS = { versions: 'keepVersions' }

// Optimal string alignment distance: edits, with a swap of two neighbours
// ("titel") as one.
export function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1)
    }
  }
  return rows[a.length][b.length]
}

// The known key `key` most likely meant, or null: the same word in other
// case first ("baseURL", "outputdir", "waitfor"), then the nearest within
// one edit for a short key and two for a longer one.
export function didYouMean(key, known) {
  const lower = String(key).toLowerCase()
  const sameCase = known.find((item) => item.toLowerCase() === lower)
  if (sameCase) return sameCase
  const limit = lower.length <= 4 ? 1 : 2
  let best = null
  let bestDistance = Infinity
  for (const item of known) {
    const distance = editDistance(lower, item.toLowerCase())
    if (distance < bestDistance) {
      best = item
      bestDistance = distance
    }
  }
  return bestDistance <= limit ? best : null
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// Unknown keys of one object: [{ path, key, suggestion, belongs }].
// `elsewhere`: { label: keys } of the other levels, for a key that is
// right but in the wrong place ("waitFor" at the top level is a page key).
function unknownKeys(value, known, where, elsewhere = {}) {
  if (!isObject(value)) return []
  return Object.keys(value)
    .filter((key) => !known.includes(key) && !ALLOWED_ANYWHERE.has(key))
    .map((key) => {
      const suggestion = didYouMean(key, known)
      const path = where ? `${where}.${key}` : key
      // A key that is there under its right name too is a duplicate, not a typo.
      if (suggestion && !Object.hasOwn(value, suggestion)) return { path, key, suggestion }
      for (const [label, keys] of Object.entries(elsewhere)) {
        const right = keys.find((item) => item.toLowerCase() === key.toLowerCase())
        if (right) return { path, key, suggestion: null, belongs: { label, key: right } }
      }
      return { path, key, suggestion: null }
    })
}

const PAGE_ONLY = PAGE_KEYS.filter((key) => !TOP_LEVEL_KEYS.includes(key))
const TOP_ONLY = TOP_LEVEL_KEYS.filter((key) => !PAGE_KEYS.includes(key) && !BOARD_KEYS.includes(key))
function pageKeys(pages, where) {
  return Array.isArray(pages)
    ? pages.flatMap((page, index) => unknownKeys(page, PAGE_KEYS, `${where}[${index}]`, { 'a top-level key': TOP_ONLY }))
    : []
}
function environmentKeys(environments, where) {
  return Array.isArray(environments) ? environments.flatMap((env, index) => unknownKeys(env, ENVIRONMENT_KEYS, `${where}[${index}]`)) : []
}

// Every unknown key of a parsed config, in file order. At most `max`.
export function configKeyWarnings(raw, { max = 20 } = {}) {
  if (!isObject(raw)) return []
  const found = [
    ...unknownKeys(raw, [...TOP_LEVEL_KEYS, ...Object.keys(RENAMED_TOP_LEVEL_KEYS)], '', { 'a page key, set on each page': PAGE_ONLY }),
    ...unknownKeys(raw.timeouts, TIMEOUT_KEYS, 'timeouts'),
    ...environmentKeys(raw.environments, 'environments'),
    ...pageKeys(raw.pages, 'pages'),
    ...(Array.isArray(raw.boards)
      ? raw.boards.flatMap((board, index) => [
          ...unknownKeys(board, BOARD_KEYS, `boards[${index}]`, {
            'a top-level key': TOP_ONLY,
            'a page key, set on each page': PAGE_ONLY,
          }),
          ...environmentKeys(board?.environments, `boards[${index}].environments`),
          ...pageKeys(board?.pages, `boards[${index}].pages`),
        ])
      : []),
  ]
  return found.slice(0, max)
}

// One warning as a line: `"viewport" is not a config key (did you mean "viewports"?); it is ignored.`
export function formatKeyWarning({ path, key, suggestion, belongs }) {
  const where = path === key ? `"${key}"` : `"${key}" at ${path}`
  if (belongs) return `${where} is ignored here: "${belongs.key}" is ${belongs.label}.`
  const meant = suggestion ? ` Did you mean "${suggestion}"?` : ''
  return `${where} is not a config key, so it is ignored.${meant}`
}

// The lines a command prints for a config's unknown keys, or [].
export function keyWarningLines(warnings, { file = null } = {}) {
  if (!warnings?.length) return []
  return [
    `Warning: ${file ? `${file} has` : 'the config has'} ${warnings.length === 1 ? 'a key' : `${warnings.length} keys`} Shapewall does not use (https://shapewall.com/docs/config lists them):`,
    ...warnings.map((warning) => `  ${formatKeyWarning(warning)}`),
  ]
}

// A required key that is missing while a near miss of it is there: the
// hint for its "got undefined" problem (keys are case-sensitive).
// { warning, hint } or null.
export function missingKeyHint(warnings, path) {
  const near = warnings.find((warning) => warning.suggestion && `${warning.path.replace(/[^.[\]]+$/, '')}${warning.suggestion}` === path)
  if (!near) return null
  const why = near.key.toLowerCase() === near.suggestion.toLowerCase() ? 'keys are case-sensitive, so rename' : 'rename'
  return { warning: near, hint: `the config has "${near.key}"; ${why} it to "${near.suggestion}"` }
}
