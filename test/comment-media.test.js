import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import {
  DRAWING_POINTS_MAX,
  DRAWING_SHAPES_MAX,
  DRAWING_STROKE_POINTS_MAX,
  DrawingError,
  INK_RGB,
  drawingBounds,
  readDrawing,
  simplifyStroke,
  validateDrawing,
} from '../src/comment-drawing.js'
import { COMMENT_IMAGES_MAX, COMMENT_IMAGE_BYTES_MAX, readImages } from '../src/comment-fields.js'
import {
  MARKUP_EDGE_MAX,
  cleanCommentImage,
  commentFilePath,
  markupFile,
  parseImageInputs,
  renderMarkup,
  sendCommentFile,
} from '../src/comment-media.js'
import { ATTACHMENTS_MAX, ATTACHMENT_BYTES_MAX, sniffImage } from '../src/agent/threads.js'
import { addReply, boardDir, createComment, deleteComment, getComment, listComments, updateComment } from '../src/store.js'
import { commentText, hasCommentMedia, mediaLabel } from '../src/comment-fields.js'
import { commentSummary } from '../src/event-log.js'
import { summarize } from '../src/notify/messages.js'
import { feedback, feedbackContext, feedbackItem, formatFeedbackItem } from '../src/feedback.js'
import { commentForModel, commentMediaParts } from '../src/agent/tools.js'
import { modelMessages } from '../src/agent/run.js'
import { exportStatic } from '../src/export.js'
import { sampleConfig, tempDir } from './helpers.js'
import { b64, gifWithComment, jpegWithExif, pngWithText, solidPng, webpWithExif } from './comment-media-fixtures.js'

const box = {
  tool: 'box',
  ink: 'accent',
  width: 3,
  points: [
    [0.1, 0.1],
    [0.3, 0.2],
  ],
}
const arrow = {
  tool: 'arrow',
  ink: 'bad',
  width: 4,
  points: [
    [0.5, 0.5],
    [0.7, 0.6],
  ],
}
const valid = { pageId: 'home', viewport: 'desktop', x: 20, y: 15, body: 'Look at this' }

const codeOf = (fn) => {
  try {
    fn()
  } catch (error) {
    return error.code
  }
  return null
}

// ---- Drawings ----------------------------------------------------------------

test('drawings: boxes, arrows and pen strokes are kept, rounded and defaulted', () => {
  const clean = validateDrawing({
    shapes: [
      box,
      arrow,
      {
        tool: 'pen',
        points: [
          [0.123456, 0.5],
          [0.2, 0.5],
          [0.3, 0.5000001],
          [0.4, 0.6],
        ],
      },
    ],
  })
  assert.equal(clean.shapes.length, 3)
  assert.deepEqual(clean.shapes[0], box)
  // Pen defaults: the accent ink and a 3 px line; a straight run is simplified.
  assert.deepEqual(clean.shapes[2], {
    tool: 'pen',
    ink: 'accent',
    width: 3,
    points: [
      [0.1235, 0.5],
      [0.3, 0.5],
      [0.4, 0.6],
    ],
  })
  assert.equal(validateDrawing(null), null)
  assert.equal(validateDrawing({ shapes: [] }), null)
  // Slightly off the frame is clamped.
  assert.deepEqual(
    validateDrawing({
      shapes: [
        {
          ...box,
          points: [
            [-0.02, 0],
            [1.03, 1],
          ],
        },
      ],
    }).shapes[0].points,
    [
      [0, 0],
      [1, 1],
    ],
  )
})

