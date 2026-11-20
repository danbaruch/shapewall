// One frame of a card: the screenshot (or the page's live HTML), its pins,
// the draft pin and the hover outline; and a compare frame.
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@xyflow/react'
import { ImageOff, Info } from 'lucide-react'
import { defaultEnvironment, environmentOf, frameKey } from './commentSide'
import { anchorAt, describeElement, elementAt, nameOf, resolveAnchor } from './anchors'
import { frameDom } from './frameDom'
import { useElementMap } from './elementMaps'
import { anchorOnMap, describeAt, hitTest, nameOnMap, resolveOnMap } from '../../../src/capture/element-map.js'
import { anchorNames } from './anchorNames'
import { DraftPin } from './pins'
import { FramePins, useFrameClusters, useFramePins, useLandedPin, usePinLook } from './framePins'
import { cn } from '../lib/utils'
import { useBoardView, useBoardViewStore } from './boardView'
import { BoardContext } from './boardContext'
import { FrameDrawing } from './CommentMedia'
import { compareSideNote } from './compareSideNote'
import { drawingsFor, hasDrawing, useDrawing } from './drawing'
import { changeText, entryVersion, shotChanged } from './flow'

// Device pixels per CSS pixel, capped: a dpr 3 phone does not need 3x images.
const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1

// The full screenshot only when this frame, at the settled zoom, is drawn
// wider on screen than the thumbnail has pixels. Before the camera settles it
// is always the thumbnail. Off-screen nodes are not rendered at all.
function wantsFull(frame, settledZoom, native) {
  if (!settledZoom || !native) return false
  return frame.w * settledZoom * dpr > native.width * (native.thumbScale || 0.25) * 1.05
}

// The page's captured HTML in a sandboxed iframe. Scripts never run (no
// allow-scripts, and the document's CSP has no script source). With an
// element map (every capture made since maps) the frame is sandbox="", an
// opaque origin: the board never reads it (pins, clicks and outlines come from
// the map), and a document that got past the sanitizer and both CSPs still
// could not reach the board, its cookies or its API. Only on the local board
// does a capture from before maps keep allow-same-origin and the DOM path
// (anchors.js). It renders at the capture's native width and is scaled to the
// frame, so the layout matches the screenshot, which stays visible until it
// has loaded.
// `selecting`: the page has the mouse, for selecting and copying text. A
// frame's document takes its own wheel events and the board never sees them
// (Ctrl+wheel there zooms the whole browser tab), so that is only while the
// person is at it: `onLeave` hands the mouse back when the pointer leaves.
function LiveDoc({ src, viewport, native, frame, selecting, opaque, onReady, onLeave }) {
  const scale = frame.w / native.width
  const ref = useRef(null)
  const [loaded, setLoaded] = useState(false)
  const onLoad = () => {
    if (opaque) {
      setLoaded(true)
      onReady(true)
      return
    }
    const doc = ref.current?.contentDocument
    if (!doc) return
    // Links and forms stay inert even while selecting text.
    const stop = (event) => event.preventDefault()
    frameDom.addEventListener(doc, 'click', stop, true)
    frameDom.addEventListener(doc, 'submit', stop, true)
    frameDom.addEventListener(doc, 'auxclick', stop, true)
    setLoaded(true)
    onReady(doc)
  }
  useEffect(() => () => onReady(null), [onReady])
  return (
    <iframe
      ref={ref}
      src={src}
      title={`Live ${viewport} page`}
      sandbox={opaque ? '' : 'allow-same-origin'}
      referrerPolicy="no-referrer"
      tabIndex={selecting ? 0 : -1}
      onLoad={onLoad}
      onMouseLeave={selecting ? onLeave : undefined}
      className={cn(
        'absolute top-0 left-0 origin-top-left border-0 bg-white transition-opacity duration-(--motion-base)',
        loaded ? 'opacity-100' : 'opacity-0',
        selecting ? 'nodrag nopan nowheel' : 'pointer-events-none',
      )}
      style={{ width: native.width, height: native.height, transform: `scale(${scale})` }}
      data-sw-live-frame={viewport}
    />
  )
}

