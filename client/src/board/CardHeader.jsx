import { cn } from '../lib/utils'
import { CardTip } from './CardTip'
import { StepDots } from './CardBadges'

// Screen-constant pieces of the canvas (titles, labels, badges) read CSS
// variables that CanvasControls' ZoomVars keeps on the React Flow root, so a
// zoom re-renders none of them:
//   --sw-inv          1 / zoom
//   --sw-title-scale  1 / zoom, capped so a card's title row fits above it
//   --sw-title-fade   1, fading to 0 when cards get too small to read
//   --sw-group-scale  1 / zoom, capped so a group label fits above its frame
//   --sw-chip-scale   1 / zoom, capped at 1 (chips never grow past board size)
const TITLE_SCALE = 'var(--sw-title-scale, 1)'

// The full title (and path and note) of a card, for its tooltip.
export function TitleTip({ title, path, note }) {
  return (
    <span className="block">
      <span className="block font-semibold">{title}</span>
      {path ? <span className="block font-mono text-[11px] opacity-80">{path}</span> : null}
      {note ? <span className="mt-0.5 block font-normal opacity-80">{note}</span> : null}
    </span>
  )
}

// A card's one header row, above the card like a Figma frame name: the
// title (its path on hover), then a compact cluster of badges. It keeps the
// same size on screen at any zoom (until the card gets too small to read,
// when it fades out), and measures its own on-screen width with a container
// query, so the badges and path only show where they fit.
export function CardHeader({ width, title, tip, path, steps, current, only, tag, badges, onTitle, accent = false }) {
  return (
    <div
      className="@container pointer-events-none absolute bottom-full left-0 z-10 origin-bottom-left pb-1"
      style={{
        width: `calc(${width}px / ${TITLE_SCALE})`,
        transform: `scale(${TITLE_SCALE})`,
        opacity: 'var(--sw-title-fade, 1)',
      }}
      data-sw-card-header="true"
    >
      <div className="flex h-6 min-w-0 items-center gap-1.5">
        <StepDots steps={steps} current={current} />
        <CardTip content={tip} side="top" align="start">
          <p
            className={cn(
              'nodrag nopan pointer-events-auto min-w-0 shrink cursor-default truncate text-[12.5px] leading-6 font-semibold',
              accent ? 'text-accent' : 'text-fg',
            )}
            onClick={onTitle}
            data-sw-card-title="true"
          >
            {title}
            {path ? (
              <span className="ml-1.5 hidden font-mono text-[11px] font-normal text-faint group-hover/card:@min-[200px]:inline">
                {path}
              </span>
            ) : null}
          </p>
        </CardTip>
        {only ? (
          <span
            className="hidden shrink-0 rounded bg-surface-2 px-1 text-[10px] leading-4 font-medium text-muted @min-[150px]:block"
            data-sw-only
          >
            {only}
          </span>
        ) : null}
        {tag ? (
          <span className="hidden shrink-0 rounded bg-surface-2 px-1 text-[10px] leading-4 font-medium text-muted @min-[200px]:block">
            {tag}
          </span>
        ) : null}
        <span className="ml-auto hidden shrink-0 items-center gap-0.5 @min-[130px]:flex" data-sw-card-badges="true">
          {badges}
        </span>
      </div>
    </div>
  )
}