test('drawings: hostile and oversized input is refused with invalid_drawing', () => {
  const cases = [
    'a string',
    [],
    { shapes: 'no' },
    { shapes: [null] },
    { shapes: [{ ...box, tool: 'text' }] },
    { shapes: [{ ...box, tool: '__proto__' }] },
    { shapes: [{ ...box, ink: '#ff0000' }] },
    { shapes: [{ ...box, ink: 'url(javascript:alert(1))' }] },
    { shapes: [{ ...box, width: 0 }] },
    { shapes: [{ ...box, width: 13 }] },
    { shapes: [{ ...box, width: 2.5 }] },
    { shapes: [{ ...box, points: [[0, 0]] }] },
    {
      shapes: [
        {
          ...box,
          points: [
            [0, 0],
            [1, 1],
            [0.5, 0.5],
          ],
        },
      ],
    },
    {
      shapes: [
        {
          ...box,
          points: [
            [0, 0],
            [2, 1],
          ],
        },
      ],
    },
    {
      shapes: [
        {
          ...box,
          points: [
            [0, 0],
            [NaN, 1],
          ],
        },
      ],
    },
    {
      shapes: [
        {
          ...box,
          points: [
            [0, 0],
            [Infinity, 1],
          ],
        },
      ],
    },
    {
      shapes: [
        {
          ...box,
          points: [
            [0, 0],
            ['0.5', 1],
          ],
        },
      ],
    },
    { shapes: [{ ...box, points: [[0, 0], [0.5]] }] },
    { shapes: [{ ...box, points: 'M0 0' }] },
    { shapes: [{ tool: 'pen', points: [[0.1, 0.1]] }] },
    { shapes: Array.from({ length: DRAWING_SHAPES_MAX + 1 }, () => box) },
    { shapes: [{ tool: 'pen', points: Array.from({ length: DRAWING_STROKE_POINTS_MAX + 1 }, (_, i) => [i / 3000, 0.5]) }] },
  ]
  for (const input of cases)
    assert.equal(
      codeOf(() => validateDrawing(input)),
      'invalid_drawing',
      JSON.stringify(input).slice(0, 80),
    )
  assert.ok(new DrawingError('x') instanceof Error)
})

test('drawings: the total point cap holds after simplification', () => {
  // Zigzags do not simplify: 3 strokes of 2000 points is over the total.
  const zigzag = Array.from({ length: DRAWING_STROKE_POINTS_MAX }, (_, i) => [i / DRAWING_STROKE_POINTS_MAX, i % 2 ? 0.2 : 0.8])
  assert.equal(
    codeOf(() => validateDrawing({ shapes: [1, 2, 3].map(() => ({ tool: 'pen', points: zigzag })) })),
    'invalid_drawing',
  )
  assert.ok(DRAWING_POINTS_MAX >= DRAWING_STROKE_POINTS_MAX)
  // A long smooth stroke shrinks a lot.
  const smooth = Array.from({ length: 2000 }, (_, i) => [i / 2000, 0.5 + Math.sin(i / 300) * 0.1])
  const simplified = simplifyStroke(smooth)
  assert.ok(simplified.length < 200, `${simplified.length} points`)
  assert.deepEqual(simplified[0], smooth[0])
  assert.deepEqual(simplified.at(-1), smooth.at(-1))
})

test('drawings: fuzzed input either validates to bounded shapes or throws invalid_drawing', () => {
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const values = [0, 1, -1, 0.5, 2, NaN, null, undefined, 'x', {}, [], true, 1e308, -0, 0.99999]
  const pick = (list) => list[Math.floor(random() * list.length)]
  for (let round = 0; round < 400; round += 1) {
    const shapes = Array.from({ length: Math.floor(random() * 5) }, () => ({
      tool: pick(['box', 'arrow', 'pen', 'circle', undefined]),
      ink: pick(['accent', 'bad', 'warn', 'red', undefined]),
      width: pick([1, 3, 12, 0, 20, 2.2, undefined]),
      points: Array.from({ length: Math.floor(random() * 6) }, () =>
        random() < 0.8 ? [random() * 1.2 - 0.1, random() * 1.2 - 0.1] : [pick(values), pick(values)],
      ),
    }))
    let clean
    try {
      clean = validateDrawing({ shapes })
    } catch (error) {
      assert.equal(error.code, 'invalid_drawing')
      continue
    }
    for (const shape of clean?.shapes || []) {
      assert.ok(['box', 'arrow', 'pen'].includes(shape.tool))
      for (const [x, y] of shape.points) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1)
    }
  }
})

test('drawings: a stored drawing is read back through the validator', () => {
  assert.deepEqual(readDrawing({ shapes: [box], captureVersion: '20260101T000000000Z-ab12' }), {
    shapes: [box],
    captureVersion: '20260101T000000000Z-ab12',
  })
  assert.equal(readDrawing({ shapes: [box], captureVersion: '../../etc' }).captureVersion, null)
  assert.equal(readDrawing({ shapes: [{ tool: 'evil' }] }), null)
  assert.equal(readDrawing('nope'), null)
  assert.deepEqual(drawingBounds({ shapes: [box, arrow] }), { x: 0.1, y: 0.1, width: 0.6, height: 0.5 })
})

