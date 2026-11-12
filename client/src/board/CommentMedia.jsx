// Images and drawings on comments, in the board: the composer's attach
// button, thumbnails and drawing tools; the thread's thumbnails and their
// lightbox; the drawing over a page frame (being made, or of the open
// thread); and the phone's full-sheet page to draw on.
import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Brush, ChevronLeft, ChevronRight, ImagePlus, Loader2, Square, Trash2, Undo2, X } from 'lucide-react'
import { Button, Dialog, IconButton, Tooltip } from '../components/ui'
import { KeyTip } from './KeyTip'
import { commentFileUrl } from '../lib/api'
import { cn } from '../lib/utils'
import { COMMENT_IMAGES_MAX, IMAGE_ACCEPT, imagesFrom } from './commentImages'
import { DRAWING_INKS, INK_LABELS, drawing, finishShape, pointIn, shapePaths, useDrawing } from './drawing'

// `start`: what a click on the tool does from a composer or a reply box.
const TOOLS = [
  { id: 'box', label: 'Box', start: 'Draw a box on the page', icon: Square },
  { id: 'arrow', label: 'Arrow', start: 'Draw an arrow on the page', icon: ArrowUpRight },
  { id: 'pen', label: 'Pen', start: 'Draw freehand on the page', icon: Brush },
]
const INK_CLASS = { accent: 'bg-accent', bad: 'bg-bad', warn: 'bg-warn' }
const INK_STROKE = { accent: 'var(--accent)', bad: 'var(--bad)', warn: 'var(--warn)' }

// ---- Drawing ------------------------------------------------------------------

// Shapes in a box of `width` x `height` (the frame's native size, so a line
// is as wide as on the page at any zoom); `crop` (native pixels) shows only
// that part of the frame. Never takes a pointer.
export function DrawingSvg({ shapes, width, height, crop = null, className, ...props }) {
  if (!shapes?.length) return null
  const view = crop ? `${crop.left} ${crop.top} ${crop.width} ${crop.height}` : `0 0 ${width} ${height}`
  return (
    <svg
      className={cn('pointer-events-none absolute inset-0 h-full w-full', crop ? 'overflow-hidden' : 'overflow-visible', className)}
      viewBox={view}
      preserveAspectRatio="none"
      aria-hidden="true"
      {...props}
    >
      {shapes.map((shape, index) =>
        shapePaths(shape, width, height).map((d, part) => (
          <path
            key={`${index}-${part}`}
            d={d}
            fill="none"
            stroke={INK_STROKE[shape.ink] || INK_STROKE.accent}
            strokeWidth={shape.width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )),
      )}
    </svg>
  )
}

// Where a drawing tool draws: the whole of its box, pointer events (mouse,
// pen and touch alike; pressure ignored), never panning the canvas under it.
function DrawInput({ tool, ink, width, height, className, children }) {
  const [live, setLive] = useState(null)
  const points = useRef([])
  const box = useRef(null)
  const point = (event) => pointIn(box.current.getBoundingClientRect(), event)
  // While a stroke is being made the drawing bar fades back and lets the
  // pointer through (DrawBar), so the pen can cross the strip it sits on.
  useEffect(() => () => drawing.set({ stroking: false }), [])
  const end = (event, keep) => {
    if (!points.current.length) return
    drawing.set({ stroking: false })
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const shape = keep ? finishShape(tool, ink, points.current) : null
    points.current = []
    setLive(null)
    if (shape) drawing.add(shape)
  }
  return (
    <div
      ref={box}
      className={cn('nodrag nopan absolute inset-0 z-[25] cursor-crosshair touch-none select-none', className)}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        drawing.set({ stroking: true })
        points.current = [point(event)]
        setLive({ tool, ink, width: 4, points: [points.current[0], points.current[0]] })
      }}
      onPointerMove={(event) => {
        if (!points.current.length) return
        event.stopPropagation()
        const next = point(event)
        if (tool === 'pen') points.current.push(next)
        else points.current = [points.current[0], next]
        setLive({ tool, ink, width: 4, points: tool === 'pen' ? [...points.current] : points.current })
      }}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      // The click that ends a stroke never drops a new pin.
      onClick={(event) => event.stopPropagation()}
      data-sw-draw-input={tool}
    >
      {children}
      {live ? <DrawingSvg shapes={[live]} width={width} height={height} /> : null}
    </div>
  )
}

