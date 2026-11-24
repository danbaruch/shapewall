// Builds the public live demo (shapewall.com/demo/) from Brackwell, a big
// fictional field operations app (examples/brackwell: about 150 screens
// across marketing, sign in, onboarding, the app's modules, admin, billing,
// a customer portal and a technician app), so the board shows what Shapewall
// is for: the whole app on one board, journeys through it, and instructions
// pinned to screens for coding agents.
//
// - A staging copy captured three times (fixes land between rounds, so
//   screens have a history and resolved instructions a before and after) and
//   a production copy running an older release (other copy and prices, one
//   screen that only exists on staging).
// - Instructions to the agent in every state: queued, working, done, needs a
//   person, a fix waiting on a branch, resolved with a pull request or a
//   commit, reopened; a few questions between people. Only a handful are
//   unread when the board opens.
// - Eight journeys from the config (one with a branch).
// - No broken links: the board opens clean.
// - A second board in the same project: Lumen Notes, the small notes app,
//   with its own captures and a few instructions (scripts/demo-lumen-board.js),
//   so the demo shows a project holding more than one board.
//
// Captures are WebP (smaller than PNG, so the board's first view loads fast).
// Every name, address and URL is made up. Times are moved back over two
// weeks before a fixed moment, as in scripts/demo-lumen.js, so every export
// has the same times and file names.
//
// With --publish <siteRoot> both copies are written there after the captures
// (production as /brackwell, staging as /brackwell-staging, see
// scripts/demo-publish.js), with a demo banner, noindex and forms that send
// nothing. The captures come from the clean copies. The Lumen Notes board's
// copies go to /lumen and /lumen-staging (scripts/demo-lumen-board.js).
// Error reports: SHAPEWALL_ERROR_DSN (and SHAPEWALL_ERROR_ENVIRONMENT), as in
// scripts/demo-lumen.js.
// Run: node scripts/demo-export.js [outDir] [--publish siteRoot]   (Brackwell is the default app)
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startDemoSite } from '../examples/demo-site/server.js'
import { GROUPS, PAGES, brokenLinks, buildSite } from '../examples/brackwell/build.js'
import { frameSize, joinUrl, normalizeConfig } from '../src/config.js'
import { runCapture } from '../src/capture/capture.js'
import { exportStatic } from '../src/export.js'
import { errorMeta, errorSettingsFrom } from '../src/error-tracking.js'
import { addReply, createComment, reactToComment, setAgentStatus, updateComment } from '../src/store.js'
import { DEMO_APPS, publicUrl, publishDemoSite } from './demo-publish.js'
import { addLumenBoard } from './demo-lumen-board.js'
import { toWebp, walk } from './demo-webp.js'
import { demoHeadTags } from '../website/src/seo.js'

const APP = 'brackwell'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const publishAt = args.indexOf('--publish')
const publishRoot = publishAt >= 0 ? args.splice(publishAt, 2)[1] : null
if (publishAt >= 0 && !publishRoot) throw new Error('--publish needs a folder (the site root, e.g. website/dist)')
const out = path.resolve(args[0] || path.join(ROOT, 'demo-export'))
const DEMO_CLIENT = path.join(ROOT, 'dist', 'demo-app')
const errorSettings = errorSettingsFrom(process.env)
if (errorSettings?.problem) throw new Error(errorSettings.problem)
if (!fs.existsSync(path.join(DEMO_CLIENT, 'console.html'))) throw new Error('Build the demo client first: npm run build:demo')
// One scratch folder per output folder, as in demo-lumen.js.
const work = path.join(ROOT, 'test', '.output', 'demo-export-brackwell', createHash('sha256').update(out).digest('hex').slice(0, 12))
fs.rmSync(work, { recursive: true, force: true })

const STAGING_URL = publicUrl('staging', APP)
const PRODUCTION_URL = publicUrl('production', APP)
// The fictional repository has no web page: pull requests are plain references.
const PR = (number) => `brackwell/app#${number}`

