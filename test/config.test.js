import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ConfigError,
  authFiles,
  getBoard,
  getEnvironment,
  joinUrl,
  loadConfig,
  normalizeConfig,
  selectPages,
  starterConfig,
} from '../src/config.js'
import { SAMPLE, tempDir } from './helpers.js'

test('a valid config is normalized with defaults', () => {
  const config = normalizeConfig(structuredClone(SAMPLE), { dir: '/srv/site' })
  assert.equal(config.outputDir, path.resolve('/srv/site/.shapewall'))
  assert.equal(config.concurrency, 2)
  assert.deepEqual(Object.keys(config.viewports), ['desktop', 'phone'])
  assert.equal(config.boards.length, 1)
  const board = config.boards[0]
  assert.equal(board.id, 'sample')
  assert.deepEqual(board.groups, ['Marketing', 'App'])
  assert.deepEqual(board.pages[2].viewports, ['desktop'])
  assert.deepEqual(board.pages[0].viewports, ['desktop', 'phone'])
  assert.equal(board.pages[1].note, 'Prices are placeholders')
})

test('the demo config is valid', () => {
  const config = loadConfig(path.join(import.meta.dirname, '..', 'examples', 'demo-site', 'shapewall.config.json'))
  assert.equal(config.boards[0].pages.length, 7)
  assert.equal(config.boards[0].pages.find((page) => page.id === 'login').actions[0].type, 'fill')
})

test('every problem is reported at once, with its path', () => {
  const raw = {
    baseUrl: 'ftp://example.test',
    concurrency: 99,
    viewports: { desktop: { width: 10, height: 10 }, watch: { width: 200, height: 200 } },
    pages: [
      { id: 'Home Page', path: 'no-slash' },
      { id: 'ok', path: '/ok', actions: [{ click: '' }, { dance: true }] },
      { id: 'ok', path: '/again' },
    ],
  }
  let error
  try {
    normalizeConfig(raw)
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof ConfigError)
  const text = error.problems.join('\n')
  for (const fragment of [
    'baseUrl',
    'concurrency',
    'viewports.desktop',
    'viewports.watch',
    'pages[0].id',
    'pages[0].path',
    'pages[1].actions[0]',
    'pages[1].actions[1]',
    'duplicate page id "ok"',
  ]) {
    assert.ok(text.includes(fragment), `missing problem for ${fragment}:\n${text}`)
  }
})

test('pages and boards cannot both be set; boards are validated', () => {
  assert.throws(
    () =>
      normalizeConfig({
        baseUrl: 'http://x.test',
        pages: [{ id: 'a', path: '/' }],
        boards: [{ id: 'b', pages: [{ id: 'a', path: '/' }] }],
      }),
    /either top-level pages or boards/,
  )
  const config = normalizeConfig({
    baseUrl: 'http://x.test',
    boards: [
      { id: 'marketing', pages: [{ id: 'home', path: '/' }] },
      { id: 'docs', baseUrl: 'http://docs.x.test/v2', publicUrl: 'https://docs.example.com', pages: [{ id: 'intro', path: '/intro' }] },
    ],
  })
  assert.equal(getBoard(config, 'docs').baseUrl, 'http://docs.x.test/v2')
  assert.equal(getBoard(config).id, 'marketing')
  assert.throws(() => getBoard(config, 'nope'), /No board "nope"/)
})

test('auth paths resolve against the config folder', () => {
  const config = normalizeConfig(
    { ...structuredClone(SAMPLE), auth: { storageState: 'auth/state.auth.json', loginScript: './login.mjs' } },
    { dir: '/work/site' },
  )
  assert.equal(config.auth.storageState, path.resolve('/work/site/auth/state.auth.json'))
  assert.equal(config.auth.loginScript, path.resolve('/work/site/login.mjs'))
})

test('joinUrl keeps base paths and queries without doubled slashes', () => {
  assert.equal(joinUrl('http://127.0.0.1:3000', '/'), 'http://127.0.0.1:3000/')
  assert.equal(joinUrl('http://127.0.0.1:3000/app/', '/pricing'), 'http://127.0.0.1:3000/app/pricing')
  assert.equal(joinUrl('http://127.0.0.1:3000/app', 'pricing'), 'http://127.0.0.1:3000/app/pricing')
  assert.equal(joinUrl('http://127.0.0.1:3000/?x=1#top', '/list?tab=a&b=2'), 'http://127.0.0.1:3000/list?tab=a&b=2')
})

test('selectPages accepts ids and paths and rejects unknown ones', () => {
  const board = normalizeConfig(structuredClone(SAMPLE)).boards[0]
  assert.deepEqual(
    selectPages(board, ['home', '/pricing']).map((page) => page.id),
    ['home', 'pricing'],
  )
  assert.equal(selectPages(board, null).length, 3)
  assert.throws(() => selectPages(board, ['missing']), /No page matches "missing"/)
})

test('loadConfig explains a missing file and bad JSON', () => {
  const dir = tempDir('config')
  assert.throws(() => loadConfig(path.join(dir, 'shapewall.config.json')), /shapewall init/)
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope')
  assert.throws(() => loadConfig(path.join(dir, 'broken.json')), /not valid JSON/)
})

