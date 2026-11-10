// Builds the public live demo (shapewall.com/demo/): the fictional product
// "Lumen Notes" (examples/demo-site, board from shapewall.full.config.json)
// with a staging and a production copy, so every part of the board has
// something to show (every page at desktop, tablet and phone width):
//
// - three staging capture rounds (fixes land between them), so pages have a
//   history (with the changed pixels in red) and resolved comments have a
//   before and after;
// - comments in every state: open, pinned to an element or by position,
//   threads, @mentions of people and of the agent, agent queued / working /
//   done / needs a person, resolved with a pull request or a commit, resolved
//   but not recaptured, reopened, an element that moved, on variants;
// - five journeys from the config (happy paths and error paths, one visiting a
//   page twice, Sign up forking at the email link: it works, or it has
//   expired and is sent again) and one made on the board;
// - two variants; a desktop-only page (a narrower card, no phone frame); a
//   page that fails to capture;
// - production older than staging: changed copy and prices, a page that only
//   exists on staging.
//
// Every name, address and URL in it is made up. Capture times are moved back
// over two weeks before a fixed moment so history and "captured 2 days ago"
// read like a real project, and every export has the same times and file
// names. Visitors' changes (comments, invites, roles, chat) stay in their own
// browser; the client is the demo build (vite.demo.config.js).
//
// The board's live links open real pages: with --publish <siteRoot> both
// copies of the site are written there after the captures (production as
// /lumen, staging as /lumen-staging, see scripts/demo-publish.js), with a
// demo banner, noindex and forms that send nothing. The captures are taken
// from the clean copies, so the board's screenshots carry none of that.
// Run: node scripts/demo-export.js [outDir] [--publish siteRoot]   (default demo-export/)
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startDemoSite } from '../examples/demo-site/server.js'
import { joinUrl, normalizeConfig } from '../src/config.js'
import { captureVariant, runCapture } from '../src/capture/capture.js'
import { exportStatic } from '../src/export.js'
import { createJourney } from '../src/journeys.js'
import { addReply, createComment, reactToComment, saveVariant, setAgentStatus, updateComment } from '../src/store.js'
import { BANNER_TEXT, publicUrl, publishDemoSite } from './demo-publish.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'examples', 'demo-site', 'public')
const CONFIG = path.join(ROOT, 'examples', 'demo-site', 'shapewall.full.config.json')
const args = process.argv.slice(2)
const publishAt = args.indexOf('--publish')
const publishRoot = publishAt >= 0 ? args.splice(publishAt, 2)[1] : null
if (publishAt >= 0 && !publishRoot) throw new Error('--publish needs a folder (the site root, e.g. website/dist)')
const out = path.resolve(args[0] || path.join(ROOT, 'demo-export'))
const DEMO_CLIENT = path.join(ROOT, 'dist', 'demo-app')
if (!fs.existsSync(path.join(DEMO_CLIENT, 'console.html'))) throw new Error('Build the demo client first: npm run build:demo')
const work = path.join(ROOT, 'test', '.output', 'demo-export')
fs.rmSync(work, { recursive: true, force: true })

// Shown on the board instead of the local servers the captures came from:
// the copies published on shapewall.com (--publish), so live links open.
const STAGING_URL = publicUrl('staging')
const PRODUCTION_URL = publicUrl('production')
// The fictional repository has no web page: pull requests are plain
// references, shown on the board as text rather than links that go nowhere.
const PR = (number) => `lumen/web#${number}`

// ---- Site states ------------------------------------------------------------------
// examples/demo-site/public is staging as it is now (after round 3). Each
// round lists [now, before] pairs per file; undoing round 3 and then round 2
// gives the site as it was at the first capture. A RegExp `now` removes or
// replaces every match.