// ---- Images --------------------------------------------------------------------

test('images use the chat attachment limits, types and sniffing', () => {
  assert.equal(COMMENT_IMAGES_MAX, ATTACHMENTS_MAX)
  assert.equal(COMMENT_IMAGE_BYTES_MAX, ATTACHMENT_BYTES_MAX)
  assert.equal(sniffImage(pngWithText()), 'image/png')
  assert.equal(sniffImage(jpegWithExif()), 'image/jpeg')
  assert.equal(sniffImage(webpWithExif()), 'image/webp')
  assert.equal(sniffImage(gifWithComment()), 'image/gif')
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
})

test('images: inputs are checked for count, type, base64 and size', () => {
  const png = { name: 'shot.png', mediaType: 'image/png', data: b64(pngWithText()) }
  assert.equal(parseImageInputs(undefined).length, 0)
  assert.equal(parseImageInputs([png])[0].name, 'shot.png')
  assert.equal(parseImageInputs([{ ...png, data: `data:image/png;base64,${png.data}` }]).length, 1)
  const svg = b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
  const cases = [
    [[png, png, png, png, png], 'too_many_images'],
    ['nope', 'too_many_images'],
    [[{ ...png, mediaType: 'image/svg+xml', data: svg }], 'bad_image_type'],
    [[{ ...png, data: svg }], 'bad_image_type'],
    [[{ ...png, mediaType: 'image/jpeg' }], 'bad_image_type'],
    [[{ ...png, mediaType: 'text/html' }], 'bad_image_type'],
    [[{ ...png, data: 'not base64!' }], 'bad_image'],
    [[{ ...png, data: '' }], 'bad_image'],
    [[{ ...png, data: 'A'.repeat(Math.ceil((COMMENT_IMAGE_BYTES_MAX + 10) / 3) * 4) }], 'image_too_big'],
  ]
  for (const [input, code] of cases)
    assert.equal(
      codeOf(() => parseImageInputs(input)),
      code,
      JSON.stringify(input).slice(0, 60),
    )
  // Names lose markup and path characters.
  assert.equal(parseImageInputs([{ ...png, name: '<img src=x>../../evil".png' }])[0].name, 'img src=x....evil.png')
})

test('images: PNGs are re-encoded without their text chunks', () => {
  const input = pngWithText({ width: 4, height: 3 })
  assert.ok(input.includes(Buffer.from('secret-gps')))
  const clean = cleanCommentImage(input, 'image/png')
  assert.equal(clean.width, 4)
  assert.equal(clean.height, 3)
  assert.ok(!clean.buffer.includes(Buffer.from('tEXt')))
  assert.ok(!clean.buffer.includes(Buffer.from('secret')))
  const pixels = PNG.sync.read(clean.buffer)
  assert.deepEqual([...pixels.data.subarray(0, 4)], [200, 40, 40, 255])
})

test('images: JPEG, WebP and GIF lose their metadata and keep their pixels', () => {
  const jpeg = cleanCommentImage(jpegWithExif({ width: 640, height: 480, trailer: Buffer.from('PK\x03\x04hidden zip') }), 'image/jpeg')
  assert.deepEqual([jpeg.width, jpeg.height], [640, 480])
  assert.ok(!jpeg.buffer.includes(Buffer.from('Exif')))
  assert.ok(!jpeg.buffer.includes(Buffer.from('comment with')))
  assert.ok(!jpeg.buffer.includes(Buffer.from('hidden zip')))
  assert.ok(jpeg.buffer.includes(Buffer.from('JFIF')))
  assert.ok(jpeg.buffer.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78])))
  assert.deepEqual([...jpeg.buffer.subarray(-2)], [0xff, 0xd9])

  const webp = cleanCommentImage(webpWithExif({ width: 100, height: 50 }), 'image/webp')
  assert.deepEqual([webp.width, webp.height], [100, 50])
  assert.ok(!webp.buffer.includes(Buffer.from('EXIF')))
  assert.ok(!webp.buffer.includes(Buffer.from('secret')))
  assert.equal(webp.buffer.readUInt32LE(4) + 8, webp.buffer.length)
  assert.equal(webp.buffer[20] & 0x0c, 0)

  const gif = cleanCommentImage(gifWithComment(), 'image/gif')
  assert.deepEqual([gif.width, gif.height], [1, 1])
  assert.ok(!gif.buffer.includes(Buffer.from('secret')))
  assert.ok(!gif.buffer.includes(Buffer.from('XMP')))
  assert.equal(gif.buffer.at(-1), 0x3b)
})

