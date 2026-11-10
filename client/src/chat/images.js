// Images for the chat: files the person picks, pastes or drops, and crops of
// the board's own screenshots (a page, or the area around a comment's pin).
// Everything becomes { id, name, mediaType, data (base64), preview, source? }.

export const ATTACH_MAX = 4
const BYTES_MAX = 5 * 1024 * 1024
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
// Long edge of a page screenshot sent to the model.
const PAGE_EDGE_MAX = 1600

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function fromBlob(blob, name, source = null) {
  const preview = await readAsDataUrl(blob)
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    mediaType: blob.type,
    data: preview.split(',')[1],
    preview,
    source,
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The image could not be loaded.'))
    image.src = src
  })
}

function draw(image, rect, edgeMax, type = 'image/png') {
  const scale = Math.min(1, edgeMax / Math.max(rect.width, rect.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.width * scale))
  canvas.height = Math.max(1, Math.round(rect.height * scale))
  canvas.getContext('2d').drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not crop the screenshot.'))), type, 0.9),
  )
}

// A file from the picker, a paste or a drop. Large photos are re-encoded.
export async function fromFile(file) {
  const label = file.name || 'That image'
  if (!TYPES.includes(file.type)) throw new Error(`${label} is not a PNG, JPEG, WebP or GIF image.`)
  if (file.size <= BYTES_MAX) return fromBlob(file, file.name || 'pasted-image.png')
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const blob = await draw(image, { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }, 2048, 'image/jpeg')
    if (blob.size > BYTES_MAX) throw new Error(`${label} is larger than 5 MB.`)
    return fromBlob(blob, `${(file.name || 'image').replace(/\.\w+$/, '')}.jpg`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

// The screenshot of a page (`url` is its capture image), or with `point`
// ({ x, y } in percent) a 900 x 700 crop around it, like the MCP server's.
export async function cropCapture(url, { name, point = null, source }) {
  const image = await loadImage(url)
  const width = image.naturalWidth
  const height = image.naturalHeight
  let rect = { x: 0, y: 0, width, height }
  if (point) {
    const w = Math.min(width, 900)
    const h = Math.min(height, 700)
    const cx = (point.x / 100) * width
    const cy = (point.y / 100) * height
    rect = {
      x: Math.round(Math.min(Math.max(0, cx - w / 2), width - w)),
      y: Math.round(Math.min(Math.max(0, cy - h / 2), height - h)),
      width: w,
      height: h,
    }
  }
  const blob = await draw(image, rect, point ? 900 : PAGE_EDGE_MAX, point ? 'image/png' : 'image/jpeg')
  return fromBlob(blob, name, source)
}

export function imageFiles(list) {
  return [...(list || [])].filter((file) => file.type?.startsWith('image/'))
}
