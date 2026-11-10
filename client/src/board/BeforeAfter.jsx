import { useRef, useState } from 'react'
import { Columns2, SplitSquareHorizontal } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger, ToggleGroup } from '../components/ui'
import { cn } from '../lib/utils'
import { cropAround } from './flow'

// Two captures of the same frame, one over the other: drag the divider (or
// use the arrow keys on it) to wipe between before (left) and after (right).
// `before` and `after` render the same box; `children` lies on top of both.
export function CompareSlider({
  before,
  after,
  label = 'Before and after',
  beforeLabel = 'Before',
  afterLabel = 'After',
  className,
  children,
  ...props
}) {
  const [at, setAt] = useState(50)
  const box = useRef(null)
  const dragging = useRef(false)
  const moveTo = (clientX) => {
    const rect = box.current?.getBoundingClientRect()
    if (!rect?.width) return
    setAt(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }
  return (
    <div
      ref={box}
      className={cn('relative touch-pan-y overflow-hidden select-none', className)}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        dragging.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
        moveTo(event.clientX)
      }}
      onPointerMove={(event) => dragging.current && moveTo(event.clientX)}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      data-sw-compare-slider={Math.round(at)}
      {...props}
    >
      {/* Before first in the document (it reads first), drawn over after. */}
      <div className="absolute inset-0 z-[1]" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}>
        {before}
      </div>
      {after}
      <div className="pointer-events-none absolute inset-0 z-[2]">{children}</div>
      <span className="pointer-events-none absolute top-1.5 left-1.5 z-[3] rounded bg-black/60 px-1.5 text-[10px] leading-4 font-medium text-white">
        {beforeLabel}
      </span>
      <span className="pointer-events-none absolute top-1.5 right-1.5 z-[3] rounded bg-black/60 px-1.5 text-[10px] leading-4 font-medium text-white">
        {afterLabel}
      </span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(at)}
        aria-valuetext={`${Math.round(at)}% ${beforeLabel.toLowerCase()}`}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 20 : 5
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') setAt((value) => Math.max(0, value - step))
          else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') setAt((value) => Math.min(100, value + step))
          else if (event.key === 'Home') setAt(0)
          else if (event.key === 'End') setAt(100)
          else return
          event.preventDefault()
          event.stopPropagation()
        }}
        className="group absolute inset-y-0 z-[3] w-8 -translate-x-1/2 cursor-ew-resize outline-none"
        style={{ left: `${at}%` }}
        data-sw-compare-handle="true"
      >
        <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" />
        <span className="absolute top-1/2 left-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-pop group-focus-visible:ring-2 group-focus-visible:ring-accent">
          <SplitSquareHorizontal size={13} aria-hidden="true" />
        </span>
      </div>
    </div>
  )
}

// The image of one side, cropped around the pin (or the whole frame).
function Frame({ url, native, crop, label, comment, onImageError }) {
  const box = crop || { left: 0, top: 0, width: native.width, height: native.height }
  if (!url) return <div className="h-full w-full bg-surface-2" />
  return (
    <img
      src={url}
      alt={`${label}: ${comment.viewport} capture`}
      draggable={false}
      onError={onImageError}
      className={cn('block max-w-none select-none', crop ? 'absolute' : 'w-full')}
      style={
        crop
          ? {
              width: `${(native.width / box.width) * 100}%`,
              left: `${(-box.left / box.width) * 100}%`,
              top: `${(-box.top / box.height) * 100}%`,
            }
          : undefined
      }
    />
  )
}

// A ring where the comment was.
function Ring({ native, crop, comment }) {
  if (!crop) return null
  const ringX = ((native.width * comment.x) / 100 - crop.left) / crop.width
  const ringY = ((native.height * comment.y) / 100 - crop.top) / crop.height
  if (ringX < 0 || ringX > 1 || ringY < 0 || ringY > 1) return null
  return (
    <span
      className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent shadow-pop"
      style={{ left: `${ringX * 100}%`, top: `${ringY * 100}%` }}
      aria-hidden="true"
    />
  )
}

// One side on its own, with its caption.
function Shot({ url, native, crop, comment, label, onImageError }) {
  const box = crop || { left: 0, top: 0, width: native.width, height: native.height }
  return (
    <figure className="min-w-0 flex-1">
      <figcaption className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{label}</figcaption>
      <div
        className={cn('relative w-full overflow-hidden rounded-md border border-line bg-surface-2', !crop && 'max-h-80 overflow-y-auto')}
        style={crop ? { aspectRatio: `${box.width} / ${box.height}` } : undefined}
      >
        <Frame url={url} native={native} crop={crop} label={label} comment={comment} onImageError={onImageError} />
        <Ring native={native} crop={crop} comment={comment} />
      </div>
    </figure>
  )
}

