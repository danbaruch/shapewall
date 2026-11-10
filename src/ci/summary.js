// The pull request comment, rendered from summary.json (src/ci/compare.js).
// `shapewall ci capture-compare` writes it as summary.md; `shapewall ci
// comment` renders it again with the links it knows by then (the workflow
// artifact, and image URLs when ci.images is "branch").
//
// Everything in it that came from the repository (page titles, paths, error
// text) is plain text: markdown, HTML and @mentions are neutralised, so a
// config in a pull request cannot put markup or pings in the comment.

export const COMMENT_MARKER = '<!-- shapewall-ci -->'
export const ROWS_MAX = 50
const FAILURES_MAX = 20
// GitHub refuses comments over 65536 characters.
export const BODY_MAX = 60000

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`

// One table cell or line of plain text: no markdown, HTML, mention or link.
// A zero-width space (U+200B) breaks every @ (mentions, and GitHub's email
// and mailto:/xmpp: autolinks), "://" and "www." (GitHub's bare autolinks).
export function plain(value, max = 120) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, max)
    .replace(/[\\`*_{}[\]()#+!|<>~]/g, (char) => `\\${char}`)
    .replace(/@/g, '@​')
    .replace(/:\/\//g, ':​//')
    .replace(/(www)\./gi, '$1​.')
}

// ---- Reading a summary.json back --------------------------------------------
//
// `shapewall ci comment` reads summary.json from the workflow artifact, which
// the pull request's own code could have written. normalizeSummary() keeps
// only what the comment uses, each field checked: counts are safe
// non-negative integers, ratios finite numbers in [0, 1], statuses and sides
// from their known values, image paths in the shape compare.js writes, and
// strings capped (and still passed through plain() when rendered). Anything
// else: null, and the comment says the result could not be read.

const SHOT_STATUSES = new Set(['unchanged', 'changed', 'new', 'removed', 'failed'])
const TOTAL_KEYS = [
  'pages',
  'changedPages',
  'shots',
  'changedShots',
  'unchangedShots',
  'failedShots',
  'newPages',
  'removedPages',
  'pagesNotCompared',
]
const IMAGE_KEYS = ['before', 'after', 'diff', 'beforeThumb', 'afterThumb', 'diffThumb']
const IMAGE_PATH_RE = /^images\/[a-z0-9][a-z0-9.-]{0,100}\/[a-z.]{1,40}\.png$/
const SHOTS_MAX = 5000
const FAILURES_READ_MAX = 1000

class Unreadable extends Error {}
const unreadable = () => {
  throw new Unreadable()
}
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : unreadable())
const unit = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : unreadable())
const flag = (value) => (typeof value === 'boolean' ? value : unreadable())
const text = (value, max, { optional = false } = {}) => {
  if (value === null || value === undefined) return optional ? null : unreadable()
  return typeof value === 'string' ? value.slice(0, max) : unreadable()
}
const size = (value) => {
  if (value === null || value === undefined) return null
  return isObject(value) ? { width: count(value.width), height: count(value.height) } : unreadable()
}

function cleanShot(raw) {
  if (!isObject(raw) || !SHOT_STATUSES.has(raw.status)) unreadable()
  let images = null
  if (raw.images !== null && raw.images !== undefined) {
    if (!isObject(raw.images)) unreadable()
    images = {}
    for (const key of IMAGE_KEYS) {
      const value = raw.images[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || !IMAGE_PATH_RE.test(value)) unreadable()
      images[key] = value
    }
  }
  return {
    page: text(raw.page, 200),
    title: text(raw.title, 300, { optional: true }),
    path: text(raw.path, 500, { optional: true }),
    viewport: text(raw.viewport, 64),
    viewportSize: size(raw.viewportSize),
    status: raw.status,
    changed: flag(raw.changed),
    ratio: unit(raw.ratio),
    changedPixels: count(raw.changedPixels ?? 0),
    totalPixels: count(raw.totalPixels ?? 0),
    dimensionsChanged: flag(raw.dimensionsChanged ?? false),
    base: size(raw.base),
    head: size(raw.head),
    images,
    error: text(raw.error, 2000, { optional: true }),
  }
}

function cleanFailure(raw) {
  if (!isObject(raw) || ![null, undefined, 'base', 'head'].includes(raw.side)) unreadable()
  return {
    side: raw.side ?? null,
    page: text(raw.page, 200, { optional: true }),
    viewport: text(raw.viewport, 64, { optional: true }),
    error: text(raw.error, 2000, { optional: true }) || '',
  }
}

// A parsed summary.json, checked field by field: the clean summary, or null.
export function normalizeSummary(raw) {
  try {
    if (!isObject(raw) || !isObject(raw.totals) || !Array.isArray(raw.shots)) return null
    const failures = raw.failures ?? []
    if (!Array.isArray(failures) || raw.shots.length > SHOTS_MAX || failures.length > FAILURES_READ_MAX) return null
    const totals = {}
    for (const key of TOTAL_KEYS) totals[key] = count(raw.totals[key] ?? 0)
    return {
      schema: raw.schema,
      version: raw.version,
      threshold: unit(raw.threshold),
      totals,
      failures: failures.map(cleanFailure),
      shots: raw.shots.map(cleanShot),
    }
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }
}

export function percent(ratio) {
  const value = ratio * 100
  if (value > 0 && value < 0.01) return '<0.01%'
  return `${value.toFixed(2)}%`
}

function screen(shot) {
  const size = shot.viewportSize ? ` ${shot.viewportSize.width}x${shot.viewportSize.height}` : ''
  return `${plain(shot.viewport, 32)}${size}`
}