test('images: broken files and huge dimensions are refused before decoding', () => {
  const png = pngWithText()
  const huge = Buffer.from(png)
  huge.writeUInt32BE(9000, 16)
  assert.equal(
    codeOf(() => cleanCommentImage(huge, 'image/png')),
    'image_too_large_pixels',
  )
  const wide = Buffer.from(png)
  wide.writeUInt32BE(5000, 16)
  wide.writeUInt32BE(5000, 20)
  assert.equal(
    codeOf(() => cleanCommentImage(wide, 'image/png')),
    'image_too_large_pixels',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(png.subarray(0, 40), 'image/png')),
    'bad_image',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(jpegWithExif().subarray(0, 30), 'image/jpeg')),
    'bad_image',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(jpegWithExif({ width: 9000, height: 10 }), 'image/jpeg')),
    'image_too_large_pixels',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(webpWithExif().subarray(0, 24), 'image/webp')),
    'bad_image',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(gifWithComment().subarray(0, 20), 'image/gif')),
    'bad_image',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(png, 'image/gif')),
    'bad_image_type',
  )
  assert.deepEqual(readImages([{ file: '../../etc/passwd' }, { file: 'abc.png' }, 'x']), [])
})

test('images: every GIF frame is checked, not only the logical screen', () => {
  // The fixture's image descriptor: 0x2c, left, top, width, height (16-bit little-endian).
  const withFrame = ({ left = 0, top = 0, width, height }) => {
    const gif = Buffer.from(gifWithComment())
    const at = gif.indexOf(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0]))
    gif.writeUInt16LE(left, at + 1)
    gif.writeUInt16LE(top, at + 3)
    gif.writeUInt16LE(width, at + 5)
    gif.writeUInt16LE(height, at + 7)
    return gif
  }
  // A 1x1 screen with a 65535x65535 frame: over the pixel cap.
  assert.equal(
    codeOf(() => cleanCommentImage(withFrame({ width: 65535, height: 65535 }), 'image/gif')),
    'image_too_large_pixels',
  )
  // Small frames that leave the 1x1 screen.
  assert.equal(
    codeOf(() => cleanCommentImage(withFrame({ width: 2, height: 1 }), 'image/gif')),
    'bad_image',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(withFrame({ left: 1, width: 1, height: 1 }), 'image/gif')),
    'bad_image',
  )
  assert.equal(
    codeOf(() => cleanCommentImage(withFrame({ width: 0, height: 1 }), 'image/gif')),
    'bad_image',
  )
  assert.deepEqual(Object.keys(cleanCommentImage(withFrame({ width: 1, height: 1 }), 'image/gif')).sort(), [
    'buffer',
    'height',
    'mediaType',
    'width',
  ])
})

test('images: served as their type with nosniff and a sandbox CSP, never as HTML', () => {
  const headers = {}
  let type = null
  let sent = null
  const res = {
    setHeader: (name, value) => (headers[name.toLowerCase()] = value),
    type(value) {
      type = value
      return this
    },
    sendFile: (file) => (sent = file),
  }
  sendCommentFile(res, '/x/0123456789abcdef01234567.gif', '0123456789abcdef01234567.gif')
  assert.equal(type, 'image/gif')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.match(headers['content-security-policy'], /sandbox/)
  assert.equal(sent, '/x/0123456789abcdef01234567.gif')
})

// ---- Storage and deletion -----------------------------------------------------------