const VIEWS = [
  { id: 'near', label: 'Near the pin' },
  { id: 'whole', label: 'Whole frame' },
]
const LAYOUTS = [
  {
    id: 'slider',
    label: (
      <>
        <SplitSquareHorizontal size={13} aria-hidden="true" />
        <span className="sr-only">Slider</span>
      </>
    ),
  },
  {
    id: 'split',
    label: (
      <>
        <Columns2 size={13} aria-hidden="true" />
        <span className="sr-only">Side by side</span>
      </>
    ),
  },
]
const SIDES = [
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
]

// Before and after of a resolved comment: on wide screens a slider over the
// two (or side by side); on phones one at a time, switched with the tabs or
// a swipe.
export default function BeforeAfter({ comment, pair, native, urlFor, touch, onImageError }) {
  const [view, setView] = useState('near')
  const [layout, setLayout] = useState('slider')
  const [side, setSide] = useState('after')
  const swipe = useRef(null)
  if (!pair || !native) return null
  if (!pair.before && !pair.after) return null
  if (!pair.after || !pair.before) {
    return (
      <p className="mt-2 rounded-md bg-surface-2 px-2 py-1.5 text-xs text-muted" data-sw-before-after={pair.reason}>
        {pair.reason === 'not-recaptured'
          ? 'Not recaptured since this comment. Recapture the page to see before and after.'
          : 'The capture this comment was made on is no longer kept, so there is no before to show.'}
      </p>
    )
  }
  const crop = view === 'near' ? cropAround(native, comment.x, comment.y) : null
  const box = crop || { left: 0, top: 0, width: native.width, height: native.height }
  const shared = { native, crop, comment, onImageError }
  const zoom = <ToggleGroup label="Zoom" options={VIEWS} value={view} onChange={setView} large={touch} className={touch ? 'flex-1' : ''} />
  if (!touch) {
    return (
      <div className="mt-2.5 space-y-2" data-sw-before-after="ready">
        <div className="flex items-center gap-2">
          {zoom}
          <span className="flex-1" />
          <ToggleGroup label="Layout" options={LAYOUTS} value={layout} onChange={setLayout} itemClassName="px-2" />
        </div>
        {layout === 'slider' ? (
          <div className={cn('rounded-md border border-line bg-surface-2', !crop && 'max-h-80 overflow-y-auto')}>
            <CompareSlider
              className="w-full"
              style={crop ? { aspectRatio: `${box.width} / ${box.height}` } : undefined}
              label={`Before and after comment ${comment.id}`}
              before={
                <div className="relative h-full w-full bg-surface-2">
                  <Frame url={urlFor(pair.before)} label="Before" {...shared} />
                </div>
              }
              after={
                <div className={cn('relative w-full bg-surface-2', crop && 'h-full')}>
                  <Frame url={urlFor(pair.after)} label="After" {...shared} />
                </div>
              }
            >
              <Ring native={native} crop={crop} comment={comment} />
            </CompareSlider>
          </div>
        ) : (
          <div className="flex gap-2">
            <Shot url={urlFor(pair.before)} label="Before" {...shared} />
            <Shot url={urlFor(pair.after)} label="After" {...shared} />
          </div>
        )}
      </div>
    )
  }
  const before = <Shot url={urlFor(pair.before)} label="Before" {...shared} />
  const after = <Shot url={urlFor(pair.after)} label="After" {...shared} />
  // Phones: one side at a time, as tabs (or a swipe).
  return (
    <Tabs value={side} onValueChange={setSide} className="mt-2.5 space-y-2" data-sw-before-after="ready">
      <div className="flex flex-wrap items-center gap-2">
        <TabsList aria-label="Show" className="flex-1">
          {SIDES.map((item) => (
            <TabsTrigger key={item.id} value={item.id} large>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {zoom}
      </div>
      <div
        onTouchStart={(event) => {
          swipe.current = event.touches[0]?.clientX ?? null
        }}
        onTouchEnd={(event) => {
          const start = swipe.current
          const end = event.changedTouches[0]?.clientX
          swipe.current = null
          if (start === null || end === undefined || Math.abs(end - start) < 40) return
          setSide(end < start ? 'after' : 'before')
        }}
        data-sw-before-after-side={side}
      >
        <TabsContent value="before">{before}</TabsContent>
        <TabsContent value="after">{after}</TabsContent>
      </div>
    </Tabs>
  )
}