// Fixes that landed between capture 1 and capture 2.
const ROUND2 = {
  'pricing/index.html': [
    ['class="btn btn-primary" href="/login/" data-testid="plus-cta"', 'class="btn btn-ghost" href="/login/" data-testid="plus-cta"'],
  ],
  'features/index.html': [['Built for messy, real thinking.', 'Built for messy, real thinkng.']],
  'app/settings/billing/index.html': [
    ['<th>Status</th>\n                      <th>Receipt</th>', '<th>Status</th>'],
    [
      '<td><span class="pill">Paid</span></td>\n                      <td><a href="/app/settings/billing/">Download</a></td>',
      '<td><span class="pill">Paid</span></td>',
    ],
  ],
  'welcome/index.html': [
    [
      '<span class="step"></span><span class="step"></span><span class="steps-label">Step 1 of 3</span>',
      '<span class="step"></span><span class="step"></span>',
    ],
  ],
  'error/index.html': [
    [
      'Back to my notes</a\n            ><a class="btn btn-ghost" href="/changelog/" data-testid="status-link">See system status</a>',
      'Back to my notes</a>',
    ],
  ],
  'blog/sync-without-servers/index.html': [['<p class="meta">March 4 · 6 min read</p>', '<p class="meta">March 4</p>']],
  'index.html': [['Finding things is finally fast.', 'It is the first notes app that stuck.']],
}
const ROUND2_PAGES = ['pricing', 'features', 'billing', 'welcome', 'server-error', 'blog-post', 'home']

// Changes between capture 2 and capture 3.
const ROUND3 = {
  'index.html': [['New: templates', 'New: offline sync']],
  'pricing/index.html': [['outgrow one device. Pay yearly and save 17%.', 'outgrow one device.']],
  'app.js': [['<th aria-sort="descending" data-testid="sort-updated">Updated &darr;</th>', '<th>Updated</th>']],
  'app/note/index.html': [['type="button">Table</button', 'type="button" data-testid="toolbar-more">More</button']],
  'app/empty/index.html': [['data-testid="empty-cta">Write today\'s note', 'data-testid="empty-cta">Create a note']],
}
const ROUND3_PAGES = ['home', 'pricing', 'dashboard', 'editor', 'empty']

// Production runs an older release than staging's first capture: an older
// headline and price, no templates (page and link), older copy.
const MARKETING = [
  'index.html',
  'features/index.html',
  'pricing/index.html',
  'pricing-v2/index.html',
  'blog/index.html',
  'blog/sync-without-servers/index.html',
  'changelog/index.html',
  'signup/index.html',
  'login/index.html',
  'login/error/index.html',
  'reset-password/index.html',
  '404/index.html',
  'error/index.html',
]
const PRODUCTION = {
  ...Object.fromEntries(MARKETING.map((file) => [file, [[/\n\s*<a href="\/templates\/">Templates<\/a>/g, '']]])),
  'index.html': [
    [/\n\s*<a href="\/templates\/">Templates<\/a>/g, ''],
    ['New: offline sync', 'Now on Android'],
    ['Notes that keep up with how you think.', 'Your notes, on every device.'],
  ],
  'pricing/index.html': [
    [/\n\s*<a href="\/templates\/">Templates<\/a>/g, ''],
    ['$6 <small>per month</small>', '$5 <small>per month</small>'],
  ],
  'changelog/index.html': [
    [/\n\s*<a href="\/templates\/">Templates<\/a>/g, ''],
    [/<li class="release" data-testid="release-latest">[\s\S]*?<\/li>/, ''],
  ],
  'signup/index.html': [
    [/\n\s*<a href="\/templates\/">Templates<\/a>/g, ''],
    ['>Create account</button>', '>Sign up</button>'],
  ],
  'app/settings/index.html': [['Weekly summary email', 'Weekly digest']],
}

function applyEdits(dir, edits, { reverse = false } = {}) {
  for (const [file, pairs] of Object.entries(edits)) {
    const target = path.join(dir, file)
    let text = fs.readFileSync(target, 'utf8')
    for (const [now, before] of pairs) {
      const [from, to] = reverse ? [before, now] : [now, before]
      if (from instanceof RegExp) {
        if (!from.test(text)) throw new Error(`demo edit: ${from} matches nothing in ${file}`)
        text = text.replace(from, to)
        continue
      }
      if (!from || !text.includes(from)) throw new Error(`demo edit: "${from}" not found in ${file}`)
      text = text.split(from).join(to)
    }
    fs.writeFileSync(target, text)
  }
}