function boardWithCapture(name) {
  const config = sampleConfig(name)
  const board = config.boards[0]
  const captures = path.join(boardDir(config, board.id), 'captures')
  fs.mkdirSync(captures, { recursive: true })
  fs.writeFileSync(path.join(captures, 'home.desktop.png'), solidPng(400, 300))
  fs.writeFileSync(
    path.join(captures, 'manifest.json'),
    JSON.stringify({
      capturedAt: '2026-01-01T00:00:00.000Z',
      pages: { home: { desktop: { status: 'ok', version: '20260101T000000000Z-aaaa' } } },
    }),
  )
  return { config, board, folder: boardDir(config, board.id) }
}

test('storage: images and drawings are stored with the comment and its replies, and deleted with it', async () => {
  const { config, board, folder } = boardWithCapture('media-store')
  const comment = await createComment(config, board, {
    ...valid,
    images: [{ name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }],
    drawing: { shapes: [box, arrow], captureVersion: 'client-cannot-set-this' },
  })
  assert.equal(comment.images.length, 1)
  assert.match(comment.images[0].file, /^[a-f0-9]{24}\.png$/)
  assert.deepEqual(Object.keys(comment.images[0]).sort(), ['bytes', 'file', 'height', 'id', 'mediaType', 'name', 'width'])
  assert.equal(comment.drawing.captureVersion, comment.captureVersion)
  const imagePath = commentFilePath(folder, comment.images[0].file)
  assert.ok(imagePath && fs.existsSync(imagePath))

  const { reply } = await addReply(config, board.id, comment.id, {
    body: 'and here',
    images: [{ name: 'b.gif', mediaType: 'image/gif', data: b64(gifWithComment()) }],
    drawing: { shapes: [box] },
  })
  assert.equal(reply.images[0].mediaType, 'image/gif')
  assert.equal(reply.drawing.shapes.length, 1)
  const replyImage = commentFilePath(folder, reply.images[0].file)

  // A comment without media reads as before: no images or drawing keys.
  const plain = await createComment(config, board, valid)
  assert.equal('images' in plain, false)
  assert.equal('drawing' in plain, false)

  // A refused comment leaves no files behind.
  const before = fs.readdirSync(path.join(folder, 'comment-files')).length
  await assert.rejects(
    createComment(config, board, { ...valid, images: [{ mediaType: 'image/png', data: b64(pngWithText()) }], drawing: { shapes: 'x' } }),
    { code: 'invalid_drawing' },
  )
  await assert.rejects(
    createComment(config, board, { ...valid, pageId: 'nope', images: [{ mediaType: 'image/png', data: b64(pngWithText()) }] }),
    { code: 'unknown_page' },
  )
  assert.equal(fs.readdirSync(path.join(folder, 'comment-files')).length, before)

  // Render the markup so deletion has it to remove too.
  const item = feedbackItem(feedbackContext(config, board), getComment(config, board.id, comment.id))
  assert.ok(fs.existsSync(item.files.markup))
  await deleteComment(config, board.id, comment.id)
  assert.equal(fs.existsSync(imagePath), false)
  assert.equal(fs.existsSync(replyImage), false)
  assert.equal(fs.existsSync(item.files.markup), false)
  assert.deepEqual(fs.readdirSync(path.join(folder, 'comment-files')), [])
})

test('storage: images over the limit and too many images are refused with codes', async () => {
  const { config, board } = boardWithCapture('media-limits')
  const png = { mediaType: 'image/png', data: b64(pngWithText()) }
  await assert.rejects(createComment(config, board, { ...valid, images: [png, png, png, png, png] }), { code: 'too_many_images' })
  await assert.rejects(createComment(config, board, { ...valid, images: [{ ...png, mediaType: 'image/svg+xml' }] }), {
    code: 'bad_image_type',
    statusCode: 415,
  })
  const four = await createComment(config, board, { ...valid, images: [png, png, png, png] })
  assert.equal(four.images.length, 4)
})

// ---- Markup rendering ----------------------------------------------------------------

