import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, History as HistoryIcon, LocateFixed, MessageSquare, SplitSquareHorizontal } from 'lucide-react'
import { Badge, Button, CommentDot, Dialog, EmptyState, Toggle, ToggleGroup } from '../components/ui'
import { cn, formatRelative, shownTime } from '../lib/utils'
import { useImageDiff } from '../lib/imageDiff'
import { CompareSlider } from './BeforeAfter'
import { pageHistory } from './flow'
import { scrollBehavior } from '../lib/motion'

function stamp(at) {
  if (!at) return 'Unknown time'
  const date = new Date(shownTime(at))
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function diffText(diff) {
  if (diff.status === 'loading') return 'Finding changes…'
  if (diff.status === 'error') return 'Could not compare these captures.'
  if (diff.status !== 'ok') return ''
  return diff.changed ? `${diff.percent}% changed` : 'No pixel changes'
}

// Where the first changed pixel is, as a fraction of the height (0..1), read
// from the diff mask (transparent except the changes). Null: none, or it
// could not be read.
const changeCache = new Map()
function firstChange(maskUrl) {
  if (!changeCache.has(maskUrl)) {
    const job = (async () => {
      const image = new Image()
      image.src = maskUrl
      await image.decode()
      // A narrow copy is plenty to find the first changed row.
      const width = Math.min(160, image.naturalWidth)
      const height = Math.max(1, Math.round((image.naturalHeight * width) / image.naturalWidth))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(image, 0, 0, width, height)
      const { data } = context.getImageData(0, 0, width, height)
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3] > 0) return y / height
      return null
    })().catch(() => null)
    changeCache.set(maskUrl, job)
  }
  return changeCache.get(maskUrl)
}

function useFirstChange(diff) {
  const url = diff.status === 'ok' && diff.changed ? diff.url : null
  const [found, setFound] = useState({ url: null, at: null })
  useEffect(() => {
    if (!url) return undefined
    let live = true
    firstChange(url).then((at) => live && setFound({ url, at }))
    return () => {
      live = false
    }
  }, [url])
  return url && found.url === url ? found.at : null
}

// Scrolls a pane so a fraction of its content height sits near the top.
function scrollToFraction(element, at) {
  if (!element || at === null) return
  element.scrollTo({ top: Math.max(0, at * element.scrollHeight - 48), behavior: scrollBehavior() })
}

// Narrow captures stay near their real width instead of filling the dialog.
const PANE_WIDTH = { phone: 'max-w-[400px]', tablet: 'max-w-[600px]' }

function Side({ label, entry, urlFor, page, viewport, diff = null, onImageError, paneRef, onScroll }) {
  return (
    <figure className={cn('mx-auto w-full min-w-0 flex-1', PANE_WIDTH[viewport])} data-sw-history-side={entry.version}>
      <figcaption className="mb-1.5 flex items-baseline gap-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">
        {label}
        <span className="truncate font-normal tracking-normal normal-case">
          {entry.current ? 'current capture' : stamp(entry.at)} · {formatRelative(entry.at)}
        </span>
      </figcaption>
      <div ref={paneRef} onScroll={onScroll} className="relative max-h-[52dvh] overflow-y-auto rounded-md border border-line bg-surface-2">
        <img
          src={urlFor(entry, false)}
          alt={`${page} ${viewport}, ${entry.current ? 'current capture' : `captured ${stamp(entry.at)}`}`}
          className="block w-full select-none"
          draggable={false}
          onError={onImageError}
        />
        {diff?.url ? (
          <img
            src={diff.url}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-x-0 top-0 block w-full opacity-80 select-none"
            data-sw-history-diff-overlay="true"
          />
        ) : null}
      </div>
    </figure>
  )
}

const LAYOUTS = [
  {
    id: 'split',
    label: (
      <>
        <Columns2 size={13} aria-hidden="true" /> Side by side
      </>
    ),
  },
  {
    id: 'slider',
    label: (
      <>
        <SplitSquareHorizontal size={13} aria-hidden="true" /> Slider
      </>
    ),
  },
]
const PHONE_LAYOUTS = [
  { id: 'before', label: 'Earlier' },
  { id: 'after', label: 'Current' },
  { id: 'slider', label: 'Slider' },
]

