// The public demo (the Brackwell world, client/src/demo/world.js): one
// project holding two boards, Brackwell (the board that opens first) and
// Lumen Notes, with nothing left of the earlier second project.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setDemoWorld } from '../client/src/demo/world.js'
import { createDemoBackend } from '../client/src/demo/backend.js'
import { demoChecks, demoSeo } from '../client/src/demo/checks.js'
import { NOTES_PROJECT, WORKSPACE_ID, seedState } from '../client/src/demo/fixtures.js'
import { usageAgents, usageWorld } from '../client/src/demo/usage/world.js'

setDemoWorld('brackwell')
const NOW = Date.parse('2026-10-01T15:00:00.000Z')
const ws = (rest = '') => `/api/workspaces/${WORKSPACE_ID}${rest}`

// A small export: the two boards' views and comments, each in its own folder.
const view = (title, pages) => ({
  board: { id: 'demo', title, groups: ['Marketing', 'App'], pages },
  viewports: { desktop: { width: 1440, height: 960 }, phone: { width: 390, height: 844 } },
  manifest: { pages: Object.fromEntries(pages.map((page) => [page.id, {}])) },
  captures: Object.fromEntries(
    pages.map((page) => [page.id, { desktop: { file: `${page.id}.desktop.webp`, thumb: `${page.id}.thumb.webp` } }]),
  ),
  links: {},
  journeys: [],
  versions: {},
  environments: [{ id: 'staging' }, { id: 'production' }],
  variants: [],
  commentCounts: {},
})
const page = (id, group = 'App') => ({ id, title: id, path: `/${id}/`, group, viewports: ['desktop', 'phone'] })
const comment = (id, pageId, body) => ({
  id,
  pageId,
  viewport: 'desktop',
  x: 10,
  y: 10,
  body,
  author: 'Robin',
  status: 'open',
  createdAt: '2026-09-30T10:00:00.000Z',
  replies: [],
})
const EXPORT = {
  'data/boards/demo.json': view('Brackwell (demo)', [page('home', 'Marketing'), page('dashboard'), page('wo-list')]),
  'data/boards/demo/comments.json': { comments: [comment(1, 'wo-list', '@agent Add bulk assign.')] },
  'data/boards/lumen.json': view('Lumen Notes (demo)', [page('home', 'Marketing'), page('pricing', 'Marketing'), page('settings')]),
  'data/boards/lumen/comments.json': {
    comments: [comment(1, 'pricing', '@agent Make Plus the primary button.'), comment(2, 'settings', '@agent Move Delete account.')],
  },
}

function demo(location = {}) {
  const state = seedState(NOW, { fixturesAt: '2026-10-01T15:00:00.000Z' })
  const backend = createDemoBackend({
    state,
    location,
    now: () => NOW,
    loadJson: async (url) => structuredClone(EXPORT[url] ?? Promise.reject(new Error(url))),
  })
  const call = async (method, path, body) => {
    const [pathname, search = ''] = path.split('?')
    return backend.handle({ method, path: pathname, search: search ? `?${search}` : '', body })
  }
  return { state, call }
}

test('the demo seeds one project with two boards, Brackwell first', () => {
  const state = seedState(NOW)
  const projects = state.projects.filter((project) => project.workspaceId === WORKSPACE_ID)
  assert.equal(projects.length, 1)
  assert.equal(projects[0].id, NOTES_PROJECT)
  assert.equal(projects[0].name, 'Demo project')
  assert.deepEqual(
    projects[0].boards.map((board) => [board.id, board.folder, board.title]),
    [
      ['brackwell', 'demo', 'Brackwell'],
      ['lumen-notes', 'lumen', 'Lumen Notes'],
    ],
  )
  // Nothing seeded points at a project or board that is no longer there.
  const ids = new Set(state.projects.map((project) => project.id))
  for (const item of [...state.tokens, ...state.shares]) assert.ok(ids.has(item.projectId), item.name)
  for (const entry of state.audit) if (entry.detail?.project?.startsWith?.('pr_')) assert.ok(ids.has(entry.detail.project), entry.action)
  const text = JSON.stringify(state)
  assert.doesNotMatch(text, /marketing|website/i)
  assert.doesNotMatch(text, /"(demo|website)#\d+"/)
})