// A copy of the site as it was at staging's first capture.
function firstCaptureCopy(name) {
  const dir = path.join(work, 'sites', name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(SOURCE, dir, { recursive: true })
  applyEdits(dir, ROUND3)
  applyEdits(dir, ROUND2)
  return dir
}

// Staging only, through every round: a changelog link to a help page that was
// never published (the board's broken-links list) and a dashboard request
// that fails while the page is captured (the card's network warning). Both
// are relative or rewritten links, so the published copy only meets 404s.
const STAGING_ONLY = {
  'changelog/index.html': [
    [
      '<p>Twelve templates to start from, and search results in under 50 ms on large spaces.</p>',
      '<p>Twelve templates to start from, and search results in under 50 ms on large spaces.</p>\n              <p><a href="/help/templates/">Read the templates guide</a></p>',
    ],
  ],
  'app/index.html': [
    [
      '    <script src="/app.js"></script>',
      '    <script src="/app.js"></script>\n    <script>fetch("api/sync-status").catch(() => {})</script>',
    ],
  ],
}

const stagingDir = firstCaptureCopy('staging')
applyEdits(stagingDir, STAGING_ONLY)
const productionDir = firstCaptureCopy('production')
applyEdits(productionDir, PRODUCTION)
fs.rmSync(path.join(productionDir, 'templates'), { recursive: true, force: true })

const staging = await startDemoSite({ port: 0, root: stagingDir })
const production = await startDemoSite({ port: 0, root: productionDir })
const local = (server) => `http://127.0.0.1:${server.address().port}`

const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
delete raw.baseUrl
raw.environments = [
  { id: 'staging', title: 'Staging', baseUrl: local(staging), publicUrl: STAGING_URL },
  { id: 'production', title: 'Production', baseUrl: local(production), publicUrl: PRODUCTION_URL },
]
raw.outputDir = path.join(work, '.shapewall')
const config = normalizeConfig(raw, { dir: work })
const board = config.boards[0]
const log = (line) => console.log(line)
let browser = null

// ---- Time -------------------------------------------------------------------------
// Comments get explicit times; capture runs are shifted afterwards. Each run
// records its real window and the day it should appear to have run on.
// Everything is relative to a fixed moment, not the time of the build, so
// every export has the same times and file names: a tab opened before a
// redeploy keeps working. The board shows these times as if that moment
// were now (info.json fixturesAt, client/src/lib/utils.js setFixtureClock).
const BUILT = Date.UTC(2026, 9, 1, 15, 0, 0)
const SCRIPT_START = Date.now()
const DAY = 24 * 3600 * 1000
const ago = (days) => new Date(BUILT - days * DAY)
const runs = []
async function capture(label, daysAgo, options = {}) {
  const start = Date.now()
  const result = await runCapture({ config, log, ...options })
  // Runs follow each other within milliseconds: the windows must not overlap.
  runs.push({ label, start, end: Date.now(), target: BUILT - daysAgo * DAY })
  return result
}

// Where an element sits in a staging capture, in percent, as a click would store it.
async function pinAt(viewportName, pagePath, selector) {
  const size = config.viewports[viewportName]
  const mobile = viewportName !== 'desktop'
  const page = await browser.newPage({ viewport: size, isMobile: mobile, hasTouch: mobile })
  await page.goto(joinUrl(local(staging), pagePath))
  const box = await page.locator(selector).first().boundingBox()
  await page.close()
  if (!box) throw new Error(`demo pin: ${selector} is not on ${pagePath} (${viewportName})`)
  const round = (value) => Math.round(value * 100) / 100
  const share = (value) => Math.min(1, Math.round(value * 10000) / 10000)
  return {
    x: round(((box.x + box.width / 2) / size.width) * 100),
    y: round(((box.y + box.height / 2) / size.height) * 100),
    // The element's size, so the pin can sit on its corner (like a click on the live page stores it).
    size: { w: share(box.width / size.width), h: share(box.height / size.height) },
  }
}

const pathOf = (pageId) => board.pages.find((item) => item.id === pageId).path
const AGENT = 'Coding agent'

// A screenshot of the area around an element on staging, as someone would
// attach it to a comment (PNG, base64).
async function elementShot(viewportName, pagePath, selector, pad = 24) {
  const size = config.viewports[viewportName]
  const mobile = viewportName !== 'desktop'
  const page = await browser.newPage({ viewport: size, isMobile: mobile, hasTouch: mobile })
  await page.goto(joinUrl(local(staging), pagePath))
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`demo shot: ${selector} is not on ${pagePath} (${viewportName})`)
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  const png = await page.screenshot({
    clip: { x, y, width: Math.min(size.width - x, box.width + pad * 2), height: box.height + pad * 2 },
    fullPage: true,
  })
  await page.close()
  return png.toString('base64')
}

