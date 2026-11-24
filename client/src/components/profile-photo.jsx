import { useRef, useState } from 'react'
import { Camera, Trash2 } from 'lucide-react'
import { Avatar, Button, Spinner } from './ui'

// Upload only a small raster image. The server independently validates and
// reencodes the PNG; a browser conversion is not a trust boundary.
// `maxBytes`, `maxLabel`: the largest file taken (an agent's icon is 2 MB).
export async function profilePng(file, { maxBytes = 5 * 1024 * 1024, maxLabel = '5 MB' } = {}) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.')
  if (file.size > maxBytes) throw new Error(`Choose an image smaller than ${maxLabel}.`)
  let bitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    if (!bitmap.width || !bitmap.height) throw new Error('empty image')
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no canvas')
    const side = Math.min(bitmap.width, bitmap.height)
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
    return canvas.toDataURL('image/png').split(',')[1]
  } catch {
    throw new Error('This image could not be read. Try another PNG, JPEG or WebP image.')
  } finally {
    bitmap?.close()
  }
}

export function ProfilePhoto({ name, avatarUrl, transport, onSaved }) {
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const change = async (file) => {
    if (!file) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const png = await profilePng(file)
      await transport.put('/auth/me/avatar', { png })
      await onSaved()
      setStatus('Profile photo saved.')
    } catch (caught) {
      setError(caught.message || 'The profile photo could not be saved.')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  const remove = async () => {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await transport.delete('/auth/me/avatar')
      await onSaved()
      setStatus('Profile photo removed.')
    } catch (caught) {
      setError(caught.message || 'The profile photo could not be removed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 border-b border-line px-4 py-4 sm:px-5" data-sw-profile-photo>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={name} src={avatarUrl} className="h-16 w-16 text-lg" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-fg">Profile photo</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              variant="secondary"
              className="lg:h-9"
              disabled={busy}
              onClick={() => input.current?.click()}
              data-sw-profile-photo-upload
            >
              {busy ? <Spinner /> : <Camera size={15} aria-hidden="true" />} Upload photo
            </Button>
            {avatarUrl ? (
              <Button size="touch" variant="ghost" className="lg:h-9" disabled={busy} onClick={remove} data-sw-profile-photo-remove>
                <Trash2 size={15} aria-hidden="true" /> Remove photo
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted">PNG, JPEG or WebP, up to 5 MB. Cropped to a square.</p>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Choose profile photo"
        onChange={(event) => void change(event.target.files?.[0])}
        data-sw-profile-photo-file
      />
      {error ? (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted" role="status">
        {status}
      </p>
    </div>
  )
}
