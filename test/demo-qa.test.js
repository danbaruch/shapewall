// The public demo after the QA pass: the scripted agent works on the comment
// a request names, says variants by their titles, share links that do not
// open say why, every person has one mention handle, the export's times sit
// on the state's clock, and the console's tab titles name the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { matchComment, pickScript } from '../client/src/demo/agent.js'
import { NOTES_PROJECT, REVIEW_SHARE, WORKSPACE_ID, fixedId, seedState } from '../client/src/demo/fixtures.js'
import { consoleTitle } from '../client/src/demo/titles.js'

const FIXTURES_AT = '2026-10-01T15:00:00.000Z'
const DAY = 86_400_000
const PAGES = [
  { id: 'home', title: 'Home', group: 'Marketing', viewports: ['desktop', 'phone'] },
  { id: 'pricing', title: 'Pricing', group: 'Marketing', viewports: ['desktop', 'phone'] },
  { id: 'dashboard', title: 'Dashboard', group: 'App', viewports: ['desktop', 'phone'] },
]
const VARIANTS = [{ id: 'yearly-toggle', pageId: 'pricing', title: 'Yearly toggle' }]
const comment = (id, pageId, body, extra = {}) => ({
  id,
  pageId,
  viewport: 'desktop',
  x: 10,
  y: 10,
  body,
  author: 'Robin',
  status: 'open',
  createdAt: new Date(Date.parse(FIXTURES_AT) - id * DAY).toISOString(),
  updatedAt: new Date(Date.parse(FIXTURES_AT) - id * DAY).toISOString(),
  replies: [],
  ...extra,
})
const COMMENTS = [
  comment(1, 'pricing', 'Make Plus the primary button. @agent'),
  comment(2, 'dashboard', 'Sort this table by last edited, newest first. @agent'),
  comment(3, 'home', 'Shorter label on phones: "Start free".', { author: 'Jo' }),
  comment(4, 'variant:yearly-toggle', '"-17%" reads like a discount code. @jo-park can you look?'),
]
const EXPORT = {
  'data/boards/demo.json': {
    board: { id: 'demo', title: 'Lumen Notes (demo)', groups: ['Marketing', 'App'], pages: PAGES },
    viewports: { desktop: { width: 1440, height: 2200 }, phone: { width: 390, height: 1800 } },
    manifest: { pages: { home: { desktop: { capturedAt: '2026-09-29T15:10:00.000Z' } }, pricing: {}, dashboard: {} } },
    captures: { home: {}, pricing: {}, dashboard: {} },
    links: {},
    journeys: [],
    versions: {},
    environments: [{ id: 'staging' }],
    variants: VARIANTS,
    commentCounts: {},
  },
  'data/boards/demo/comments.json': { comments: COMMENTS },
}

function demo({ seedAt = Date.parse(FIXTURES_AT), now = seedAt, change = () => {} } = {}) {
  const state = seedState(seedAt, { fixturesAt: FIXTURES_AT })
  change(state)
  const backend = createDemoBackend({
    state,
    now: () => now,
    location: { project: NOTES_PROJECT, fixturesAt: FIXTURES_AT },
    loadJson: async (url) => structuredClone(EXPORT[url] ?? Promise.reject(new Error(url))),
  })
  return { state, backend, call: (method, path, body) => backend.handle({ method, path, body }) }
}
const context = (threadId = 'board') => ({ threadId, comments: COMMENTS, pages: PAGES, variants: VARIANTS, attachments: [] })
const said = (script) =>
  script
    .map((step) => step.say || step.tool?.label || step.detail || '')
    .filter(Boolean)
    .join('\n')