test('markup: the crop around the drawing, ink on top, bounded and deterministic', () => {
  const screenshot = solidPng(1440, 2000, [250, 250, 250, 255])
  const drawing = {
    shapes: [
      {
        tool: 'box',
        ink: 'accent',
        width: 4,
        points: [
          [0.25, 0.1],
          [0.5, 0.2],
        ],
      },
    ],
  }
  const first = renderMarkup(screenshot, drawing)
  const second = renderMarkup(screenshot, drawing)
  assert.ok(first.png.equals(second.png))
  // Golden size: the box (360 x 200 px) plus a 48 px margin on each side.
  assert.deepEqual(first.rect, { x: 312, y: 152, width: 456, height: 296 })
  const image = PNG.sync.read(first.png)
  assert.deepEqual([image.width, image.height], [456, 296])
  const at = (x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)]
  // The box's top left corner is at (48, 48) in the crop: ink there, page in the middle.
  assert.deepEqual(at(48, 48), INK_RGB.accent)
  assert.deepEqual(at(48 + 180, 48), INK_RGB.accent)
  assert.deepEqual(at(228, 148), [250, 250, 250])
  assert.deepEqual(at(5, 5), [250, 250, 250])

  // A drawing across the whole page is scaled down to the edge cap.
  const big = renderMarkup(screenshot, {
    shapes: [
      {
        tool: 'pen',
        ink: 'bad',
        width: 3,
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
  })
  const bigImage = PNG.sync.read(big.png)
  assert.equal(Math.max(bigImage.width, bigImage.height), MARKUP_EDGE_MAX)
  assert.equal(bigImage.width, Math.round(1440 * (MARKUP_EDGE_MAX / 2000)))

  // A tiny drawing still gets a readable crop.
  const tiny = renderMarkup(screenshot, {
    shapes: [
      {
        tool: 'arrow',
        ink: 'warn',
        width: 2,
        points: [
          [0.5, 0.5],
          [0.501, 0.501],
        ],
      },
    ],
  })
  assert.ok(tiny.rect.width >= 360 && tiny.rect.height >= 240)
  assert.equal(renderMarkup(Buffer.from('not a png'), drawing), null)
  assert.equal(renderMarkup(screenshot, { shapes: [] }), null)
})

test('markup: rendered once to the board folder, from the capture it was drawn on', () => {
  const dir = tempDir('markup-file')
  const shot = path.join(dir, 'shot.png')
  fs.writeFileSync(shot, solidPng(200, 200))
  const drawing = { shapes: [box] }
  const file = markupFile(dir, { commentId: 3, drawing, screenshot: shot })
  assert.equal(path.basename(file), 'markup-3.png')
  const stat = fs.statSync(file)
  assert.equal(markupFile(dir, { commentId: 3, drawing, screenshot: shot }), file)
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs)
  assert.equal(path.basename(markupFile(dir, { commentId: 3, replyId: 2, drawing, screenshot: shot })), 'markup-3-r2.png')
  assert.equal(markupFile(dir, { commentId: 4, drawing, screenshot: path.join(dir, 'missing.png') }), null)
  assert.equal(markupFile(dir, { commentId: 5, drawing: null, screenshot: shot }), null)
  // A symlink planted as the screenshot is not followed.
  fs.symlinkSync('/etc/hostname', path.join(dir, 'link.png'))
  assert.equal(markupFile(dir, { commentId: 6, drawing, screenshot: path.join(dir, 'link.png') }), null)
})

// ---- What agents get ------------------------------------------------------------------

