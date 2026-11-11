// The board's side of images and drawings on comments: the drawing helpers
// (shapes from gestures, SVG paths, which drawings show over which capture),
// before and after for a thread drawn on an older capture, and the demo
// backend's checks, which match the server's (same validator, sniffed types,
// guests never upload).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawingsFor, finishShape, hasDrawing, shapePaths } from '../client/src/board/drawing.js'
import { beforeAfter } from '../client/src/board/flow.js'
import { DEMO_IMAGE_BYTES_MAX, demoCommentImages, demoDrawing, sniffDemoImage } from '../client/src/demo/backend/comment-media.js'
import { DemoError } from '../client/src/demo/backend/util.js'
import { validateDrawing } from '../src/comment-drawing.js'
import { b64, gifWithComment, jpegWithExif, pngWithText, webpWithExif } from './comment-media-fixtures.js'

const box = {
  tool: 'box',
  ink: 'accent',
  width: 4,
  points: [
    [0.1, 0.1],
    [0.5, 0.4],
  ],
}

test('finishShape: drops stray clicks, keeps two points for box and arrow, simplifies pen strokes', () => {
  assert.equal(
    finishShape('box', 'accent', [
      [0.2, 0.2],
      [0.201, 0.2],
    ]),
    null,
  )
  assert.deepEqual(
    finishShape('arrow', 'bad', [
      [0.1, 0.1],
      [0.3, 0.3],
      [0.6, 0.5],
    ]).points,
    [
      [0.1, 0.1],
      [0.6, 0.5],
    ],
  )
  const line = Array.from({ length: 200 }, (_, i) => [i / 400, i / 400])
  const pen = finishShape('pen', 'warn', line)
  assert.equal(pen.points.length, 2, 'a straight stroke simplifies to its ends')
  assert.ok(validateDrawing({ shapes: [pen] }), 'what the board makes, the server takes')
  assert.equal(finishShape('pen', 'accent', [[0.5, 0.5]]), null)
})

test('shapePaths: a box is one closed path, an arrow is a line and a head, in native pixels', () => {
  assert.deepEqual(shapePaths(box, 1000, 500), ['M100 50H500V200H100Z'])
  const arrow = shapePaths(
    {
      tool: 'arrow',
      width: 4,
      points: [
        [0, 0],
        [0.5, 0],
      ],
    },
    1000,
    500,
  )
  assert.equal(arrow.length, 2)
  assert.equal(arrow[0], 'M0 0L500 0')
  assert.match(arrow[1], /L500 0L/)
})

test('drawingsFor: only drawings made on the shown capture; the others are counted as previous', () => {
  const comment = {
    drawing: { shapes: [box], captureVersion: 'v1' },
    replies: [{ drawing: { shapes: [box, box], captureVersion: 'v2' } }, { body: 'no drawing' }],
  }
  assert.deepEqual(drawingsFor(comment, 'v2'), { shapes: [box, box], previous: 1 })
  assert.deepEqual(drawingsFor(comment, 'v1'), { shapes: [box], previous: 1 })
  assert.equal(hasDrawing(comment), true)
  assert.equal(hasDrawing({ replies: [] }), false)
})

test('beforeAfter: an open thread drawn on an older capture shows that capture as before, with its ink', () => {
  const data = {
    manifest: { pages: { home: { desktop: { status: 'ok', version: 'v3' } } } },
    captures: { home: { desktop: { file: 'home.desktop.png' } } },
    versions: {
      home: {
        desktop: [
          { version: 'v1', file: 'home.desktop.v1.png' },
          { version: 'v2', file: 'home.desktop.v2.png' },
        ],
      },
    },
  }
  const base = { pageId: 'home', viewport: 'desktop', status: 'open', captureVersion: 'v1', replies: [] }
  assert.equal(beforeAfter(base, data), null, 'no drawing, not resolved: nothing to compare')
  const drawn = { ...base, replies: [{ drawing: { shapes: [box], captureVersion: 'v2' } }] }
  assert.deepEqual(beforeAfter(drawn, data), {
    before: { kind: 'versions', file: 'home.desktop.v2.png', version: 'v2' },
    after: { kind: 'captures', file: 'home.desktop.png', version: 'v3' },
    reason: null,
    drawn: [box],
  })
  const current = { ...base, drawing: { shapes: [box], captureVersion: 'v3' } }
  assert.equal(beforeAfter(current, data), null, 'drawn on the current capture: it shows over the page')
  const resolved = { ...base, status: 'resolved', drawing: { shapes: [box], captureVersion: 'v1' } }
  assert.deepEqual(beforeAfter(resolved, data).drawn, [box])
})

test('demo: images are sniffed by content, capped and refused for guests; the drawing uses the server validator', () => {
  const png = pngWithText()
  const { images, attachments } = demoCommentImages([{ name: 'a<b>.png', mediaType: 'image/gif', data: b64(png) }], { guest: false })
  assert.equal(images[0].mediaType, 'image/png', 'the bytes decide, not the declared type')
  assert.match(images[0].file, /^[a-f0-9]{24}\.png$/)
  assert.equal(images[0].name, 'ab.png')
  assert.deepEqual([images[0].width, images[0].height], [4, 3])
  assert.equal(attachments[0].file, images[0].file)
  for (const [bytes, type] of [
    [jpegWithExif(), 'image/jpeg'],
    [webpWithExif(), 'image/webp'],
    [gifWithComment(), 'image/gif'],
  ])
    assert.equal(sniffDemoImage(b64(bytes)).mediaType, type)
  const refuse = (raw, options, code) =>
    assert.throws(
      () => demoCommentImages(raw, options),
      (error) => error instanceof DemoError && error.code === code,
    )
  refuse([{ data: b64(png) }], { guest: true }, 'guest_no_images')
  refuse([{ data: b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) }], { guest: false }, 'bad_image_type')
  refuse(
    Array.from({ length: 5 }, () => ({ data: b64(png) })),
    { guest: false },
    'too_many_images',
  )
  refuse([{ data: 'A'.repeat(Math.ceil((DEMO_IMAGE_BYTES_MAX * 4) / 3) + 8) }], { guest: false }, 'image_too_big')
  refuse([{ data: 'not base64!' }], { guest: false }, 'bad_image')
  assert.deepEqual(demoCommentImages(undefined, { guest: true }), { images: [], attachments: [] }, 'guests may post without images')

  assert.deepEqual(demoDrawing({ shapes: [box] }), validateDrawing({ shapes: [box] }))
  assert.equal(demoDrawing(undefined), null)
  assert.throws(
    () => demoDrawing({ shapes: [{ tool: 'text', points: [[0, 0]] }] }),
    (error) => error instanceof DemoError && error.code === 'invalid_drawing',
  )
})
