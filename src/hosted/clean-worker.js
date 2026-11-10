// Worker thread for cleaning pushed files (src/hosted/cleaner.js): decoding
// and re-encoding a PNG, or sanitizing live HTML, takes CPU time that must
// not block the server's event loop.

import { parentPort } from 'node:worker_threads'
import { cleanHtml, cleanPng, PushError } from './push.js'

parentPort.on('message', ({ id, kind, body, base }) => {
  try {
    const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    const clean = kind === 'html' ? cleanHtml(buffer, { baseUrl: base }) : cleanPng(buffer)
    const out = new Uint8Array(clean.buffer, clean.byteOffset, clean.byteLength)
    parentPort.postMessage({ id, ok: true, body: out })
  } catch (error) {
    const known = error instanceof PushError
    parentPort.postMessage({
      id,
      ok: false,
      status: known ? error.statusCode : 500,
      code: known ? error.code : 'clean_failed',
      message: known ? error.message : 'The file could not be cleaned.',
    })
  }
})