test('agents: comments --json, the text list and the model context include the media', async () => {
  const { config, board, folder } = boardWithCapture('media-agents')
  const comment = await createComment(config, board, {
    ...valid,
    images: [{ name: 'screen.png', mediaType: 'image/png', data: b64(pngWithText()) }],
    drawing: { shapes: [box] },
  })
  await addReply(config, board.id, comment.id, { body: 'see', drawing: { shapes: [arrow] } })
  const report = feedback(config, { boardId: board.id })
  const item = report.comments.find((entry) => entry.id === comment.id)
  assert.equal(item.files.images.length, 1)
  assert.deepEqual(Object.keys(item.files.images[0]).sort(), ['bytes', 'height', 'mediaType', 'name', 'path', 'width'])
  assert.equal(item.files.images[0].path, path.join(folder, 'comment-files', comment.images[0].file))
  assert.equal(item.files.images[0].mediaType, 'image/png')
  assert.equal(path.dirname(item.files.markup), path.join(folder, 'comment-files'))
  assert.deepEqual(item.drawing, { shapes: 1, tools: ['box'], captureVersion: '20260101T000000000Z-aaaa', onPreviousCapture: false })
  assert.equal(path.basename(item.replies[0].markup), `markup-${comment.id}-r1.png`)
  assert.equal(item.replies[0].drawing.tools[0], 'arrow')
  const plainItem = feedbackItem(feedbackContext(config, board), await createComment(config, board, valid))
  assert.deepEqual(plainItem.files.images, [])
  assert.equal(plainItem.files.markup, null)
  assert.equal(plainItem.drawing, null)

  const lines = formatFeedbackItem(item, { cwd: folder }).join('\n')
  assert.match(lines, /image: comment-files\/[a-f0-9]{24}\.png \(image\/png, \d+ bytes\)/)
  assert.match(lines, /drawing: comment-files\/markup-1\.png/)

  // The model sees no local paths, but gets the images as image parts,
  // each after a quoted untrusted note.
  const forModel = commentForModel(config, board, getComment(config, board.id, comment.id))
  assert.equal(JSON.stringify(forModel).includes(folder), false)
  assert.equal(forModel.images[0].name, 'screen.png')
  assert.equal(forModel.drawingImage, 'attached as an image')
  const parts = commentMediaParts(config, board, getComment(config, board.id, comment.id))
  assert.deepEqual(
    parts.map((part) => part.type),
    ['text', 'image', 'text', 'image', 'text', 'image'],
  )
  assert.match(parts[0].text, /<shapewall-data source="comment-image" trust="untrusted"/)
  assert.match(parts[0].text, /reviewer drawing/)
  assert.equal(parts[1].mediaType, 'image/png')
  assert.ok(
    Buffer.from(parts[1].data, 'base64')
      .subarray(0, 4)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  )

  const conversation = modelMessages({
    config,
    board,
    threadId: `comment-${comment.id}`,
    messages: [{ id: 'm1', role: 'user', text: 'Fix it', attachments: [] }],
  })
  const images = conversation.at(-1).content.filter((part) => part.type === 'image')
  assert.equal(images.length, 3)
})

test('agents: a drawing on an earlier capture uses that capture and says so', async () => {
  const { config, board, folder } = boardWithCapture('media-previous')
  const comment = await createComment(config, board, { ...valid, drawing: { shapes: [box] } })
  // Recaptured: the old shot moves to versions/, a new one with a new version.
  fs.mkdirSync(path.join(folder, 'versions'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'versions', 'home.desktop.20260101T000000000Z-aaaa.png'), solidPng(400, 300, [10, 10, 10, 255]))
  fs.writeFileSync(
    path.join(folder, 'captures', 'manifest.json'),
    JSON.stringify({
      capturedAt: '2026-02-01T00:00:00.000Z',
      pages: { home: { desktop: { status: 'ok', version: '20260201T000000000Z-bbbb' } } },
    }),
  )
  const item = feedbackItem(feedbackContext(config, board), getComment(config, board.id, comment.id))
  assert.equal(item.drawing.onPreviousCapture, true)
  const markup = PNG.sync.read(fs.readFileSync(item.files.markup))
  // The old (dark) capture under the ink, not the new white one.
  assert.deepEqual([...markup.data.subarray(0, 3)], [10, 10, 10])
})

test('export: exported boards carry the images of exported comments only', async () => {
  const { config, board, folder } = boardWithCapture('media-export')
  const png = { mediaType: 'image/png', data: b64(pngWithText()) }
  const kept = await createComment(config, board, { ...valid, images: [png] })
  const gone = await createComment(config, board, { ...valid, images: [png] })
  const goneFile = gone.images[0].file
  // A stray file (a markup render, an orphan) is not exported.
  fs.writeFileSync(path.join(folder, 'comment-files', 'markup-1.png'), solidPng(2, 2))
  fs.writeFileSync(path.join(folder, 'comment-files', 'ffffffffffffffffffffffff.png'), solidPng(2, 2))
  await deleteComment(config, board.id, gone.id)
  const client = tempDir('media-export-client')
  fs.writeFileSync(path.join(client, 'index.html'), '<!doctype html><head></head>')
  const out = tempDir('media-export-out')
  await exportStatic(config, { out, clientDir: client })
  const exported = path.join(out, 'data', 'boards', board.id)
  assert.deepEqual(fs.readdirSync(path.join(exported, 'comment-files')), [kept.images[0].file])
  assert.equal(fs.existsSync(path.join(exported, 'comment-files', goneFile)), false)
  const comments = JSON.parse(fs.readFileSync(path.join(exported, 'comments.json'), 'utf8')).comments
  assert.equal(comments[0].images[0].file, kept.images[0].file)
  // Without comments, no images either.
  const bare = tempDir('media-export-bare')
  await exportStatic(config, { out: bare, clientDir: client, includeComments: false })
  assert.equal(fs.existsSync(path.join(bare, 'data', 'boards', board.id, 'comment-files')), false)
  assert.equal(listComments(config, board.id).length, 1)
})

