// Shared with the browser: the SEO view's plain-English analysis of page
// check reports and their local search previews. Pure functions; callers
// supply validated v1 reports and validated preview snapshots.

// Google draws result titles in 20 px Arial and snippets in 14 px Arial, and
// cuts them by rendered width, not by a character count. These are Arial's
// advance widths per 1000 units, close enough to predict the cut.
const ARIAL = {
  ' ': 278,
  '!': 278,
  '"': 355,
  '#': 556,
  $: 556,
  '%': 889,
  '&': 667,
  "'": 191,
  '(': 333,
  ')': 333,
  '*': 389,
  '+': 584,
  ',': 278,
  '-': 333,
  '.': 278,
  '/': 278,
  ':': 278,
  ';': 278,
  '<': 584,
  '=': 584,
  '>': 584,
  '?': 556,
  '@': 1015,
  '[': 278,
  ']': 278,
  _: 556,
  '|': 260,
  '–': 556,
  '—': 1000,
  '·': 278,
  '…': 1000,
  '’': 222,
  '‘': 222,
  '“': 333,
  '”': 333,
}
const UPPER = { A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833 }
Object.assign(UPPER, { N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611 })
const LOWER = { a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833 }
Object.assign(LOWER, { n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500 })

function advance(char) {
  if (ARIAL[char] !== undefined) return ARIAL[char]
  if (UPPER[char] !== undefined) return UPPER[char]
  if (LOWER[char] !== undefined) return LOWER[char]
  if (/[0-9]/.test(char)) return 556
  const code = char.codePointAt(0)
  // CJK, kana, hangul and emoji are about one em wide.
  if (code >= 0x2e80) return 1000
  if (/\p{Lu}/u.test(char)) return 700
  return 560
}

// Rendered width in CSS pixels of `text` in Arial at `size` px.
export function textWidth(text, size) {
  let units = 0
  for (const char of String(text || '')) units += advance(char)
  return (units * size) / 1000
}

export const SEO_LIMITS = Object.freeze({
  titleFont: 20,
  titlePixels: 580,
  titleMinChars: 10,
  descriptionFont: 14,
  descriptionPixels: 920,
  descriptionMinChars: 50,
})

const clean = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

// What Google would likely show: the text cut at a word boundary to fit the
// width, with an ellipsis. `cut` says whether anything was dropped.
export function truncateForSearch(text, { size, pixels }) {
  const value = clean(text)
  if (textWidth(value, size) <= pixels) return { text: value, cut: false }
  const room = pixels - textWidth(' ...', size)
  let width = 0
  let end = 0
  for (const char of value) {
    const next = width + (advance(char) * size) / 1000
    if (next > room) break
    width = next
    end += char.length
  }
  let head = value.slice(0, end)
  const space = head.lastIndexOf(' ')
  if (space > end * 0.6) head = head.slice(0, space)
  return { text: `${head.replace(/[\s,.;:–—-]+$/, '')} ...`, cut: true }
}

// The length observations a report records for a page's title and
// description. Returned ids are the report finding ids.
export function lengthIssues(title, description) {
  const issues = []
  const t = clean(title)
  const d = clean(description)
  if (t && [...t].length < SEO_LIMITS.titleMinChars) issues.push({ id: 'seo-title-short', length: [...t].length })
  if (t && textWidth(t, SEO_LIMITS.titleFont) > SEO_LIMITS.titlePixels) issues.push({ id: 'seo-title-long', length: [...t].length })
  if (d && [...d].length < SEO_LIMITS.descriptionMinChars) issues.push({ id: 'seo-description-short', length: [...d].length })
  if (d && textWidth(d, SEO_LIMITS.descriptionFont) > SEO_LIMITS.descriptionPixels)
    issues.push({ id: 'seo-description-long', length: [...d].length })
  return issues
}

