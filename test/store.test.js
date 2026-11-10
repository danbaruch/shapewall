import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  CommentError,
  captureFiles,
  commentCounts,
  commentsFile,
  createComment,
  deleteComment,
  listComments,
  readVariants,
  removeVariant,
  resolveFile,
  saveVariant,
  updateComment,
  validateAnchor,
  variantsWithFiles,
  writeFileAtomic,
} from '../src/store.js'
import { sampleConfig, tempDir } from './helpers.js'

const valid = { pageId: 'home', viewport: 'desktop', x: 25.123, y: 40, body: '  Make the headline shorter  ' }

test('comments are created, listed newest first and counted', async () => {
  const config = sampleConfig('store-basic')
  const board = config.boards[0]
  const first = await createComment(config, board, valid, { now: new Date('2026-01-01T00:00:00Z') })
  const second = await createComment(
    config,
    board,
    { ...valid, pageId: 'pricing', viewport: 'phone', author: '  Sam  ' },
    { now: new Date('2026-01-02T00:00:00Z') },
  )
  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.equal(first.body, 'Make the headline shorter')
  assert.equal(first.x, 25.12)
  assert.equal(first.author, 'anonymous')
  assert.equal(second.author, 'Sam')
  assert.equal(first.status, 'open')
  assert.deepEqual(
    listComments(config, board.id).map((item) => item.id),
    [2, 1],
  )
  assert.deepEqual(commentCounts(config, board.id), { home: { open: 1, resolved: 0 }, pricing: { open: 1, resolved: 0 } })
})

test('invalid comments are rejected with clear codes', async () => {
  const config = sampleConfig('store-invalid')
  const board = config.boards[0]
  const cases = [
    [{ ...valid, pageId: 'nope' }, 'unknown_page'],
    [{ ...valid, viewport: 'watch' }, 'invalid_viewport'],
    [{ ...valid, pageId: 'app', viewport: 'phone' }, 'invalid_viewport'],
    [{ ...valid, x: 101 }, 'invalid_position'],
    [{ ...valid, y: '50' }, 'invalid_position'],
    [{ ...valid, body: '   ' }, 'empty_comment'],
    [{ ...valid, body: 'x'.repeat(2001) }, 'comment_too_long'],
    [{ ...valid, anchor: 'button' }, 'invalid_anchor'],
  ]
  for (const [input, code] of cases) {
    await assert.rejects(createComment(config, board, input), (error) => error instanceof CommentError && error.code === code, code)
  }
  assert.equal(fs.existsSync(commentsFile(config, board.id)), false)
})

test('anchors only accept the selector grammar the board writes', () => {
  const ok = [
    'a[data-testid="plus-cta"]',
    '#main > div:nth-of-type(2) > button:nth-of-type(1)',
    'nav[aria-label="Main"] > a:nth-of-type(3)',
    String.raw`#\31 23 > p:nth-of-type(1)`,
  ]
  for (const selector of ok) assert.equal(validateAnchor({ selector, text: 'x', dx: 0.5, dy: 0.5 }).selector, selector)
  const bad = [
    '*',
    'div:has(script)',
    'a[href^="javascript"]',
    'body div',
    'img[src="x"]',
    'a:nth-of-type(1) ~ b:nth-of-type(1)',
    'p:nth-of-type(0)',
  ]
  for (const selector of bad) assert.throws(() => validateAnchor({ selector, dx: 0.5, dy: 0.5 }), /not one Shapewall writes/, selector)
  assert.throws(() => validateAnchor({ selector: '#a', dx: 2, dy: 0.5 }), /offset/)
  assert.throws(() => validateAnchor({ selector: '#a', text: 'x'.repeat(81), dx: 0, dy: 0 }), /limited/)
})

test('anchors may carry the element size (for pins on its corner), both or neither', () => {
  assert.deepEqual(validateAnchor({ selector: '#a', text: 'x', dx: 0.5, dy: 0.5, w: 0.123456, h: 0.02 }), {
    selector: '#a',
    text: 'x',
    dx: 0.5,
    dy: 0.5,
    w: 0.1235,
    h: 0.02,
  })
  assert.equal('w' in validateAnchor({ selector: '#a', dx: 0.5, dy: 0.5 }), false)
  // Unknown fields are dropped.
  assert.equal('evil' in validateAnchor({ selector: '#a', dx: 0.5, dy: 0.5, evil: 1 }), false)
  for (const size of [{ w: 0.2 }, { w: 0, h: 0.1 }, { w: 1.5, h: 0.1 }, { w: '0.2', h: 0.1 }, { w: Number.NaN, h: 0.1 }]) {
    assert.throws(() => validateAnchor({ selector: '#a', dx: 0.5, dy: 0.5, ...size }), /anchor size/, JSON.stringify(size))
  }
})