export function Frame({ targetId, frame, image, kind, version, emptyText, note }) {
  const board = useContext(BoardContext)
  // A page with its own frame height carries its frame's size (layout.js).
  const native = frame.native || board.viewports[frame.viewport]
  const { viewport } = frame
  const liveKey = `${targetId}|${viewport}`
  // This frame's pins, and the open thread's own, which it keeps even when
  // the filter hides it (just resolved).
  const { pins, openHere, selectedCommentId } = useFramePins(board, targetId, viewport)
  // The drawing shown over the page: the open thread's, else the hovered
  // pin's, when it was drawn on this capture (an older one shows in the
  // thread's before and after instead).
  const hoveredDrawn = useBoardView((state) => {
    if (state.hoveredId === null) return null
    return pins.find((item) => item.id === state.hoveredId && hasDrawing(item)) || null
  })
  const drawn = openHere && hasDrawing(openHere) ? openHere : hoveredDrawn
  const shownDrawing = useMemo(() => {
    if (!drawn) return null
    // Drawn on another environment's capture (in compare mode): not over
    // this one, where it would point at the wrong things. The thread says
    // where it was left, and compare mode shows it on its own side.
    if (environmentOf(drawn, board.environments) !== defaultEnvironment(board.environments)) return null
    const current = String(targetId).startsWith('variant:')
      ? null
      : entryVersion(board.manifest?.pages?.[targetId]?.[viewport], board.manifest)
    return { id: drawn.id, ...drawingsFor(drawn, current) }
  }, [drawn, targetId, viewport, board.manifest, board.environments])
  const draft = useBoardView((state) => {
    const spot = state.draftSpot
    return spot && spot.pageId === targetId && spot.viewport === viewport ? spot : null
  })
  const live = useBoardView((state) => Boolean(image?.live) && state.liveKeys.has(liveKey))
  // A frame with nothing pinned (and no hover outline possible) skips the pin
  // zoom subscriptions, so zooming does not re-render it for them.
  const scalesPins = pins.length > 0 || Boolean(draft) || (board.commentMode && live)
  const { pinScale, compactPins } = usePinLook(board, frame, { active: scalesPins, drafting: Boolean(draft) })
  const selecting = useBoardView((state) => state.selectingKey === liveKey) && live
  // Selecting text (Select text on the page's bar) has two steps, so the
  // wheel stays the board's: armed (a text cursor; the board still pans and
  // zooms over the page) and, after a click on the page, reading (the page
  // has the mouse: select, copy) until the pointer leaves the page. Esc, a
  // click away from the page or Done on its bar ends it (Board.jsx).
  const selectable = selecting && !board.commentMode
  const reading = useBoardView((state) => state.readingKey === liveKey) && selectable
  const { onReading } = board
  useEffect(() => {
    if (!selectable) return undefined
    return () => onReading(null)
  }, [selectable, onReading])
  useEffect(() => {
    if (!reading) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onReading(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reading, onReading])
  const focused = useBoardView((state) => state.focusedKey === liveKey)
  // An element map, or (local board, older capture) the frame's own DOM.
  const mapFile = image?.live ? image.elements || null : null
  const opaque = Boolean(mapFile) || !board.domFallback
  const { map: elementMap, state: mapState } = useElementMap(live && mapFile ? board.elementsUrl(kind, mapFile, version) : null)
  const [frameLoaded, setFrameLoaded] = useState(false)
  const [doc, setDoc] = useState(null)
  const [layoutTick, setLayoutTick] = useState(0)
  const ready = live && (opaque ? frameLoaded && mapState !== 'loading' : Boolean(doc))
  const map = live && opaque ? elementMap : null
  // Live pins sit on their element, so a recapture or a little text reflow cannot strand them.
  const positions = useMemo(() => {
    if (!live || !(map || doc)) return null
    const out = new Map()
    for (const comment of pins) {
      if (!comment.anchor) continue
      const point = map ? resolveOnMap(map, comment.anchor, native) : resolveAnchor(doc, comment.anchor, native)
      out.set(comment.id, point || { x: comment.x, y: comment.y, moved: true })
    }
    return out
    // layoutTick re-resolves after the document resizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, map, doc, pins, native, layoutTick])
  // What each pinned element is called here, for its thread's "Pinned to".
  useEffect(() => {
    if (!map || !positions) return
    for (const [id, point] of positions)
      if (point.element !== undefined) anchorNames.set(board.boardId, id, nameOnMap(map, point.element).text)
  }, [board.boardId, map, positions])
  const landedId = useLandedPin(pins)
  const clusters = useFrameClusters({ pins, positions, frame, compact: compactPins, selectedCommentId })
  useEffect(() => {
    const view = frameDom.defaultView(doc)
    if (!view) return undefined
    const bump = () => setLayoutTick((value) => value + 1)
    frameDom.addEventListener(view, 'resize', bump)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(bump) : null
    observer?.observe(frameDom.documentElement(doc))
    return () => {
      frameDom.removeEventListener(view, 'resize', bump)
      observer?.disconnect()
    }
  }, [doc])
  const { setLiveReady } = board
  // LiveDoc reports true (opaque frame loaded), the Document (legacy) or null.
  const onFrame = useCallback((value) => {
    setFrameLoaded(Boolean(value))
    setDoc(value && value !== true ? value : null)
  }, [])
  useEffect(() => {
    setLiveReady(liveKey, ready)
  }, [liveKey, ready, setLiveReady])
  useEffect(() => () => setLiveReady(liveKey, false), [liveKey, setLiveReady])

  const sharp = useBoardView((state) => wantsFull(frame, state.settledZoom, native))
  const full = !image?.thumb || live || sharp
  const src = image ? board.imageUrl(kind, full ? image.file : image.thumb, version) : null

  // The steps of a comment, one at a time: picking (comment mode, nothing
  // picked yet), composing (a target is picked and its composer is open) and
  // drawing (a drawing tool is on). Only picking shows the crosshair and the
  // hover outline; once a target is picked the page is calm again.
  const composing = useBoardView(isComposing)
  const drawingOn = useDrawing(toolOn)
  const drawSurface = useDrawing((value) => Boolean(value?.tool) && value.key === liveKey)
  const picking = board.commentMode && !composing && !drawingOn
  // Picking on live HTML: outline the element a click would pin to, with
  // what it is, so a click in a gap does not land on a whole section
  // unnoticed. Not while this page's thread is open: a click then closes it
  // (as in Figma), and the thread's element keeps a quiet outline instead.
  const anchorsReady = live && Boolean(map || doc)
  const canHover = picking && !openHere && anchorsReady && !board.touch
  const { hover, onMouseMove, onMouseLeave, describe, clear: clearHover } = useHoverTarget({ enabled: canHover, map, doc, native })
  const hoveredAnchored = useHoveredAnchored(pins)
  // A touch screen has no hover: the element under the finger is outlined
  // and named from touch-down, and a drag (a pan) or a second finger (a
  // pinch) drops it, so only a tap pins.
  const canPress = picking && anchorsReady && Boolean(board.touch)
  const { press, pressEvents, consumedDrag } = useTouchTarget(canPress, describe, native)
  const onClick = (event) => {
    event.stopPropagation()
    // Selecting text: this click hands the mouse to the page.
    if (selectable) {
      if (!reading) onReading(liveKey)
      return
    }
    // Outside comment mode a tap selects the card; its actions appear in a
    // screen-space bar, usable at any zoom.
    if (!board.commentMode) {
      board.onFocusFrame(targetId, frame.viewport)
      return
    }
    // A drag or a pinch on a touch screen is not a tap.
    if (consumedDrag()) return
    // This page's thread is open: the click closes it, and the next one pins.
    if (picking && openHere && !board.touch) {
      board.onCloseThread()
      return
    }
    pinAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY, true, event.altKey ? 1 : 0)
  }
  // Starts a comment at a point of the screen that is on this page. `anchored`:
  // on a live page, also to the element under it.
  const pinAt = (rect, clientX, clientY, anchored = true, up = 0) => {
    const fx = (clientX - rect.left) / rect.width
    const fy = (clientY - rect.top) / rect.height
    const pin = {
      pageId: targetId,
      viewport: frame.viewport,
      x: Math.max(0, Math.min(100, fx * 100)),
      y: Math.max(0, Math.min(100, fy * 100)),
    }
    // On a live page the tap is also anchored to the element under it;
    // `target` is that element in plain words, for the composer and the banner.
    if (anchored && live && (map || doc)) {
      const x = fx * native.width
      const y = fy * native.height
      const position = map ? hitTest(map, x, y, up) : -1
      const anchor = map ? (position >= 0 ? anchorOnMap(map, position, x, y, native) : null) : anchorAt(doc, x, y, native, up)
      if (anchor) {
        const named = map ? nameOnMap(map, position) : nameOf(elementAt(doc, x, y, up))
        pin.anchor = anchor
        pin.target = named.text
        pin.targetKind = named.kind
        pin.targetName = named.name
      }
    }
    clearHover()
    board.onPin(pin)
  }
  // "Comment" on this page's bar was pressed (FrameBar.jsx): the page takes
  // the keyboard, and Enter pins a comment near the top left of what shows of
  // it (a page has no comment without a spot). No element: nothing was
  // pointed at.
  const commentTarget = useBoardView((state) => state.commentTargetKey === liveKey) && picking
  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const canvas = event.currentTarget.closest('[data-sw-canvas]')?.getBoundingClientRect() || rect
    // 24 px in from the corner, less on a page drawn small.
    const inset = Math.min(24, rect.width * 0.04, rect.height * 0.04)
    const x = Math.min(rect.right - inset, Math.max(rect.left, canvas.left) + inset)
    const y = Math.min(rect.bottom - inset, Math.max(rect.top, canvas.top) + inset)
    pinAt(rect, x, y, false)
  }

  return (
    <>
      {frame.y > 12 ? (
        <FrameLabel frame={frame}>
          {frame.viewport}
          {live ? <span className="text-accent"> · live</span> : null}
        </FrameLabel>
      ) : null}
      <div
        className={cn(
          'absolute rounded-sm border border-line bg-surface-2',
          // Picking: a click picks, so a drag must not pan. With a target
          // picked the page drags the canvas again, like any other page.
          // On a touch screen a drag still pans: only a tap pins (onClick).
          picking && (board.touch ? 'cursor-crosshair' : 'nodrag nopan cursor-crosshair'),
          selectable && !reading && 'cursor-text',
          live && 'border-accent/60',
          focused && !drawSurface && 'outline-2 outline-offset-2 outline-accent',
          // The keyboard is on the page (Enter pins): a heavier frame.
          commentTarget && 'focus-visible:outline-4',
          // The page being drawn on: a strong frame, the same weight on
          // screen at any zoom (styles.css dims every other page).
          drawSurface && 'outline-solid outline-accent',
        )}
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.w,
          height: frame.h,
          ...(drawSurface ? DRAW_OUTLINE : null),
        }}
        onClick={onClick}
        tabIndex={commentTarget ? 0 : undefined}
        // A group, not a button: the page's pins are buttons inside it.
        role={commentTarget ? 'group' : undefined}
        aria-label={
          commentTarget ? `The ${frame.viewport} page: press Enter to comment at its top left, or click where the comment goes` : undefined
        }
        onKeyDown={commentTarget ? onKeyDown : undefined}
        data-sw-comment-target={commentTarget ? 'true' : undefined}
        onMouseMove={canHover ? onMouseMove : undefined}
        onMouseLeave={canHover ? onMouseLeave : undefined}
        {...pressEvents}
        data-sw-frame={`${targetId}:${frame.viewport}`}
        data-sw-image={src ? (full ? 'full' : 'thumb') : 'none'}
        data-sw-live={live ? (ready ? 'ready' : 'loading') : 'off'}
        data-sw-live-anchors={live ? (opaque ? (map ? 'map' : 'none') : 'dom') : undefined}
        data-sw-draw-surface={drawSurface ? 'true' : undefined}
        data-sw-select-text-state={selectable ? (reading ? 'reading' : 'armed') : undefined}
      >
        {/* The page and everything drawn on it is clipped to the frame; the
            pins below are not. A pin is a mark about the page rather than
            part of it, and one near an edge was cut in half by this box: a
            comment stored at 2% / 2% (where "shapewall comments add" falls
            back when a --selector no longer resolves) had the middle of its
            bubble outside the clip, so it was not in the hit test at all and
            could not be clicked. It hangs over the card's edge instead, the
            way it does in Figma. */}
        <div className="absolute inset-0 overflow-hidden rounded-sm" data-sw-frame-clip="true">
          {src ? (
            <img
              src={src}
              alt={`${frame.viewport} screenshot`}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={board.onImageError}
              className="pointer-events-none block h-full w-full object-cover object-top select-none"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <ImageOff size={22} className="text-faint" aria-hidden="true" />
              <p className="text-[11px] leading-4 text-muted">{emptyText}</p>
            </div>
          )}
          {live ? (
            <LiveDoc
              key={opaque ? 'opaque' : 'dom'}
              src={board.liveUrl(kind, image.live, version)}
              viewport={frame.viewport}
              native={native}
              frame={frame}
              selecting={reading}
              opaque={opaque}
              onReady={onFrame}
              onLeave={() => onReading(null)}
            />
          ) : null}
          {note && !live ? (
            <p
              className="pointer-events-none absolute inset-x-0 bottom-0 flex items-start gap-1 bg-surface/90 px-1.5 py-1 text-[9.5px] leading-[13px] text-muted"
              data-sw-page-note="true"
            >
              <Info size={10} className="mt-px shrink-0" aria-hidden="true" /> {note}
            </p>
          ) : null}
          {openHere?.anchor && !drawingOn ? (
            <AnchorTarget comment={openHere} box={positions?.get(openHere.id)?.box || null} thread />
          ) : null}
          {hoveredAnchored && hoveredAnchored !== openHere && !draft && !drawingOn ? (
            <AnchorTarget comment={hoveredAnchored} box={positions?.get(hoveredAnchored.id)?.box || null} />
          ) : null}
          {hover ? <HoverOutline hover={hover} native={native} frame={frame} /> : null}
          {press && canPress ? <HoverOutline hover={press} native={native} frame={frame} /> : null}
          {draft?.anchor && !drawingOn ? (
            <PickedOutline key={`${draft.x},${draft.y}`} draft={draft} frame={frame} flash={board.touch} />
          ) : null}
          <FrameDrawing frameKey={liveKey} native={native} shown={shownDrawing} />
        </div>
        <FramePins
          targetId={targetId}
          viewport={viewport}
          clusters={clusters}
          scale={pinScale}
          compact={compactPins}
          selectedCommentId={selectedCommentId}
          landedId={landedId}
        />
        {draft ? <DraftPin draft={draft} scale={pinScale} name={board.me?.name} colorKey={board.me?.name} /> : null}
      </div>
    </>
  )
}