// Over a page frame on the canvas: the drawing being made on it (with the
// tool's input layer while a tool is on), else the open or hovered thread's
// drawing when it was made on this capture.
export function FrameDrawing({ frameKey, native, shown }) {
  const mine = useDrawing((value) => (value?.key === frameKey ? value : null))
  if (!mine && !shown?.shapes.length) return null
  return (
    <>
      {shown?.shapes.length ? (
        <DrawingSvg shapes={shown.shapes} width={native.width} height={native.height} className="z-[6]" data-sw-drawing={shown.id} />
      ) : null}
      {mine ? (
        <DrawingSvg shapes={mine.shapes} width={native.width} height={native.height} className="z-[6]" data-sw-drawing="draft" />
      ) : null}
      {mine?.tool ? <DrawInput tool={mine.tool} ink={mine.ink} width={native.width} height={native.height} /> : null}
    </>
  )
}

// Escape while a tool is on turns the tool off first (comment mode and the
// composer stay); a second Escape does what it always did.
function useEscapeLeavesTool(active) {
  useEffect(() => {
    if (!active) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      drawing.set({ tool: null })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])
}

// A drawing tool's button: with a tooltip for the mouse; on touch screens
// (no hover, and a tap would leave the tip up) only its accessible name.
// `narrow`: a slimmer button, so a whole row of tools fits on one line.
function ToolButton({ touch, label, tooltip, narrow, className, ...props }) {
  // Touch: every tool and ink is a full 44 by 44 px target (the row wraps to two lines, DrawTools).
  if (touch) return <Button variant="ghost" size="icon" aria-label={label} className={className} {...props} />
  return <IconButton size="icon-sm" label={label} tooltip={tooltip} className={cn(narrow ? 'w-6' : 'w-7', className)} {...props} />
}

const Divider = ({ touch }) => <span className={cn('h-4 w-px shrink-0 bg-line', touch ? 'mx-1' : 'mx-0.5')} aria-hidden="true" />

