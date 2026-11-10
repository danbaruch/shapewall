// Integrity of the files the natural voice downloads from Hugging Face: each
// one is pinned to its published size and SHA-256 (voices.js), and checked
// before it is kept in the Cache API or handed to ONNX Runtime. Runs in the
// worker and in Node tests (both have crypto.subtle).

export const INTEGRITY_CODE = 'integrity'

export class IntegrityError extends Error {
  constructor(name, detail) {
    super(`${name} did not match the published file (${detail}), so it was not kept.`)
    this.name = 'IntegrityError'
    this.code = INTEGRITY_CODE
  }
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

export async function sha256(buffer) {
  return hex(await globalThis.crypto.subtle.digest('SHA-256', buffer))
}

// Throws IntegrityError unless buffer is exactly the pinned file.
export async function verifyBytes(buffer, pin, name = 'A downloaded file') {
  if (!pin) throw new IntegrityError(name, 'no pinned hash')
  if (buffer.byteLength !== pin.bytes) throw new IntegrityError(name, `${buffer.byteLength} bytes, expected ${pin.bytes}`)
  const digest = await sha256(buffer)
  if (digest !== pin.sha256) throw new IntegrityError(name, 'SHA-256 differs')
  return buffer
}
