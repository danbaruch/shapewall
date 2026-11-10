// One frame of a card: the screenshot (or the page's live HTML), its pins,
// the draft pin and the hover outline; and a compare frame.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@xyflow/react'
import { ImageOff, Info } from 'lucide-react'
import { pinSpot } from './layout'
import { anchorAt, describeElement, elementAt, resolveAnchor } from './anchors'
import { frameDom } from './frameDom'
import { useElementMap } from './elementMaps'
import { anchorFromMap, describeAt, hitTest, resolveOnMap } from '../../../src/capture/element-map.js'
import { DOT_CLUSTER_PX, DraftPin, Pin, PinCluster, clusterPins, pinLookAt } from './pins'
import { cn } from '../lib/utils'
import { useBoardView } from './boardView'
import { BoardContext } from './boardContext'

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
function LiveDoc({ src, viewport, native, frame, selecting, opaque, onReady }) {
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

// An agent is working on this comment: its own status, or the chat's
// "agent focus" store (chat/agentFocus.js).
function isWorking(board, comment) {
  return comment.agentStatus === 'working' || Boolean(board.agentWorking?.has(comment.id))
}

export function Frame({ targetId, frame, image, kind, version, emptyText, note }) {
  const board = useContext(BoardContext)
  // A page with its own frame height carries its frame's size (layout.js).
  const native = frame.native || board.viewports[frame.viewport]
  // Pins keep roughly the same size on screen at any zoom: 28 px on a
  // readable frame, down to 18 px on a small one, and a 10 px dot once the
  // frame is a thumbnail (it covers no more of the page than it must). On
  // touch they never shrink below their 44 px hit area; as dots they let the
  // tap through to the card, which zooms in first.
  const pinMax = board.touch ? 50 : 6
  const { viewport } = frame
  const liveKey = `${targetId}|${viewport}`
  // The open thread, when it is on this frame: it keeps its pin even when the
  // filter hides it (just resolved).
  const comparing = Boolean(board.compare)
  const openHere = useBoardView((state) => {
    const open = state.selectedComment
    return !comparing && open && open.pageId === targetId && open.viewport === viewport ? open : null
  })
  const listed = board.pinsFor(targetId, viewport)
  const pins = useMemo(() => (openHere && !listed.includes(openHere) ? [...listed, openHere] : listed), [listed, openHere])
  const selectedCommentId = openHere?.id ?? null
  const draft = useBoardView((state) => {
    const spot = state.draftSpot
    return spot && spot.pageId === targetId && spot.viewport === viewport ? spot : null
  })
  const live = useBoardView((state) => Boolean(image?.live) && state.liveKeys.has(liveKey))
  // A frame with nothing pinned (and no hover outline possible) skips the pin
  // zoom subscriptions, so zooming does not re-render it for them.
  const scalesPins = pins.length > 0 || Boolean(draft) || (board.commentMode && live)
  const pinLook = useStore((state) => (scalesPins ? pinLookAt(state.transform[2], frame.w, board.touch, pinMax, Boolean(draft)) : 'full:1'))
  const compactPins = pinLook.startsWith('dot:')
  const pinScale = Number(pinLook.slice(pinLook.indexOf(':') + 1))
  // Clusters are worked out per zoom step, not on every frame of a zoom (and
  // never for fewer than two pins, where the zoom does not matter).
  const clusterZoom = useStore((state) => (pins.length > 1 ? Math.round(state.transform[2] * 20) / 20 : 1))
  const selecting = useBoardView((state) => state.selectingKey === liveKey) && live
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
  // This frame's unread pins as one string, so reading a thread elsewhere
  // changes nothing here.
  const unreadIds = useBoardView((state) =>
    pins.length
      ? pins
          .filter((comment) => state.unread.has(comment.id))
          .map((comment) => comment.id)
          .join(',')
      : '',
  )
  const clusters = useMemo(() => {
    const unread = new Set(unreadIds ? unreadIds.split(',') : [])
    return clusterPins(
      pins.map((comment) => {
        const position = positions?.get(comment.id) || null
        return { comment, position, spot: pinSpot(comment, position), unread: unread.has(String(comment.id)) }
      }),
      frame,
      clusterZoom,
      selectedCommentId,
      compactPins ? DOT_CLUSTER_PX : undefined,
    )
  }, [pins, positions, unreadIds, frame, clusterZoom, selectedCommentId, compactPins])
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

  // Comment mode on live HTML: outline the element a click would pin to,
  // with a short label, so a click in a gap does not land on a whole
  // section unnoticed. Mouse only (a tap has no hover).
  const [hover, setHover] = useState(null)
  const hoverFrame = useRef(0)
  const canHover = board.commentMode && live && Boolean(map || doc) && !board.touch
  useEffect(() => {
    if (!canHover) setHover(null)
  }, [canHover])
  useEffect(() => () => window.cancelAnimationFrame(hoverFrame.current), [])
  const onMouseMove = (event) => {
    if (!canHover) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * native.width
    const y = ((event.clientY - rect.top) / rect.height) * native.height
    window.cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = window.requestAnimationFrame(() => {
      if (map) {
        const position = hitTest(map, x, y)
        setHover(position >= 0 ? describeAt(map, position, native) : null)
        return
      }
      const element = elementAt(doc, x, y)
      setHover(element ? describeElement(doc, element, native) : null)
    })
  }

  const onClick = (event) => {
    event.stopPropagation()
    // Outside comment mode a tap selects the card; its actions appear in a
    // screen-space bar, usable at any zoom.
    if (!board.commentMode) {
      board.onFocusFrame(targetId, frame.viewport)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const fx = (event.clientX - rect.left) / rect.width
    const fy = (event.clientY - rect.top) / rect.height
    const pin = {
      pageId: targetId,
      viewport: frame.viewport,
      x: Math.max(0, Math.min(100, fx * 100)),
      y: Math.max(0, Math.min(100, fy * 100)),
    }
    // On a live page the tap is also anchored to the element under it.
    if (live && (map || doc)) {
      const x = fx * native.width
      const y = fy * native.height
      const anchor = map ? anchorFromMap(map, x, y, native) : anchorAt(doc, x, y, native)
      if (anchor) pin.anchor = anchor
    }
    setHover(null)
    board.onPin(pin)
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
          'absolute overflow-hidden rounded-sm border border-line bg-surface-2',
          board.commentMode && 'nodrag nopan cursor-crosshair',
          live && 'border-accent/60',
          focused && 'outline-2 outline-offset-2 outline-accent',
        )}
        style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
        onClick={onClick}
        onMouseMove={canHover ? onMouseMove : undefined}
        onMouseLeave={canHover ? () => setHover(null) : undefined}
        data-sw-frame={`${targetId}:${frame.viewport}`}
        data-sw-image={src ? (full ? 'full' : 'thumb') : 'none'}
        data-sw-live={live ? (ready ? 'ready' : 'loading') : 'off'}
        data-sw-live-anchors={live ? (opaque ? (map ? 'map' : 'none') : 'dom') : undefined}
      >
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
            selecting={selecting && !board.commentMode}
            opaque={opaque}
            onReady={onFrame}
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
        {hover && canHover ? <HoverOutline hover={hover} native={native} scale={pinScale} /> : null}
        {clusters.map((group) =>
          group.items.length === 1 ? (
            <Pin
              key={group.items[0].comment.id}
              comment={group.items[0].comment}
              position={group.items[0].position}
              scale={pinScale}
              compact={compactPins}
              selected={selectedCommentId === group.items[0].comment.id}
              unread={group.items[0].unread}
              working={isWorking(board, group.items[0].comment)}
              onSelect={board.onSelectComment}
              onHover={board.onHoverComment}
              touch={board.touch}
            />
          ) : (
            <PinCluster
              key={`cluster-${group.items[0].comment.id}`}
              items={group.items}
              compact={compactPins}
              touch={board.touch}
              working={group.items.some((item) => isWorking(board, item.comment))}
              scale={pinScale}
              onOpen={(items) => board.onOpenCluster(targetId, frame.viewport, items)}
            />
          ),
        )}
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

// The element a click would pin a comment to, outlined, with its selector.
function HoverOutline({ hover, native, scale }) {
  const { rect } = hover
  const percent = (value, size) => `${(value / size) * 100}%`
  const below = rect.top / native.height < 0.04
  return (
    <div
      className={cn(
        'pointer-events-none absolute z-[5] rounded-[2px] border-accent bg-accent/5',
        hover.large ? 'border-dashed' : 'border-solid',
      )}
      style={{
        left: percent(rect.left, native.width),
        top: percent(rect.top, native.height),
        width: percent(rect.width, native.width),
        height: percent(rect.height, native.height),
        borderWidth: 2 * scale,
      }}
      data-sw-hover-outline={hover.large ? 'large' : 'element'}
    >
      <span
        className="absolute left-0 max-w-[320px] truncate rounded-sm bg-accent px-1 font-mono text-[10px] leading-4 whitespace-nowrap text-accent-fg"
        style={{
          [below ? 'top' : 'bottom']: '100%',
          transform: `scale(${scale})`,
          transformOrigin: below ? 'top left' : 'bottom left',
          marginTop: below ? 2 * scale : 0,
          marginBottom: below ? 0 : 2 * scale,
        }}
        data-sw-hover-label="true"
      >
        {hover.label}
        {hover.large ? ' · whole section' : ''}
      </span>
    </div>
  )
}

// Compare mode: one environment's screenshot of the page. The second
// environment's frame carries the pixel diff as a red overlay and its share.
export function CompareFrame({ pageId, frame }) {
  const board = useContext(BoardContext)
  const { compare } = board
  const native = frame.native || board.viewports[frame.viewport]
  const image = compare.files?.[frame.env]?.[pageId]?.[frame.viewport]
  const sharp = useBoardView((state) => wantsFull(frame, state.settledZoom, native))
  const full = image && (!image.thumb || sharp)
  const src = image ? board.imageUrl(compare.kindOf(frame.env), full ? image.file : image.thumb, compare.versionOf(frame.env)) : null
  const result = compare.pages?.[pageId]?.[frame.viewport]
  const failure = image ? null : compare.failures?.[frame.env]?.[pageId]?.[frame.viewport] || null
  const second = frame.env === compare.b
  const diff = second && compare.showDiff && result?.status === 'ok' && result.percent > 0 ? result.diff : null
  return (
    <>
      <FrameLabel frame={frame}>
        {frame.viewport} · {compare.titleOf(frame.env)}
        {second && result?.status === 'ok' ? <span className="text-accent"> · {result.percent}% changed</span> : null}
      </FrameLabel>
      <div
        className="absolute overflow-hidden rounded-sm border border-line bg-surface-2"
        style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
        data-sw-frame={`${pageId}:${frame.viewport}:${frame.env}`}
        data-sw-image={src ? (full ? 'full' : 'thumb') : 'none'}
      >
        {src ? (
          <img
            src={src}
            alt={`${frame.viewport} screenshot, ${compare.titleOf(frame.env)}`}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={board.onImageError}
            className="pointer-events-none block h-full w-full object-cover object-top select-none"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <ImageOff size={22} className="text-faint" aria-hidden="true" />
            <p className="text-[11px] leading-4 text-muted" data-sw-compare-failed={failure ? 'true' : undefined}>
              {failure ? `Capture failed: ${failure}` : `Not captured in ${compare.titleOf(frame.env)} yet.`}
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
      </div>
    </>
  )
}
