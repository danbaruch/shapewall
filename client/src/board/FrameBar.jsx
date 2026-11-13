import { viewportLabel } from './viewports'
import { useContext, useEffect, useLayoutEffect, useState } from 'react'
import { useStore } from '@xyflow/react'
import { Camera, ExternalLink, Flag, History, MessageSquarePlus, MonitorPlay, MoreHorizontal, TextSelect, X } from 'lucide-react'
import { cn } from '../lib/utils'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from '../components/ui'
import { isThumbnail } from './layout'
import { fitFrameBar, notesRect, placeFrameBar } from './frameBarPlace'
import { KeyTip } from './KeyTip'
import { BoardContext } from './boardContext'
import { pageCommentSeen, rememberPageCommentSeen } from './prefs'

const TITLE_ROW_PX = 30

// Actions for the card the user tapped, drawn in screen pixels next to it so
// they stay tappable (44 px on touch) at any zoom. The bar sits outside the
// card, never over its title and badges: above the card, else to its right,
// else to its left. On a touch screen, where a card is about as wide as the
// canvas, it then sticks to the card's top edge (under its title row) and to
// the top of the canvas as the card scrolls, rather than collapsing on every
// pan. Otherwise, when the card fills the canvas it shrinks to one button
// in the card's header (or the canvas's top left corner when the header is
// off screen), away from the page's own nav and buttons. It never covers the
// notes along the top of the canvas (CanvasNotes), such as the links hint
// or the tip: it moves below them or to the next spot (frameBarPlace.js).
// Nor the tool dock along the bottom (the board's tools and their note).
//
// Comment comes first, for whoever may comment here (`onComment`; the same
// rule as the Comment tool at the bottom of the board): it starts a comment
// on this page, and it is the bar's primary button, labelled at every width:
// a soft accent tint at rest, the solid fill while it is on (pressed). The
// rest are quiet: Open live or Select text, Checks and History (with their
// counts, the same as the card header's badges),
// Capture, then after a hairline the utilities (More, open in a new tab,
// close). The page's name leads, with its screen size as a small chip. The
// bar hugs its content and is one line at any width: what does not fit moves
// into the More menu, never down to a row of bare icons (frameBarPlace.js,
// fitFrameBar, says what goes where).
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
    pin: touch,
  })

  const size = touch ? 'touch' : 'sm'
  const iconSize = touch ? 'icon' : 'icon-sm'
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
  const needAttention = checks ? `${checks} need${checks === 1 ? 's' : ''} attention` : null
  const historyText = `Page history: ${history + 1} captures`
  // The secondary actions, the same on the bar and in the More menu.
  const actions = {
    open: {
      label: 'Open live',
      name: 'Open live',
      icon: MonitorPlay,
      tip: 'Open the live page: scroll it, click it',
      onSelect: onOpenLive,
      data: { 'data-sw-open-live': focused },
    },
    select: {
      label: 'Select text',
      name: 'Select text',
      icon: TextSelect,
      disabled: !ready,
      pressed: false,
      onSelect: onToggleSelect,
      data: { 'data-sw-select-text': focused },
    },
    done: {
      label: 'Done',
      name: 'Done',
      icon: TextSelect,
      tip: <KeyTip label="Done selecting text" keys={['Esc']} />,
      disabled: !ready,
      pressed: true,
      onSelect: onToggleSelect,
      data: { 'data-sw-select-text': focused },
    },
    checks: {
      label: 'Checks',
      name: 'Page checks',
      description: needAttention || undefined,
      icon: Flag,
      tip: needAttention ? `Page checks: ${needAttention}` : null,
      count: checks || null,
      warn: true,
      onSelect: onChecks,
      data: { 'data-sw-frame-checks': focused },
    },
    history: {
      label: 'History',
      name: historyText,
      icon: History,
      tip: historyText,
      count: history ? history + 1 : null,
      onSelect: onHistory,
      data: { 'data-sw-frame-history': focused },
    },
    capture: {
      label: 'Capture',
      name: 'Capture this page',
      icon: Camera,
      tip: 'Recapture this page at every screen size',
      disabled: captureBusy,
      onSelect: onCapture,
      data: { 'data-sw-frame-capture': focused },
    },
  }
  const onBar = (id) => {
    const action = actions[id]
    const button = (
      <Button
        key={id}
        size={size}
        variant={action.pressed ? 'soft' : 'ghost'}
        className={cn(action.pressed ? 'shadow-none focus-visible:outline-offset-1' : secondary, touch && 'text-[13px]')}
        aria-label={action.name}
        aria-description={action.description}
        aria-pressed={action.pressed}
        disabled={action.disabled}
        onClick={action.onSelect}
        {...action.data}
      >
        <action.icon size={ICON} aria-hidden="true" />
        {action.label}
        {action.count ? <Count tone={action.warn ? 'warn' : 'neutral'}>{action.count}</Count> : null}
      </Button>
    )
    return action.tip && !touch ? (
      <Tooltip key={id} content={action.tip} side="bottom">
        {button}
      </Tooltip>
    ) : (
      button
    )
  }
  // The first of the utilities (More, open in a tab, close) draws the hairline.
  const firstUtility = fit.more ? 'more' : fit.link === 'bar' ? 'link' : 'close'
  const utility = (id) => cn(secondary, id === firstUtility && DIVIDED)
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
        <span className="flex min-w-0 shrink items-center gap-2 pr-1 pl-2" data-sw-frame-bar-title="true">
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
        <CommentAction key={focused} focused={focused} size={size} touch={touch} active={commenting} onComment={onComment} />
      ) : null}
      {fit.bar.map(onBar)}
      {fit.more ? (
        <MoreMenu
          focused={focused}
          title={title}
          size={iconSize}
          touch={touch}
          className={utility('more')}
          actions={fit.menu.map((id) => ({ id, ...actions[id] }))}
          view={transform.join(',')}
          href={fit.link === 'menu' ? href : null}
        />
      ) : null}
      {fit.link === 'bar' ? (
        <IconButton
          asChild
          size={iconSize}
          className={utility('link')}
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
        size={iconSize}
        className={utility('close')}
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

// More (…): the secondary actions that did not fit on the bar, with their
// icons, words and counts, and Open in a new tab. A Radix menu: arrow keys,
// Enter, Esc, typeahead.
//
// A pan or zoom of the board closes it (`view` is the board's transform): the
// menu belongs to the bar where it was opened, and the bar moves with the card.
// On a touch screen it is not modal, so that pan starts with the first touch.
function MoreMenu({ focused, title, size, touch, className, actions, href, view }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [view])
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button
        size={size}
        variant="ghost"
        className={cn(className, 'data-[state=open]:bg-surface-2 data-[state=open]:text-fg')}
        aria-label={`More actions for ${title}`}
        data-sw-frame-more={focused}
      >
        <MoreHorizontal size={ICON} aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
  )
  return (
    // Not modal on a touch screen: a finger on the canvas pans at once (and
    // so closes the menu) instead of being swallowed to close it first.
    <DropdownMenu open={open} onOpenChange={setOpen} modal={!touch}>
      {touch ? (
        trigger
      ) : (
        <Tooltip content="More actions" side="bottom">
          {trigger}
        </Tooltip>
      )}
      <DropdownMenuContent side="bottom" align="end" className="min-w-52" data-sw-frame-more-menu={focused}>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={action.disabled}
            onSelect={action.onSelect}
            aria-description={action.description}
            {...action.data}
          >
            <action.icon size={ICON} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
            {action.count ? <Count tone={action.warn ? 'warn' : 'neutral'}>{action.count}</Count> : null}
          </DropdownMenuItem>
        ))}
        {href ? (
          <>
            {actions.length ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem asChild data-sw-frame-bar-link="true">
              <a href={href} target="_blank" rel="noreferrer">
                <ExternalLink size={ICON} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">Open in a new tab</span>
              </a>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
function CommentAction({ focused, size, touch, active, onComment }) {
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
      // At rest a soft accent tint (accent text and icon); pressed (the Comment
      // tool is on for this page) the solid accent fill.
      variant={active ? 'default' : 'soft'}
      className={cn(
        'shadow-none focus-visible:outline-offset-1',
        touch && 'text-[13px]',
        emphasis && !active && 'outline-2 outline-offset-2 outline-accent',
      )}
      aria-label="Comment on this page"
      aria-pressed={active}
      aria-keyshortcuts="C"
      onClick={onComment}
      data-sw-frame-comment={focused}
      data-sw-frame-comment-emphasis={emphasis ? 'true' : undefined}
    >
      <MessageSquarePlus size={ICON} aria-hidden="true" /> Comment
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
