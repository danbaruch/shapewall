import { viewportLabel } from './viewports'
import { useContext, useEffect, useLayoutEffect, useState } from 'react'
import { useStore } from '@xyflow/react'
import { Camera, ExternalLink, Flag, History, MessageSquarePlus, MonitorPlay, MoreHorizontal, TextSelect, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button, IconButton, Tooltip } from '../components/ui'
import { isThumbnail } from './layout'
import { fitFrameBar, notesRect, placeFrameBar } from './frameBarPlace'
import { KeyTip } from './KeyTip'
import { BoardContext } from './boardContext'
import { pageCommentSeen, rememberPageCommentSeen } from './prefs'

const TITLE_ROW_PX = 30

// Actions for the card the user tapped, drawn in screen pixels next to it so
// they stay tappable (44 px on touch) at any zoom. The bar sits outside the
// card, never over its title and badges: above the card, else to its right,
// else to its left. When the card fills the canvas it shrinks to one button
// in the card's header (or the canvas's top left corner when the header is
// off screen), away from the page's own nav and buttons. It never covers the
// notes along the top of the canvas (CanvasNotes), such as the links hint
// or the tip: it moves below them or to the next spot (frameBarPlace.js).
// Nor the tool dock along the bottom (the board's tools and their note).
//
// Comment comes first, for whoever may comment here (`onComment`; the same
// rule as the Comment tool at the bottom of the board): it starts a comment
// on this page, and it is the bar's one filled (primary) button. The rest are
// quiet: Open live or Select text, Checks and History (with their counts, the
// same as the card header's badges), Capture, then after a hairline the
// page's utilities (open in a new tab, close). The page's name leads, with its
// screen size as a small chip. The bar hugs its content and is one line at
// any width: frameBarPlace.js (fitFrameBar) says which buttons keep their words.
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
  onComment = null,
  commenting = false,
  history = 0,
  checks = 0,
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
  // (they follow the board's state) or the canvas changes size. The tool
  // dock along the bottom (BoardTools.jsx: the board's tools, the note for
  // the tool in use, a journey bar) is kept clear the same way: the bar is
  // placed in the canvas above it (`dockRoom`, px from the canvas's bottom).
  const [avoid, setAvoid] = useState(null)
  const [dockRoom, setDockRoom] = useState(0)
  useLayoutEffect(() => {
    const canvas = focused && domNode ? domNode.closest('[data-sw-canvas]') : null
    const notes = canvas?.querySelector('[data-sw-canvas-notes]') || null
    const dock = canvas?.querySelector('[data-sw-tool-dock]') || null
    const measure = () => {
      const origin = domNode?.getBoundingClientRect()
      const box = notes
        ? notesRect(
            Array.from(notes.children).map((child) => child.getBoundingClientRect()),
            origin,
          )
        : null
      setAvoid((current) => (JSON.stringify(current) === JSON.stringify(box) ? current : box))
      const docked = dock
        ? notesRect(
            // Not a passing toast: the bar does not jump for six seconds of it.
            Array.from(dock.children)
              .filter((child) => !child.hasAttribute('data-sw-toast'))
              .map((child) => child.getBoundingClientRect()),
            origin,
          )
        : null
      setDockRoom(docked ? Math.max(0, Math.round(origin.height - docked.top)) : 0)
    }
    measure()
    if (!notes && !dock) return undefined
    const mutations = new MutationObserver(measure)
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    for (const node of [notes, dock]) {
      if (!node) continue
      mutations.observe(node, { childList: true, subtree: true, characterData: true })
      sizes?.observe(node)
    }
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
  const liveAction = live ? (selecting ? 'done' : 'select') : hasLive ? 'open' : null
  const fit = fitFrameBar({
    canvasWidth: width,
    touch,
    items: {
      comment: Boolean(onComment),
      live: liveAction,
      checks: Boolean(onChecks),
      history: Boolean(onHistory),
      capture: Boolean(onCapture),
      link: Boolean(href),
      checksCount: checks > 0,
      historyCount: history > 0,
    },
  })
  const barWidth = fit.width
  const gap = 8
  const { place, toggle, fallback } = placeFrameBar({
    card: { left, top, right, bottom, titleTop: cardTop },
    canvas: { width, height: Math.max(barHeight + gap * 2, height - dockRoom) },
    bar: { width: barWidth, height: barHeight },
    avoid,
    gap,
    zoom,
  })

  const size = touch ? 'touch' : 'sm'
  // A button without its word is the square icon button.
  const sized = (labelled) => (labelled ? size : touch ? 'icon' : 'icon-sm')
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
  // The bar hugs its content, up to the width fitFrameBar allows. A bar above
  // the card or on its left keeps its right edge where the placement put it
  // (in line with the card's right edge), so a shorter bar does not drift.
  const spot = place || fallback
  const anchorRight = Boolean(place) && place.left < left + frame.w * zoom
  const style = anchorRight
    ? { right: width - (spot.left + barWidth), top: spot.top, maxWidth: barWidth }
    : { left: spot.left, top: spot.top, maxWidth: barWidth }
  // A button that lost its word keeps its name: a tooltip (mouse, keyboard).
  const tipped = (content, button, shown = true) =>
    shown && !touch ? (
      <Tooltip content={content} side="bottom">
        {button}
      </Tooltip>
    ) : (
      button
    )
  const checksText = checks ? `Page checks: ${checks} need${checks === 1 ? 's' : ''} attention` : 'Page checks'
  const historyText = `Page history: ${history + 1} captures`
  const utility = cn(secondary, DIVIDED)
  return (
    <div
      className={cn(
        'nodrag nopan nowheel absolute z-20 flex w-max flex-nowrap items-center gap-1 overflow-hidden rounded-lg border border-line bg-surface/95 p-1 shadow-pop backdrop-blur',
        touch && 'rounded-xl',
      )}
      style={style}
      role="toolbar"
      aria-label={`${title} actions`}
      data-sw-frame-bar={focused}
      data-sw-frame-bar-fit={fit.step}
      onClick={(event) => event.stopPropagation()}
    >
      {fit.title ? (
        <span className="flex min-w-0 shrink items-center gap-1.5 pr-1.5 pl-2" data-sw-frame-bar-title="true">
          <span className="min-w-0 truncate text-[13px] font-semibold text-fg" title={title}>
            {title}
          </span>
          <span
            className={cn(
              'shrink-0 rounded bg-surface-2 px-1.5 text-[10.5px] leading-[18px] font-medium text-muted',
              !fit.chip && 'sr-only',
            )}
          >
            {viewportLabel(frame.viewport)}
          </span>
        </span>
      ) : null}
      {onComment ? (
        <CommentAction
          key={focused}
          focused={focused}
          size={sized(fit.labels.comment)}
          touch={touch}
          labelled={fit.labels.comment}
          active={commenting}
          onComment={onComment}
        />
      ) : null}
      {hasLive && !live
        ? tipped(
            'Open live',
            <Button
              size={sized(fit.labels.live)}
              variant="ghost"
              className={cn(secondary, label)}
              onClick={onOpenLive}
              aria-label="Open live"
              data-sw-open-live={focused}
            >
              <MonitorPlay size={ICON} aria-hidden="true" /> {fit.labels.live ? 'Open live' : null}
            </Button>,
            !fit.labels.live,
          )
        : null}
      {live
        ? tipped(
            selecting ? 'Done selecting text' : 'Select text',
            <Button
              size={sized(fit.labels.live)}
              variant={selecting ? 'soft' : 'ghost'}
              className={cn(selecting ? 'shadow-none' : secondary, label)}
              aria-label={selecting ? 'Done' : 'Select text'}
              aria-pressed={selecting}
              disabled={!ready}
              onClick={onToggleSelect}
              data-sw-select-text={focused}
            >
              <TextSelect size={ICON} aria-hidden="true" /> {fit.labels.live ? (selecting ? 'Done' : 'Select text') : null}
            </Button>,
            !fit.labels.live,
          )
        : null}
      {onChecks
        ? tipped(
            checksText,
            <Button
              size={sized(fit.labels.checks)}
              variant="ghost"
              className={secondary}
              onClick={onChecks}
              aria-label="Page checks"
              aria-description={checks ? `${checks} need${checks === 1 ? 's' : ''} attention` : undefined}
              data-sw-frame-checks={focused}
            >
              <Flag size={ICON} aria-hidden="true" />
              {fit.labels.checks ? (
                <>
                  Checks
                  {checks ? <Count tone="warn">{checks}</Count> : null}
                </>
              ) : null}
            </Button>,
          )
        : null}
      {onHistory
        ? tipped(
            historyText,
            <Button
              size={sized(fit.labels.history)}
              variant="ghost"
              className={secondary}
              onClick={onHistory}
              aria-label={historyText}
              data-sw-frame-history={focused}
            >
              <History size={ICON} aria-hidden="true" />
              {fit.labels.history ? (
                <>
                  History
                  {history ? <Count>{history + 1}</Count> : null}
                </>
              ) : null}
            </Button>,
          )
        : null}
      {onCapture
        ? tipped(
            'Recapture this page at every screen size',
            <Button
              size={sized(fit.labels.capture)}
              variant="ghost"
              className={secondary}
              disabled={captureBusy}
              onClick={onCapture}
              aria-label="Capture this page"
              data-sw-frame-capture={focused}
            >
              <Camera size={ICON} aria-hidden="true" /> {fit.labels.capture ? 'Capture' : null}
            </Button>,
          )
        : null}
      {/* The page's own utilities, after a hairline: open it in a tab, close the bar. */}
      {href ? (
        <IconButton
          asChild
          size={touch ? 'icon' : 'icon-sm'}
          className={utility}
          label="Open the page in a new tab"
          side="bottom"
          data-sw-frame-bar-link="true"
        >
          <a href={href} target="_blank" rel="noreferrer">
            <ExternalLink size={ICON} aria-hidden="true" />
          </a>
        </IconButton>
      ) : null}
      <IconButton
        size={touch ? 'icon' : 'icon-sm'}
        className={href ? secondary : utility}
        onClick={place ? onClose : () => setExpandedFor(null)}
        label={place ? 'Close' : 'Collapse'}
        side="bottom"
        data-sw-frame-bar-close="true"
      >
        <X size={ICON} aria-hidden="true" />
      </IconButton>
    </div>
  )
}

// One icon size on the bar (the board's tools use the same).
const ICON = 16
// A quiet action: the board tools' ghost look.
const secondary = 'text-fg/80 shadow-none hover:text-fg focus-visible:outline-offset-1'
// The hairline before the utilities, drawn by the first of them (the bar's
// children are its buttons; fitFrameBar counts the room as `divider`).
const DIVIDED =
  "relative ml-1.5 before:pointer-events-none before:absolute before:top-1/2 before:-left-[5.5px] before:h-5 before:w-px before:-translate-y-1/2 before:bg-line before:content-['']"

// A small count after a button's word (checks that need attention, captures).
function Count({ tone = 'neutral', children }) {
  return (
    <span
      className={cn(
        'tabular -mr-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10.5px] leading-none font-semibold',
        tone === 'warn' ? 'bg-warn/15 text-fg' : 'bg-surface-2 text-muted',
      )}
      aria-hidden="true"
    >
      {children}
    </span>
  )
}

// How long the one-time emphasis on Comment stays.
const EMPHASIS_MS = 2600

// "Comment" on the selected page: starts a comment on this page (Board.jsx
// commentOnPage), and while that is on it is pressed; again turns it off.
// The first time a person who has never started a comment in this browser
// sees it, it wears a ring for a moment (prefs.js: once per browser; the
// demo's Reset brings it back). No motion: the ring is there, then not.
function CommentAction({ focused, size, touch, labelled, active, onComment }) {
  const [emphasis, setEmphasis] = useState(false)
  useEffect(() => {
    if (pageCommentSeen()) return undefined
    rememberPageCommentSeen()
    setEmphasis(true)
    const timer = window.setTimeout(() => setEmphasis(false), EMPHASIS_MS)
    return () => window.clearTimeout(timer)
  }, [])
  const button = (
    <Button
      size={size}
      variant="default"
      className={cn(
        'shadow-none focus-visible:outline-offset-1',
        touch && 'text-[13px]',
        // Pressed (the Comment tool is on for this page): a ring around the fill.
        active && 'ring-2 ring-accent/35 ring-offset-1 ring-offset-surface',
        emphasis && !active && 'outline-2 outline-offset-2 outline-accent',
      )}
      aria-label="Comment on this page"
      aria-pressed={active}
      aria-keyshortcuts="C"
      onClick={onComment}
      data-sw-frame-comment={focused}
      data-sw-frame-comment-emphasis={emphasis ? 'true' : undefined}
    >
      <MessageSquarePlus size={ICON} aria-hidden="true" /> {labelled ? 'Comment' : null}
    </Button>
  )
  if (touch) return button
  return (
    <Tooltip content={<KeyTip label="Comment on this page" keys={['C']} />} side="bottom">
      {button}
    </Tooltip>
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
  onComment = null,
  commentTargetKey = null,
}) {
  const board = useContext(BoardContext)
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
      onComment={onComment ? (event) => onComment(focusedKey, event) : null}
      commenting={commentTargetKey === focusedKey}
      history={page ? data?.versions?.[page.id]?.[viewport]?.length || 0 : 0}
      // The same count as the card header's checks badge (CardBadges.jsx).
      checks={page && onChecks && board?.onChecks ? board.checksCount(page.id) : 0}
      onChecks={page && onChecks ? () => onChecks(page.id, viewport) : null}
      onHistory={page && historyCountFor(page.id) ? () => onHistory(page.id, viewport) : null}
      onCapture={page && onCapture ? () => onCapture(page.id) : null}
      captureBusy={captureBusy}
    />
  )
}