// ---- Site copies -------------------------------------------------------------------
// Staging starts at round 1 and is rebuilt at rounds 2 and 3; production is
// the older release. Neither may have a broken link (the board would open on
// a warning).
const stagingDir = path.join(work, 'sites', 'staging')
const productionDir = path.join(work, 'sites', 'production')
function build(dir, state) {
  buildSite(dir, state)
  const broken = brokenLinks(dir)
  if (broken.length) throw new Error(`brackwell: broken links in ${state.env}: ${JSON.stringify(broken.slice(0, 5))}`)
}
build(stagingDir, { env: 'staging', round: 1 })
build(productionDir, { env: 'production' })

const staging = await startDemoSite({ port: 0, root: stagingDir })
const production = await startDemoSite({ port: 0, root: productionDir })
const local = (server) => `http://127.0.0.1:${server.address().port}`

// ---- Board config ------------------------------------------------------------------
const JOURNEYS = [
  {
    id: 'sign-up',
    name: 'Sign up to first job',
    description: 'From the home page through the trial sign up and onboarding to the first day on the dashboard',
    steps: [
      'home',
      'pricing',
      'signup',
      'check-email',
      'ob-company',
      'ob-trades',
      'ob-team',
      'ob-import',
      'ob-first-job',
      'ob-done',
      'dashboard',
    ],
  },
  {
    id: 'work-order-to-invoice',
    name: 'Work order to paid invoice',
    description: 'The core loop: a job is created, assigned and dispatched, done on site, then invoiced and paid',
    steps: [
      'wo-list',
      'wo-new',
      'wo-detail',
      'wo-assign',
      'dispatch',
      'tech-job',
      'tech-checklist',
      'tech-signature',
      'wo-complete',
      'invoice-new',
      'invoice-sent',
      'payments',
    ],
  },
  {
    id: 'sign-in',
    name: 'Sign in',
    description: 'With a password (wrong once, then reset) or with single sign-on; both end at two-factor',
    steps: [
      'signin',
      {
        branches: [
          { id: 'password', label: 'Password', steps: ['signin-error', 'forgot', 'reset-sent', 'signin'] },
          { id: 'sso', label: 'Single sign-on', steps: ['signin-sso'] },
        ],
      },
      'two-factor',
      'dashboard',
    ],
  },
  {
    id: 'invite-teammate',
    name: 'Invite a teammate',
    description: 'An admin invites a dispatcher, they accept, and the admin adjusts the role',
    steps: ['settings', 'members', 'member-invite', 'invite-accept', 'roles', 'role-edit', 'audit'],
  },
  {
    id: 'customer-portal',
    name: 'Customer self-service',
    description: 'A customer signs in, requests service, follows it, approves the estimate and pays',
    steps: ['portal-signin', 'portal', 'portal-request', 'portal-status', 'portal-estimate', 'portal-pay'],
  },
  {
    id: 'restock',
    name: 'Restock parts',
    description: 'Low stock on the dashboard to a purchase order and the warehouse',
    steps: ['dashboard', 'low-stock', 'part', 'po-new', 'po', 'warehouses'],
  },
  {
    id: 'plan-project',
    name: 'Plan a project',
    description: 'A multi-visit job as a project: tasks, timeline and budget',
    steps: ['projects', 'project-new', 'project', 'project-tasks', 'project-timeline', 'project-budget'],
  },
  {
    id: 'month-end',
    name: 'Month-end numbers',
    description: 'The reports an owner reads at the end of the month, then the export for the accountant',
    steps: ['reports', 'report-revenue', 'report-utilization', 'report-sla', 'report-export'],
  },
]

