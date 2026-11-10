import { useEffect } from 'react'
import { MiniMap, Panel, useReactFlow, useStore, useStoreApi } from '@xyflow/react'
import { Map as MapIcon, Maximize, Minus, Plus } from 'lucide-react'
import { cn } from '../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Kbd,
  Tooltip,
} from '../components/ui'
import { TITLE_ROOM } from './layout'
import { isEditable } from './navigation'
import { motionDuration } from '../lib/motion'
import { KeyTip } from './KeyTip'

const TITLE_PX = 30
const GROUP_LABEL_PX = 28
const GROUP_ROOM = 240

// The zoom as CSS variables on the React Flow root, for the parts of the
// canvas that keep their size on screen (card titles, group labels, frame
// labels, chips; nodes.jsx). Set straight on the element from the store, so
// zooming re-renders no React component.
export function zoomVars(zoom) {
  const inv = 1 / zoom
  return {
    '--sw-zoom': zoom.toFixed(4),
    '--sw-inv': inv.toFixed(4),
    // A card title row fits in the room above its card; past that it shrinks.
    '--sw-title-scale': Math.min(inv, TITLE_ROOM / TITLE_PX).toFixed(4),
    // Titles fade out when cards are too small to read (the group names stay).
    '--sw-title-fade': Math.max(0, Math.min(1, (zoom - 0.16) * 25)).toFixed(3),
    '--sw-group-scale': Math.min(inv, GROUP_ROOM / GROUP_LABEL_PX).toFixed(4),
    '--sw-label-scale': Math.min(inv, 1.6).toFixed(4),
    '--sw-chip-scale': Math.min(inv, 1).toFixed(4),
  }
}

function ZoomVars() {
  const store = useStoreApi()
  useEffect(() => {
    let last = null
    const apply = (state) => {
      const zoom = state.transform[2]
      const node = state.domNode
      if (!node || zoom === last) return
      last = zoom
      for (const [name, value] of Object.entries(zoomVars(zoom))) node.style.setProperty(name, value)
    }
    apply(store.getState())
    return store.subscribe(apply)
  }, [store])
  return null
}

// Shift+1 fits the board, Shift+0 goes to 100%, + and - zoom (not while typing).
function useZoomKeys({ fitBoard, zoomTo }) {
  const flow = useReactFlow()
  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isEditable(event.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      if (event.shiftKey && event.code === 'Digit1') fitBoard()
      else if (event.shiftKey && event.code === 'Digit0') zoomTo(1)
      else if (!event.shiftKey && (event.key === '=' || event.key === '+')) flow.zoomIn({ duration: motionDuration(200) })
      else if (!event.shiftKey && event.key === '-') flow.zoomOut({ duration: motionDuration(200) })
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fitBoard, flow, zoomTo])
}