test('"fix ..." works on the comment the request names', () => {
  const open = COMMENTS
  assert.equal(matchComment('Fix #3 please', open, context()).id, 3)
  assert.equal(matchComment('can you fix comment 2', open, context()).id, 2)
  assert.equal(matchComment('Fix the sort on the dashboard table', open, context()).id, 2)
  assert.equal(matchComment('Change the Start free label on phones', open, context()).id, 3)
  // Nothing named: no match, so the next @agent comment is picked.
  assert.equal(matchComment('Fix the next @agent comment', open, context()), null)
  assert.match(said(pickScript('Fix the next @agent comment', context())), /Read comment #1/)
  assert.match(said(pickScript('please fix the dashboard sorting', context())), /Read comment #2/)
})

test('variants are named by their titles, never by their ids', () => {
  const summary = said(pickScript("What's still open?", { ...context(), comments: COMMENTS.slice(2), board: { title: 'Lumen Notes' } }))
  assert.match(summary, /Yearly toggle \(variant of Pricing\)/)
  assert.doesNotMatch(summary, /variant:/)
  const fix = said(pickScript('fix the discount code wording', context()))
  assert.match(fix, /Read comment #4/)
  assert.match(fix, /Yearly toggle \(variant of Pricing\)/)
  assert.doesNotMatch(fix, /variant:/)
})

test('one handle per person: mentions of a name-made alias count as that person', async () => {
  const { call } = demo()
  const list = (await call('GET', '/api/boards/demo/comments')).json.comments
  const variant = list.find((item) => item.id === 4)
  assert.deepEqual(variant.mentions, ['jo'])
  // Authors are accounts with their own handles.
  assert.equal(list.find((item) => item.id === 3).authorHandle, 'jo')
})

test('share links: the backend says why a link does not open', () => {
  const { backend } = demo({
    change: (state) => {
      state.shares.push({ ...state.shares[0], id: fixedId('sh', 9), expiresAt: new Date(Date.parse(FIXTURES_AT) - DAY).toISOString() })
    },
  })
  assert.deepEqual(backend.shareStatus(REVIEW_SHARE), { status: 'ok', at: null })
  assert.equal(backend.shareStatus(fixedId('sh', 3)).status, 'revoked')
  assert.equal(backend.shareStatus(fixedId('sh', 9)).status, 'expired')
  assert.equal(backend.shareStatus('sh_0123456789abcdef01234567').status, 'unknown')
  assert.equal(backend.shareStatus('nonsense').status, 'unknown')
  const off = demo({ change: (state) => (state.workspaces[0].shareLinks = false) })
  assert.equal(off.backend.shareStatus(REVIEW_SHARE).status, 'off')
})

test("the export's times move onto the state's clock", async () => {
  const seedAt = Date.parse(FIXTURES_AT) + 35 * DAY
  const { state, call } = demo({ seedAt })
  assert.equal(state.timeShift, 35 * DAY)
  const info = await call('GET', '/api/info')
  assert.equal(info.json.fixturesAt, null, 'no fixture clock on the board: the times are already moved')
  const view = await call('GET', '/api/boards/demo')
  assert.equal(view.json.manifest.pages.home.desktop.capturedAt, new Date(Date.parse('2026-09-29T15:10:00.000Z') + 35 * DAY).toISOString())
  const list = (await call('GET', '/api/boards/demo/comments')).json.comments
  // Comment 1 was a day before the fixtures: now a day before the seed, like the console's data.
  assert.equal(list.find((item) => item.id === 1).createdAt, new Date(seedAt - DAY).toISOString())
  assert.ok(state.audit.every((entry) => Date.parse(entry.at) <= seedAt))
  // A comment made now keeps its real time.
  const made = await call('POST', '/api/boards/demo/comments', { pageId: 'home', viewport: 'desktop', x: 5, y: 5, body: 'New' })
  assert.equal(made.json.comment.createdAt, new Date(seedAt).toISOString())
})

test("the console's tab title names the page and the workspace", () => {
  const state = seedState(Date.parse(FIXTURES_AT))
  assert.equal(consoleTitle(`#/w/${WORKSPACE_ID}/members`, state), 'Members · Lumen · Shapewall demo')
  assert.equal(consoleTitle(`#/w/${WORKSPACE_ID}`, state), 'Projects · Lumen · Shapewall demo')
  assert.equal(consoleTitle(`#/w/${WORKSPACE_ID}/projects/${NOTES_PROJECT}`, state), 'Lumen Notes · Lumen · Shapewall demo')
  assert.equal(consoleTitle(`#/w/${WORKSPACE_ID}/audit#entries`, state), 'Audit log · Lumen · Shapewall demo')
  assert.equal(consoleTitle('#/account', state), 'Account · Shapewall demo')
  assert.equal(consoleTitle('', state), 'Workspaces · Shapewall demo')
  assert.equal(consoleTitle('#/signin?next=%2F', state), 'Sign in · Shapewall demo')
  assert.equal(consoleTitle('#/', { ...state, viewAs: 'guest' }), 'Guest · Shapewall demo')
})