const raw = {
  title: 'Brackwell (demo)',
  id: 'demo',
  concurrency: 4,
  versions: 5,
  viewports: {
    desktop: { width: 1440, height: 960 },
    phone: { width: 390, height: 844 },
  },
  groups: GROUPS,
  pages: PAGES.map((page) => ({
    id: page.id,
    path: page.path,
    title: page.title,
    group: page.group,
    ...(page.note ? { note: page.note } : {}),
    ...(page.frameHeight ? { frameHeight: page.frameHeight } : {}),
  })),
  journeys: JOURNEYS,
  environments: [
    { id: 'staging', title: 'Staging', baseUrl: local(staging), publicUrl: STAGING_URL },
    { id: 'production', title: 'Production', baseUrl: local(production), publicUrl: PRODUCTION_URL },
  ],
  outputDir: path.join(work, '.shapewall'),
}
const config = normalizeConfig(raw, { dir: work })
const board = config.boards[0]
const log = (line) => console.log(line)
let browser = null

// ---- Time --------------------------------------------------------------------------
const BUILT = Date.UTC(2026, 9, 1, 15, 0, 0)
const SCRIPT_START = Date.now()
const DAY = 24 * 3600 * 1000
const ago = (days) => new Date(BUILT - days * DAY)
const runs = []
async function capture(label, daysAgo, options = {}) {
  const start = Date.now()
  const result = await runCapture({ config, log, ...options })
  runs.push({ label, start, end: Date.now(), target: BUILT - daysAgo * DAY })
  return result
}

// ---- Comments ----------------------------------------------------------------------
const pageOf = (pageId) => board.pages.find((item) => item.id === pageId) || fail(`no page ${pageId}`)
function fail(message) {
  throw new Error(`demo: ${message}`)
}

// Where an element sits in a staging capture, in percent of the frame (a
// page's frameHeight, else the viewport), as a click would store it.
async function pinAt(viewportName, pageId, selector) {
  const page = pageOf(pageId)
  const size = config.viewports[viewportName]
  const frame = frameSize(size, page, viewportName)
  const mobile = viewportName !== 'desktop'
  const tab = await browser.newPage({ viewport: { width: size.width, height: size.height }, isMobile: mobile, hasTouch: mobile })
  await tab.goto(joinUrl(local(staging), page.path))
  const box = await tab.locator(selector).first().boundingBox()
  const tag = box
    ? await tab
        .locator(selector)
        .first()
        .evaluate((node) => node.tagName.toLowerCase())
    : null
  await tab.close()
  if (!box) fail(`${selector} is not on ${page.path} (${viewportName})`)
  if (box.y > frame.height) fail(`${selector} is below the ${viewportName} frame of ${pageId}`)
  const round = (value) => Math.round(value * 100) / 100
  const share = (value) => Math.min(1, Math.round(value * 10000) / 10000)
  return {
    x: round(((box.x + box.width / 2) / frame.width) * 100),
    y: round(((box.y + box.height / 2) / frame.height) * 100),
    size: { w: share(box.width / frame.width), h: share(box.height / frame.height) },
    // An anchor selector as the client writes it: tag[data-testid="..."].
    anchorSelector: selector.startsWith('[') ? tag + selector : selector,
  }
}

// A box around the pinned element, and an arrow to it from `from`.
function markup({ x, y, size }, from = null) {
  const r = (value) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000
  const [cx, cy] = [x / 100, y / 100]
  const half = [size.w / 2 + 0.01, size.h / 2 + 0.006]
  const box = {
    tool: 'box',
    ink: 'bad',
    width: 4,
    points: [
      [r(cx - half[0]), r(cy - half[1])],
      [r(cx + half[0]), r(cy + half[1])],
    ],
  }
  if (!from) return { shapes: [box] }
  const arrow = { tool: 'arrow', ink: 'bad', width: 4, points: [from.map(r), [r(cx - half[0] - 0.005), r(cy)]] }
  return { shapes: [box, arrow] }
}