// A box around the element a comment is pinned to, and an arrow pointing at
// it from `from` (frame-relative), as drawn on the page.
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

// A comment: pinned to `selector`, anchored to that element when `anchor`
// is its text ('' when the text will change), created `days` ago. `shot`:
// attach a screenshot of the element; `draw`: a box (and an arrow from
// `draw.from`) around it.
async function comment({
  page,
  viewport = 'desktop',
  selector,
  anchor = null,
  body,
  author,
  days,
  path: pagePath = null,
  shot = null,
  draw = null,
}) {
  const target = page.startsWith('variant:') ? pagePath : pathOf(page)
  const { x, y, size } = await pinAt(viewport, target, selector)
  const images = shot ? [{ name: shot, mediaType: 'image/png', data: await elementShot(viewport, target, selector) }] : null
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
      ...(anchor !== null ? { anchor: { selector, text: anchor, dx: 0.5, dy: 0.5, ...size } } : {}),
      ...(images ? { images } : {}),
      ...(drawing ? { drawing } : {}),
    },
    { now: ago(days) },
  )
}
const reply = (item, author, body, days) => addReply(config, board.id, item.id, { author, body }, { now: ago(days) })
const agent = (item, status, days) => setAgentStatus(config, board.id, item.id, status, { now: ago(days) })
const resolve = (item, days, resolution, fixRef = undefined) =>
  updateComment(config, board.id, item.id, { status: 'resolved', resolution, ...(fixRef ? { fixRef } : {}) }, { now: ago(days) })
// Emoji reactions (people only): on the comment, or on its reply number `replyId`.
async function react(item, emoji, people, replyId = null) {
  for (const author of people) await reactToComment(config, board.id, item.id, { emoji, author, replyId })
}
const reopen = (item, days) => updateComment(config, board.id, item.id, { status: 'open' }, { now: ago(days) })

