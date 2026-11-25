// Deep links (src/board-links.js): one builder for every link Shapewall makes,
// the keys the board reads on load (client/src/lib/deepLink.js), the links the
// older builders made (unchanged), and `shapewall open` on a local board and
// on a loopback hosted one.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { LINK_KEYS, boardLink, hostedBoardBase, localBoardBase, parseBoardLink } from '../src/board-links.js'
import { linkedFollow, linkedPage } from '../client/src/lib/deepLink.js'
import { commentLink } from '../src/notify/messages.js'
import { boardLink as githubBoardLink } from '../src/github.js'
import { findPage, openCommand } from '../src/cli/open-command.js'
import { createComment } from '../src/store.js'
import { writeServeState, clearServeState } from '../src/serve-state.js'
import { createRemote, pushDefinition, pushFiles } from '../src/remote/remote.js'
import { COMMAND_FLAGS, parseArgs } from '../src/cli/args.js'
import { sampleConfig, tempDir } from './helpers.js'
import { createProject, createToken, signUp, startHostedServer, writeLocalCaptures } from './hosted-helpers.js'

const LOCAL = 'http://127.0.0.1:4600/'

// ---- The builder ----------------------------------------------------------------

test('every key, in one fixed order, on a local base', () => {
  assert.equal(boardLink({ base: LOCAL, board: 'demo' }), 'http://127.0.0.1:4600/?board=demo')
  assert.equal(boardLink({ base: LOCAL, board: 'demo', page: 'pricing' }), 'http://127.0.0.1:4600/?board=demo&p=pricing')
  assert.equal(
    boardLink({ base: LOCAL, board: 'demo', page: 'pricing', comment: 12, viewport: 'phone', filter: 'all' }),
    'http://127.0.0.1:4600/?board=demo&p=pricing&c=12&filter=all&vp=phone',
  )
  // Before and after: the page's history at that viewport.
  assert.equal(
    boardLink({ base: LOCAL, board: 'demo', page: 'pricing', viewport: 'phone', compare: true }),
    'http://127.0.0.1:4600/?board=demo&p=pricing&vp=phone&hist=pricing&hv=phone',
  )
  // "all" screen sizes: history opens on the board's own choice.
  assert.equal(
    boardLink({ base: LOCAL, board: 'demo', page: 'home', viewport: 'all', compare: true }),
    'http://127.0.0.1:4600/?board=demo&p=home&vp=all&hist=home',
  )
  // Two environments, in any spelling.
  for (const pair of ['staging_prod', 'staging,prod', ['staging', 'prod']])
    assert.equal(boardLink({ base: LOCAL, board: 'demo', compare: pair }), 'http://127.0.0.1:4600/?board=demo&cmp=staging_prod')
  assert.equal(boardLink({ base: LOCAL, board: 'demo', compare: false }), 'http://127.0.0.1:4600/?board=demo')
  assert.equal(boardLink({ base: LOCAL, board: 'demo', follow: 'ag_1234' }), 'http://127.0.0.1:4600/?board=demo&follow=ag_1234')
  // Every key the builder writes is one it knows the order of.
  const all = new URL(
    boardLink({ base: LOCAL, board: 'b', page: 'p1', comment: 1, filter: 'all', viewport: 'desktop', compare: true, follow: 'a' }),
  )
  assert.deepEqual(
    [...all.searchParams.keys()],
    LINK_KEYS.filter((key) => key !== 'cmp'),
  )
})