test('resolve, reopen, edit and delete', async () => {
  const config = sampleConfig('store-update')
  const board = config.boards[0]
  const comment = await createComment(config, board, valid)
  const resolved = await updateComment(
    config,
    board.id,
    comment.id,
    { status: 'resolved', resolution: 'Shortened in hero.jsx' },
    { now: new Date('2026-02-01T00:00:00Z') },
  )
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.resolvedAt, '2026-02-01T00:00:00.000Z')
  assert.equal(resolved.resolution, 'Shortened in hero.jsx')
  const reopened = await updateComment(config, board.id, comment.id, { status: 'open' })
  assert.equal(reopened.resolvedAt, null)
  assert.equal(reopened.resolution, null)
  const edited = await updateComment(config, board.id, comment.id, { body: 'New text' })
  assert.equal(edited.body, 'New text')
  await assert.rejects(updateComment(config, board.id, comment.id, { status: 'done' }), /open or resolved/)
  await assert.rejects(updateComment(config, board.id, 999, { status: 'open' }), /does not exist/)
  await deleteComment(config, board.id, comment.id)
  assert.equal(listComments(config, board.id).length, 0)
  // Ids are never reused.
  assert.equal((await createComment(config, board, valid)).id, 2)
})

test('concurrent writers never lose a comment or leave temp files', async () => {
  const config = sampleConfig('store-concurrent')
  const board = config.boards[0]
  const created = await Promise.all(
    Array.from({ length: 25 }, (_, index) => createComment(config, board, { ...valid, body: `comment ${index}` })),
  )
  const ids = created.map((item) => item.id).sort((a, b) => a - b)
  assert.deepEqual(
    ids,
    Array.from({ length: 25 }, (_, index) => index + 1),
  )
  assert.equal(listComments(config, board.id).length, 25)
  const leftovers = fs.readdirSync(path.dirname(commentsFile(config, board.id))).filter((name) => name !== 'comments.json')
  assert.deepEqual(leftovers, [])
})

test('variants are saved, listed and removed with their files', async () => {
  const config = sampleConfig('store-variants')
  const board = config.boards[0]
  await saveVariant(config, board.id, { id: 'calm-hero', pageId: 'home', title: 'Calmer hero', createdAt: '2026-01-01T00:00:00Z' })
  const dir = path.join(config.outputDir, board.id, 'variants')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'calm-hero.desktop.png'), 'png')
  assert.equal(readVariants(config, board.id)[0].title, 'Calmer hero')
  assert.ok(resolveFile(config, board.id, 'variants', 'calm-hero.desktop.png'))
  assert.equal(await removeVariant(config, board.id, 'calm-hero'), true)
  assert.equal(readVariants(config, board.id).length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'calm-hero.desktop.png')), false)
})

test('file sets list each capture and variant file from one directory read', async () => {
  const config = sampleConfig('store-file-sets')
  const board = config.boards[0]
  assert.deepEqual(captureFiles(config, board), {})
  const captures = path.join(config.outputDir, board.id, 'captures')
  fs.mkdirSync(captures, { recursive: true })
  for (const name of [
    'home.desktop.png',
    'home.desktop.thumb.png',
    'home.desktop.html',
    'home.desktop.elements.json',
    'home.phone.png',
    'home.phone.elements.json',
    'pricing.desktop.html',
    'app.phone.png',
  ])
    fs.writeFileSync(path.join(captures, name), 'x')
  const files = captureFiles(config, board)
  assert.deepEqual(files.home, {
    desktop: {
      file: 'home.desktop.png',
      thumb: 'home.desktop.thumb.png',
      live: 'home.desktop.html',
      elements: 'home.desktop.elements.json',
    },
    phone: { file: 'home.phone.png', thumb: null, live: null },
  })
  assert.deepEqual(files.pricing, {}, 'live HTML without a screenshot is not a capture')
  assert.deepEqual(files.app, {}, 'only the page viewports are listed')
  await saveVariant(config, board.id, { id: 'calm-hero', pageId: 'home', title: 'Calmer hero', createdAt: '2026-01-01T00:00:00Z' })
  assert.deepEqual(variantsWithFiles(config, board)[0].files, {}, 'no variants directory yet')
  const variants = path.join(config.outputDir, board.id, 'variants')
  fs.mkdirSync(variants, { recursive: true })
  fs.writeFileSync(path.join(variants, 'calm-hero.phone.png'), 'png')
  assert.deepEqual(variantsWithFiles(config, board)[0].files, { phone: { file: 'calm-hero.phone.png', thumb: null, live: null } })
})

test('only file names Shapewall writes can be resolved', () => {
  const config = sampleConfig('store-files')
  const dir = path.join(config.outputDir, 'sample', 'captures')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'home.desktop.png'), 'png')
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}')
  assert.ok(resolveFile(config, 'sample', 'captures', 'home.desktop.png'))
  for (const name of [
    'manifest.json',
    '../comments.json',
    '..%2Fcomments.json',
    'home.desktop.png/..',
    'Home.desktop.png',
    'home.watch.png',
    'home.desktop.exe',
  ]) {
    assert.equal(resolveFile(config, 'sample', 'captures', name), null, name)
  }
  assert.equal(resolveFile(config, 'sample', '../etc', 'home.desktop.png'), null)
})

test('writeFileAtomic leaves no temporary file behind when the write fails', () => {
  const dir = tempDir('atomic-fail')
  const target = path.join(dir, 'taken')
  fs.mkdirSync(path.join(target, 'inside'), { recursive: true }) // a folder: the rename fails
  assert.throws(() => writeFileAtomic(target, 'data'))
  assert.deepEqual(fs.readdirSync(dir), ['taken'])
  writeFileAtomic(path.join(dir, 'ok.json'), 'fine')
  assert.equal(fs.readFileSync(path.join(dir, 'ok.json'), 'utf8'), 'fine')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ok.json', 'taken'])
})
