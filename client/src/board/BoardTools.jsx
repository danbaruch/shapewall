// The board's tools: a small floating toolbar at the bottom centre of the
// canvas, the way FigJam, Miro and tldraw do it. It holds what you do TO the
// board, one tool at a time:
//   Select       the default pointer: click a page or a pin, drag empty
//                canvas to pan (V; Esc comes back to it)
//   Hand         drag anywhere to pan, pages and pins too; a click opens
//                nothing (H; holding Space is a temporary hand). Desktop only
//   Comment      click a page to pin a comment (C)
//   Draw         click a page to draw on it: a box, an arrow or the pen. A
//                drawing is part of a comment, so with a comment or a reply
//                open, Draw draws on that comment's page
//   Select text  on the selected live page (desktop)
// The board toolbar at the top keeps what you look AT (the board, the screen
// sizes, Views, the side panels). The tools a person may not use are not
// shown; with only Select left there is no toolbar at all. Someone who may
// not comment gets Select and Select text only while a page is live.
//
// The dock is one column along the bottom of the canvas, so nothing in it
// can overlap: the toast, the journey bar, the note for the tool in use (the
// comment hint, "Commenting on ...", the drawing bar, the select-text note)
// and the tools last. toolDock.js keeps the tools clear of the zoom controls
// and the minimap.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Brush, Hand, MessageSquarePlus, MousePointer2, TextSelect } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button, Tooltip } from '../components/ui'
import { useBoardView } from './boardView'
import { KeyTip } from './KeyTip'
import { POINTER_TOOLS, hasDivider } from './tools'

export const TOOLS = {
  select: { label: 'Select', tip: 'Select: click a page or a pin', keys: ['V'], shortcut: 'V', icon: MousePointer2 },
  hand: { label: 'Hand', tip: 'Hand: drag anywhere to move, opens nothing', keys: ['H'], shortcut: 'H', icon: Hand },
  comment: { label: 'Comment', tip: 'Comment: click a page to pin a note', keys: ['C'], shortcut: 'C', icon: MessageSquarePlus },
  draw: { label: 'Draw', tip: 'Draw on a page: box, arrow or pen', keys: [], icon: Brush },
  text: { label: 'Select text', tip: 'Select text on the selected live page', keys: [], icon: TextSelect },
}

// The column along the bottom of the canvas. It takes no pointer itself and
// makes no layer of its own (each child sets its own).
export function ToolDock({ touch, children }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2',
        touch ? 'px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]' : 'px-3 pb-3',
      )}
      data-sw-tool-dock="true"
    >
      {children}
    </div>
  )
}

// The toolbar. `tools`: the ids this person has, in order. `active`: the one
// in use. `onTool(id)`: a click (or Enter, Space) on one. `shift`: px off the
// canvas's centre (toolDock.js). A labelled toolbar with one tab stop: the
// arrow keys, Home and End move between its tools.
export function BoardTools({ tools, active, onTool, touch, shift = 0 }) {
  const bar = useRef(null)
  const divided = hasDivider(tools)
  const onKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const buttons = Array.from(bar.current?.querySelectorAll('button[data-sw-tool]') || [])
    const at = buttons.indexOf(document.activeElement)
    if (at < 0) return
    let next = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % buttons.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1
    if (next === null) return
    // The arrows are the toolbar's here, not the canvas's or a journey's.
    event.preventDefault()
    event.stopPropagation()
    buttons[next].focus()
  }
  return (
    <div
      ref={bar}
      className={cn(
        'pointer-events-auto relative z-30 flex items-center gap-0.5 rounded-lg border border-line bg-surface/95 p-0.5 shadow-pop backdrop-blur',
        touch && 'rounded-xl',
      )}
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      role="toolbar"
      aria-label="Board tools"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      data-sw-tools={active}
    >
      {tools.map((id) => {
        const tool = TOOLS[id]
        const on = id === active
        // Select and Hand in use are quiet: the neutral fill of a chosen
        // segment (the screen-size switch). The filled accent is for the
        // tools that change what a click does: Comment, Draw, Select text.
        const quiet = on && POINTER_TOOLS.has(id)
        const button = (
          <Button
            key={id}
            variant={on && !quiet ? 'default' : 'ghost'}
            size={touch ? 'icon' : 'icon-sm'}
            className={cn(
              'shadow-none focus-visible:outline-offset-1',
              touch && 'rounded-lg',
              !on && 'text-fg/80 hover:text-fg',
              quiet && 'bg-surface-2 text-fg ring-1 ring-line-strong/70 ring-inset hover:bg-surface-2',
            )}
            data-sw-tool-look={on ? (quiet ? 'quiet' : 'accent') : undefined}
            aria-label={tool.label}
            aria-pressed={on}
            aria-keyshortcuts={tool.shortcut}
            tabIndex={on ? 0 : -1}
            onClick={() => onTool(id)}
            data-sw-tool={id}
            // The name the tests and the docs' screenshots have always used.
            data-sw-comment-mode={id === 'comment' ? 'true' : undefined}
          >
            <tool.icon size={touch ? 19 : 16} aria-hidden="true" />
          </Button>
        )
        // Touch screens have no hover (and a tap would leave the tip up).
        const item = touch ? (
          button
        ) : (
          <Tooltip key={id} content={<KeyTip label={tool.tip} keys={tool.keys} />} side="top">
            {button}
          </Tooltip>
        )
        // A hairline between moving around (Select, Hand) and the rest.
        return id === 'hand' && divided ? (
          <Fragment key={id}>
            {item}
            <span className="mx-0.5 h-5 w-px shrink-0 bg-line" aria-hidden="true" data-sw-tools-divider="true" />
          </Fragment>
        ) : (
          item
        )
      })}
    </div>
  )
}