try {
  // ---- 1. Staging, first capture (nine days ago), and the first comments -----------
  await capture('staging 1', 9)
  browser = await chromium.launch()

  const plus = await comment({
    page: 'pricing',
    selector: 'a[data-testid="plus-cta"]',
    anchor: 'Try Plus free',
    body: 'The Plus button is the one we want people to press, but it looks like the others. Make it the primary button. @agent',
    author: 'Robin',
    days: 8.9,
  })
  await agent(plus, 'queued', 8.85)
  await agent(plus, 'working', 8.84)
  await reply(plus, AGENT, 'Switched the Plus card to the primary button and recaptured pricing. @robin over to you.', 8.8)
  await agent(plus, 'done', 8.8)

  const typo = await comment({
    page: 'features',
    selector: 'h1',
    body: 'Typo in the headline: "thinkng".',
    author: 'Jo',
    days: 8.5,
    draw: {},
  })

  const receipts = await comment({
    page: 'billing',
    selector: 'table[data-testid="invoices"]',
    anchor: 'Date',
    body: 'Customers keep asking support where to get a receipt. Can each invoice have a download link? @sam',
    author: 'Mei',
    days: 8,
  })
  await reply(receipts, 'Sam', 'Yes, adding a Receipt column.', 7.9)

  const steps = await comment({
    page: 'welcome',
    viewport: 'phone',
    selector: 'div[data-testid="steps"]',
    anchor: '',
    body: 'On a phone the progress bar alone does not say much. Add "Step 1 of 3" next to it, on every step.',
    author: 'Robin',
    days: 7.5,
  })

  const deadEnd = await comment({
    page: 'server-error',
    selector: 'h1',
    body: 'A dead end. Give people somewhere to go: a link to the status page.',
    author: 'Sam',
    days: 7,
  })

  const readTime = await comment({
    page: 'blog-post',
    selector: 'article p.meta',
    body: 'Add the reading time next to the date, like on the blog list. @agent',
    author: 'Jo',
    days: 6.5,
  })
  await agent(readTime, 'queued', 6.45)
  await agent(readTime, 'working', 6.44)
  await reply(readTime, AGENT, 'Added "6 min read" next to the date.', 6.3)
  await agent(readTime, 'done', 6.3)

  const more = await comment({
    page: 'editor',
    selector: 'button[data-testid="toolbar-more"]',
    anchor: 'More',
    body: 'What is behind More? If it is only one or two items, show them in the bar.',
    author: 'Robin',
    days: 6,
  })
  await reply(more, 'Sam', 'Just Table. Moving it into the bar and dropping More.', 5.6)

  const resetCopy = await comment({
    page: 'reset',
    viewport: 'phone',
    selector: 'button[data-testid="reset-submit"]',
    anchor: 'Send the link',
    body: 'The "Sent" message shows before anything was sent. Show it only after the button is pressed.',
    author: 'Mei',
    days: 6,
  })

  // On the "Link expired" branch of the Sign up journey.
  await comment({
    page: 'verify-expired',
    selector: 'div[data-testid="link-expired"]',
    anchor: '',
    body: 'Say when the new link was sent and to which address, or people press the button again and again.',
    author: 'Mei',
    days: 6,
  })

  // ---- 2. Fixes land; staging is captured again (five days ago) --------------------
  applyEdits(stagingDir, ROUND2, { reverse: true })
  await capture('staging 2', 5, { only: ROUND2_PAGES })
  await resolve(plus, 4.95, 'Plus card now uses the primary button.', PR(42))
  await resolve(typo, 4.9, 'Fixed the headline.', 'commit 3f9c2ab')
  await resolve(receipts, 4.85, 'Receipt column with a Download link on every invoice.', PR(45))
  await resolve(steps, 4.8, 'Added the step label.', 'commit 7d41e90')
  await resolve(deadEnd, 4.7, 'Added "See system status".', 'commit 9b1e07d')
  await resolve(readTime, 4.6, 'Reading time is next to the date.', PR(47))
  await reply(steps, 'Robin', 'Step 1 has it now, but steps 2 and 3 still show only the bar. Reopening.', 3.2)
  await reopen(steps, 3.2)

  const sort = await comment({
    page: 'dashboard',
    selector: 'th',
    body: 'Can we sort this table by last edited, newest first? @agent',
    author: 'Sam',
    days: 4.5,
  })
  await agent(sort, 'queued', 4.45)
  await agent(sort, 'working', 4.4)

  const cta = await comment({
    page: 'empty',
    selector: 'a[data-testid="empty-cta"]',
    anchor: '',
    body: '"Create a note" is vague on an empty Daily notes page. Say what it makes.',
    author: 'Robin',
    days: 4,
  })
  await reply(cta, 'Jo', '@robin "Write today\'s note"?', 3.9)
  await reply(cta, 'Robin', 'Yes. @agent can you change it?', 3.8)
  await agent(cta, 'working', 3.7)
  await reply(cta, AGENT, 'Changed the label to "Write today\'s note" and kept "Use a template" next to it.', 3.6)

  const rules = await comment({
    page: 'signup',
    selector: 'p[data-testid="password-rules"]',
    anchor: 'At least 10 characters, with a number or a symbol.',
    body: '@agent The password rules read like an error. Should they show before people type?',
    author: 'Jo',
    days: 3.5,
  })
  await agent(rules, 'queued', 3.45)
  await agent(rules, 'working', 3.44)
  await reply(
    rules,
    AGENT,
    'This needs a decision first: keep the rules always visible but muted, or show them only when the field has focus? @jo',
    3.4,
  )
  await agent(rules, 'needs-human', 3.4)
  await reply(rules, 'Jo', 'Always visible, muted. @robin can you check the tone of the copy?', 3)

  const google = await comment({
    page: 'login-error',
    selector: 'div[data-testid="login-error"]',
    anchor: 'That email and password do not match. Try again or reset your password.',
    body: 'Support sees people who signed up with Google land here. Can the error say "Did you sign up with Google?" @jo',
    author: 'Mei',
    days: 3,
  })
  await reply(google, 'Jo', 'Good catch. Adding it to the copy doc for the next release.', 2.9)
  await react(google, '👍', ['Robin', 'Sam'])
  await react(google, '❤️', ['Mei'], 1)

  const dropzone = await comment({
    page: 'welcome-import',
    viewport: 'phone',
    selector: 'div[data-testid="dropzone"]',
    anchor: 'Drop files here, or choose a folder',
    body: 'Nobody drops files on a phone. Show a "Choose files" button instead. @agent',
    author: 'Robin',
    days: 2.8,
  })
  await agent(dropzone, 'queued', 2.75)

  const copy = await comment({
    page: 'share',
    selector: 'button[data-testid="copy-link"]',
    anchor: 'Copy link',
    body: 'Copy link needs feedback: the label could change to "Copied" for a moment. @agent',
    author: 'Sam',
    days: 2.6,
  })
  await agent(copy, 'working', 2.55)
  await reply(copy, AGENT, 'Working on it: "Copied" for two seconds, announced to screen readers too.', 2.5)

  // ---- 3. More changes; staging is captured a third time (two days ago) -------------
  applyEdits(stagingDir, ROUND3, { reverse: true })
  await capture('staging 3', 2, { only: ROUND3_PAGES })
  await reply(sort, AGENT, 'Sorted by Updated, newest first, with an arrow on the column header. Recaptured the dashboard.', 1.95)
  await react(sort, '🎉', ['Sam', 'Robin'], 1)
  await react(cta, '👍', ['Jo'], 2)
  await react(rules, '👀', ['Robin'])
  await agent(sort, 'done', 1.95)
  await agent(cta, 'done', 1.95)
  await resolve(cta, 1.6, 'Label is "Write today\'s note".', PR(53))
  await resolve(resetCopy, 1.5, 'The message appears after sending.', PR(51))
  await reply(more, 'Robin', 'The pin says the button is gone now, which is the point. Resolving after a last look.', 1.4)

  const hero = await comment({
    page: 'home',
    viewport: 'phone',
    selector: 'a[data-testid="hero-cta"]',
    anchor: 'Start writing free',
    body: 'Shorter label on phones: "Start free". @agent',
    author: 'Robin',
    days: 1.3,
  })
  await agent(hero, 'working', 1.25)
  await reply(hero, AGENT, 'On it: "Start free" below 480 px wide.', 1.2)

  // Pinned by position only (no element under it).
  await comment({
    page: 'home',
    selector: '.logos',
    body: 'The logo row feels crowded. Fewer logos and more space?',
    author: 'Jo',
    days: 1.2,
  })
  await comment({ page: 'blog', selector: 'main img', body: 'The covers feel heavy next to the titles.', author: 'Jo', days: 1.1 })

  const tpl = await comment({
    page: 'templates',
    selector: 'a[data-testid="tpl-reading"]',
    anchor: 'Reading list',
    body: 'New page, so it is missing on production in Compare. The pink card clashes with the brand colour. @jo fine to ship otherwise?',
    author: 'Robin',
    days: 1,
  })
  await reply(tpl, 'Jo', 'Fine to ship once the colour is fixed.', 0.9)

  const members = await comment({
    page: 'admin',
    selector: 'table[data-testid="members"]',
    anchor: 'Member',
    body: 'This page is desktop only in the config, so there is no phone capture. Do admins ever use it on a phone? @mei',
    author: 'Sam',
    days: 0.9,
  })
  await reply(members, 'Mei', 'Rarely. Desktop only is fine for now.', 0.8)

  await comment({
    page: 'settings',
    viewport: 'phone',
    selector: 'button[data-testid="delete-account"]',
    anchor: 'Delete account',
    body: 'On a phone Delete account sits right above Save changes. Too easy to hit: move it to the end or ask to confirm.',
    author: 'Mei',
    days: 0.7,
    shot: 'delete-account-phone.png',
    draw: { from: [0.12, 0.2] },
  })
  await comment({
    page: 'not-found',
    selector: 'a[data-testid="home-link"]',
    anchor: 'Go home',
    body: 'Add a search box here; people usually know what they were looking for.',
    author: 'Jo',
    days: 0.6,
  })
  await comment({
    page: 'changelog',
    viewport: 'phone',
    selector: 'li[data-testid="release-latest"]',
    anchor: 'Templates and a faster search',
    body: '@mei could the help center link to this page?',
    author: 'Robin',
    days: 0.5,
  })
  await comment({
    page: 'pricing',
    viewport: 'tablet',
    selector: '.pricing',
    body: 'On a tablet the three plans stack into one long column. Could they sit side by side from 768 px wide?',
    author: 'Sam',
    days: 0.25,
    shot: 'plans-tablet.png',
  })
  await comment({
    page: 'dashboard',
    viewport: 'phone',
    selector: '.stats',
    body: 'Three stat cards push the notes below the fold on phones. One row of small numbers instead?',
    author: 'Mei',
    days: 0.2,
  })

  // ---- 4. Variants, a journey made on the board, and production --------------------
  const variants = [
    {
      id: 'yearly-toggle',
      pageId: 'pricing',
      path: '/pricing-v2/',
      title: 'Yearly toggle',
      note: 'Billing switch, clearer Plus card',
      source: 'branch pricing-v2',
    },
    {
      id: 'one-step-welcome',
      pageId: 'welcome',
      path: '/welcome-v2/',
      title: 'One-step welcome',
      note: 'Three onboarding steps in one',
      source: 'branch onboarding-one-step',
    },
  ]
  for (const variant of variants) {
    await captureVariant({
      config,
      boardId: board.id,
      pageId: variant.pageId,
      variantId: variant.id,
      url: joinUrl(local(staging), variant.path),
    })
    await saveVariant(config, board.id, {
      id: variant.id,
      pageId: variant.pageId,
      title: variant.title,
      note: variant.note,
      source: variant.source,
      createdAt: ago(1).toISOString(),
    })
  }
  const oneStep = await comment({
    page: 'variant:one-step-welcome',
    path: '/welcome-v2/',
    selector: 'h1',
    body: 'I prefer this one: fewer steps, and it matches what we heard in the interviews.',
    author: 'Jo',
    days: 0.4,
  })
  await reply(oneStep, 'Robin', 'Agree. @sam how hard is it to ship behind a flag?', 0.35)
  await comment({
    page: 'variant:yearly-toggle',
    path: '/pricing-v2/',
    selector: '[role="group"]',
    body: 'Yearly first is right, but "-17%" reads like a discount code.',
    author: 'Robin',
    days: 0.3,
  })

  await createJourney(
    config,
    board,
    {
      name: 'Design review',
      description: 'Made on the board: the pages with open design questions',
      steps: ['home', 'templates', 'welcome', 'editor', 'share', 'settings'],
    },
    { now: ago(1) },
  )

  // What each copy looked like at its last capture: the published copies
  // (--publish) must be exactly these, so /lumen and /lumen-staging show
  // what the board's Production and Staging captures show.
  const captured = { staging: siteHash(stagingDir) }
  await capture('production', 12, { envId: 'production' })
  captured.production = siteHash(productionDir)

  // The demo client (npm run build:demo): the board and the console with the
  // in-browser backend (client/src/demo) that plays the hosted server, so
  // visitors see the whole app: roles, the admin console and chat.
  const result = await exportStatic(config, { out, clientDir: DEMO_CLIENT, noindex: true })
  // Capture manifests record the URL each shot was taken from: show the public ones.
  replaceInJson(result.out, [
    [local(staging), STAGING_URL],
    [local(production), PRODUCTION_URL],
  ])
  retime(result.out)
  checkNoLocalDetails(result.out)
  console.log(`Demo exported to ${result.out} (${result.files} files)`)
  if (publishRoot) {
    // After every capture, from the copies as they were last captured.
    const root = path.resolve(publishRoot)
    for (const [env, dir] of [
      ['production', productionDir],
      ['staging', stagingDir],
    ]) {
      if (siteHash(dir) !== captured[env]) throw new Error(`demo publish: the ${env} copy changed after its last capture`)
      const files = publishDemoSite(dir, root, env)
      for (const file of files) checkNoLocalDetails(path.join(root, file))
      console.log(`Demo site (${env}) published as ${new URL(publicUrl(env)).pathname} in ${root} (${files.length} files)`)
    }
    // The board's live HTML snapshots come from the clean copies: no banner, no form guard.
    const marked = walk(result.out).find((file) => {
      if (!file.endsWith('.html')) return false
      const text = fs.readFileSync(file, 'utf8')
      return text.includes(BANNER_TEXT) || text.includes('data-lumen-demo')
    })
    if (marked) throw new Error(`demo publish: ${path.relative(result.out, marked)} shows the demo banner or form guard`)
  }
} finally {
  await browser?.close()
  staging.close()
  production.close()
}

