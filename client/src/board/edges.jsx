import { memo } from 'react'
import { EdgeLabelRenderer, useInternalNode, useStore } from '@xyflow/react'
import { cn } from '../lib/utils'

// Arrows between page cards: links found in the captures, and the steps of
// a journey. They run from border to border of the two cards (not from
// fixed handles), curve a little so a -> b and b -> a stay apart, and keep
// their on-screen thickness at any zoom.

// Where the line from the rectangle's center towards (tx, ty) leaves it.
function borderPoint(rect, tx, ty) {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const dx = tx - cx
  const dy = ty - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const scale = Math.min(dx ? rect.w / 2 / Math.abs(dx) : Infinity, dy ? rect.h / 2 / Math.abs(dy) : Infinity)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

function rectOf(node) {
  if (!node) return null
  const { x, y } = node.internals.positionAbsolute
  const w = node.measured?.width ?? node.width ?? 0
  const h = node.measured?.height ?? node.height ?? 0
  return w && h ? { x, y, w, h } : null
}

// Geometry of a curved edge between two cards: path, the arrowhead and the
// midpoint (for a label). Pure, so it can be tested on its own.
export function edgeGeometry(source, target, { bend = 0.12, gap = 6 } = {}) {
  const sc = { x: source.x + source.w / 2, y: source.y + source.h / 2 }
  const tc = { x: target.x + target.w / 2, y: target.y + target.h / 2 }
  const start = borderPoint(source, tc.x, tc.y)
  const endRaw = borderPoint(target, sc.x, sc.y)
  const dx = endRaw.x - start.x
  const dy = endRaw.y - start.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const end = { x: endRaw.x - ux * gap, y: endRaw.y - uy * gap }
  // Control point to the left of the direction of travel.
  const control = { x: (start.x + end.x) / 2 + uy * length * bend, y: (start.y + end.y) / 2 - ux * length * bend }
  const mid = { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 }
  // Tangent at the end of the curve, for the arrowhead.
  const tx = end.x - control.x
  const ty = end.y - control.y
  const tl = Math.hypot(tx, ty) || 1
  return { path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`, end, dir: { x: tx / tl, y: ty / tl }, mid }
}

const STYLES = {
  // Link arrows: quiet until a card is hovered or selected.
  idle: { stroke: 'var(--faint)', width: 1.25, opacity: 0.35 },
  out: { stroke: 'var(--accent)', width: 2, opacity: 0.95 },
  in: { stroke: 'var(--muted)', width: 1.5, opacity: 0.7 },
  journey: { stroke: 'var(--accent)', width: 3, opacity: 0.95 },
  done: { stroke: 'var(--accent)', width: 2.5, opacity: 0.45 },
  // Branches of an open journey that the path being stepped through does not take.
  alt: { stroke: 'var(--faint)', width: 2, opacity: 0.6, dash: 3 },
}

export const FlowEdge = memo(function FlowEdge({ id, source, target, data }) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  // Thickness in screen pixels: divide by the zoom (bucketed, so edges
  // re-render only when the bucket changes).
  const unit = useStore((state) => Math.min(40, Math.max(0.25, Math.round((1 / state.transform[2]) * 8) / 8)))
  const a = rectOf(sourceNode)
  const b = rectOf(targetNode)
  if (!a || !b) return null
  const style = STYLES[data?.tone] || STYLES.idle
  const { path, end, dir, mid } = edgeGeometry(a, b, { bend: data?.bend ?? 0.12, gap: 4 * unit })
  const head = (style.width * 2.5 + 5) * unit
  const px = -dir.y
  const py = dir.x
  const arrow = [
    `${end.x},${end.y}`,
    `${end.x - dir.x * head + px * head * 0.55},${end.y - dir.y * head + py * head * 0.55}`,
    `${end.x - dir.x * head - px * head * 0.55},${end.y - dir.y * head - py * head * 0.55}`,
  ].join(' ')
  return (
    <g className="sw-flow-edge" data-sw-edge={id} data-sw-edge-tone={data?.tone || 'idle'} style={{ opacity: style.opacity }}>
      <path
        d={path}
        fill="none"
        stroke={style.stroke}
        strokeWidth={style.width * unit}
        strokeLinecap="round"
        strokeDasharray={style.dash ? `${style.dash * style.width * unit} ${style.dash * style.width * unit}` : undefined}
      />
      <polygon points={arrow} fill={style.stroke} />
      {data?.label || data?.branch ? (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan pointer-events-none absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px) scale(${Math.min(unit, 2)})` }}
          >
            {data.label ? (
              <span
                className="flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-surface bg-accent px-1 text-[11px] font-bold text-accent-fg shadow-pop"
                data-sw-edge-label={data.label}
              >
                {data.label}
              </span>
            ) : null}
            {data.branch ? (
              <span
                className={cn(
                  'flex h-6 max-w-48 items-center truncate rounded-full border-2 px-2 text-[11px] font-semibold whitespace-nowrap shadow-pop',
                  data.tone === 'alt' ? 'border-line bg-surface text-muted' : 'border-surface bg-accent text-accent-fg',
                )}
                data-sw-edge-branch={data.branch}
              >
                {data.branch}
              </span>
            ) : null}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  )
})

export const EDGE_TYPES = { flow: FlowEdge }