// A frame's viewport (and environment) label, in the strip above the frame
// when a card shows more than one (All, compare), so it never covers the page.
function FrameLabel({ frame, children }) {
  return (
    <span
      className="pointer-events-none absolute z-10 flex origin-bottom-left items-center gap-1 truncate text-[10.5px] leading-4 font-semibold tracking-wide text-muted uppercase"
      style={{
        left: frame.x,
        top: frame.y - 19,
        width: `calc(${frame.w}px / var(--sw-label-scale, 1))`,
        transform: 'scale(var(--sw-label-scale, 1))',
      }}
      data-sw-frame-label={frame.env ? `${frame.viewport}:${frame.env}` : frame.viewport}
    >
      {children}
    </span>
  )
}

const isComposing = (state) => Boolean(state.draftSpot)
// The page being drawn on: a strong frame, the same weight on screen at any zoom.
const DRAW_OUTLINE = { outlineWidth: 'calc(3px * var(--sw-inv, 1))', outlineOffset: 'calc(2px * var(--sw-inv, 1))' }
const toolOn = (value) => Boolean(value?.tool)

// Outlines on a page, all the same weight on screen at any zoom (the stroke
// and the label scale by --sw-inv, 1 / zoom: CanvasControls.jsx):
//   hover     the element a click would pin to, with its name above it
//   picked    the element the comment being written is attached to
//   quiet     the element of the open thread, or of the pin or comment row
//             under the mouse: a soft outline, so you see what it is about
// Boxes are { left, top, right, bottom } in percent of the page.
const boxStyle = (box) => ({
  left: `${box.left}%`,
  top: `${box.top}%`,
  width: `${box.right - box.left}%`,
  height: `${box.bottom - box.top}%`,
})