// One hash over a site copy's files (names and contents).
function siteHash(dir) {
  const hash = createHash('sha256')
  for (const file of walk(dir).sort()) hash.update(path.relative(dir, file)).update('\0').update(fs.readFileSync(file)).update('\0')
  return hash.digest('hex')
}

function walk(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

function replaceInJson(dir, pairs) {
  for (const file of walk(dir)) {
    if (!file.endsWith('.json')) continue
    const text = fs.readFileSync(file, 'utf8')
    const next = pairs.reduce((value, [from, to]) => value.split(from).join(to), text)
    if (next !== text) fs.writeFileSync(file, next)
  }
}

// Moves every capture time (ISO times and version ids, in JSON and file
// names) from the minutes this script ran to the day its run stands for,
// the same way on every run: a shot's new version id comes from its run,
// its page and its viewport (never from how long the capture took or the
// random suffix it got), and run-level times land at a fixed minute of their
// run. Times this script made in real time outside a run land on BUILT.
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

  // Which page and viewport each version id belongs to: the board JSON lists
  // the current shot of every page (manifest) and every kept earlier one.
  const slots = new Map()
  board.pages.forEach((page, index) =>
    Object.keys(config.viewports).forEach((viewport, offset) => slots.set(`${page.id}.${viewport}`, index * 4 + offset)),
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
      // A version nobody lists any more (pruned): a fixed spot at the end of its run.
      const slot = owner && slots.has(owner) ? slots.get(owner) : 999
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
      // Shot durations differ on every run and the board never shows them.
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
  // The moment the fixtures stand for, for the board's clock.
  const infoFile = path.join(dir, 'data', 'info.json')
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'))
  fs.writeFileSync(infoFile, JSON.stringify({ ...info, fixturesAt: new Date(BUILT).toISOString() }))
}

// The demo is public: no local hosts, ports, paths or machine names in it.
function checkNoLocalDetails(dir) {
  const needles = ['127.0.0.1', 'localhost', os.homedir(), ROOT, os.hostname()].filter((item) => item && item.length > 3)
  for (const file of fs.statSync(dir).isDirectory() ? walk(dir) : [dir]) {
    if (!/\.(json|html|js|css|webmanifest)$/.test(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const hit = needles.find((needle) => text.includes(needle))
    if (hit) throw new Error(`${path.relative(dir, file) || path.basename(file)} contains "${hit}"; the demo must not carry local details.`)
  }
}