// The SEO view's wording for each finding id: a level (`error` keeps the
// page out of search or breaks sharing, `warning` hurts how it shows, `tip`
// is polish), a short label, what it means and what to do.
export const SEO_ISSUES = Object.freeze({
  'search-noindex': {
    level: 'error',
    group: 'indexing',
    label: 'Asks search engines not to index it',
    explain: 'A robots "noindex" tag or header tells Google to leave this page out of search results.',
    fix: 'Remove the noindex robots meta tag or X-Robots-Tag header if this page should be found. If it is meant to stay private, mark the page private in the Shapewall config.',
  },
  'robots-crawl-blocked': {
    level: 'error',
    group: 'indexing',
    label: 'Blocked by robots.txt',
    explain: 'The site’s robots.txt rules stop Googlebot from crawling this address, so Google can’t read its content.',
    fix: 'Change the Disallow rule in robots.txt that matches this path, or add a more specific Allow rule for it.',
  },
  'robots-unavailable': {
    level: 'tip',
    group: 'indexing',
    label: 'Crawl rules could not be read',
    explain: 'robots.txt redirected, timed out or was too large, so crawl permission is unknown.',
    fix: 'Serve robots.txt directly from the site root with a 200 or 404 response.',
  },
  'missing-title': {
    level: 'error',
    group: 'title',
    label: 'No page title',
    explain: 'Without a <title>, Google writes its own headline for the result, usually from text on the page.',
    fix: 'Add a unique <title> that says what the page is, with the brand at the end.',
  },
  'seo-title-long': {
    level: 'tip',
    group: 'title',
    label: 'Title will be cut off',
    explain: 'Google shows about 580 pixels of a title (roughly 55 to 60 characters). The rest is replaced with an ellipsis.',
    fix: 'Put the important words first and shorten the title so it fits.',
  },
  'seo-title-short': {
    level: 'tip',
    group: 'title',
    label: 'Title is very short',
    explain: 'A very short title gives searchers little reason to pick this result.',
    fix: 'Describe the page in a few more words, for example the product or topic and the brand.',
  },
  'duplicate-title': {
    level: 'warning',
    group: 'title',
    label: 'Same title as another page',
    explain: 'Several pages share this title, so searchers can’t tell them apart and Google may pick the wrong one.',
    fix: 'Give each page its own title that names what is different about it.',
  },
  'seo-description': {
    level: 'warning',
    group: 'description',
    label: 'No meta description',
    explain: 'Without a description, Google picks a snippet from the page text, which is often a menu or a cookie banner.',
    fix: 'Add <meta name="description"> with one or two sentences (about 120 to 155 characters) that sell the page.',
  },
  'seo-description-long': {
    level: 'tip',
    group: 'description',
    label: 'Description will be cut off',
    explain: 'Google shows about 920 pixels of a description (roughly 150 to 160 characters) on desktop and less on phones.',
    fix: 'Keep the key message in the first 120 characters.',
  },
  'seo-description-short': {
    level: 'tip',
    group: 'description',
    label: 'Description is very short',
    explain: 'A short description leaves room Google may fill with page text instead.',
    fix: 'Write one or two full sentences about what the visitor gets on this page.',
  },
  'duplicate-description': {
    level: 'warning',
    group: 'description',
    label: 'Same description as another page',
    explain: 'Repeated descriptions make results look identical and tell searchers nothing about this page.',
    fix: 'Write a description for this page that is specific to it.',
  },
  'seo-canonical': {
    level: 'warning',
    group: 'canonical',
    label: 'No canonical URL',
    explain:
      'A canonical link tells search engines which address is the real one when the page is reachable at several (with tracking parameters, trailing slashes or www).',
    fix: 'Add <link rel="canonical" href="..."> with the page’s full preferred address.',
  },
  'canonical-invalid': {
    level: 'warning',
    group: 'canonical',
    label: 'Canonical URL is not a full address',
    explain: 'The canonical link is relative or not http(s). Search engines may ignore it.',
    fix: 'Use an absolute https:// address in the canonical link.',
  },
  'canonical-elsewhere': {
    level: 'error',
    group: 'canonical',
    label: 'Canonical points to another page',
    explain: 'The canonical link names a different address, which tells Google to show that page instead of this one.',
    fix: 'Point the canonical link at this page’s own address, unless this really is a copy of the other page.',
  },
  'seo-ogtitle': {
    level: 'warning',
    group: 'social',
    label: 'No social title',
    explain: 'Without og:title, Slack, LinkedIn, iMessage and others guess a headline for shared links.',
    fix: 'Add <meta property="og:title"> with the headline you want in link previews.',
  },
  'seo-ogdescription': {
    level: 'tip',
    group: 'social',
    label: 'No social description',
    explain: 'Link previews show og:description under the headline. Without it they show nothing or random text.',
    fix: 'Add <meta property="og:description"> with one short sentence.',
  },
  'seo-ogimage': {
    level: 'warning',
    group: 'social',
    label: 'No social image',
    explain: 'Shared links without og:image show as a plain text line and get far fewer clicks.',
    fix: 'Add <meta property="og:image"> with an absolute URL to a 1200 × 630 image.',
  },
  'social-image-failed': {
    level: 'error',
    group: 'social',
    label: 'Social image is broken',
    explain: 'The og:image address returned an error or isn’t a valid image, so previews show a blank box.',
    fix: 'Fix the og:image URL so it returns a PNG, JPEG or WebP image with a 200 response.',
  },
  'social-image-invalid': {
    level: 'warning',
    group: 'social',
    label: 'Social image URL is not a full address',
    explain: 'og:image must be an absolute http(s) URL. Most platforms ignore relative paths.',
    fix: 'Use the full https:// address of the image.',
  },
  'social-image-unavailable': {
    level: 'tip',
    group: 'social',
    label: 'Social image could not be verified',
    explain: 'The image is on another domain, redirected or is in a format Shapewall can’t decode, so its preview is not shown here.',
    fix: 'Nothing is necessarily wrong. Check a preview with the platform’s own debugger if in doubt.',
  },
  'social-image-dimensions': {
    level: 'tip',
    group: 'social',
    label: 'Image size differs from its tags',
    explain: 'og:image:width and og:image:height don’t match the actual image, which can make previews crop or load late.',
    fix: 'Update the declared width and height to the real image size, or remove them.',
  },
})