// Box, Arrow, Pen, the inks, Undo and Clear for the drawing of `owner`, on
// one line. `onTool` hears a tool being picked (the phone opens its sheet
// then); `leading` sits first in the row (the composer's attach button).
// `compact` (a composer or reply box): only the tools until a tool is
// picked or a shape is drawn. `showCount` false: the count shows elsewhere.
// `bar`: the drawing bar itself, where a tool is always on (its tooltips
// name the tool; in a composer they say what a click starts).
export function DrawTools({ owner, touch, onTool = null, leading = null, compact = false, showCount = true, bar = false, className }) {
  const mine = useDrawing((value) => (value?.owner === owner ? value : null))
  useEscapeLeavesTool(Boolean(mine?.tool))
  const count = mine?.shapes.length || 0
  const full = !compact || Boolean(mine?.tool) || count > 0
  return (
    <div
      // Touch (the phone's drawing sheet): two lines on purpose, the tools
      // on the first, the inks with Undo and Clear on the second, so every
      // button keeps its 44 px.
      className={cn('flex min-w-0 items-center', touch ? 'flex-wrap gap-y-0.5' : 'flex-nowrap', className)}
      role="group"
      aria-label="Draw on the page"
      data-sw-draw-tools={owner}
    >
      {leading ? (
        <>
          {leading}
          <Divider touch={touch} />
        </>
      ) : null}
      {compact && !full ? (
        // Nothing drawn yet: say what these three buttons start.
        <span className="shrink-0 pr-1 pl-0.5 text-caption text-faint" aria-hidden="true" data-sw-draw-label="true">
          Draw
        </span>
      ) : null}
      {TOOLS.map((tool) => {
        const on = mine?.tool === tool.id
        return (
          <ToolButton
            key={tool.id}
            touch={touch}
            variant={on ? 'soft' : 'ghost'}
            aria-pressed={on}
            className={cn(on && 'ring-1 ring-accent/50')}
            label={on ? `${tool.label}: on. Draw on the page, Esc stops` : tool.start}
            tooltip={bar || on ? tool.label : tool.start}
            onClick={() => {
              drawing.set({ tool: on ? null : tool.id })
              if (!on) onTool?.(tool.id)
            }}
            data-sw-draw-tool={tool.id}
          >
            <tool.icon size={15} aria-hidden="true" />
          </ToolButton>
        )
      })}
      {full ? (
        <>
          {touch ? <span className="h-0 basis-full" aria-hidden="true" data-sw-draw-tools-break="true" /> : <Divider touch={touch} />}
          {DRAWING_INKS.map((ink) => {
            const on = (mine?.ink || DRAWING_INKS[0]) === ink
            return (
              <ToolButton
                key={ink}
                touch={touch}
                narrow
                aria-pressed={on}
                label={`${INK_LABELS[ink]} ink`}
                tooltip={`${INK_LABELS[ink]} ink`}
                onClick={() => drawing.set({ ink })}
                data-sw-draw-ink={ink}
              >
                <span
                  className={cn(
                    'block h-3.5 w-3.5 rounded-full',
                    INK_CLASS[ink],
                    on ? 'ring-2 ring-fg ring-offset-1 ring-offset-surface' : '',
                  )}
                  aria-hidden="true"
                />
              </ToolButton>
            )
          })}
          <Divider touch={touch} />
          <ToolButton
            touch={touch}
            label="Undo the last shape"
            tooltip="Undo"
            disabled={!count}
            onClick={() => drawing.undo()}
            data-sw-draw-undo="true"
          >
            <Undo2 size={15} aria-hidden="true" />
          </ToolButton>
          <ToolButton
            touch={touch}
            label="Clear the drawing"
            tooltip="Clear"
            disabled={!count}
            onClick={() => drawing.clear()}
            data-sw-draw-clear="true"
          >
            <Trash2 size={15} aria-hidden="true" />
          </ToolButton>
        </>
      ) : null}
      {showCount && count ? <ShapeCount count={count} className="ml-auto pl-1" /> : null}
    </div>
  )
}

export function ShapeCount({ count, className }) {
  return (
    <span
      className={cn('shrink-0 text-caption whitespace-nowrap text-faint tabular-nums', className)}
      aria-live="polite"
      data-sw-draw-count={count}
    >
      {count} {count === 1 ? 'shape' : 'shapes'}
    </span>
  )
}

// Desktop, while a tool is on: the composer or thread steps aside and this
// bar, docked at the top of the canvas, says what is going on ("Drawing on
// Home · Desktop") and holds the tools. Done (or Escape) goes one step back:
// the composer or the reply box, with its text, images and the drawing.
// The bar can sit over the top of the page being drawn on (the camera is
// not moved for it), so it never blocks the pen: only its buttons take the
// pointer, a stroke can start on its label or between its buttons, and
// while a stroke is being made the whole bar fades back and lets go.
export function DrawBar({ owner, title }) {
  const back = owner === 'composer' ? 'your comment' : 'your reply'
  const stroking = useDrawing((value) => Boolean(value?.stroking))
  return (
    <div
      className={cn(
        'pointer-events-none flex max-w-full items-center gap-2 rounded-xl border border-accent/50 bg-surface py-1 pr-1 pl-3 shadow-pop ring-2 ring-accent/15 transition-opacity duration-(--motion-fast) motion-reduce:transition-none',
        stroking ? 'opacity-25 [&_button]:pointer-events-none' : '[&_button]:pointer-events-auto',
      )}
      data-sw-draw-bar-stroking={stroking ? 'true' : undefined}
      role="toolbar"
      aria-label={title ? `Drawing on ${title}` : 'Drawing on the page'}
      data-sw-draw-bar={owner}
    >
      <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-fg" data-sw-draw-bar-title="true">
        <Brush size={14} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="truncate">{title ? `Drawing on ${title}` : 'Drawing on the page'}</span>
      </p>
      <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      <DrawTools owner={owner} touch={false} bar />
      <Tooltip content={<KeyTip label={`Back to ${back}`} keys={['Esc']} />} side="bottom">
        <Button
          size="xs"
          variant="default"
          className="ml-1 shrink-0 px-3"
          onClick={() => drawing.set({ tool: null })}
          aria-label={`Done drawing: back to ${back}`}
          data-sw-draw-bar-done="true"
        >
          Done
        </Button>
      </Tooltip>
    </div>
  )
}

