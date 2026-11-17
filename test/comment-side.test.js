// Comments in compare mode: which side of a compare card a comment is on
// (client/src/board/commentSide.js), the environment a comment stores
// (src/store.js), and the capture an agent is pointed at for one left on
// another environment (src/feedback.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { compareSide, defaultEnvironment, environmentOf, frameKey, onSide, sideLabel } from '../client/src/board/commentSide.js'
import { splitFrameKey } from '../client/src/board/viewports.js'
import { feedback, feedbackContext, feedbackItem, fileKind, formatFeedbackItem } from '../src/feedback.js'
import { capturesDir, commentOnOtherEnvironment, createComment, listComments, saveVariant, updateComment } from '../src/store.js'
import { guestView } from '../src/hosted/guest-view.js'
import { createApp } from '../src/server/app.js'
import { elementsUrl } from '../client/src/lib/api.js'
import { request, sampleConfig, tempDir } from './helpers.js'

const environments = [
  { id: 'production', title: 'Production', default: true },
  { id: 'staging', title: 'Staging' },
  { id: 'preview', title: 'Preview' },
]

test('a comment is on its own environment, else the default; a variant has none', () => {
  assert.equal(defaultEnvironment(environments), 'production')
  assert.equal(defaultEnvironment([{ id: 'a' }, { id: 'b' }]), 'a', 'no default flag: the first')
  assert.equal(defaultEnvironment([]), null)
  assert.equal(environmentOf({ pageId: 'home' }, environments), 'production', 'older comments are on the default')
  assert.equal(environmentOf({ pageId: 'home', environment: 'staging' }, environments), 'staging')
  assert.equal(environmentOf({ pageId: 'home', environment: 'gone' }, environments), 'production', 'one the board lost')
  assert.equal(environmentOf({ pageId: 'variant:v1', environment: 'staging' }, environments), null)
})

test('comparing, a comment is drawn on its own side, or on the first when it is on neither', () => {
  const pair = ['staging', 'production']
  assert.equal(compareSide({ pageId: 'home' }, pair, environments), 'production')
  assert.equal(compareSide({ pageId: 'home', environment: 'staging' }, pair, environments), 'staging')
  assert.equal(compareSide({ pageId: 'home', environment: 'preview' }, pair, environments), 'staging', 'neither: the first frame')
  // Swapping the pair keeps every comment on its own side.
  assert.equal(compareSide({ pageId: 'home', environment: 'staging' }, ['production', 'staging'], environments), 'staging')
  assert.equal(compareSide({ pageId: 'home' }, ['production', 'staging'], environments), 'production')
  // Outside compare mode, and on a variant, there are no sides.
  assert.equal(compareSide({ pageId: 'home', environment: 'staging' }, null, environments), null)
  assert.equal(compareSide({ pageId: 'variant:v1' }, pair, environments), null)
  assert.ok(onSide({ pageId: 'home', environment: 'staging' }, 'staging', pair, environments))
  assert.ok(!onSide({ pageId: 'home', environment: 'staging' }, 'production', pair, environments))
})

test('frame keys name the side of a compare card, and split back into all three parts', () => {
  assert.equal(frameKey('home', 'desktop'), 'home|desktop')
  assert.equal(frameKey('home', 'desktop', 'staging'), 'home|desktop@staging')
  assert.deepEqual(splitFrameKey('home|desktop@staging'), { targetId: 'home', viewport: 'desktop', env: 'staging' })
  assert.deepEqual(splitFrameKey('home|desktop'), { targetId: 'home', viewport: 'desktop', env: null })
  assert.deepEqual(splitFrameKey('variant:v1|phone-landscape'), { targetId: 'variant:v1', viewport: 'phone-landscape', env: null })
})

test('the thread names the side while comparing, and outside it only a comment left elsewhere', () => {
  const pair = ['staging', 'production']
  assert.deepEqual(sideLabel({ pageId: 'home' }, { environments, pair }), { env: 'production', title: 'Production', drawnOn: null })
  assert.deepEqual(sideLabel({ pageId: 'home', environment: 'preview' }, { environments, pair }), {
    env: 'preview',
    title: 'Preview',
    drawnOn: 'Staging',
  })
  assert.equal(sideLabel({ pageId: 'home' }, { environments }), null, 'on the capture the board shows: nothing to say')
  assert.deepEqual(sideLabel({ pageId: 'home', environment: 'staging' }, { environments }), {
    env: 'staging',
    title: 'Staging',
    drawnOn: 'Production',
  })
  assert.equal(sideLabel({ pageId: 'variant:v1', environment: 'staging' }, { environments, pair }), null)
  assert.equal(sideLabel({ pageId: 'home', environment: 'staging' }, { environments: environments.slice(0, 1) }), null)
})

function envConfig(name) {
  return sampleConfig(name, {
    baseUrl: undefined,
    environments: [
      { id: 'production', title: 'Production', baseUrl: 'https://www.example.com' },
      { id: 'staging', title: 'Staging', baseUrl: 'http://127.0.0.1:9' },
    ],
  })
}

const pin = { pageId: 'home', viewport: 'desktop', x: 40, y: 30, body: 'The hero image is cropped' }