const NOTE =
  'pointer-events-auto relative z-30 flex w-max max-w-full items-center gap-2 rounded-[18px] py-0.5 pr-0.5 pl-3 text-xs font-medium shadow-pop'

// The note for the tool in use, just above the tools. One at a time; Select
// has none.
//   picking    comment mode, nothing picked yet ({ live, draw })
//   composing  a target is picked, its composer is open ({ target, onCancel })
//   selectText "Select text" is on for a page ({ title, onDone })
export function ToolNote({ wide, picking = null, composing = null, selectText = null, onDone }) {
  // "Select text" on a live page: armed, or the page has the mouse.
  const reading = useBoardView((state) => Boolean(state.readingKey))
  if (composing) {
    // The note says what the comment is on, and Esc (or Cancel) goes back
    // one step, to picking.
    return (
      <div
        className={cn(NOTE, 'border border-line bg-surface text-fg')}
        role="status"
        data-sw-tool-note="true"
        data-sw-comment-hint="composing"
      >
        <MessageSquarePlus size={13} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 truncate" data-sw-comment-hint-target="true">
          <span className="text-muted">Commenting on</span> {composing.target}
        </span>
        <Button size="xs" variant="ghost" className="shrink-0 rounded-full" onClick={composing.onCancel} data-sw-comment-hint-cancel="true">
          Cancel (Esc)
        </Button>
      </div>
    )
  }
  if (picking) {
    const Icon = picking.draw ? Brush : MessageSquarePlus
    const verb = wide ? 'Click' : 'Tap'
    const text = picking.draw
      ? `${verb} a page to draw on it. The drawing goes with your comment.`
      : picking.live
        ? `${verb} an element on the live page to comment on it.`
        : wide
          ? 'Click a page to comment. Zoom in until the page goes live to pin it to an element.'
          : 'Tap a page to pin a comment.'
    return (
      <div
        className={cn(NOTE, 'bg-accent text-accent-fg')}
        role="status"
        data-sw-tool-note="true"
        data-sw-comment-hint={picking.draw ? 'draw' : picking.live ? 'element' : 'page'}
      >
        <Icon size={13} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0">{text}</span>
        <Button
          size={wide ? 'xs' : 'touch'}
          variant="inverse"
          className="shrink-0 rounded-full"
          onClick={onDone}
          data-sw-comment-hint-done="true"
        >
          Done{wide ? ' (Esc)' : ''}
        </Button>
      </div>
    )
  }
  if (selectText) {
    // "Select text" is a mode with two steps; this says which, and how to
    // get the board's scrolling and zoom back.
    return (
      <div
        className={cn(NOTE, 'border border-line bg-surface text-fg')}
        role="status"
        data-sw-tool-note="true"
        data-sw-select-text-note={reading ? 'reading' : 'armed'}
      >
        <TextSelect size={13} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0">
          {reading
            ? `Selecting text on ${selectText.title}. Move the pointer off the page to scroll and zoom the board again.`
            : `Select text is on for ${selectText.title}: click the page, then select and copy.`}
        </span>
        <Button size="xs" variant="ghost" className="shrink-0 rounded-full" onClick={selectText.onDone} data-sw-select-text-done="true">
          Done
        </Button>
      </div>
    )
  }
  return null
}

// The canvas's width, for placing the tools (toolDock.js).
export function useCanvasWidth(canvasRef) {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useLayoutEffect(() => {
    const node = canvasRef.current
    if (!node) return undefined
    const read = () => setWidth(Math.round(node.getBoundingClientRect().width))
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [canvasRef])
  return width
}

// A phone's on-screen keyboard is up: the page's visible height is well short
// of the window's. The tools step aside for it.
export function useKeyboardUp(enabled) {
  const [up, setUp] = useState(false)
  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport
    if (!enabled || !viewport) {
      setUp(false)
      return undefined
    }
    const read = () => setUp(window.innerHeight - viewport.height > 120)
    read()
    viewport.addEventListener('resize', read)
    return () => viewport.removeEventListener('resize', read)
  }, [enabled])
  return up
}