// Phones: the page in a full sheet, to draw on with a finger.
export function DrawSheet({ open, onClose, owner, src, native, title }) {
  const mine = useDrawing((value) => (value?.owner === owner ? value : null))
  useEffect(() => {
    if (open && mine && !mine.tool) drawing.set({ tool: 'box' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!native) return null
  const close = () => {
    drawing.set({ tool: null })
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Draw on the page"
      description={title}
      size="lg"
      className="max-h-[100dvh] rounded-none sm:rounded-xl"
      footer={
        <div className="flex w-full items-center gap-3 sm:w-auto">
          {mine?.shapes.length ? <ShapeCount count={mine.shapes.length} /> : null}
          <Button size="touch" className="flex-1 sm:flex-none" onClick={close} data-sw-draw-done="true">
            Done
          </Button>
        </div>
      }
    >
      <div className="sticky top-0 z-10 border-b border-line bg-surface px-2 py-1">
        <DrawTools owner={owner} touch showCount={false} />
      </div>
      <div className="p-3">
        <div
          className="relative w-full overflow-hidden rounded-md border border-line bg-surface-2"
          style={{ aspectRatio: `${native.width} / ${native.height}` }}
          data-sw-draw-sheet="true"
        >
          {src ? (
            <img
              src={src}
              alt="The page this comment is on"
              className="block h-full w-full object-cover object-top select-none"
              draggable={false}
            />
          ) : null}
          <DrawingSvg shapes={mine?.shapes} width={native.width} height={native.height} />
          {mine?.tool ? <DrawInput tool={mine.tool} ink={mine.ink} width={native.width} height={native.height} /> : null}
        </div>
      </div>
    </Dialog>
  )
}

// ---- Images in the composer ----------------------------------------------------

// The attach button (with its hidden file picker) for `draft` (useImageDraft).
export function AttachButton({ draft, touch, disabled }) {
  const input = useRef(null)
  const full = draft.images.length >= COMMENT_IMAGES_MAX
  return (
    <>
      <IconButton
        size={touch ? 'icon' : 'icon-sm'}
        className={touch ? undefined : 'w-7'}
        label={full ? `Attach an image (${COMMENT_IMAGES_MAX} is the most)` : 'Attach an image'}
        tooltip={full ? `${COMMENT_IMAGES_MAX} images is the most` : 'Attach an image (or paste one)'}
        disabled={disabled || full}
        onClick={() => input.current?.click()}
        data-sw-attach-image="true"
      >
        <ImagePlus size={16} aria-hidden="true" />
      </IconButton>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          draft.add(event.target.files)
          event.target.value = ''
        }}
        data-sw-attach-input="true"
      />
    </>
  )
}

// Paste and drop onto a composer add images (text pastes stay text).
export function imageDropProps(draft, enabled) {
  if (!enabled) return {}
  return {
    onPaste: (event) => {
      const files = imagesFrom(event.clipboardData)
      if (!files.length) return
      event.preventDefault()
      draft.add(files)
    },
    onDragOver: (event) => {
      if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault()
    },
    onDrop: (event) => {
      const files = imagesFrom(event.dataTransfer)
      if (!files.length) return
      event.preventDefault()
      draft.add(files)
    },
  }
}

export function ComposerImages({ draft, touch, id }) {
  if (!draft.images.length && !draft.error) return null
  return (
    <div className="space-y-1">
      {draft.images.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Images to attach" data-sw-composer-images={draft.images.length}>
          {draft.images.map((image) => (
            <li
              key={image.id}
              className={cn('relative overflow-hidden rounded-md border border-line bg-surface-2', touch ? 'h-16 w-16' : 'h-14 w-14')}
              data-sw-composer-image={image.state}
            >
              {image.preview ? (
                <img src={image.preview} alt={image.name} className="h-full w-full object-cover" draggable={false} />
              ) : (
                <span
                  className="flex h-full w-full items-center justify-center text-faint"
                  role="status"
                  aria-label={`Reading ${image.name}`}
                >
                  <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                </span>
              )}
              <button
                type="button"
                onClick={() => draft.remove(image.id)}
                className={cn(
                  'absolute top-0 right-0 flex items-center justify-center rounded-bl-md bg-black/60 text-white outline-none hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-accent',
                  touch ? 'h-7 w-7' : 'h-5 w-5',
                )}
                aria-label={`Remove ${image.name}`}
                data-sw-composer-image-remove={image.id}
              >
                <X size={touch ? 14 : 12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {draft.error ? (
        <p id={id} className="text-xs text-bad" role="alert" data-sw-image-error="true">
          {draft.error}
        </p>
      ) : null}
    </div>
  )
}

// ---- Images in a thread ---------------------------------------------------------

// A message's images as thumbnails; a click opens them large (kit Dialog:
// focus moves in, Escape and Back close it, arrows step through).
export function MessageImages({ boardId, images, touch, label }) {
  const [open, setOpen] = useState(null)
  // Escape closes the lightbox, never the thread under it (the thread's
  // popover would otherwise take it as its own).
  useEffect(() => {
    if (open === null) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setOpen(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  if (!images?.length) return null
  const current = open === null ? null : images[open]
  const step = (by) => setOpen((index) => (index + by + images.length) % images.length)
  return (
    <>
      <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`${label}: images`} data-sw-message-images={images.length}>
        {images.map((image, index) => (
          <li key={image.file}>
            <button
              type="button"
              onClick={() => setOpen(index)}
              className={cn(
                'block overflow-hidden rounded-md border border-line bg-surface-2 outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent',
                touch ? 'h-16 w-16' : 'h-14 w-14',
              )}
              aria-label={`Open image ${index + 1} of ${images.length}: ${image.name}`}
              data-sw-message-image={image.file}
            >
              <img
                src={commentFileUrl(boardId, image.file)}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
                draggable={false}
              />
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={current !== null}
        onClose={() => setOpen(null)}
        title={current?.name || 'Image'}
        description={
          current ? `Image ${open + 1} of ${images.length}${current.width ? `, ${current.width} by ${current.height} pixels` : ''}` : ''
        }
        size="lg"
      >
        {current ? (
          <div
            className="flex flex-col items-center gap-3 p-4"
            onKeyDown={(event) => {
              if (images.length < 2) return
              if (event.key === 'ArrowRight') step(1)
              else if (event.key === 'ArrowLeft') step(-1)
              else return
              event.preventDefault()
            }}
            data-sw-lightbox={current.file}
          >
            <img
              src={commentFileUrl(boardId, current.file)}
              alt={current.name}
              className="max-h-[70dvh] max-w-full rounded-md border border-line bg-surface-2 object-contain"
              draggable={false}
            />
            {images.length > 1 ? (
              <div className="flex items-center gap-2">
                <IconButton size={touch ? 'icon' : 'icon-sm'} label="Previous image" onClick={() => step(-1)} data-sw-lightbox-prev="true">
                  <ChevronLeft size={16} aria-hidden="true" />
                </IconButton>
                <span className="text-caption text-muted tabular-nums">
                  {open + 1} of {images.length}
                </span>
                <IconButton size={touch ? 'icon' : 'icon-sm'} label="Next image" onClick={() => step(1)} data-sw-lightbox-next="true">
                  <ChevronRight size={16} aria-hidden="true" />
                </IconButton>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </>
  )
}