async function comment({ page, viewport = 'desktop', selector, anchor = null, body, author, days, draw = null }) {
  const { x, y, size, anchorSelector } = await pinAt(viewport, page, selector)
  const drawing = draw ? markup({ x, y, size }, draw.from || null) : null
  return createComment(
    config,
    board,
    {
      pageId: page,
      viewport,
      x,
      y,
      body,
      author,
      ...(anchor !== null ? { anchor: { selector: anchorSelector, text: anchor, dx: 0.5, dy: 0.5, ...size } } : {}),
      ...(drawing ? { drawing } : {}),
    },
    { now: ago(days) },
  )
}
const AGENT = 'Coding agent'
const reply = (item, author, body, days) => addReply(config, board.id, item.id, { author, body }, { now: ago(days) })
const agent = (item, status, days, extra = {}) => setAgentStatus(config, board.id, item.id, status, { now: ago(days), ...extra })
const resolve = (item, days, resolution, fixRef = undefined) =>
  updateComment(config, board.id, item.id, { status: 'resolved', resolution, ...(fixRef ? { fixRef } : {}) }, { now: ago(days) })
const reopen = (item, days) => updateComment(config, board.id, item.id, { status: 'open' }, { now: ago(days) })
async function react(item, emoji, people, replyId = null) {
  for (const author of people) await reactToComment(config, board.id, item.id, { emoji, author, replyId })
}
// An instruction the agent took and finished: queued, working, its reply, done.
async function agentDid(item, days, text) {
  await agent(item, 'queued', days)
  await agent(item, 'working', days - 0.01)
  await reply(item, AGENT, text, days - 0.05)
  await agent(item, 'done', days - 0.05)
}

const ROUND2_PAGES = ['wo-list', 'invoice', 'dispatch', 'dashboard', 'signup', 'tech-job']
const ROUND3_PAGES = ['schedule', 'report-revenue', 'customer', 'pricing']

