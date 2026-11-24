import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ConfigError, normalizeConfig } from '../src/config.js'
import { createJourney, deleteJourney, journeysFile, listJourneys, updateJourney } from '../src/journeys.js'
import { createApp } from '../src/server/app.js'
import { CommentError } from '../src/store.js'
import { SAMPLE, request, sampleConfig, tempDir } from './helpers.js'

const signup = { id: 'signup', name: 'Sign up', steps: ['home', 'pricing', 'app'], description: 'From the landing page to the app' }

function problemsOf(raw) {
  try {
    normalizeConfig(raw)
  } catch (error) {
    assert.ok(error instanceof ConfigError)
    return error.problems.join('\n')
  }
  return ''
}

test('journeys in the config are validated and normalized', () => {
  const config = normalizeConfig({ ...structuredClone(SAMPLE), journeys: [{ ...signup, name: '  Sign   up ' }] })
  assert.deepEqual(config.boards[0].journeys, [{ ...signup }])
  assert.deepEqual(normalizeConfig(structuredClone(SAMPLE)).boards[0].journeys, [])
  const text = problemsOf({
    ...structuredClone(SAMPLE),
    journeys: [
      { id: 'Bad Id', name: 'x', steps: ['home', 'pricing'] },
      { id: 'one', name: 'One step', steps: ['home'] },
      { id: 'ghost', name: 'Ghost', steps: ['home', 'nope'] },
      { id: 'noname', steps: ['home', 'pricing'] },
      { id: 'dup', name: 'A', steps: ['home', 'pricing'] },
      { id: 'dup', name: 'B', steps: ['pricing', 'home'] },
      'not an object',
    ],
  })
  for (const fragment of [
    'journeys[0].id',
    'journeys[1].steps: 2 to 50',
    'journeys[2].steps[1]: no page "nope"',
    'journeys[3].name',
    'duplicate journey id "dup"',
    'journeys[6]: a journey is an object',
  ]) {
    assert.ok(text.includes(fragment), `missing "${fragment}" in:\n${text}`)
  }
  // Multi-board configs keep journeys inside each board.
  assert.match(problemsOf({ baseUrl: SAMPLE.baseUrl, journeys: [], boards: [{ id: 'a', pages: SAMPLE.pages }] }), /inside each board/)
  const multi = normalizeConfig({ baseUrl: SAMPLE.baseUrl, boards: [{ id: 'a', pages: SAMPLE.pages, journeys: [signup] }] })
  assert.equal(multi.boards[0].journeys[0].id, 'signup')
})

