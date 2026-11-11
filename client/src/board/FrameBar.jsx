import { viewportLabel } from './viewports'
import { useEffect, useLayoutEffect, useState } from 'react'
import { useStore } from '@xyflow/react'
import { Camera, ExternalLink, Flag, History, MonitorPlay, MoreHorizontal, TextSelect, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button, IconButton, Tooltip } from '../components/ui'
import { isThumbnail } from './layout'
import { notesRect, placeFrameBar } from './frameBarPlace'

const TITLE_ROW_PX = 30

// Actions for the card the user tapped, drawn in screen pixels next to it so
// they stay tappable (44 px on touch) at any zoom. The bar sits outside the
// card, never over its title and badges: above the card, else to its right,
// else to its left. When the card fills the canvas it shrinks to one button
// in the card's header (or the canvas's top left corner when the header is
// off screen), away from the page's own nav and buttons. It never covers the
// notes along the top of the canvas (CanvasNotes), such as the comment-mode
// hint: it moves below them or to the next spot (frameBarPlace.js).
export default function FrameBar({
  focused,
  target,
  frame,
  title,
  hasLive,
  live,
  ready,
  selecting,
  touch,
  href,
  onOpenLive,
  onToggleSelect,
  onClose,
  history = 0,
  onHistory = null,
  onChecks = null,
  onCapture = null,
  captureBusy = false,
}) {
  const transform = useStore((state) => state.transform)
  const width = useStore((state) => state.width)
  const height = useStore((state) => state.height)
  const domNode = useStore((state) => state.domNode)
  const [expandedFor, setExpandedFor] = useState(null)
  const expanded = expandedFor === focused
  useEffect(() => {
    if (!focused) setExpandedFor(null)
  }, [focused])
  // The notes' box, measured now and whenever a note comes, goes or changes
  // (they follow the board's state) or the canvas changes size.
  const [avoid, setAvoid] = useState(null)
  useLayoutEffect(() => {
    const notes = focused && domNode ? domNode.closest('[data-sw-canvas]')?.querySelector('[data-sw-canvas-notes]') : null
    const measure = () => {
      const box = notes
        ? notesRect(
            Array.from(notes.children).map((child) => child.getBoundingClientRect()),
            domNode.getBoundingClientRect(),
          )
        : null
      setAvoid((current) => (JSON.stringify(current) === JSON.stringify(box) ? current : box))
    }
    measure()
    if (!notes) return undefined
    const mutations = new MutationObserver(measure)
    mutations.observe(notes, { childList: true, subtree: true, characterData: true })
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    sizes?.observe(notes)
    return () => {
      mutations.disconnect()
      sizes?.disconnect()
    }
  }, [focused, domNode, width, height])
  if (!focused || !target || !frame) return null
  const [tx, ty, zoom] = transform
  const left = (target.x + frame.x) * zoom + tx
  const top = (target.y + frame.y) * zoom + ty
  // The card's own top, above its title row (which sits above the card at a
  // constant size on screen; nodes.jsx CardHeader).
  const cardTop = target.y * zoom + ty - (zoom > 0.2 ? TITLE_ROW_PX : 0)
  const right = left + frame.w * zoom
  const bottom = top + frame.h * zoom
  if (right < 0 || left > width || bottom < 0 || top > height) return null
  // Zoomed out until the card is a thumbnail: a bar that big would float over
  // other cards and groups. It comes back when the card is large again.
  if (isThumbnail(frame, zoom)) return null
  const barHeight = touch ? 54 : 40
  const barWidth =
    (touch ? 236 : 340) + (onHistory ? (touch ? 56 : 90) : 0) + (onCapture ? (touch ? 56 : 120) : 0) + (onChecks ? (touch ? 48 : 90) : 0)
  const gap = 8
  const { place, toggle, fallback } = placeFrameBar({
    card: { left, top, right, bottom, titleTop: cardTop },
    canvas: { width, height },
    bar: { width: barWidth, height: barHeight },
    avoid,
    gap,
    zoom,
  })

  const size = touch ? 'touch' : 'sm'
  const quiet = 'text-fg shadow-none'
  // Labels stay 13 px on touch so the bar keeps its measured width.
  const label = touch && 'text-[13px]'
  if (!place && !expanded) {
    return (
      <IconButton
        size="icon"
        variant="secondary"
        style={toggle}
        className="nodrag nopan absolute z-20 rounded-full bg-surface/95 text-fg shadow-pop"
        onClick={(event) => {
          event.stopPropagation()
          setExpandedFor(focused)
        }}
        label={`${title} actions`}
        side="bottom"
        data-sw-frame-bar-toggle={focused}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </IconButton>
    )
  }
  const style = place
    ? { left: place.left, top: place.top, width: Math.min(barWidth, width - 16) }
    : { left: fallback.left, top: fallback.top, width: Math.min(barWidth, width - 16) }
  return (
    <div
      className="nodrag nopan nowheel absolute z-20 flex items-center flex-wrap justify-end gap-1 rounded-lg border border-line bg-surface/95 p-1 shadow-pop backdrop-blur"
      style={style}
      role="toolbar"
      aria-label={`${title} actions`}
      data-sw-frame-bar={focused}
      onClick={(event) => event.stopPropagation()}
    >
      {!touch ? (
        <span className="min-w-0 flex-1 truncate px-1.5 text-xs font-medium text-muted">
          {title} · {viewportLabel(frame.viewport)}
        </span>
      ) : null}
      {hasLive && !live ? (
        <Button size={size} variant="default" className={cn('shadow-none', label)} onClick={onOpenLive} data-sw-open-live={focused}>
          <MonitorPlay size={15} aria-hidden="true" /> Open live
        </Button>
      ) : null}
      {live ? (
        <Button
          size={size}
          variant={selecting ? 'default' : 'ghost'}
          className={cn('shadow-none', label, !selecting && 'text-fg')}
          aria-pressed={selecting}
          disabled={!ready}
          onClick={onToggleSelect}
          data-sw-select-text={focused}
        >
          <TextSelect size={15} aria-hidden="true" /> {selecting ? 'Done' : 'Select text'}
        </Button>
      ) : null}
      {onChecks ? (
        <Button size={size} variant="ghost" className={quiet} onClick={onChecks} aria-label="Page checks" data-sw-frame-checks={focused}>
          <Flag size={15} aria-hidden="true" />
          {touch ? null : 'Checks'}
        </Button>
      ) : null}
      {onHistory ? (
        <Tooltip content={`Page history: ${history + 1} captures`}>
          <Button
            size={size}
            variant="ghost"
            className={quiet}
            onClick={onHistory}
            aria-label={`Page history: ${history + 1} captures`}
            data-sw-frame-history={focused}
          >
            <History size={15} aria-hidden="true" /> {touch ? null : 'History'}
          </Button>
        </Tooltip>
      ) : null}
      {onCapture ? (
        <Tooltip content="Recapture this page at every screen size">
          <Button
            size={size}
            variant="ghost"
            className={quiet}
            disabled={captureBusy}
            onClick={onCapture}
            aria-label="Capture this page"
            data-sw-frame-capture={focused}
          >
            <Camera size={15} aria-hidden="true" /> {touch ? null : 'Capture'}
          </Button>
        </Tooltip>
      ) : null}
      {href ? (
        <IconButton asChild size={touch ? 'icon' : 'icon-sm'} className={quiet} label="Open the page in a new tab">
          <a href={href} target="_blank" rel="noreferrer">
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        </IconButton>
      ) : null}
      <IconButton
        size={touch ? 'icon' : 'icon-sm'}
        onClick={place ? onClose : () => setExpandedFor(null)}
        label={place ? 'Close' : 'Collapse'}
        data-sw-frame-bar-close="true"
      >
        <X size={15} aria-hidden="true" />
      </IconButton>
    </div>
  )
}