const rectBox = (rect, native) => ({
  left: (rect.left / native.width) * 100,
  top: (rect.top / native.height) * 100,
  right: ((rect.left + rect.width) / native.width) * 100,
  bottom: ((rect.top + rect.height) / native.height) * 100,
})

// A comment's element box from its own anchor (where in the element the
// pin landed, and the element's size), for a screenshot or before the live
// page has resolved it.
function anchorBox(item) {
  const { anchor } = item
  if (!anchor?.w || !anchor?.h) return null
  const left = item.x - anchor.dx * anchor.w * 100
  const top = item.y - anchor.dy * anchor.h * 100
  return { left, top, right: left + anchor.w * 100, bottom: top + anchor.h * 100 }
}

const STROKE = { hover: 2, picked: 2, quiet: 1.5 }

function ElementOutline({ box, tone, large = false, ...data }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute rounded-[2px] outline-offset-0',
        tone === 'quiet' ? 'z-[4] bg-accent/[0.05] outline-accent/55' : 'z-[5] outline-accent',
        tone === 'hover' && !large && 'bg-accent/[0.06]',
        large ? 'outline-dashed' : 'outline-solid',
      )}
      // An outline, not a border: the stroke goes around the element, never over its text.
      style={{ ...boxStyle(box), outlineWidth: `calc(${large ? 1.5 : STROKE[tone]}px * var(--sw-inv, 1))` }}
      {...data}
    />
  )
}