test('the starter config is valid', () => {
  const config = normalizeConfig(starterConfig({ baseUrl: 'http://localhost:5173' }))
  assert.equal(config.boards[0].pages.length, 3)
})

test('without environments a board has one default environment from baseUrl', () => {
  const config = normalizeConfig(structuredClone(SAMPLE))
  assert.equal(config.versions, 5)
  assert.deepEqual(config.boards[0].environments, [{ id: 'default', title: 'Default', baseUrl: SAMPLE.baseUrl, publicUrl: null }])
  assert.equal(getEnvironment(config.boards[0]).id, 'default')
})

test('environments: the first is the default and sets baseUrl', () => {
  const raw = { ...structuredClone(SAMPLE), versions: 0 }
  delete raw.baseUrl
  raw.environments = [
    { id: 'staging', baseUrl: 'http://127.0.0.1:4000', title: 'Staging' },
    { id: 'production', baseUrl: 'https://www.example.com', publicUrl: 'https://www.example.com' },
  ]
  const config = normalizeConfig(raw)
  const board = config.boards[0]
  assert.equal(config.versions, 0)
  assert.equal(board.baseUrl, 'http://127.0.0.1:4000')
  assert.deepEqual(
    board.environments.map((env) => [env.id, env.title]),
    [
      ['staging', 'Staging'],
      ['production', 'production'],
    ],
  )
  assert.equal(getEnvironment(board, 'production').baseUrl, 'https://www.example.com')
  assert.throws(() => getEnvironment(board, 'qa'), /No environment "qa".*staging, production/)
  // Multi-board: top-level environments apply to every board, a board may bring its own.
  const multi = normalizeConfig({
    environments: raw.environments,
    boards: [
      { id: 'a', pages: SAMPLE.pages },
      { id: 'b', pages: SAMPLE.pages, environments: [{ id: 'local', baseUrl: 'http://127.0.0.1:5000' }] },
    ],
  })
  assert.equal(multi.boards[0].environments.length, 2)
  assert.equal(multi.boards[1].baseUrl, 'http://127.0.0.1:5000')
})

test('environment and versions problems are reported with their paths', () => {
  const problems = (raw) => {
    try {
      normalizeConfig(raw)
      return ''
    } catch (error) {
      return error.problems.join('\n')
    }
  }
  const text = problems({
    ...structuredClone(SAMPLE),
    versions: 99,
    environments: [
      { id: 'Staging', baseUrl: 'ftp://x' },
      { id: 'prod', baseUrl: 'https://x.example', publicUrl: 'nope' },
      { id: 'prod', baseUrl: 'https://y.example' },
    ],
  })
  for (const fragment of [
    'versions: previous captures',
    'environments[0].id',
    'environments[0].baseUrl',
    'environments[1].publicUrl',
    'duplicate environment id "prod"',
    'baseUrl: with environments, leave baseUrl out',
  ]) {
    assert.ok(text.includes(fragment), `missing "${fragment}" in:\n${text}`)
  }
  assert.match(problems({ pages: SAMPLE.pages, environments: [] }), /environments: 1 to 8/)
})

test('browser.executablePath: a program inside the project is refused, a system path is kept', () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'tools'))
  for (const inside of ['./tools/chrome', 'tools/../tools/chrome', path.join(dir, 'tools', 'chrome'), '.']) {
    assert.throws(
      () => normalizeConfig({ ...structuredClone(SAMPLE), browser: { executablePath: inside } }, { dir }),
      (error) =>
        error instanceof ConfigError && /browser\.executablePath: a browser inside the project folder is refused/.test(error.message),
      inside,
    )
  }
  const system = path.resolve(path.sep, 'usr', 'bin', 'chromium')
  assert.equal(normalizeConfig({ ...structuredClone(SAMPLE), browser: { executablePath: system } }, { dir }).browser.executablePath, system)
  const channel = normalizeConfig({ ...structuredClone(SAMPLE), browser: { channel: 'chrome' } }, { dir })
  assert.deepEqual(channel.browser, { channel: 'chrome', executablePath: null })
  // A link inside the project that leads out of it is a system path; one
  // that leads back in is not.
  const outside = tempDir()
  fs.symlinkSync(outside, path.join(dir, 'out'))
  assert.equal(
    normalizeConfig({ ...structuredClone(SAMPLE), browser: { executablePath: path.join(outside, 'chrome') } }, { dir }).browser
      .executablePath,
    path.join(outside, 'chrome'),
  )
  fs.symlinkSync(path.join(dir, 'tools'), path.join(outside, 'back'))
  assert.throws(
    () => normalizeConfig({ ...structuredClone(SAMPLE), browser: { executablePath: path.join(outside, 'back', 'chrome') } }, { dir }),
    ConfigError,
  )
})

test('authFiles lists every login script and storage state the config names', () => {
  const dir = tempDir()
  const raw = structuredClone(SAMPLE)
  raw.auth = { loginScript: './login.mjs' }
  const config = normalizeConfig(raw, { dir })
  assert.deepEqual(authFiles(config), [path.join(dir, 'login.mjs')])
  assert.deepEqual(authFiles({ boards: [{ auth: { storageState: '/x/state.json' } }, {}] }), ['/x/state.json'])
  assert.deepEqual(authFiles(null), [])
})