// Page history: every kept capture of one page at one viewport, newest
// first, as a strip of thumbnails. Pick an older one to compare it with the
// current capture: side by side (scrolling together) or under a slider (on
// phones one at a time, or the slider), with the changed pixels laid over
// the current one, a jump to the first change, and the comments made on
// each version.
export default function HistoryDialog({ open, onClose, page, viewport, data, comments, urlFor, onPickComment, touch, onImageError }) {
  const history = useMemo(
    () =>
      page ? pageHistory({ pageId: page.id, viewport, manifest: data?.manifest, captures: data?.captures, versions: data?.versions }) : [],
    [data?.captures, data?.manifest, data?.versions, page, viewport],
  )
  const [pickedFor, setPickedFor] = useState(null)
  const [layout, setLayout] = useState(touch ? 'before' : 'split')
  const key = `${page?.id}|${viewport}`
  const picked = pickedFor?.key === key ? pickedFor.version : null
  const current = history.find((entry) => entry.current) || history[0] || null
  const before = history.find((entry) => entry.version === picked) || history.find((entry) => entry !== current) || null
  const [showDiff, setShowDiff] = useState(true)
  const diff = useImageDiff(before ? urlFor(before, false) : null, current ? urlFor(current, false) : null, showDiff && before !== current)
  const changeAt = useFirstChange(diff)
  // A capture that is gone (the board was recaptured or redeployed since it
  // loaded): the board refetches its data once.
  useEffect(() => {
    if (open && diff.status === 'error') onImageError?.()
  }, [diff.status, onImageError, open])
  const onVersion = (version) => (comments || []).filter((comment) => comment.captureVersion === version)

  // Side by side, the two panes scroll together; both go to the first change
  // once it is known (and again from "Jump to the change").
  const panes = useRef({ before: null, after: null, slider: null })
  const syncing = useRef(false)
  const follow = (from, to) => () => {
    if (syncing.current) return
    const source = panes.current[from]
    const target = panes.current[to]
    if (!source || !target) return
    syncing.current = true
    target.scrollTop = source.scrollTop
    window.requestAnimationFrame(() => {
      syncing.current = false
    })
  }
  const jump = () => {
    for (const pane of Object.values(panes.current)) scrollToFraction(pane, changeAt)
  }
  const jumped = useRef(null)
  useEffect(() => {
    if (changeAt === null || jumped.current === `${key}|${before?.version}|${changeAt}`) return
    jumped.current = `${key}|${before?.version}|${changeAt}`
    const timer = window.setTimeout(() => {
      for (const pane of Object.values(panes.current)) scrollToFraction(pane, changeAt)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [before?.version, changeAt, key])

  const overlay = showDiff && diff.status === 'ok' ? diff : null
  const sliding = layout === 'slider'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={page ? `History: ${page.title}` : 'History'}
      description={page ? `${viewport} · ${history.length} capture${history.length === 1 ? '' : 's'} kept` : ''}
      size="lg"
    >
      <div className="space-y-3 p-4" data-sw-history={key}>
        {history.length < 2 ? (
          <EmptyState icon={HistoryIcon} title="No earlier captures yet">
            Each recapture keeps the previous shot, so the changes to this page show up here.
          </EmptyState>
        ) : (
          <>
            <ol className="flex gap-2.5 overflow-x-auto pb-1" aria-label="Captures, newest first" data-sw-history-strip="true">
              {history.map((entry, index) => {
                const count = onVersion(entry.version).length
                const isBefore = before?.version === entry.version
                return (
                  <li key={entry.version} className="shrink-0">
                    <button
                      type="button"
                      disabled={entry.current}
                      onClick={() => setPickedFor({ key, version: entry.version })}
                      aria-pressed={isBefore}
                      className={cn(
                        'group block w-36 rounded-lg border bg-surface p-1.5 text-left transition-colors disabled:cursor-default',
                        isBefore
                          ? 'border-accent ring-2 ring-accent/30'
                          : entry.current
                            ? 'border-line'
                            : 'border-line hover:border-faint hover:bg-surface-2',
                      )}
                      data-sw-history-version={entry.version}
                    >
                      <span className="relative block h-24 overflow-hidden rounded bg-surface-2">
                        <img
                          src={urlFor(entry, true)}
                          alt=""
                          className="block w-full"
                          draggable={false}
                          loading="lazy"
                          onError={onImageError}
                        />
                        {entry.current ? (
                          <Badge tone="solid" className="absolute top-1 left-1 shadow-card">
                            Current
                          </Badge>
                        ) : isBefore ? (
                          <Badge tone="accent" className="absolute top-1 left-1 bg-surface shadow-card">
                            Comparing
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-1.5 flex items-center gap-1 px-0.5">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">
                          {entry.current ? 'Current' : `Version ${history.length - index}`}
                        </span>
                        {count ? (
                          <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-accent tabular">
                            <MessageSquare size={11} aria-hidden="true" /> {count}
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate px-0.5 text-[11px] text-faint">{stamp(entry.at)}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                label="Compare"
                large={touch}
                value={layout}
                onChange={setLayout}
                className={touch ? 'w-full' : ''}
                itemClassName="inline-flex items-center justify-center gap-1.5"
                options={touch ? PHONE_LAYOUTS : LAYOUTS}
              />
              <Toggle
                size={touch ? 'touch' : 'sm'}
                pressed={showDiff}
                onPressedChange={setShowDiff}
                data-sw-history-diff={showDiff ? 'on' : 'off'}
              >
                Highlight changes
              </Toggle>
              {showDiff ? (
                <span className="text-xs text-muted tabular" role="status" data-sw-history-diff-status={diff.status}>
                  {diffText(diff)}
                </span>
              ) : null}
              {showDiff && changeAt !== null ? (
                <Button size={touch ? 'touch' : 'sm'} variant="ghost" onClick={jump} data-sw-history-jump="true">
                  <LocateFixed size={13} aria-hidden="true" /> Jump to the change
                </Button>
              ) : null}
            </div>
            {sliding && before && current ? (
              <figure className={cn('mx-auto w-full min-w-0', PANE_WIDTH[viewport])} data-sw-history-slider="true">
                <figcaption className="mb-1.5 text-[11px] text-faint">
                  Earlier {stamp(before.at)} on the left, current on the right. Drag the divider.
                </figcaption>
                <div
                  ref={(element) => {
                    panes.current.slider = element
                  }}
                  className="max-h-[52dvh] overflow-y-auto rounded-md border border-line bg-surface-2"
                >
                  <CompareSlider
                    label="Earlier and current capture"
                    beforeLabel="Earlier"
                    afterLabel="Current"
                    before={
                      <img
                        src={urlFor(before, false)}
                        alt={`${page.title} ${viewport}, captured ${stamp(before.at)}`}
                        className="block w-full select-none"
                        draggable={false}
                        onError={onImageError}
                      />
                    }
                    after={
                      <div className="relative">
                        <img
                          src={urlFor(current, false)}
                          alt={`${page.title} ${viewport}, current capture`}
                          className="block w-full select-none"
                          draggable={false}
                          onError={onImageError}
                        />
                        {overlay?.url ? (
                          <img
                            src={overlay.url}
                            alt=""
                            draggable={false}
                            className="pointer-events-none absolute inset-x-0 top-0 block w-full opacity-80 select-none"
                            data-sw-history-diff-overlay="true"
                          />
                        ) : null}
                      </div>
                    }
                  />
                </div>
              </figure>
            ) : (
              <div className="flex justify-center gap-3">
                {before && (!touch || layout === 'before') ? (
                  <Side
                    label="Earlier"
                    entry={before}
                    urlFor={urlFor}
                    page={page.title}
                    viewport={viewport}
                    onImageError={onImageError}
                    paneRef={(element) => {
                      panes.current.before = element
                    }}
                    onScroll={follow('before', 'after')}
                  />
                ) : null}
                {current && (!touch || layout === 'after') ? (
                  <Side
                    label="Current"
                    entry={current}
                    urlFor={urlFor}
                    page={page.title}
                    viewport={viewport}
                    diff={overlay}
                    onImageError={onImageError}
                    paneRef={(element) => {
                      panes.current.after = element
                    }}
                    onScroll={follow('after', 'before')}
                  />
                ) : null}
              </div>
            )}
            {before && onVersion(before.version).length ? (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted">Comments made on the earlier capture</p>
                <ul className="flex flex-wrap gap-1.5">
                  {onVersion(before.version).map((comment) => (
                    <li key={comment.id}>
                      <button
                        type="button"
                        onClick={() => onPickComment(comment)}
                        className={cn(
                          'inline-flex max-w-72 items-center gap-1.5 rounded-full border border-line px-2 text-xs text-fg transition-colors hover:bg-surface-2',
                          touch ? 'h-11' : 'h-7',
                        )}
                        data-sw-history-comment={comment.id}
                      >
                        <CommentDot className={comment.status === 'resolved' ? 'bg-ok text-ok-fg' : 'bg-accent text-accent-fg'}>
                          {comment.id}
                        </CommentDot>
                        <span className="truncate">{comment.body}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