// Inside the canvas. Desktop: one zoom cluster (out, the zoom level with a
// menu, in, fit, minimap) bottom left, and a small minimap bottom right.
// Phone: a fit button (hidden while a journey bar is up).
export function CanvasControls({
  wide,
  clearFocus,
  setSettledZoom,
  minimapOn,
  liveKeys,
  toggleMinimap,
  hideFit,
  hideMinimap = false,
  fitBoard,
}) {
  const flow = useReactFlow()
  const percent = useStore((state) => Math.round(state.transform[2] * 100))
  const zoomTo = (zoom) => {
    clearFocus()
    setSettledZoom(null)
    const { x, y, zoom: current } = flow.getViewport()
    const box = document.querySelector('[data-sw-canvas]')?.getBoundingClientRect()
    const cx = (box?.width || 0) / 2
    const cy = (box?.height || 0) / 2
    const ratio = zoom / current
    flow.setViewport({ x: cx - (cx - x) * ratio, y: cy - (cy - y) * ratio, zoom }, { duration: motionDuration(250) })
  }
  useZoomKeys({ fitBoard, zoomTo })
  if (!wide) {
    return (
      <>
        <ZoomVars />
        <Panel position="bottom-left" className={cn('!m-2', hideFit && 'hidden')}>
          <IconButton
            size="icon"
            variant="secondary"
            className="bg-surface/95 shadow-pop backdrop-blur"
            onClick={fitBoard}
            label="Fit the whole board"
            data-sw-fit="true"
          >
            <Maximize size={17} aria-hidden="true" />
          </IconButton>
        </Panel>
      </>
    )
  }
  const showMinimap = minimapOn && !liveKeys.size && !hideMinimap
  const minimapTip =
    minimapOn && liveKeys.size ? 'Minimap: hidden while a page is live' : minimapOn ? 'Hide the minimap' : 'Show the minimap'
  const button = 'h-8 w-8 rounded-md text-muted shadow-none hover:bg-surface-2 hover:text-fg'
  return (
    <>
      <ZoomVars />
      <Panel position="bottom-left" className="!m-3">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-line bg-surface/95 p-0.5 shadow-pop backdrop-blur"
          role="group"
          aria-label="Zoom"
          data-sw-zoom-controls="true"
        >
          <IconButton
            className={cn(button, 'react-flow__controls-zoomout')}
            onClick={() => flow.zoomOut({ duration: motionDuration(200) })}
            label="Zoom out"
            tooltip={<KeyTip label="Zoom out" keys={['-']} />}
          >
            <Minus size={15} aria-hidden="true" />
          </IconButton>
          <DropdownMenu>
            <Tooltip content="Zoom level">
              <DropdownMenuTrigger
                className="tabular h-8 min-w-12 rounded-md px-1.5 text-xs font-medium text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={`Zoom ${percent}%`}
                data-sw-zoom-level={percent}
              >
                {percent}%
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent side="top" align="start" className="min-w-52">
              <DropdownMenuItem onSelect={() => flow.zoomIn({ duration: motionDuration(200) })}>
                Zoom in <Kbd className="ml-auto">+</Kbd>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => flow.zoomOut({ duration: motionDuration(200) })}>
                Zoom out <Kbd className="ml-auto">-</Kbd>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => zoomTo(0.5)}>Zoom to 50%</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => zoomTo(1)}>
                Zoom to 100% <Kbd className="ml-auto">Shift 0</Kbd>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => zoomTo(2)}>Zoom to 200%</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={fitBoard}>
                Fit the whole board <Kbd className="ml-auto">Shift 1</Kbd>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton
            className={cn(button, 'react-flow__controls-zoomin')}
            onClick={() => flow.zoomIn({ duration: motionDuration(200) })}
            label="Zoom in"
            tooltip={<KeyTip label="Zoom in" keys={['+']} />}
          >
            <Plus size={15} aria-hidden="true" />
          </IconButton>
          <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
          <IconButton
            className={cn(button, 'react-flow__controls-fitview')}
            onClick={fitBoard}
            label="Fit the whole board"
            tooltip={<KeyTip label="Fit the whole board" keys={['Shift', '1']} />}
          >
            <Maximize size={14} aria-hidden="true" />
          </IconButton>
          <IconButton
            className={cn(button, minimapOn && 'text-accent hover:text-accent')}
            aria-pressed={minimapOn}
            onClick={toggleMinimap}
            label={minimapOn ? 'Hide the minimap' : 'Show the minimap'}
            tooltip={minimapTip}
            data-sw-minimap-toggle={minimapOn ? (liveKeys.size ? 'auto-hidden' : 'on') : 'off'}
          >
            <MapIcon size={14} aria-hidden="true" />
          </IconButton>
        </div>
      </Panel>
      {showMinimap ? (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          className="!m-3 overflow-hidden !rounded-lg shadow-pop"
          style={{ width: 168, height: 104 }}
          bgColor="color-mix(in srgb, var(--surface) 88%, transparent)"
          maskColor="color-mix(in srgb, var(--sunken) 55%, transparent)"
          maskStrokeColor="var(--accent)"
          maskStrokeWidth={2}
          nodeBorderRadius={6}
          nodeColor={(node) =>
            node.type === 'groupFrame' ? 'color-mix(in srgb, var(--fg) 5%, transparent)' : 'color-mix(in srgb, var(--fg) 28%, transparent)'
          }
          nodeStrokeWidth={0}
          ariaLabel="Minimap"
          data-sw-minimap="true"
        />
      ) : null}
    </>
  )
}