test('the store keeps the environment a comment was placed on, and refuses one the board does not have', async () => {
  const config = envConfig('comment-side-store')
  const board = config.boards[0]
  const plain = await createComment(config, board, pin)
  assert.equal(plain.environment, undefined, 'outside compare mode: nothing stored, the default environment')
  const staging = await createComment(config, board, { ...pin, environment: 'staging' })
  assert.equal(staging.environment, 'staging')
  assert.equal(staging.captureVersion, null, 'only the default environment keeps capture versions')
  const production = await createComment(config, board, { ...pin, environment: 'production' })
  assert.equal(production.environment, 'production', 'the default side is stored too, so it stays put')
  assert.ok(commentOnOtherEnvironment(board, staging))
  assert.ok(!commentOnOtherEnvironment(board, production))
  assert.ok(!commentOnOtherEnvironment(board, plain))
  for (const environment of ['nope', 42, { id: 'staging' }]) {
    await assert.rejects(createComment(config, board, { ...pin, environment }), (error) => error.code === 'invalid_environment')
  }
  // An empty value is no environment.
  assert.equal((await createComment(config, board, { ...pin, environment: '' })).environment, undefined)
  // It survives a reply, a resolve and a reopen, and is listed.
  await updateComment(config, board.id, staging.id, { status: 'resolved' })
  await updateComment(config, board.id, staging.id, { status: 'open' })
  assert.equal(listComments(config, board.id).find((item) => item.id === staging.id).environment, 'staging')
})

test('a variant has no environment', async () => {
  const config = envConfig('comment-side-variant')
  const board = config.boards[0]
  await saveVariant(config, board.id, { id: 'v1', pageId: 'home', title: 'Bolder', createdAt: '2026-01-01T00:00:00Z' })
  assert.equal((await createComment(config, board, { ...pin, pageId: 'variant:v1' })).pageId, 'variant:v1')
  await assert.rejects(
    createComment(config, board, { ...pin, pageId: 'variant:v1', environment: 'staging' }),
    (error) => error.code === 'invalid_environment',
  )
})

test('agents get the capture the comment was left on: that environment, when it is not the default', async () => {
  const config = envConfig('comment-side-feedback')
  const board = config.boards[0]
  for (const env of ['production', 'staging']) {
    const dir = capturesDir(config, board.id, env)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'home.desktop.png'), `png of ${env}`)
    fs.writeFileSync(path.join(dir, 'home.desktop.html'), `<p>${env}</p>`)
  }
  const onStaging = await createComment(config, board, { ...pin, environment: 'staging' })
  const onProduction = await createComment(config, board, pin)
  const report = feedback(config, { boardId: board.id })
  const staging = report.comments.find((item) => item.id === onStaging.id)
  const production = report.comments.find((item) => item.id === onProduction.id)
  assert.equal(staging.environment, 'staging')
  assert.equal(fs.readFileSync(staging.files.screenshot, 'utf8'), 'png of staging')
  assert.equal(fs.readFileSync(staging.files.liveHtml, 'utf8'), '<p>staging</p>')
  assert.equal(fileKind(staging, staging.files.screenshot), 'envs/staging', 'its URL is under the environment')
  assert.equal(production.environment, undefined)
  // The CLI's line says it too.
  assert.match(formatFeedbackItem(staging)[0], / desktop \d+x\d+ on staging -- by /)
  assert.doesNotMatch(formatFeedbackItem(production)[0], / on production/)
  assert.equal(fs.readFileSync(production.files.screenshot, 'utf8'), 'png of production')
  assert.equal(fileKind(production, production.files.screenshot), 'captures')
  // The same item from a context made once for the whole board.
  const context = feedbackContext(config, board)
  assert.equal(
    feedbackItem(
      context,
      listComments(config, board.id).find((item) => item.id === onStaging.id),
    ).environment,
    'staging',
  )
})

test('a share link guest sees the side a comment is on', () => {
  const comment = { id: 1, pageId: 'home', viewport: 'desktop', x: 1, y: 2, body: 'b', author: 'a', replies: [], environment: 'staging' }
  assert.equal(guestView(comment, null).environment, 'staging')
  assert.equal('environment' in guestView({ ...comment, environment: undefined }, null), false)
})

test('a comment on another environment sticks to that capture: its element map, not the default one', async () => {
  assert.equal(
    elementsUrl('demo', 'captures', 'home.desktop.elements.json', '3'),
    'api/boards/demo/elements/home.desktop.elements.json?v=3',
  )
  assert.equal(
    elementsUrl('demo', 'envs/production', 'home.desktop.elements.json', '3'),
    'api/boards/demo/env-elements/production/home.desktop.elements.json?v=3',
  )
  const config = sampleConfig('comment-side-maps', {
    baseUrl: undefined,
    environments: [
      { id: 'staging', baseUrl: 'http://127.0.0.1:9' },
      { id: 'production', baseUrl: 'http://127.0.0.1:9' },
    ],
  })
  for (const env of ['staging', 'production']) {
    const dir = capturesDir(config, 'sample', env)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'home.desktop.elements.json'), JSON.stringify({ env }))
  }
  const server = await new Promise((resolve) => {
    const listening = createApp({ config, clientDir: tempDir('comment-side-client') }).listen(0, '127.0.0.1', () => resolve(listening))
  })
  try {
    const port = server.address().port
    const get = (url) => request(port, 'GET', url)
    assert.deepEqual((await get('/api/boards/sample/elements/home.desktop.elements.json')).json, { env: 'staging' })
    assert.deepEqual((await get('/api/boards/sample/env-elements/production/home.desktop.elements.json')).json, { env: 'production' })
    assert.equal((await get('/api/boards/sample/env-elements/nope/home.desktop.elements.json')).status, 404)
    assert.equal((await get('/api/boards/sample/env-elements/production/home.desktop.png')).status, 404)
    assert.equal((await get('/api/boards/sample/env-elements/production/..%2Fmanifest.json')).status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