function changeText(shot) {
  if (shot.status === 'new') return 'new page'
  if (shot.status === 'removed') return 'page removed'
  let text = percent(shot.ratio)
  if (shot.dimensionsChanged && shot.base && shot.head)
    text += ` (size ${shot.base.width}x${shot.base.height} to ${shot.head.width}x${shot.head.height})`
  return text
}

function pageCell(shot) {
  const title = plain(shot.title || shot.page, 80)
  return shot.path ? `${title} (${plain(shot.path, 80)})` : title
}

// The headline: "Shapewall: 4 of 23 pages changed".
export function headline(summary) {
  const { totals } = summary
  const sideFailed = summary.failures.some((failure) => failure.page === null)
  if (sideFailed && !totals.changedPages) return 'Shapewall: capture failed'
  if (!totals.changedPages) return `Shapewall: no visual changes on ${plural(totals.pages, 'page')}`
  return `Shapewall: ${totals.changedPages} of ${plural(totals.pages, 'page')} changed`
}

// `imageUrl(path)`: a URL for a file of the result folder (images branch), or
// null for links only. `artifactUrl`: the workflow artifact with the images.
// `runUrl`: the workflow run, for "see the log".
export function renderSummary(summary, { artifactUrl = null, runUrl = null, imageUrl = null, note = null } = {}) {
  const { totals } = summary
  const lines = [COMMENT_MARKER]
  const title = headline(summary)
  const changed = summary.shots.filter((shot) => shot.changed)
  const failed = summary.failures
  const quiet = !changed.length && !failed.length
  if (quiet) lines.push('<details>', `<summary>${title}</summary>`, '')
  else lines.push(`### ${title}`, '')

  if (changed.length) {
    lines.push('| Page | Screen size | Pixels changed |', '| --- | --- | --- |')
    for (const shot of changed.slice(0, ROWS_MAX)) lines.push(`| ${pageCell(shot)} | ${screen(shot)} | ${changeText(shot)} |`)
    if (changed.length > ROWS_MAX) lines.push('', `And ${plural(changed.length - ROWS_MAX, 'more changed shot')} in summary.json.`)
    lines.push('')
  }

  if (imageUrl && changed.length) {
    lines.push('<details open>', '<summary>Before, after and diff</summary>', '')
    for (const shot of changed.slice(0, ROWS_MAX)) {
      const images = shot.images || {}
      const cell = (label, thumb, full) =>
        images[thumb] ? `[![${label}](${imageUrl(images[thumb])})](${imageUrl(images[full] || images[thumb])})` : ' '
      lines.push(`**${pageCell(shot)}**, ${screen(shot)}`, '', '| Before | After | Diff |', '| --- | --- | --- |')
      lines.push(
        `| ${cell('before', 'beforeThumb', 'before')} | ${cell('after', 'afterThumb', 'after')} | ${cell('diff', 'diffThumb', 'diff')} |`,
        '',
      )
    }
    lines.push('</details>', '')
  }

  if (failed.length) {
    lines.push(`**Not captured** (${plural(failed.length, 'problem')}):`, '')
    for (const failure of failed.slice(0, FAILURES_MAX)) {
      const where = failure.page ? `${plain(failure.page, 64)} ${plain(failure.viewport, 32)}` : 'every page'
      const side = failure.side === 'base' ? 'before' : failure.side === 'head' ? 'after' : 'compare'
      lines.push(`- ${where} (${side}): ${plain(failure.error, 300)}`)
    }
    if (failed.length > FAILURES_MAX) lines.push(`- and ${failed.length - FAILURES_MAX} more in summary.json`)
    lines.push('')
  }

  const facts = [`${plural(totals.shots, 'shot')} compared`]
  if (totals.unchangedShots) facts.push(`${totals.unchangedShots} unchanged`)
  if (totals.newPages) facts.push(plural(totals.newPages, 'new page'))
  if (totals.removedPages) facts.push(plural(totals.removedPages, 'removed page'))
  if (totals.pagesNotCompared) facts.push(`${plural(totals.pagesNotCompared, 'page')} left out by the page limit`)
  facts.push(`a shot counts as changed from ${percent(summary.threshold)} of its pixels`)
  lines.push(`${facts.join(', ')}.`)
  const links = []
  if (changed.length && artifactUrl) links.push(`[Before, after and diff images](${artifactUrl}) (the "shapewall-ci" artifact of this run)`)
  if (runUrl) links.push(`[the workflow run](${runUrl})`)
  if (links.length) lines.push('', `${links.join(', ')}.`)
  if (note) lines.push('', plain(note, 300))
  lines.push(
    '',
    '<sub>Turn this off: delete .github/workflows/shapewall.yml, set "ci": { "enabled": false } in shapewall.config.json, or put [skip shapewall] in the pull request title.</sub>',
  )
  if (quiet) lines.push('', '</details>')
  let body = `${lines.join('\n')}\n`
  if (body.length > BODY_MAX) body = `${body.slice(0, BODY_MAX)}\n\n(cut short; the full list is in summary.json)\n`
  return body
}

// The comment when summary.json is there but not one Shapewall wrote as it
// should be (normalizeSummary said null): nothing from it is shown.
export function renderUnreadable({ runUrl = null } = {}) {
  return [
    COMMENT_MARKER,
    '### Shapewall: the result could not be read',
    '',
    `The capture result (summary.json) is not in the shape Shapewall writes, so none of it is shown here.${runUrl ? ` See [the workflow run](${runUrl}).` : ''}`,
    '',
  ].join('\n')
}

// The comment when no summary.json exists: the capture step itself failed.
export function renderMissing({ runUrl = null } = {}) {
  return [
    COMMENT_MARKER,
    '### Shapewall: capture failed',
    '',
    `No result was written, so nothing was compared.${runUrl ? ` The log of [the workflow run](${runUrl}) says what failed.` : ''}`,
    '',
  ].join('\n')
}