test('hosted bases: absolute and console-relative, ids encoded, never from a server URL', () => {
  const base = hostedBoardBase('https://wall.example.com/ignored/path?x=1', 'ws_abc', 'pr_def')
  assert.equal(base, 'https://wall.example.com/w/ws_abc/p/pr_def/')
  assert.equal(
    boardLink({ base, board: 'site', comment: 4, viewport: 'phone' }),
    'https://wall.example.com/w/ws_abc/p/pr_def/?board=site&c=4&vp=phone',
  )
  assert.equal(hostedBoardBase('', 'ws_abc', 'pr_def'), '/w/ws_abc/p/pr_def/')
  assert.equal(boardLink({ base: '/w/ws_abc/p/pr_def/', board: 'site', comment: 3 }), '/w/ws_abc/p/pr_def/?board=site&c=3')
  assert.equal(hostedBoardBase('http://localhost:9', 'ws a/b', 'p?q'), 'http://localhost:9/w/ws%20a%2Fb/p/p%3Fq/')
})

test('values are escaped; a base keeps its own query, loses its fragment and any of our keys', () => {
  const link = boardLink({ base: 'https://h.example/team/?embed=1&c=99#old', board: 'a&b=c', page: 'variant:home#x' })
  const url = new URL(link)
  assert.equal(url.hash, '')
  assert.equal(url.searchParams.get('embed'), '1')
  assert.equal(url.searchParams.get('c'), null)
  assert.equal(url.searchParams.get('board'), 'a&b=c')
  assert.equal(url.searchParams.get('p'), 'variant:home#x')
  assert.ok(!link.includes('#'), link)
})

test('bad input is refused, not written into a link', () => {
  const bad = [
    {},
    { base: LOCAL },
    { base: LOCAL, board: '' },
    { base: LOCAL, board: 'a\nb' },
    { base: LOCAL, board: 'demo', comment: 0 },
    { base: LOCAL, board: 'demo', comment: 'twelve' },
    { base: LOCAL, board: 'demo', comment: 1.5 },
    { base: LOCAL, board: 'demo', viewport: 'phone wide' },
    { base: LOCAL, board: 'demo', filter: 'mine' },
    { base: LOCAL, board: 'demo', compare: true },
    { base: LOCAL, board: 'demo', compare: 'prod_prod' },
    { base: LOCAL, board: 'demo', compare: 'a_b_c' },
    { base: LOCAL, board: 'demo', follow: 'x y' },
    { base: 'javascript:alert(1)', board: 'demo' },
    { base: 'ftp://h.example/', board: 'demo' },
    { base: '//h.example/', board: 'demo' },
    { base: 'https://user:pass@h.example/', board: 'demo' },
  ]
  for (const options of bad) assert.throws(() => boardLink(options), TypeError, JSON.stringify(options))
  // A comment number as a string of digits is fine (CLI flags arrive as strings).
  assert.equal(boardLink({ base: LOCAL, board: 'demo', comment: '7' }), 'http://127.0.0.1:4600/?board=demo&c=7')
})

test('a link reads back as what it names', () => {
  const options = { board: 'demo', page: 'pricing', comment: 3, viewport: 'phone', filter: 'all', compare: true, follow: 'ag_1' }
  assert.deepEqual(parseBoardLink(boardLink({ base: LOCAL, ...options })), options)
  assert.deepEqual(parseBoardLink(boardLink({ base: '/w/ws/p/pr/', board: 'b', compare: 'a_b' })), { board: 'b', compare: 'a_b' })
})

test('the board reads p only without c or v, and follow as an agent id', () => {
  const params = (link) => new URL(link, 'http://x').searchParams
  assert.equal(linkedPage(params('/?board=demo&p=pricing')), 'pricing')
  assert.equal(linkedPage(params('/?board=demo&p=variant:home')), 'variant:home')
  // A comment wins over a page; so does a camera.
  assert.equal(linkedPage(params('/?board=demo&p=pricing&c=3')), null)
  assert.equal(linkedPage(params('/?board=demo&p=pricing&v=1,2,0.5')), null)
  assert.equal(linkedPage(params('/?board=demo&p=<script>')), null)
  assert.equal(linkedPage(params('/?board=demo')), null)
  assert.equal(linkedFollow(params('/?follow=ag_1234')), 'ag_1234')
  assert.equal(linkedFollow(params('/?follow=../x')), null)
  assert.equal(linkedFollow(params('/?board=demo')), null)
})