// Resolves the focused key ("<target>|<viewport>") to its card and renders FrameBar.
export function FocusedFrameBar({
  onChecks,
  onHistory,
  historyCountFor,
  focusedKey,
  layout,
  data,
  liveKeys,
  readyKeys,
  selectingKey,
  touch,
  liveFileFor,
  onOpenLive,
  onToggleSelect,
  onClose,
  onCapture,
  captureBusy,
}) {
  if (!focusedKey) return null
  const split = focusedKey.lastIndexOf('|')
  const targetId = focusedKey.slice(0, split)
  const viewport = focusedKey.slice(split + 1)
  const target = layout.targets[targetId]
  const frame = target?.frames.find((item) => item.viewport === viewport)
  if (!frame) return null
  const variant = targetId.startsWith('variant:') ? data?.variants?.find((item) => `variant:${item.id}` === targetId) : null
  const page = variant ? null : data?.board?.pages.find((item) => item.id === targetId)
  return (
    <FrameBar
      focused={focusedKey}
      target={target}
      frame={frame}
      title={variant ? variant.title : page?.title || targetId}
      hasLive={Boolean(liveFileFor(targetId, viewport))}
      live={liveKeys.has(focusedKey)}
      ready={readyKeys.has(focusedKey)}
      selecting={selectingKey === focusedKey}
      touch={touch}
      href={page?.url || (variant?.source && /^https?:/.test(variant.source) ? variant.source : null)}
      onOpenLive={() => onOpenLive(targetId, viewport)}
      onToggleSelect={() => onToggleSelect(focusedKey)}
      onClose={onClose}
      history={page ? data?.versions?.[page.id]?.[viewport]?.length || 0 : 0}
      onChecks={page && onChecks ? () => onChecks(page.id, viewport) : null}
      onHistory={page && historyCountFor(page.id) ? () => onHistory(page.id, viewport) : null}
      onCapture={page && onCapture ? () => onCapture(page.id) : null}
      captureBusy={captureBusy}
    />
  )
}