test('the board opens on Brackwell, and switches to Lumen Notes with its own screens and comments', async () => {
  const { call } = demo()
  const info = (await call('GET', '/api/info')).json
  assert.equal(info.project.name, 'Demo project')
  const { boards } = (await call('GET', '/api/boards')).json
  assert.deepEqual(
    boards.map((board) => [board.id, board.title, board.pageCount]),
    [
      ['brackwell', 'Brackwell', 3],
      ['lumen-notes', 'Lumen Notes', 3],
    ],
  )
  const brackwell = (await call('GET', '/api/boards/brackwell')).json
  assert.deepEqual(
    brackwell.board.pages.map((item) => item.id),
    ['home', 'dashboard', 'wo-list'],
  )
  assert.equal(brackwell.commentCounts['wo-list'].open, 1)
  const lumen = (await call('GET', '/api/boards/lumen-notes')).json
  assert.equal(lumen.board.id, 'lumen-notes')
  assert.equal(lumen.board.title, 'Lumen Notes')
  assert.deepEqual(
    lumen.board.pages.map((item) => item.id),
    ['home', 'pricing', 'settings'],
  )
  const comments = (await call('GET', '/api/boards/lumen-notes/comments')).json.comments
  assert.deepEqual(comments.map((item) => item.body).sort(), ['@agent Make Plus the primary button.', '@agent Move Delete account.'])
  // Each board keeps its own comments.
  assert.equal((await call('GET', '/api/boards/brackwell/comments')).json.comments.length, 1)
})

test('the console lists both boards under the one project, with their own summaries', async () => {
  const { call } = demo()
  const { projects } = (await call('GET', ws())).json
  assert.equal(projects.length, 1)
  assert.deepEqual(
    projects[0].boards.map((board) => [board.id, board.summary.pages, board.summary.openComments]),
    [
      ['brackwell', 3, 1],
      ['lumen-notes', 3, 2],
    ],
  )
  assert.match(projects[0].boards[1].summary.thumbnailUrl, /^data\/boards\/lumen\/captures\//)
})

test("each board's search previews are its own app's", () => {
  const lumen = view('Lumen Notes', [page('home', 'Marketing')])
  lumen.board.id = 'lumen-notes'
  const checks = demoChecks(lumen, { now: NOW })
  const seo = demoSeo(lumen, checks)
  assert.ok(Object.values(seo.snapshots).every((item) => item.social.siteName === 'Lumen Notes'))
  const brackwell = view('Brackwell', [page('home', 'Marketing')])
  brackwell.board.id = 'brackwell'
  const other = demoSeo(brackwell, demoChecks(brackwell, { now: NOW }))
  assert.ok(Object.values(other.snapshots).every((item) => item.social.siteName === 'Brackwell'))
})

test('usage and activity name the boards, never their ids', async () => {
  const agents = usageAgents()
  assert.deepEqual(
    agents.map((agent) => [agent.name, agent.projectId, agent.boardId]),
    [
      ['Demo agent', NOTES_PROJECT, 'brackwell'],
      ['Second agent', NOTES_PROJECT, 'brackwell'],
      ['Coding agent', NOTES_PROJECT, 'brackwell'],
      ['Notes agent', NOTES_PROJECT, 'lumen-notes'],
    ],
  )
  assert.deepEqual(usageWorld().projects, [NOTES_PROJECT])
  const { call } = demo()
  const { entries } = (await call('GET', ws('/activity?limit=500'))).json
  const boards = new Set(entries.filter((entry) => entry.action === 'agent_turn_started').map((entry) => entry.detail?.board))
  assert.deepEqual([...boards].sort(), ['Brackwell', 'Lumen Notes'])
  // A turn on the Lumen Notes board links to that board.
  const range = `from=${new Date(NOW - 30 * 86_400_000).toISOString()}&to=${new Date(NOW).toISOString()}&tz=UTC`
  const rows = (await call('GET', ws(`/usage/rows?${range}&limit=200`))).json.rows
  const lumenRow = rows.find((row) => row.boardId === 'lumen-notes')
  assert.ok(lumenRow, 'a turn on the Lumen Notes board')
  const { link } = (await call('GET', ws(`/usage/rows/${lumenRow.id}`))).json.row
  assert.match(link.url, /^index\.html\?project=pr_[a-f0-9]{24}&board=lumen-notes(&c=\d+)?$/)
})