// ---- The older builders, unchanged ---------------------------------------------

test('notification, GitHub, usage, share and push links are what they were', () => {
  const config = sampleConfig('links-snapshot')
  // Notifications: the comment's viewport only when it is not the board's first.
  assert.equal(
    commentLink(config, 'https://wall.example.com/team/', 'sample', { id: 7, viewport: 'phone' }),
    'https://wall.example.com/team/?board=sample&c=7&filter=all&vp=phone',
  )
  assert.equal(
    commentLink(config, 'https://wall.example.com/team/', 'sample', { id: 7, viewport: 'desktop' }),
    'https://wall.example.com/team/?board=sample&c=7&filter=all',
  )
  assert.equal(commentLink(config, 'http://127.0.0.1:4600/#x', 'sample', null), 'http://127.0.0.1:4600/?board=sample')
  // GitHub: the same keys (only their order moved to the shared one).
  const github = new URL(githubBoardLink({ boardUrl: 'http://board.test/review/' }, 'sample', 1))
  assert.equal(github.toString(), 'http://board.test/review/?board=sample&c=1&filter=all')
  // Usage rows in the console: a relative link, comment number when there is one.
  const usage = (item) =>
    boardLink({ base: hostedBoardBase('', 'ws_1', item.project_id), board: item.board_id, comment: item.comment_number || undefined })
  assert.equal(usage({ project_id: 'pr_1', board_id: 'site', comment_number: 9 }), '/w/ws_1/p/pr_1/?board=site&c=9')
  assert.equal(usage({ project_id: 'pr_1', board_id: 'site', comment_number: null }), '/w/ws_1/p/pr_1/?board=site')
  // share --remote and a push answer: the board on the project.
  assert.equal(
    boardLink({ base: hostedBoardBase('https://h.example', 'ws_1', 'pr_1'), board: 'site' }),
    'https://h.example/w/ws_1/p/pr_1/?board=site',
  )
})

test('the local base: set address, then a running serve, then the default port', () => {
  const config = sampleConfig('links-base')
  assert.deepEqual(localBoardBase(config, { env: {} }), { url: LOCAL, running: false, source: 'default' })
  assert.equal(localBoardBase(config, { env: { SHAPEWALL_BOARD_URL: 'https://set.example/' } }).url, 'https://set.example/')
  assert.equal(localBoardBase(config, { env: {}, boardUrl: 'http://127.0.0.1:9999/' }).url, 'http://127.0.0.1:9999/')
  assert.ok(writeServeState(config, 'http://127.0.0.1:4711/'))
  try {
    assert.deepEqual(localBoardBase(config, { env: {} }), { url: 'http://127.0.0.1:4711/', running: true, source: 'serve' })
  } finally {
    clearServeState(config)
  }
})

// ---- shapewall open, local -------------------------------------------------------

function localProject(name) {
  const config = sampleConfig(name)
  fs.writeFileSync(
    config.file,
    JSON.stringify({
      title: 'Sample',
      id: 'sample',
      baseUrl: 'http://127.0.0.1:9',
      pages: config.boards[0].pages.map(({ id, path: p, title }) => ({ id, path: p, title })),
    }),
  )
  return config
}

async function run(flags, options = {}) {
  const lines = []
  const opened = []
  const code = await openCommand(flags, (line) => lines.push(line), { open: (url) => opened.push(url), ...options })
  return { code, lines, opened }
}