const LEVEL_ORDER = { error: 0, warning: 1, tip: 2 }

// The one severity of a finding everywhere it is counted (Issues tab, summary
// tiles, page cards, sorting): an SEO finding takes its level from SEO_ISSUES
// (errors and warnings need attention, tips are notes), so the SEO view and
// the Issues tab agree; every other finding keeps the runner's severity.
export function findingSeverity(finding) {
  const known = finding?.category === 'seo' ? SEO_ISSUES[finding.id] : null
  return known ? (known.level === 'tip' ? 'advisory' : 'warning') : finding?.severity
}
export const SEO_FINDING_IDS = Object.freeze(Object.keys(SEO_ISSUES))

// The newest report of `runner` for a page across its devices; SEO-enabled
// reports first when `seoOnly`.
function newestReport(views, pageId, runner, test = () => true) {
  let best = null
  for (const view of views) {
    if (view.pageId !== pageId) continue
    const runs = view.runs?.length
      ? view.runs
      : view.report
        ? [{ runner: view.report.profile.runner, state: view.state, report: view.report }]
        : []
    for (const run of runs) {
      const report = run.report
      if (!report || (run.runner || report.profile.runner) !== runner || !test(report)) continue
      // Prefer desktop when two runs are from the same moment.
      const better =
        !best ||
        report.auditedAt > best.report.auditedAt ||
        (report.auditedAt === best.report.auditedAt && report.viewport.name === 'desktop')
      if (better) best = { report, stale: run.state === 'stale' }
    }
  }
  return best
}

// The report each page's SEO row is built from: its newest SEO-enabled page
// check on any device. The local API serves previews for exactly these.
export function latestSeoReports(views, pageIds) {
  const out = new Map()
  for (const id of pageIds) {
    const found = newestReport(views, id, 'playwright', (r) => r.profile.seo)
    if (found) out.set(id, found.report)
  }
  return out
}

const normalized = (value) => clean(value).toLowerCase()