// What an element is, in a small tab outside its top left corner, the way
// Figma and the browser's element picker name what is under the pointer.
// Above the element when there is room on the page (and on screen), else
// below it, else just inside its top; never past the page's edges. The
// same size on screen at any zoom.
function TargetLabel({ box, frame, kind, name, ...data }) {
  const ref = useRef(null)
  const zoom = useStore((state) => state.transform[2])
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !zoom) return
    const inv = 1 / zoom
    const width = node.offsetWidth * inv
    const height = node.offsetHeight * inv
    // 4 px clear of the 2 px outline.
    const gap = 6 * inv
    const left = (box.left / 100) * frame.w
    const top = (box.top / 100) * frame.h
    const bottom = (box.bottom / 100) * frame.h
    // The part of the page on screen: a label above the fold is no use.
    let shown = { left: 0, top: 0, right: frame.w, bottom: frame.h }
    const page = node.parentElement?.getBoundingClientRect()
    const canvas = node.closest('[data-sw-canvas]')?.getBoundingClientRect()
    if (page && canvas) {
      shown = {
        left: Math.max(0, (canvas.left - page.left) * inv),
        top: Math.max(0, (canvas.top - page.top) * inv),
        right: Math.min(frame.w, (canvas.right - page.left) * inv),
        bottom: Math.min(frame.h, (canvas.bottom - page.top) * inv),
      }
    }
    // Above; below when the element starts at the top of the page; else
    // inside its top edge, held at the top of the screen while the element
    // runs past it (like a sticky header).
    let place = 'above'
    let y = top - height - gap
    if (y < shown.top) {
      place = top >= shown.top && bottom + gap + height <= shown.bottom ? 'below' : 'inside'
      y = place === 'below' ? bottom + gap : Math.max(top, shown.top) + gap
    }
    const inset = place === 'inside' ? gap : 0
    const x = Math.max(shown.left + inset, Math.min(Math.max(left, shown.left) + inset, shown.right - width - inset))
    node.style.transform = `translate(${x}px, ${y}px) scale(${inv})`
    node.style.visibility = 'visible'
    node.dataset.swLabelPlace = place
  })
  return (
    <span
      ref={ref}
      className="pointer-events-none invisible absolute top-0 left-0 z-[6] block h-5 origin-top-left truncate rounded-[5px] bg-accent px-1.5 text-[11px] leading-5 whitespace-nowrap text-accent-fg shadow-card"
      style={{ maxWidth: Math.max(80, Math.min(280, frame.w * (zoom || 1) - 8)) }}
      {...data}
    >
      <span className="font-semibold">{kind}</span>
      {name ? (
        <>
          <span className="opacity-60">{' · '}</span>
          <span className="font-medium">{name}</span>
        </>
      ) : null}
    </span>
  )
}

// The element a click would pin a comment to, outlined, with what it is in
// plain words ("Button · Start free"). Its selector stays on the label as
// data-sw-hover-selector, for tests and the curious.
function HoverOutline({ hover, native, frame }) {
  const box = rectBox(hover.rect, native)
  return (
    <>
      <ElementOutline box={box} tone="hover" large={hover.large} data-sw-hover-outline={hover.large ? 'large' : 'element'} />
      <TargetLabel
        box={box}
        frame={frame}
        kind={hover.kind}
        name={hover.name}
        data-sw-hover-label="true"
        data-sw-hover-selector={hover.label}
      />
    </>
  )
}