test('open: prints and opens the link to a running board; --print and --json open nothing', async () => {
  const config = localProject('open-local')
  const flags = { config: config.file }
  const saved = process.env.SHAPEWALL_BOARD_URL
  delete process.env.SHAPEWALL_BOARD_URL
  writeServeState(config, 'http://127.0.0.1:4711/')
  try {
    let result = await run({ ...flags, page: 'pricing' })
    assert.equal(result.code, 0)
    assert.deepEqual(result.lines, ['http://127.0.0.1:4711/?board=sample&p=pricing'])
    assert.deepEqual(result.opened, ['http://127.0.0.1:4711/?board=sample&p=pricing'])
    // A page by title, any case.
    result = await run({ ...flags, page: 'PRICING', viewport: 'phone', compare: true, print: true })
    assert.deepEqual(result.lines, ['http://127.0.0.1:4711/?board=sample&p=pricing&vp=phone&hist=pricing&hv=phone'])
    assert.deepEqual(result.opened, [])
    result = await run({ ...flags, page: 'home', json: true })
    assert.deepEqual(JSON.parse(result.lines[0]), {
      url: 'http://127.0.0.1:4711/?board=sample&p=home',
      board: 'sample',
      page: 'home',
      comment: null,
      viewport: null,
      compare: null,
      running: true,
    })
    assert.deepEqual(result.opened, [])
  } finally {
    clearServeState(config)
    if (saved !== undefined) process.env.SHAPEWALL_BOARD_URL = saved
  }
})

test('open: a comment brings its screen size and every state; --compare takes its page', async () => {
  const config = localProject('open-comment')
  const comment = await createComment(config, config.boards[0], {
    pageId: 'pricing',
    viewport: 'phone',
    x: 10,
    y: 10,
    body: 'Bigger',
    author: 'Jo',
  })
  const saved = process.env.SHAPEWALL_BOARD_URL
  process.env.SHAPEWALL_BOARD_URL = 'http://127.0.0.1:4712/'
  try {
    let result = await run({ config: config.file, comment: String(comment.id), print: true })
    assert.deepEqual(result.lines, [`http://127.0.0.1:4712/?board=sample&c=${comment.id}&filter=all&vp=phone`])
    result = await run({ config: config.file, comment: String(comment.id), compare: true, print: true })
    assert.deepEqual(result.lines, [
      `http://127.0.0.1:4712/?board=sample&p=pricing&c=${comment.id}&filter=all&vp=phone&hist=pricing&hv=phone`,
    ])
    // An explicit viewport wins over the comment's.
    result = await run({ config: config.file, comment: String(comment.id), viewport: 'desktop', print: true })
    assert.match(result.lines[0], /&vp=desktop$/)
  } finally {
    if (saved === undefined) delete process.env.SHAPEWALL_BOARD_URL
    else process.env.SHAPEWALL_BOARD_URL = saved
  }
})

test('open: a board nobody serves still gets its link, and the hint to serve it; exit 0', async () => {
  const config = localProject('open-stopped')
  const saved = process.env.SHAPEWALL_BOARD_URL
  delete process.env.SHAPEWALL_BOARD_URL
  try {
    const result = await run({ config: config.file, page: 'home' })
    assert.equal(result.code, 0)
    assert.equal(result.lines[0], `${LOCAL}?board=sample&p=home`)
    assert.match(result.lines[1], /start it with shapewall serve/)
    assert.deepEqual(result.opened, [])
  } finally {
    if (saved !== undefined) process.env.SHAPEWALL_BOARD_URL = saved
  }
})

