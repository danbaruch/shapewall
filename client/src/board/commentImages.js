// Images on a comment or reply being written: picked, pasted or dropped,
// checked here with the server's limits (src/comment-fields.js, the chat's
// own), then sent as base64 with the comment. Built on the chat's image
// helpers (chat/images.js). Photos (JPEG) are redrawn on a canvas first, so
// their camera orientation is applied and their metadata never leaves this
// browser; the server strips it again either way (src/comment-media.js).
import { useCallback, useRef, useState } from 'react'
import { COMMENT_IMAGES_MAX, COMMENT_IMAGE_BYTES_MAX, COMMENT_IMAGE_TYPES } from '../../../src/comment-fields.js'
import { fromFile } from '../chat/images'

export { COMMENT_IMAGES_MAX }
export const IMAGE_ACCEPT = Object.keys(COMMENT_IMAGE_TYPES).join(',')
const MB = COMMENT_IMAGE_BYTES_MAX / 1048576
const PHOTO_EDGE_MAX = 2560

async function redrawJpeg(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const scale = Math.min(1, PHOTO_EDGE_MAX / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('The photo could not be read.'))), 'image/jpeg', 0.9),
    )
    return new File([blob], file.name || 'photo.jpg', { type: 'image/jpeg' })
  } finally {
    bitmap.close?.()
  }
}

// One file as { id, name, mediaType, data, preview } or a thrown Error with
// a plain message.
export async function prepareImage(file) {
  const label = file.name ? `"${file.name}"` : 'That image'
  if (!COMMENT_IMAGE_TYPES[file.type]) throw new Error(`${label} is not a PNG, JPEG, WebP or GIF image.`)
  let source = file
  if (file.type === 'image/jpeg' && typeof createImageBitmap === 'function') {
    try {
      source = await redrawJpeg(file)
    } catch {
      throw new Error(`${label} could not be read as an image.`)
    }
  }
  const image = await fromFile(source).catch((error) => {
    throw new Error(error.message?.includes('5 MB') ? `${label} is larger than ${MB} MB.` : error.message || `${label} could not be read.`)
  })
  if ((image.data.length * 3) / 4 > COMMENT_IMAGE_BYTES_MAX) throw new Error(`${label} is larger than ${MB} MB.`)
  return image
}

export const imagesPayload = (images) =>
  images.filter((image) => image.state === 'ready').map(({ name, mediaType, data }) => ({ name, mediaType, data }))

// The images of one composer: add(files), remove(id), clear(), the list
// ({ id, name, preview, state: 'reading' | 'ready' }) and the latest error.
// `initial`: images to start with (a reply left unsent, replyDrafts.js).
export function useImageDraft({ enabled = true, max = COMMENT_IMAGES_MAX, initial = null } = {}) {
  const [images, setImages] = useState(() => (enabled && initial ? initial.slice(0, max) : []))
  const [error, setError] = useState(null)
  const count = useRef(0)
  count.current = images.length
  const add = useCallback(
    async (files) => {
      const list = [...(files || [])]
      if (!enabled || !list.length) return
      const room = max - count.current
      if (room <= 0) {
        setError(`A comment holds at most ${max} images.`)
        return
      }
      setError(
        list.length > room ? `Only ${room === 1 ? 'one more image fits' : `${room} more images fit`}: a comment holds ${max}.` : null,
      )
      for (const file of list.slice(0, room)) {
        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        count.current += 1
        setImages((current) => [...current, { id, name: file.name || 'pasted image', preview: null, state: 'reading' }])
        try {
          const image = await prepareImage(file)
          setImages((current) => current.map((item) => (item.id === id ? { ...image, id, state: 'ready' } : item)))
        } catch (failure) {
          count.current -= 1
          setImages((current) => current.filter((item) => item.id !== id))
          setError(failure.message)
        }
      }
    },
    [enabled, max],
  )
  const remove = useCallback((id) => {
    setImages((current) => current.filter((item) => item.id !== id))
    setError(null)
  }, [])
  const clear = useCallback(() => {
    setImages([])
    setError(null)
  }, [])
  return { images, error, setError, add, remove, clear, reading: images.some((image) => image.state === 'reading') }
}

// Images in a paste or a drop (files only, never text or HTML).
export function imagesFrom(transfer) {
  return [...(transfer?.files || [])].filter((file) => file.type?.startsWith('image/'))
}