try {
  // ---- 1. Staging, first capture (nine days ago), and the first instructions -------
  await capture('staging 1', 9)
  browser = await chromium.launch()

  const bulk = await comment({
    page: 'wo-list',
    selector: '[data-testid="bulk-bar"]',
    anchor: '',
    body: '@agent Dispatchers select a few jobs and then open each one to assign it. Add an Assign button to this selection bar that assigns all of them at once.',
    author: 'Robin',
    days: 8.9,
  })
  await agentDid(
    bulk,
    8.85,
    'Added Assign to the selection bar; it opens the same technician picker as one job. Recaptured Work orders. @robin over to you.',
  )

  const pdf = await comment({
    page: 'invoice',
    selector: '[data-testid="invoice-paper"]',
    anchor: '',
    body: '@agent Customers ask for a PDF of every invoice. Add a Download PDF button next to Send reminder.',
    author: 'Robin',
    days: 8.5,
  })
  await agentDid(pdf, 8.45, 'Added Download PDF in the header actions, using the printed invoice layout.')

  const legend = await comment({
    page: 'dispatch',
    selector: '.map',
    body: 'New dispatchers ask what the pin colours mean. @agent add a small legend under the map: on the way, on site, done, late.',
    author: 'Mei',
    days: 8,
  })
  await agentDid(legend, 7.95, 'Legend added under the map, same colours as the pins.')

  const sort = await comment({
    page: 'dashboard',
    selector: '[data-testid="today-jobs"]',
    anchor: '',
    body: "@agent Sort today's jobs by start time and say so in the card title. Right now the order looks random.",
    author: 'Robin',
    days: 7.5,
  })
  await agentDid(sort, 7.45, 'Sorted by start time; the title reads "Today\'s jobs, by start time".')

  const rules = await comment({
    page: 'signup',
    viewport: 'phone',
    selector: '[data-testid="password-rules"]',
    anchor: '',
    body: '@agent The password rule is red before anyone has typed, so it reads like an error. Show it muted, and friendlier.',
    author: 'Jo',
    days: 7,
  })
  await agentDid(rules, 6.95, 'The rule is muted help text now: "At least 12 characters. A passphrase works well."')

  const navigate = await comment({
    page: 'tech-job',
    viewport: 'phone',
    selector: '[data-testid="tech-navigate"]',
    anchor: '',
    body: '@agent Technicians tap Navigate more than anything else on this screen. Make it the big primary button.',
    author: 'Robin',
    days: 6.5,
  })
  await agentDid(navigate, 6.45, 'Navigate is the large primary button now, first in the row.')

  // ---- 2. Fixes land; staging is captured again (five days ago) --------------------
  build(stagingDir, { env: 'staging', round: 2 })
  await capture('staging 2', 5, { only: ROUND2_PAGES })
  await resolve(bulk, 4.95, 'Bulk Assign in the selection bar.', PR(118))
  await resolve(pdf, 4.9, 'Download PDF on every invoice.', 'commit 4be1c07')
  await resolve(legend, 4.85, 'Legend under the dispatch map.', PR(121))
  await resolve(sort, 4.8, 'Sorted by start time.', 'commit 9a03f5e')
  await resolve(rules, 4.75, 'Muted, friendlier password rule.', PR(123))
  await resolve(navigate, 4.7, 'Navigate is the primary action.', PR(124))
  await reply(navigate, 'Robin', 'Better, but on the job list it is still the small button. Reopening until both match.', 3.4)
  await reopen(navigate, 3.4)

  const conflicts = await comment({
    page: 'schedule',
    selector: '[data-testid="week-grid"]',
    anchor: '',
    body: '@agent Two jobs booked for the same technician at the same time should be impossible to miss. Show overlapping jobs in red.',
    author: 'Robin',
    days: 4.6,
  })
  await agentDid(conflicts, 4.55, 'Overlapping jobs are red with a warning icon, on the week and the day view.')

  const compare = await comment({
    page: 'report-revenue',
    selector: '.chart',
    body: '@agent Add last year as a dashed line on the revenue chart, so a slow month is obvious.',
    author: 'Sam',
    days: 4.2,
  })
  await agentDid(compare, 4.15, 'Last year is a dashed grey line, with a legend.')

  const tabCount = await comment({
    page: 'customer',
    selector: '.tabs',
    body: '@agent Show how many open work orders a customer has on the Work orders tab, like the other tabs.',
    author: 'Robin',
    days: 4,
  })
  await agentDid(tabCount, 3.95, 'The tab shows the count of open work orders.')

  const yearly = await comment({
    page: 'pricing',
    selector: '[data-testid="billing-toggle"]',
    anchor: '',
    body: '@agent Most customers pay yearly. Make yearly the default on the pricing page.',
    author: 'Jo',
    days: 3.6,
  })

  const signature = await comment({
    page: 'wo-detail',
    selector: '[data-testid="complete-job"]',
    anchor: '',
    body: "@agent Completing a job should require the customer's signature.",
    author: 'Robin',
    days: 3.5,
  })
  await agent(signature, 'queued', 3.45)
  await agent(signature, 'working', 3.44)
  await reply(
    signature,
    AGENT,
    'This needs a decision first: block Complete until there is a signature, or allow it with a reason (customer not on site)? @robin',
    3.4,
  )
  await agent(signature, 'needs-human', 3.4)
  await reply(signature, 'Robin', 'Allow it with a reason. Most of our maintenance visits have nobody on site.', 3.1)

  // ---- 3. More changes; staging is captured a third time (two days ago) -------------
  build(stagingDir, { env: 'staging', round: 3 })
  await capture('staging 3', 2, { only: ROUND3_PAGES })
  await resolve(conflicts, 1.95, 'Conflicts are red on the schedule.', PR(131))
  await resolve(compare, 1.9, 'Last year as a dashed line.', 'commit c27d8b1')
  await resolve(tabCount, 1.85, 'Open work order count on the tab.', PR(133))
  await react(conflicts, '🎉', ['Mei', 'Sam'])
  await agentDid(yearly, 1.8, 'Yearly is the default; the toggle shows the monthly price on switch. @jo please check the copy.')

  const bulkProjects = await comment({
    page: 'projects',
    selector: '[data-testid="project-cards"]',
    anchor: '',
    body: '@agent Projects need the same select-and-act bar as Work orders: select several, change status or owner.',
    author: 'Robin',
    days: 1.7,
  })
  await agent(bulkProjects, 'queued', 1.69)

  const routes = await comment({
    page: 'route-plan',
    selector: '.map',
    body: '@agent Route planning is new on staging. Check it against Dispatch: same pin colours, same legend, same technician order.',
    author: 'Robin',
    days: 1.5,
  })
  await agent(routes, 'queued', 1.49)
  await agent(routes, 'working', 1.48)
  await reply(
    routes,
    AGENT,
    'Comparing the two now. The pin colours match; the legend is missing here and the technician order differs. Fixing both.',
    1.45,
  )

  const members = await comment({
    page: 'members',
    selector: 'table',
    body: "@agent Changing someone's role takes three clicks. Put a role dropdown right in the Role column.",
    author: 'Jo',
    days: 1.3,
  })
  await agent(members, 'queued', 1.28)
  await agent(members, 'working', 1.27)
  const branch = `shapewall/comment-${members.id}-role-dropdown`
  await agent(members, 'branch-ready', 1.25, { branch })
  await reply(
    members,
    'shapewall',
    `The agent's change is ready on branch ${branch}. Your checkout is unchanged: apply the branch from the chat to see it on the board, with before and after.`,
    1.25,
  )

  await comment({
    page: 'tech-today',
    viewport: 'phone',
    selector: '.card',
    body: 'Technicians want the job they are on at the top, then what is next. Right now it is in booking order. @robin worth doing?',
    author: 'Mei',
    days: 1.1,
  })

  const reorder = await comment({
    page: 'low-stock',
    selector: 'table',
    body: '@agent Add a Reorder all button that opens a new purchase order with these parts and quantities filled in.',
    author: 'Robin',
    days: 1,
  })
  await agent(reorder, 'queued', 0.99)

  const pay = await comment({
    page: 'portal-pay',
    viewport: 'phone',
    selector: 'form',
    body: 'On a phone the amount is below the card fields. Customers want to see what they pay first.',
    author: 'Mei',
    days: 0.9,
    draw: { from: [0.15, 0.12] },
  })
  await reply(pay, 'Robin', '@agent take this one: amount and invoice summary above the form on phones.', 0.85)
  await agent(pay, 'queued', 0.84)
  await react(pay, '👍', ['Jo'])

  const auditCsv = await comment({
    page: 'audit',
    selector: 'table',
    body: '@agent Auditors want the log as a file. Add Export CSV with the current filters.',
    author: 'Sam',
    days: 3,
  })
  await agentDid(auditCsv, 2.95, 'Export CSV added; it respects the filters and the date range.')
  await resolve(auditCsv, 2.5, 'Export CSV on the audit log.', 'commit 61f0a9d')

  const choose = await comment({
    page: 'ob-import',
    viewport: 'phone',
    selector: '[data-testid="dropzone"]',
    anchor: '',
    body: '@agent Nobody drops files on a phone. Show a "Choose file" button instead of the drop zone below 480 px.',
    author: 'Robin',
    days: 0.7,
  })
  await agent(choose, 'queued', 0.69)

  const errorState = await comment({
    page: 'wo-error',
    selector: '[data-testid="load-error"]',
    anchor: '',
    body: '@agent Use this error state everywhere a list fails to load (customers, invoices, inventory), not one-off messages.',
    author: 'Robin',
    days: 0.5,
  })
  await agent(errorState, 'queued', 0.49)
  await agent(errorState, 'working', 0.48)
  await reply(errorState, AGENT, 'Made it a shared component; switching the three lists over now.', 0.45)

  await comment({
    page: 'dashboard-empty',
    selector: 'h1',
    body: '@agent A new account sees an empty dashboard. Add a getting started card: add a technician, import customers, create the first job.',
    author: 'Robin',
    days: 0.3,
  })

  // ---- 4. Production (an older release, captured twelve days ago) -----------------
  const captured = { staging: siteHash(stagingDir) }
  await capture('production', 12, { envId: 'production' })
  captured.production = siteHash(productionDir)

  const result = await exportStatic(config, { out, clientDir: DEMO_CLIENT, noindex: true })
  replaceInJson(result.out, [
    [local(staging), STAGING_URL],
    [local(production), PRODUCTION_URL],
  ])
  retime(result.out)
  const converted = await toWebp(result.out)
  // The project's second board: Lumen Notes, with its own captures (and, with
  // --publish, its own published copies at /lumen and /lumen-staging).
  const lumen = await addLumenBoard(result.out, { publishRoot })
  checkNoLocalDetails(result.out)
  writeDemoHead(path.join(result.out, 'index.html'))
  if (errorSettings)
    for (const page of ['index.html', 'console.html']) {
      const file = path.join(result.out, page)
      const text = fs.readFileSync(file, 'utf8')
      if (!text.includes('</head>')) throw new Error(`demo export: ${page} has no </head> for the error report tags`)
      fs.writeFileSync(file, text.replace('</head>', `${errorMeta(errorSettings)}</head>`))
    }
  console.log(
    `Demo (Brackwell, ${board.pages.length} screens, and Lumen Notes, ${lumen.pages} screens) exported to ${result.out} (${result.files + lumen.files} files, ${converted + lumen.converted} images as WebP)`,
  )
  if (publishRoot) {
    const root = path.resolve(publishRoot)
    for (const [env, dir] of [
      ['production', productionDir],
      ['staging', stagingDir],
    ]) {
      if (siteHash(dir) !== captured[env]) throw new Error(`demo publish: the ${env} copy changed after its last capture`)
      const files = publishDemoSite(dir, root, env, APP)
      for (const file of files) checkNoLocalDetails(path.join(root, file))
      console.log(`Demo app (${env}) published as ${new URL(publicUrl(env, APP)).pathname} in ${root} (${files.length} files)`)
    }
    const { banner, mark } = DEMO_APPS[APP]
    const marked = walk(result.out).find((file) => {
      if (!file.endsWith('.html')) return false
      const text = fs.readFileSync(file, 'utf8')
      return text.includes(banner) || text.includes(mark)
    })
    if (marked) throw new Error(`demo publish: ${path.relative(result.out, marked)} shows the demo banner or form guard`)
  }
} finally {
  await browser?.close()
  staging.close()
  production.close()
}