// The element the comment being written is attached to: a calm solid
// outline that stays while the composer is open. Its box comes from the
// draft itself (the click point and where in the element it landed), so it
// shows on a screenshot as well as on the live page. On a touch screen,
// where nothing showed it before the tap, its name shows for a moment too.
const FLASH_MS = 1600
function PickedOutline({ draft, frame, flash }) {
  const box = anchorBox(draft)
  const [named, setNamed] = useState(Boolean(flash && draft.targetKind))
  useEffect(() => {
    if (!named) return undefined
    const timer = window.setTimeout(() => setNamed(false), FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [named])
  if (!box) return null
  return (
    <>
      <ElementOutline box={box} tone="picked" data-sw-picked-outline="true" />
      {named ? <TargetLabel box={box} frame={frame} kind={draft.targetKind} name={draft.targetName} data-sw-picked-label="true" /> : null}
    </>
  )
}

// The element a comment is on: the open thread's (the thread's popover
// keeps off it: ThreadPopover.jsx), or the one whose pin or list row is
// under the mouse. From the live page when the pin was resolved on it
// (`box`, in percent), else from the comment's own anchor.
function AnchorTarget({ comment, box, thread = false }) {
  const shown = box || anchorBox(comment)
  if (!shown) return null
  return (
    <ElementOutline
      box={shown}
      tone="quiet"
      aria-hidden="true"
      data-sw-thread-target={thread ? comment.id : undefined}
      data-sw-anchor-highlight={comment.id}
    />
  )
}

// Both ordinary and compare frames let a touch drag pan, while a tap picks
// the element previewed under the finger.
function useTouchTarget(canPress, describe, native) {
  const [press, setPress] = useState(null)
  const pressing = useRef(null)
  useEffect(() => {
    if (!canPress) {
      pressing.current = null
      setPress(null)
    }
  }, [canPress])
  const pointAt = (target, clientX, clientY) => {
    const rect = target.getBoundingClientRect()
    return [((clientX - rect.left) / rect.width) * native.width, ((clientY - rect.top) / rect.height) * native.height]
  }
  const onPointerDown = (event) => {
    if (!canPress || event.pointerType !== 'touch') return
    // A pin on the page is its own button.
    if (event.target.closest?.('[data-sw-pin], [data-sw-cluster]')) return
    if (pressing.current && pressing.current.id !== event.pointerId) {
      pressing.current.moved = true
      setPress(null)
      return
    }
    pressing.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    const [x, y] = pointAt(event.currentTarget, event.clientX, event.clientY)
    setPress(describe(x, y))
  }
  const onPointerMove = (event) => {
    const at = pressing.current
    if (!at || at.id !== event.pointerId || at.moved) return
    if (Math.hypot(event.clientX - at.x, event.clientY - at.y) > 10) {
      at.moved = true
      setPress(null)
    }
  }
  const onPointerEnd = (event) => {
    const at = pressing.current
    if (!at || at.id !== event.pointerId) return
    if (event.type === 'pointercancel') at.moved = true
    // The tap's click comes next; a press that ended any other way just goes.
    window.setTimeout(() => {
      if (pressing.current === at) {
        pressing.current = null
        setPress(null)
      }
    }, 350)
  }

  const consumedDrag = () => {
    const moved = pressing.current?.moved
    pressing.current = null
    setPress(null)
    return moved
  }
  const pressEvents = canPress ? { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd } : {}
  return { press, pressEvents, consumedDrag }
}

// Hover on a live page while picking: which element a click would pin to.
// Read once per animation frame from the element map (or the frame's DOM),
// and a new outline only when the element changes, so moving across a big
// page costs one hit test a frame and nothing flickers. Holding Alt (Option
// on a Mac) steps out to the container around the element; the click then
// pins to that container. `describe(x, y, up)` answers for any point.
function useHoverTarget({ enabled, map, doc, native }) {
  const [hover, setHover] = useState(null)
  const request = useRef(0)
  const last = useRef(null)
  const view = useBoardViewStore()
  const describe = useCallback(
    (x, y, up = 0) => {
      if (map) {
        const position = hitTest(map, x, y, up)
        return position >= 0 ? describeAt(map, position, native) : null
      }
      if (!doc) return null
      const element = elementAt(doc, x, y, up)
      return element ? describeElement(doc, element, native) : null
    },
    [map, doc, native],
  )
  const update = useCallback(
    (x, y, up) => {
      last.current = { x, y, up }
      window.cancelAnimationFrame(request.current)
      request.current = window.requestAnimationFrame(() => {
        const next = describe(x, y, up)
        setHover((previous) => (previous && next && previous.id === next.id ? previous : next))
      })
    },
    [describe],
  )
  const clear = useCallback(() => {
    last.current = null
    window.cancelAnimationFrame(request.current)
    setHover(null)
  }, [])
  useEffect(() => {
    if (!enabled) clear()
  }, [enabled, clear])
  useEffect(() => () => window.cancelAnimationFrame(request.current), [])
  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (event) => {
      if (event.key !== 'Alt') return
      // A lone Alt would focus the browser's menu on some systems.
      if (event.type === 'keyup') event.preventDefault()
      const at = last.current
      const up = event.type === 'keydown' ? 1 : 0
      if (at && at.up !== up) update(at.x, at.y, up)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [enabled, update])
  // The comment hint mentions Alt only while something is outlined.
  const shown = enabled && Boolean(hover)
  useEffect(() => {
    if (!shown) return undefined
    view.set({ targetHover: true })
    return () => view.set({ targetHover: false })
  }, [shown, view])
  const onMouseMove = (event) => {
    if (!enabled) return
    const rect = event.currentTarget.getBoundingClientRect()
    update(
      ((event.clientX - rect.left) / rect.width) * native.width,
      ((event.clientY - rect.top) / rect.height) * native.height,
      event.altKey ? 1 : 0,
    )
  }
  return { hover: enabled ? hover : null, onMouseMove, onMouseLeave: clear, describe, clear }
}

// The pin or comment row under the mouse, when it is one of this frame's
// pins on an element (the same comment object, so the answer is stable).
function useHoveredAnchored(pins) {
  return useBoardView((state) => {
    if (state.hoveredId === null) return null
    return pins.find((item) => item.id === state.hoveredId && item.anchor) || null
  })
}

// Compare mode: one environment's screenshot of the page. The second
// environment's frame carries the pixel diff as a red overlay and its share.
// Each side draws the comments left on it (commentSide.js): a comment
// placed here records this frame's environment, so it comes back on this
// side in every later compare, and older comments (made outside compare
// mode) are on the default environment's side. In comment mode a click
// places a comment on this side; with the capture's element map, on the
// element under the pointer, as on a live page.
export function CompareFrame({ pageId, frame }) {
  const board = useContext(BoardContext)
  const { compare } = board
  const { viewport, env } = frame
  const native = frame.native || board.viewports[viewport]
  const key = frameKey(pageId, viewport, env)
  const { pins, openHere, selectedCommentId } = useFramePins(board, pageId, viewport, true, env)
  const draft = useBoardView((state) => {
    const spot = state.draftSpot
    return spot && spot.pageId === pageId && spot.viewport === viewport && spot.environment === env ? spot : null
  })
  const composing = useBoardView(isComposing)
  const drawingOn = useDrawing(toolOn)
  const drawSurface = useDrawing((value) => Boolean(value?.tool) && value.key === key)
  const picking = board.commentMode && !composing && !drawingOn
  const { pinScale, compactPins } = usePinLook(board, frame, {
    active: pins.length > 0 || Boolean(draft) || picking,
    drafting: Boolean(draft),
  })
  const landedId = useLandedPin(pins)
  const clusters = useFrameClusters({ pins, frame, compact: compactPins, selectedCommentId })
  const image = compare.files?.[env]?.[pageId]?.[viewport]
  const sharp = useBoardView((state) => wantsFull(frame, state.settledZoom, native))
  const full = image && (!image.thumb || sharp)
  const kind = compare.kindOf(env)
  const version = compare.versionOf(env)
  const src = image ? board.imageUrl(kind, full ? image.file : image.thumb, version) : null
  const result = compare.pages?.[pageId]?.[viewport]
  const failure = image ? null : compare.failures?.[env]?.[pageId]?.[viewport] || null
  const second = env === compare.b
  const diff = second && compare.showDiff && result?.status === 'ok' && shotChanged(result) ? result.diff : null
  // The capture's element map, read once the page is drawn big enough to
  // point at its elements while commenting: a comment then sticks to the
  // element, and the pointer outlines what a click would pin to.
  const wantsMap = Boolean(image?.elements) && (picking || Boolean(draft)) && Boolean(sharp)
  const { map } = useElementMap(wantsMap ? board.elementsUrl(kind, image.elements, version) : null)
  // The drawing over this side: the open thread's own, else the hovered
  // pin's. Only the default environment keeps capture versions; a drawing
  // made on another one shows as it was made.
  const hoveredDrawn = useBoardView((state) =>
    state.hoveredId === null ? null : pins.find((item) => item.id === state.hoveredId && hasDrawing(item)) || null,
  )
  const drawn = openHere && hasDrawing(openHere) ? openHere : hoveredDrawn
  const shownDrawing = useMemo(() => {
    if (!drawn) return null
    const current =
      env === defaultEnvironment(board.environments) ? entryVersion(board.manifest?.pages?.[pageId]?.[viewport], board.manifest) : null
    return { id: drawn.id, ...drawingsFor(drawn, current) }
  }, [drawn, env, pageId, viewport, board.manifest, board.environments])
  const canHover = picking && !openHere && Boolean(map) && !board.touch
  const { hover, onMouseMove, onMouseLeave, describe, clear: clearHover } = useHoverTarget({ enabled: canHover, map, doc: null, native })
  const { press, pressEvents, consumedDrag } = useTouchTarget(picking && board.touch, describe, native)
  const hoveredAnchored = useHoveredAnchored(pins)
  // Places a comment at (fx, fy) of this side, 0 to 1. `anchored`: also to
  // the element there, when the element map is loaded.
  const place = (fx, fy, anchored = true, up = 0) => {
    const pin = {
      pageId,
      viewport,
      environment: env,
      x: Math.max(0, Math.min(100, fx * 100)),
      y: Math.max(0, Math.min(100, fy * 100)),
    }
    if (anchored && map) {
      const x = fx * native.width
      const y = fy * native.height
      const position = hitTest(map, x, y, up)
      const anchor = position >= 0 ? anchorOnMap(map, position, x, y, native) : null
      if (anchor) {
        const named = nameOnMap(map, position)
        pin.anchor = anchor
        pin.target = named.text
        pin.targetKind = named.kind
        pin.targetName = named.name
      }
    }
    clearHover()
    board.onPin(pin)
  }
  const onClick = (event) => {
    if (!board.commentMode) return
    event.stopPropagation()
    if (consumedDrag()) return
    // This side's thread is open: the click closes it, and the next one pins.
    if (picking && openHere && !board.touch) {
      board.onCloseThread()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    place((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height, true, event.altKey ? 1 : 0)
  }
  // "Comment" on the page bar from the keyboard (FrameBar.jsx): both sides
  // of the pair take the keyboard, the first one first (Board.jsx), and
  // Enter places the comment near the top left of what shows of that side,
  // as on a page outside compare mode. Tab reaches the other side.
  const commentTarget = useBoardView((state) => state.commentTargetKey === frameKey(pageId, viewport)) && picking
  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const canvas = event.currentTarget.closest('[data-sw-canvas]')?.getBoundingClientRect() || rect
    const inset = Math.min(24, rect.width * 0.04, rect.height * 0.04)
    const x = Math.min(rect.right - inset, Math.max(rect.left, canvas.left) + inset)
    const y = Math.min(rect.bottom - inset, Math.max(rect.top, canvas.top) + inset)
    place((x - rect.left) / rect.width, (y - rect.top) / rect.height, false)
  }
  const title = compare.titleOf(env)
  const note = compareSideNote(failure, title)
  return (
    <>
      <FrameLabel frame={frame}>
        {viewport} · {title}
        {second && result?.status === 'ok' ? <span className="text-accent"> · {changeText(result)} changed</span> : null}
      </FrameLabel>
      <div
        className={cn(
          'absolute rounded-sm border border-line bg-surface-2',
          picking && (board.touch ? 'cursor-crosshair' : 'nodrag nopan cursor-crosshair'),
          commentTarget && 'focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-accent',
          drawSurface && 'outline-solid outline-accent',
        )}
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.w,
          height: frame.h,
          ...(drawSurface ? DRAW_OUTLINE : null),
        }}
        onClick={board.commentMode ? onClick : undefined}
        tabIndex={commentTarget ? 0 : undefined}
        role={commentTarget ? 'group' : undefined}
        aria-label={
          commentTarget
            ? `The ${viewport} page on ${title}: press Enter to comment at its top left, or click where the comment goes`
            : undefined
        }
        onKeyDown={commentTarget ? onKeyDown : undefined}
        data-sw-comment-target={commentTarget ? 'true' : undefined}
        {...pressEvents}
        onMouseMove={canHover ? onMouseMove : undefined}
        onMouseLeave={canHover ? onMouseLeave : undefined}
        data-sw-frame={`${pageId}:${viewport}:${env}`}
        data-sw-image={src ? (full ? 'full' : 'thumb') : 'none'}
        data-sw-draw-surface={drawSurface ? 'true' : undefined}
      >
        {/* The captures and the diff are clipped to the frame, the pins are
            not: see the Frame above. */}
        <div className="absolute inset-0 overflow-hidden rounded-sm" data-sw-frame-clip="true">
          {src ? (
            <img
              src={src}
              alt={`${viewport} screenshot, ${title}`}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={board.onImageError}
              className="pointer-events-none block h-full w-full object-cover object-top select-none"
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <ImageOff size={22} className="text-faint" aria-hidden="true" />
              <p
                className="text-[11px] leading-4 text-muted"
                data-sw-compare-failed={note.failed ? 'true' : undefined}
                data-sw-compare-missing={failure && !note.failed ? 'true' : undefined}
              >
                {note.text}
              </p>
            </div>
          )}
          {diff ? (
            <img
              src={board.imageUrl(compare.diffKind, diff, compare.diffVersion)}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 block h-full w-full object-cover object-top opacity-80 select-none"
              data-sw-diff-overlay="true"
            />
          ) : null}
          {openHere?.anchor && !drawingOn ? <AnchorTarget comment={openHere} box={null} thread /> : null}
          {hoveredAnchored && hoveredAnchored !== openHere && !draft && !drawingOn ? (
            <AnchorTarget comment={hoveredAnchored} box={null} />
          ) : null}
          {hover ? <HoverOutline hover={hover} native={native} frame={frame} /> : null}
          {press && picking ? <HoverOutline hover={press} native={native} frame={frame} /> : null}
          {draft?.anchor && !drawingOn ? (
            <PickedOutline key={`${draft.x},${draft.y}`} draft={draft} frame={frame} flash={board.touch} />
          ) : null}
          <FrameDrawing frameKey={key} native={native} shown={shownDrawing} />
        </div>
        <FramePins
          targetId={pageId}
          viewport={viewport}
          env={env}
          clusters={clusters}
          scale={pinScale}
          compact={compactPins}
          selectedCommentId={selectedCommentId}
          landedId={landedId}
        />
        {draft ? <DraftPin draft={draft} scale={pinScale} name={board.me?.name} colorKey={board.me?.name} /> : null}
      </div>
    </>
  )
}