test('no text: a drawing or an image can be the whole comment or reply, and nothing at all is still refused', async () => {
  const { config, board, folder } = boardWithCapture('media-wordless')
  const image = { name: 'a.png', mediaType: 'image/png', data: b64(pngWithText()) }
  const empty = { ...valid, body: '   ' }
  await assert.rejects(createComment(config, board, empty), { code: 'empty_comment' })
  await assert.rejects(createComment(config, board, { ...empty, images: [], drawing: { shapes: [] } }), { code: 'empty_comment' })
  await assert.rejects(createComment(config, board, { ...empty, drawing: null }), { code: 'empty_comment' })
  // Media that does not validate never lets an empty comment through.
  await assert.rejects(createComment(config, board, { ...empty, drawing: { shapes: [{ tool: 'star' }] } }), { code: 'invalid_drawing' })
  assert.equal(listComments(config, board.id).length, 0)

  const drawn = await createComment(config, board, { ...empty, drawing: { shapes: [box] } })
  assert.equal(drawn.body, '')
  assert.equal(drawn.drawing.shapes.length, 1)
  const pictured = await createComment(config, board, { ...valid, body: undefined, images: [image, image] })
  assert.equal(pictured.body, '')

  await assert.rejects(addReply(config, board.id, drawn.id, { body: '' }), { code: 'empty_comment' })
  const { reply } = await addReply(config, board.id, drawn.id, { body: '', drawing: { shapes: [arrow] } })
  assert.equal(reply.body, '')
  const both = await addReply(config, board.id, drawn.id, { body: '\n', images: [image], drawing: { shapes: [box] } })
  assert.equal(both.reply.images.length, 1)

  // An edit may empty the text of a comment with media, never of one without.
  const worded = await createComment(config, board, { ...valid, drawing: { shapes: [box] } })
  assert.equal((await updateComment(config, board.id, worded.id, { body: '' })).body, '')
  const plain = await createComment(config, board, valid)
  await assert.rejects(updateComment(config, board.id, plain.id, { body: ' ' }), { code: 'empty_comment' })

  // One stand-in everywhere a line of text is needed.
  assert.equal(mediaLabel(drawn), '(drawing)')
  assert.equal(mediaLabel(pictured), '(2 images)')
  assert.equal(mediaLabel(both.reply), '(image and drawing)')
  assert.equal(mediaLabel(plain), '')
  assert.equal(commentText(plain), 'Look at this')
  assert.equal(commentText({ body: ' ', images: [{}] }), '(image)')
  assert.equal(hasCommentMedia({ drawing: { shapes: 2 } }), true, "the CLI item's drawing is a count")
  assert.equal(hasCommentMedia({ images: [], drawing: { shapes: [] } }), false)

  const item = feedback(config, { boardId: board.id }).comments.find((entry) => entry.id === drawn.id)
  assert.equal(item.body, '', 'JSON keeps the text as it is')
  const lines = formatFeedbackItem(item, { cwd: folder })
  assert.equal(lines[1], '    (drawing)')
  assert.ok(lines.includes('    > anonymous: (drawing)'))
  assert.ok(lines.includes('    > anonymous: (image and drawing)'))
  const second = formatFeedbackItem(feedbackItem(feedbackContext(config, board), pictured), { cwd: folder })
  assert.equal(second[1], '    (2 images)')

  assert.equal(commentSummary(getComment(config, board.id, drawn.id)).body, '(drawing)')
  const told = summarize(
    config,
    { type: 'comment.replied', boardId: board.id, comment: getComment(config, board.id, drawn.id), reply },
    'http://localhost:4810',
  )
  assert.match(told.quote, /\(drawing\)/)
})