test('board journeys: create, list, update, delete; config journeys stay read-only', async () => {
  const config = sampleConfig('journeys-store', { journeys: [signup] })
  const board = config.boards[0]
  const made = await createJourney(config, board, { name: 'Upgrade to Plus', steps: ['pricing', 'app'] })
  assert.equal(made.id, 'upgrade-to-plus')
  assert.equal(made.source, 'board')
  // Ids never collide, with config journeys or each other.
  const again = await createJourney(config, board, { name: 'Upgrade to Plus', steps: ['home', 'app'] })
  assert.notEqual(again.id, made.id)
  const clash = await createJourney(config, board, { name: 'Signup', steps: ['home', 'app'] })
  assert.notEqual(clash.id, 'signup')
  assert.deepEqual(
    listJourneys(config, board).map((item) => [item.id === signup.id ? 'signup' : 'board', item.source]),
    [
      ['signup', 'config'],
      ['board', 'board'],
      ['board', 'board'],
      ['board', 'board'],
    ],
  )
  const changed = await updateJourney(config, board, made.id, { steps: ['home', 'pricing', 'app'], description: 'Via pricing' })
  assert.deepEqual(changed.steps, ['home', 'pricing', 'app'])
  assert.equal(changed.name, 'Upgrade to Plus')
  await assert.rejects(updateJourney(config, board, made.id, { steps: ['home'] }), (error) => error.code === 'invalid_journey')
  await assert.rejects(updateJourney(config, board, 'signup', { name: 'x' }), (error) => error.code === 'config_journey')
  await assert.rejects(deleteJourney(config, board, 'signup'), (error) => error.code === 'config_journey')
  await assert.rejects(deleteJourney(config, board, 'missing'), (error) => error instanceof CommentError && error.statusCode === 404)
  assert.equal(await deleteJourney(config, board, made.id), true)
  assert.equal(
    listJourneys(config, board).some((item) => item.id === made.id),
    false,
  )
  // Written atomically: no temp files left beside the store.
  assert.deepEqual(
    fs.readdirSync(path.join(config.outputDir, 'sample')).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test('invalid board journeys are refused with readable messages', async () => {
  const config = sampleConfig('journeys-invalid')
  const board = config.boards[0]
  for (const input of [
    { name: '', steps: ['home', 'pricing'] },
    { name: 'x'.repeat(200), steps: ['home', 'pricing'] },
    { name: 'Ok', steps: ['home', 'variant:abc'] },
    { name: 'Ok', steps: 'home,pricing' },
    { name: 'Ok', steps: ['home', 'pricing'], description: 7 },
    null,
  ]) {
    await assert.rejects(
      createJourney(config, board, input),
      (error) => error.code === 'invalid_journey' && !/journey\./.test(error.message),
    )
  }
})

test('stored journeys whose pages left the config lose those steps', async () => {
  const config = sampleConfig('journeys-stale')
  const board = config.boards[0]
  fs.mkdirSync(path.join(config.outputDir, 'sample'), { recursive: true })
  fs.writeFileSync(
    journeysFile(config, 'sample'),
    JSON.stringify({
      journeys: [
        { id: 'kept', name: 'Kept', steps: ['home', 'removed', 'pricing'] },
        { id: 'gone', name: 'Gone', steps: ['home', 'removed'] },
        { id: 'BAD', name: 'Bad id', steps: ['home', 'pricing'] },
      ],
    }),
  )
  assert.deepEqual(
    listJourneys(config, board).map((item) => [item.id, item.steps]),
    [['kept', ['home', 'pricing']]],
  )
  // A corrupt file is reported, never overwritten.
  fs.writeFileSync(journeysFile(config, 'sample'), '{ nope')
  await assert.rejects(createJourney(config, board, { name: 'New', steps: ['home', 'pricing'] }), (error) => error.code === 'corrupt_file')
  assert.equal(fs.readFileSync(journeysFile(config, 'sample'), 'utf8'), '{ nope')
})

let server
let port
let readOnly
let config

function listen(app) {
  return new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
}

before(async () => {
  config = sampleConfig('journeys-api', { journeys: [signup] })
  const clientDir = tempDir('journeys-client')
  server = await listen(createApp({ config, clientDir }))
  readOnly = await listen(createApp({ config, clientDir, readOnly: true }))
  port = server.address().port
})

after(() => {
  server?.close()
  readOnly?.close()
})

test('journeys API: JSON-only writes, read-only mode, board view', async () => {
  const made = await request(port, 'POST', '/api/boards/sample/journeys', { body: { name: 'Checkout', steps: ['pricing', 'app'] } })
  assert.equal(made.status, 201)
  const id = made.json.journey.id
  assert.equal(
    (await request(port, 'PATCH', `/api/boards/sample/journeys/${id}`, { body: { name: 'Checkout flow' } })).json.journey.name,
    'Checkout flow',
  )
  const view = await request(port, 'GET', '/api/boards/sample')
  assert.deepEqual(
    view.json.journeys.map((item) => item.id),
    ['signup', id],
  )
  const bad = await request(port, 'POST', '/api/boards/sample/journeys', { body: { name: 'x', steps: ['home'] } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'invalid_journey')
  const form = await request(port, 'POST', '/api/boards/sample/journeys', {
    body: 'name=x',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(form.status, 415)
  assert.equal((await request(port, 'DELETE', '/api/boards/sample/journeys/signup')).status, 409)
  const roPort = readOnly.address().port
  assert.equal((await request(roPort, 'GET', '/api/boards/sample/journeys')).json.journeys.length, 2)
  assert.equal((await request(roPort, 'POST', '/api/boards/sample/journeys', { body: { name: 'x', steps: ['home', 'app'] } })).status, 403)
  assert.equal((await request(roPort, 'DELETE', `/api/boards/sample/journeys/${id}`)).status, 403)
  assert.equal((await request(port, 'DELETE', `/api/boards/sample/journeys/${id}`)).status, 200)
})

const branching = {
  id: 'open-app',
  name: 'Open the app',
  steps: [
    'home',
    'pricing',
    {
      branches: [
        { id: 'signed-out', label: 'Signed out', steps: ['home'] },
        { label: 'Signed in', steps: [] },
      ],
    },
    'app',
  ],
}

test('branching journeys in the config: validated, normalized, with pages and paths', () => {
  const config = sampleConfig('journeys-branching', { journeys: [signup, branching] })
  const [linear, forked] = listJourneys(config, config.boards[0])
  // Linear journeys keep their shape and gain one path.
  assert.deepEqual(linear.steps, signup.steps)
  assert.equal(linear.branching, false)
  assert.deepEqual(linear.paths, [{ choices: [], labels: [], steps: signup.steps, ended: false }])
  assert.equal(forked.branching, true)
  assert.equal(forked.steps[2].branches[1].id, 'signed-in')
  assert.deepEqual(forked.pages, ['home', 'pricing', 'app'])
  assert.deepEqual(
    forked.paths.map((item) => [item.choices[0], item.steps.join(' ')]),
    [
      ['signed-out', 'home pricing home app'],
      ['signed-in', 'home pricing app'],
    ],
  )
  const text = problemsOf({
    ...structuredClone(SAMPLE),
    journeys: [{ id: 'bad', name: 'Bad', steps: ['home', { branches: [{ label: 'Only', steps: ['nope'] }] }] }],
  })
  assert.match(text, /journeys\[0\]\.steps\[1\]\.branches: 2 to 6 branches/)
  assert.match(text, /journeys\[0\]\.steps\[1\]\.branches\[0\]\.steps\[0\]: no page "nope"/)
})

test('board journeys may branch; stored ones lose pages that left the config', async () => {
  const config = sampleConfig('journeys-board-branching')
  const board = config.boards[0]
  const made = await createJourney(config, board, { name: 'Open the app', steps: branching.steps })
  assert.equal(made.branching, true)
  assert.equal(made.paths.length, 2)
  await assert.rejects(
    createJourney(config, board, { name: 'Bad', steps: [{ branches: [] }, 'home'] }),
    (error) => error.code === 'invalid_journey' && /fork follows a page/.test(error.message),
  )
  const changed = await updateJourney(config, board, made.id, { steps: ['home', 'app'] })
  assert.equal(changed.branching, false)
  // A stored fork whose branch pages are gone collapses; one left invalid falls back to its first path.
  fs.writeFileSync(
    journeysFile(config, 'sample'),
    JSON.stringify({
      journeys: [
        {
          id: 'kept',
          name: 'Kept',
          steps: [
            'home',
            {
              branches: [
                { id: 'a', label: 'A', steps: ['removed'] },
                { id: 'b', label: 'B', steps: ['pricing'] },
              ],
            },
            'app',
          ],
        },
        {
          id: 'fallback',
          name: 'Fallback',
          steps: [
            'removed',
            {
              branches: [
                { id: 'a', label: 'A', steps: ['home'] },
                { id: 'b', label: 'B', steps: ['pricing'] },
              ],
            },
            'app',
          ],
        },
      ],
    }),
  )
  assert.deepEqual(
    listJourneys(config, board).map((item) => [item.id, item.steps]),
    [
      [
        'kept',
        [
          'home',
          {
            branches: [
              { id: 'a', label: 'A', steps: [] },
              { id: 'b', label: 'B', steps: ['pricing'] },
            ],
          },
          'app',
        ],
      ],
      ['fallback', ['home', 'app']],
    ],
  )
})

test('journeys API: branching steps in, the structure out', async () => {
  const made = await request(port, 'POST', '/api/boards/sample/journeys', { body: { name: 'Forked', steps: branching.steps } })
  assert.equal(made.status, 201)
  const listed = await request(port, 'GET', '/api/boards/sample/journeys')
  const journey = listed.json.journeys.find((item) => item.id === made.json.journey.id)
  assert.equal(journey.branching, true)
  assert.equal(journey.steps[2].branches.length, 2)
  assert.deepEqual(journey.pages, ['home', 'pricing', 'app'])
  assert.equal(journey.paths.length, 2)
  const bad = await request(port, 'POST', '/api/boards/sample/journeys', {
    body: {
      name: 'Bad',
      steps: [
        'home',
        {
          branches: [
            { label: 'x', steps: [] },
            { label: 'y', steps: ['app'] },
          ],
        },
      ],
    },
  })
  assert.equal(bad.status, 400)
  assert.match(bad.json.error.message, /empty branch/)
  assert.equal((await request(port, 'DELETE', `/api/boards/sample/journeys/${made.json.journey.id}`)).status, 200)
})