test('open: unknown board, page, comment, viewport or environment, and compare without a page, say so', async () => {
  const config = localProject('open-errors')
  const flags = { config: config.file, print: true }
  await assert.rejects(run({ ...flags, board: 'nope' }), /No board "nope"\. Boards: sample/)
  await assert.rejects(run({ ...flags, page: 'nope' }), /No page "nope" on this board\. Pages: home, pricing, app/)
  await assert.rejects(run({ ...flags, comment: '99' }), /No comment #99/)
  await assert.rejects(run({ ...flags, comment: 'x' }), /--comment takes a comment number/)
  await assert.rejects(run({ ...flags, viewport: 'watch' }), /No viewport "watch"/)
  await assert.rejects(run({ ...flags, compare: true }), /needs? --page|add --page ID or --comment N/)
  await assert.rejects(run({ ...flags, compare: 'staging_prod' }), /No environment "staging"/)
  assert.throws(
    () =>
      findPage(
        [
          { id: 'a', title: 'Same' },
          { id: 'b', title: 'same' },
        ],
        'SAME',
      ),
    /More than one page is called "SAME"/,
  )
})

test('open is a command with its flags; --compare works alone and with a pair', () => {
  assert.ok(COMMAND_FLAGS.open.includes('compare'))
  assert.equal(parseArgs(['open', '--compare', '--page', 'home'], { strict: true }).flags.compare, true)
  assert.equal(parseArgs(['open', '--compare', 'a_b'], { strict: true }).flags.compare, 'a_b')
  assert.equal(parseArgs(['open', '--page', 'home', '--compare'], { strict: true }).flags.compare, true)
})

// ---- shapewall open --remote, against a loopback hosted server --------------------

let hosted
let owner
let project
let tokenFile
before(async () => {
  hosted = await startHostedServer('open-remote', { signup: 'open' })
  owner = await signUp(hosted, { handle: 'open-owner', displayName: 'Open Owner' })
  project = await createProject(owner, owner.workspaceId, 'Open fixture')
  const config = sampleConfig('open-remote-local')
  writeLocalCaptures(config, 'sample')
  const token = await createToken(owner, owner.workspaceId, project.id, ['read', 'push', 'reply'])
  const remote = createRemote({ origin: hosted.origin, token })
  const start = await remote.startPush(pushDefinition(config, config.boards[0]))
  for (const [area, name, file] of pushFiles(config, config.boards[0])) await remote.pushFile(start.id, area, name, fs.readFileSync(file))
  await remote.commitPush(start.id, {
    manifest: JSON.parse(fs.readFileSync(path.join(config.outputDir, 'sample/captures/manifest.json'))),
    variants: [],
  })
  const posted = await owner.browser.post(`/w/${owner.workspaceId}/p/${project.id}/api/boards/sample/comments`, {
    body: 'Remote comment',
    pageId: 'pricing',
    viewport: 'phone',
    x: 20,
    y: 20,
  })
  assert.equal(posted.status, 201)
  tokenFile = path.join(tempDir('open-remote-token'), 'token')
  fs.writeFileSync(tokenFile, token)
})
after(async () => {
  await hosted?.close()
})

test('open --remote: the hosted board link from ids, with page, comment and before and after', async () => {
  const flags = { remote: hosted.origin, 'token-file': tokenFile, print: true }
  const base = `${hosted.origin}/w/${owner.workspaceId}/p/${project.id}/`
  let result = await run(flags)
  assert.deepEqual(result.lines, [`${base}?board=sample`])
  result = await run({ ...flags, page: 'Pricing', viewport: 'phone' })
  assert.deepEqual(result.lines, [`${base}?board=sample&p=pricing&vp=phone`])
  result = await run({ ...flags, comment: '1', compare: true })
  assert.deepEqual(result.lines, [`${base}?board=sample&p=pricing&c=1&filter=all&vp=phone&hist=pricing&hv=phone`])
  result = await run({ ...flags, comment: '1', json: true })
  assert.equal(JSON.parse(result.lines[0]).url, `${base}?board=sample&c=1&filter=all&vp=phone`)
  await assert.rejects(run({ ...flags, board: 'other' }), /No board "other" in this project/)
  await assert.rejects(run({ ...flags, page: 'nope' }), /No page "nope"/)
  await assert.rejects(run({ ...flags, comment: '42' }), /No comment #42/)
  await assert.rejects(run({ ...flags, compare: 'a_b' }), /one environment/)
  // The link never carries the token.
  for (const line of result.lines) assert.ok(!line.includes(fs.readFileSync(tokenFile, 'utf8').trim()))
})