// ---- Helpers -----------------------------------------------------------------------

// The board's index.html gets the site's title, description, canonical and share card for /demo/ (website/src/routes.js
// DEMO_PAGE), in place of its plain title and robots tag. Still noindex.
function writeDemoHead(file) {
  const html = fs.readFileSync(file, 'utf8')
  const stripped = html.replace(/\s*<title>[^<]*<\/title>/, '').replace(/\s*<meta name="robots"[^>]*>/g, '')
  if (!stripped.includes('</head>')) throw new Error('demo export: index.html has no </head> for the share tags')
  fs.writeFileSync(file, stripped.replace('</head>', `    ${demoHeadTags()}\n  </head>`))
}

function siteHash(dir) {
  const hash = createHash('sha256')
  for (const file of walk(dir).sort()) hash.update(path.relative(dir, file)).update('\0').update(fs.readFileSync(file)).update('\0')
  return hash.digest('hex')
}

function replaceInJson(dir, pairs) {
  for (const file of walk(dir)) {
    if (!file.endsWith('.json')) continue
    const text = fs.readFileSync(file, 'utf8')
    const next = pairs.reduce((value, [from, to]) => value.split(from).join(to), text)
    if (next !== text) fs.writeFileSync(file, next)
  }
}

// As in scripts/demo-lumen.js: capture times move from the minutes this
// script ran to the days the runs stand for, the same way on every run.
function retime(dir) {
  const RUN_END = 10 * 60 * 1000
  const runOf = (time) => runs.find((item) => time >= item.start && time <= item.end) || null
  const shift = (time) => {
    const run = runOf(time)
    if (run) return run.target + RUN_END
    return time >= SCRIPT_START ? BUILT : time
  }
  const iso = (value) => new Date(shift(Date.parse(value))).toISOString()
  const fromVersion = (value) =>
    Date.UTC(
      +value.slice(0, 4),
      +value.slice(4, 6) - 1,
      +value.slice(6, 8),
      +value.slice(9, 11),
      +value.slice(11, 13),
      +value.slice(13, 15),
      +value.slice(15, 18),
    )
  const toVersion = (time) =>
    new Date(time)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.(\d{3})Z$/, '$1Z')

  // Two viewports per page, one second apart: every slot fits in the run's window.
  const slots = new Map()
  board.pages.forEach((page, index) =>
    Object.keys(config.viewports).forEach((viewport, offset) => slots.set(`${page.id}.${viewport}`, index * 2 + offset)),
  )
  const owners = new Map()
  const view = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'boards', `${board.id}.json`), 'utf8'))
  for (const [pageId, byViewport] of Object.entries(view.manifest?.pages || {})) {
    for (const [viewport, entry] of Object.entries(byViewport || {})) if (entry?.version) owners.set(entry.version, `${pageId}.${viewport}`)
  }
  for (const [pageId, byViewport] of Object.entries(view.versions || {})) {
    for (const [viewport, list] of Object.entries(byViewport || {}))
      for (const item of list) owners.set(item.version, `${pageId}.${viewport}`)
  }
  const mapped = new Map()
  const version = (value) => {
    if (mapped.has(value)) return mapped.get(value)
    const [stamp, suffix] = value.split('-')
    const run = runOf(fromVersion(stamp))
    let next = value
    if (run) {
      const owner = owners.get(value)
      const slot = owner && slots.has(owner) ? slots.get(owner) : 590
      const tag = createHash('sha256')
        .update(`${run.label}|${owner || value}`)
        .digest('hex')
        .slice(0, 4)
      next = `${toVersion(run.target + slot * 1000)}${suffix === undefined ? '' : `-${tag}`}`
    } else if (fromVersion(stamp) >= SCRIPT_START) {
      next = `${toVersion(BUILT)}${suffix === undefined ? '' : '-0000'}`
    }
    mapped.set(value, next)
    return next
  }
  const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g
  const VERSION_RE = /\d{8}T\d{9}Z(?:-[a-f0-9]{4})?/g
  for (const file of walk(dir).sort()) {
    if (file.endsWith('.json')) {
      const text = fs.readFileSync(file, 'utf8')
      const next = text
        .replace(ISO_RE, iso)
        .replace(VERSION_RE, version)
        .replace(/"(ms|durationMs)":\d+/g, '"$1":0')
      if (next !== text) fs.writeFileSync(file, next)
    }
    const name = path.basename(file)
    const renamed = name.replace(VERSION_RE, version)
    if (renamed !== name) fs.renameSync(file, path.join(path.dirname(file), renamed))
  }
  if (new Set(mapped.values()).size !== mapped.size) throw new Error('demo retime: two capture versions got the same id')
  // The moment the fixtures stand for, and which fictional app this is (client/src/demo/world.js).
  const infoFile = path.join(dir, 'data', 'info.json')
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'))
  fs.writeFileSync(infoFile, JSON.stringify({ ...info, fixturesAt: new Date(BUILT).toISOString(), demoApp: APP }))
}

function checkNoLocalDetails(dir) {
  const needles = ['127.0.0.1', 'localhost', os.homedir(), ROOT, os.hostname()].filter((item) => item && item.length > 3)
  for (const file of fs.statSync(dir).isDirectory() ? walk(dir) : [dir]) {
    if (!/\.(json|html|js|css|webmanifest)$/.test(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const sdk = /(^|[\\/])error-reports-sdk-[\w-]+\.js$/.test(file)
    const hit = needles.find((needle) => text.includes(needle) && !(sdk && ['127.0.0.1', 'localhost'].includes(needle)))
    if (hit) throw new Error(`${path.relative(dir, file) || path.basename(file)} contains "${hit}"; the demo must not carry local details.`)
  }
}
