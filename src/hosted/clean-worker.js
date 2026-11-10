// Worker thread for cleaning pushed files (src/hosted/cleaner.js): decoding
// and re-encoding a PNG, or sanitizing live HTML, takes CPU time that must
// not block the server's event loop. Comment images ('comment-image', base
// = the media type) and markup renders ('markup', base = the drawing as
// JSON, body = the screenshot) run here too.

import { parentPort } from 'node:worker_threads'
import { CommentError } from '../comment-fields.js'
import { cleanCommentImage, renderMarkup } from '../comment-media.js'
import { cleanHtml, cleanPng, PushError } from './push.js'

function run(kind, buffer, base) {
  if (kind === 'html') return { clean: cleanHtml(buffer, { baseUrl: base }) }
  if (kind === 'comment-image') {
    const image = cleanCommentImage(buffer, base)
    return { clean: image.buffer, meta: { mediaType: image.mediaType, width: image.width, height: image.height } }
  }
  if (kind === 'markup') {
    const rendered = renderMarkup(buffer, JSON.parse(base))
    if (!rendered) throw new PushError(422, 'no_markup', 'The drawing could not be rendered.')
    return { clean: rendered.png }
  }
  return { clean: cleanPng(buffer) }
}

parentPort.on('message', ({ id, kind, body, base }) => {
  try {
    const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    const { clean, meta } = run(kind, buffer, base)
    const out = new Uint8Array(clean.buffer, clean.byteOffset, clean.byteLength)
    parentPort.postMessage({ id, ok: true, body: out, ...(meta ? { meta } : {}) })
  } catch (error) {
    const known = error instanceof PushError || error instanceof CommentError
    parentPort.postMessage({
      id,
      ok: false,
      status: known ? error.statusCode : 500,
      code: known ? error.code : 'clean_failed',
      message: known ? error.message : 'The file could not be cleaned.',
    })
  }
})