// The board's SEO picture.
// - views: checksView(...).views
// - pages: the board's pages ({ id, title, url })
// - snapshots: { [reportId]: snapshot } of local search previews (optional)
// - privatePages: page ids configured with seo.indexable === false
export function analyzeSeo({ views = [], pages = [], snapshots = {}, privatePages = [] } = {}) {
  const privateSet = new Set(privatePages)
  const rows = pages.map((page) => {
    const found = newestReport(views, page.id, 'playwright', (r) => r.profile.seo)
    const any = found || newestReport(views, page.id, 'playwright')
    const lighthouse = newestReport(views, page.id, 'lighthouse', (r) => Number.isFinite(r.metrics?.lighthouseSeoLabScore))
    const report = found?.report || null
    const snapshot = report ? snapshots[report.id] || null : null
    const isPrivate = privateSet.has(page.id) || Boolean(report?.findings.some((f) => f.id === 'seo-private-expected'))
    const row = {
      pageId: page.id,
      title: page.title || page.id,
      url: page.url || null,
      status: isPrivate ? 'private' : !any ? 'not-run' : !report ? 'no-seo' : report.state === 'failed' ? 'failed' : 'checked',
      stale: Boolean(found?.stale),
      report,
      snapshot,
      lighthouseSeo: lighthouse ? lighthouse.report.metrics.lighthouseSeoLabScore : null,
      issues: [],
    }
    if (row.status === 'checked')
      for (const finding of report.findings) {
        const known = SEO_ISSUES[finding.id]
        // Duplicates are recomputed below from the previews when there are any.
        if (!known || (finding.id.startsWith('duplicate-') && snapshot)) continue
        row.issues.push({ id: finding.id, ...known, observation: finding.observation, finding })
      }
    return row
  })
  // Duplicates across every checked public page, not just one run.
  const duplicates = { title: [], description: [] }
  for (const key of ['title', 'description']) {
    const groups = new Map()
    for (const row of rows) {
      if (row.status !== 'checked' || !row.snapshot) continue
      const value = normalized(row.snapshot[key])
      if (!value) continue
      if (!groups.has(value)) groups.set(value, [])
      groups.get(value).push(row)
    }
    for (const [, group] of groups) {
      if (group.length < 2) continue
      duplicates[key].push({ value: clean(group[0].snapshot[key]), pageIds: group.map((r) => r.pageId) })
      for (const row of group) {
        const others = group.filter((r) => r !== row).map((r) => r.title)
        const id = `duplicate-${key}`
        row.issues.push({
          id,
          ...SEO_ISSUES[id],
          observation: `Also used on ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}.`,
          finding: null,
          others: group.filter((r) => r !== row).map((r) => r.pageId),
        })
      }
    }
  }
  // Reports without previews (hosted, imported) still carry run-level duplicates.
  for (const key of ['title', 'description'])
    if (!duplicates[key].length) {
      const ids = rows.filter((r) => r.issues.some((i) => i.id === `duplicate-${key}`)).map((r) => r.pageId)
      if (ids.length > 1) duplicates[key].push({ value: null, pageIds: ids })
    }
  for (const row of rows) {
    row.issues.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    row.errors = row.issues.filter((i) => i.level === 'error').length
    row.warnings = row.issues.filter((i) => i.level === 'warning').length
    row.tips = row.issues.filter((i) => i.level === 'tip').length
    row.indexable =
      row.status === 'checked'
        ? !row.issues.some((i) => ['search-noindex', 'robots-crawl-blocked', 'canonical-elsewhere'].includes(i.id))
        : null
  }
  const checked = rows.filter((r) => r.status === 'checked')
  const has = (row, ...ids) => row.issues.some((i) => ids.includes(i.id))
  const scores = rows.map((r) => r.lighthouseSeo).filter((n) => Number.isFinite(n))
  const summary = {
    pages: rows.filter((r) => r.status !== 'private').length,
    checked: checked.length,
    private: rows.filter((r) => r.status === 'private').length,
    notChecked: rows.filter((r) => ['not-run', 'no-seo', 'failed'].includes(r.status)).length,
    indexable: checked.filter((r) => r.indexable).length,
    notIndexable: checked.filter((r) => r.indexable === false).length,
    missingTitles: checked.filter((r) => has(r, 'missing-title')).length,
    missingDescriptions: checked.filter((r) => has(r, 'seo-description')).length,
    duplicateTitles: duplicates.title.reduce((n, g) => n + g.pageIds.length, 0),
    duplicateDescriptions: duplicates.description.reduce((n, g) => n + g.pageIds.length, 0),
    socialImageProblems: checked.filter((r) => has(r, 'seo-ogimage', 'social-image-failed', 'social-image-invalid')).length,
    canonicalIssues: checked.filter((r) => has(r, 'seo-canonical', 'canonical-invalid', 'canonical-elsewhere')).length,
    robotsIssues: checked.filter((r) => has(r, 'search-noindex', 'robots-crawl-blocked', 'robots-unavailable')).length,
    errors: checked.reduce((n, r) => n + r.errors, 0),
    warnings: checked.reduce((n, r) => n + r.warnings, 0),
    tips: checked.reduce((n, r) => n + r.tips, 0),
    lighthouseSeo: scores.length
      ? { min: Math.min(...scores), average: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), count: scores.length }
      : null,
  }
  return { rows, summary, duplicates }
}

// The Google result breadcrumb for a URL: "example.com › docs › setup".
export function searchBreadcrumb(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part)
        } catch {
          return part
        }
      })
    return { site: u.hostname.replace(/^www\./, ''), origin: `${u.protocol}//${u.host}`, path: parts }
  } catch {
    return { site: '', origin: '', path: [] }
  }
}
