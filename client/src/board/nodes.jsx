import { memo, useContext } from 'react'
import { Handle, Position } from '@xyflow/react'
import { ExternalLink, Lightbulb } from 'lucide-react'
import { pageChangeAt } from './flow'
import { CaptureWarnings } from './CaptureWarnings'
import { cn } from '../lib/utils'
import { CardTip } from './CardTip'
import { BoardContext } from './boardContext'
import { CompareFrame, Frame } from './Frame'
import {
  AgentWorkingBadge,
  COARSE_HIT,
  ChangeBadge,
  ChecksBadge,
  CountBadge,
  HistoryBadge,
  LiveChip,
  useLiveSingleFrame,
} from './CardBadges'
import { CardHeader, TitleTip } from './CardHeader'

// Board.jsx provides it; the pieces read it from boardContext.js.
export { BoardContext }

const hiddenHandle = '!h-1 !w-1 !min-w-0 !border-0 !bg-transparent'

function statusText(board, status, viewport) {
  if (status?.[viewport]?.status === 'failed') return `Capture failed: ${status[viewport].error}`
  if (board.manifest) return 'No capture for this screen size.'
  // The command only helps where the board runs on the reader's own machine.
  return board.domFallback ? 'Not captured yet. Run "shapewall capture".' : 'Not captured yet.'
}

// "Desktop only" for a page limited to some of the board's viewports.
function onlyLabel(only, viewports) {
  const names = Object.keys(viewports || {})
  if (!Array.isArray(only) || !only.length || names.every((name) => only.includes(name))) return null
  const text = names
    .filter((name) => only.includes(name))
    .map((name) => name.replace(/-/g, ' '))
    .join(' and ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} only`
}

export const PageNode = memo(function PageNode({ data, width }) {
  const board = useContext(BoardContext)
  const { page, frames } = data
  const files = board.captures[page.id] || {}
  const status = board.manifest?.pages?.[page.id]
  const steps = board.journey?.steps.get(page.id) || null
  // On a branch of the journey that the current path does not take.
  const offPath = !steps && Boolean(board.journey?.offPath?.has(page.id))
  const faded = Boolean(board.journey) && !steps && !offPath
  const current = board.journey?.currentPage === page.id
  const only = onlyLabel(page.viewports, board.viewports)
  const change = board.compare ? pageChangeAt(board.compare, page.id) : null
  // Compare: changed pages stand out, unchanged ones step back.
  const changed = Boolean(change?.percent > 0)
  const same = Boolean(board.compare) && change && !changed
  const working = board.agentWorkingPages?.has(page.id)
  const liveSingle = useLiveSingleFrame(page.id, frames, files)
  const focusFirst = (event) => {
    event.stopPropagation()
    if (frames[0] && !frames[0].env) board.onFocusFrame(page.id, frames[0].viewport)
  }
  return (
    <div
      className={cn(
        'group/card relative h-full w-full rounded-lg border border-line bg-surface shadow-card transition-[opacity,outline-color] duration-(--motion-base)',
        faded && 'opacity-25',
        offPath && 'opacity-60 outline-2 outline-offset-4 outline-faint/60 outline-dashed',
        steps && 'outline-offset-4 outline-accent/40',
        current && 'outline-accent',
        changed && 'outline-offset-2 outline-accent',
        same && 'opacity-50',
      )}
      style={{
        ...(steps || changed ? { outlineWidth: `calc(${current ? 3 : 2}px * min(var(--sw-inv, 1), 12))`, outlineStyle: 'solid' } : null),
        // An agent at work on one of its comments: a soft accent halo, the
        // same width on screen at any zoom.
        ...(working
          ? { boxShadow: '0 0 0 calc(4px * min(var(--sw-inv, 1), 12)) color-mix(in srgb, var(--accent) 35%, transparent)' }
          : null),
      }}
      data-sw-node={page.id}
      data-sw-faded={faded ? 'true' : undefined}
      data-sw-off-path={offPath ? 'true' : undefined}
      data-sw-current-step={current ? 'true' : undefined}
      data-sw-changed={board.compare ? (changed ? 'true' : 'false') : undefined}
      data-sw-agent-working={working ? 'true' : undefined}
    >
      <Handle type="source" position={Position.Right} id="right" className={hiddenHandle} isConnectable={false} />
      <Handle type="target" position={Position.Left} id="left" className={hiddenHandle} isConnectable={false} />
      {board.compare ? <ChangeBadge change={change} named={Object.keys(board.viewports || {}).length > 1} /> : null}
      <CardHeader
        width={width || frames.reduce((right, frame) => Math.max(right, frame.x + frame.w), 0) + 8}
        title={page.title}
        tip={<TitleTip title={page.title} path={page.path} note={page.note} />}
        path={page.path}
        steps={steps}
        current={board.journey?.currentStep}
        only={only}
        accent={current}
        onTitle={focusFirst}
        badges={
          <>
            {liveSingle ? <LiveChip /> : null}
            {working ? <AgentWorkingBadge /> : null}
            <CountBadge count={board.counts[page.id]} />
            <ChecksBadge pageId={page.id} title={page.title} />
            <span className="pointer-events-auto inline-flex">
              <CaptureWarnings pageId={page.id} title={page.title} entries={status} viewports={Object.keys(board.viewports)} />
            </span>
            <HistoryBadge pageId={page.id} />
            {page.url ? (
              <CardTip content="Open the page in a new tab">
                <a
                  href={page.url}
                  target="_blank"
                  rel="noreferrer"
                  tabIndex={-1}
                  // Gives way on a narrow card, so the title keeps its words.
                  className={cn(
                    'nodrag nopan pointer-events-auto relative hidden h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg @min-[200px]:inline-flex',
                    COARSE_HIT,
                  )}
                  aria-label={`Open ${page.title} in a new tab`}
                >
                  <ExternalLink size={12} />
                </a>
              </CardTip>
            ) : null}
          </>
        }
      />
      {frames.map((frame) =>
        frame.env ? (
          board.compare ? (
            <CompareFrame key={`${frame.viewport}:${frame.env}`} pageId={page.id} frame={frame} />
          ) : null
        ) : (
          <Frame
            key={frame.viewport}
            targetId={page.id}
            frame={frame}
            kind="captures"
            image={files[frame.viewport]}
            note={page.note}
            emptyText={statusText(board, status, frame.viewport)}
          />
        ),
      )}
    </div>
  )
})

export const VariantNode = memo(function VariantNode({ data, width }) {
  const board = useContext(BoardContext)
  const { variant, frames, only } = data
  const id = `variant:${variant.id}`
  const liveSingle = useLiveSingleFrame(id, frames, variant.files)
  return (
    <div
      className={cn(
        'group/card relative h-full w-full rounded-lg border border-dashed border-faint/60 bg-surface shadow-card transition-opacity duration-(--motion-base)',
        board.journey && 'opacity-25',
      )}
      data-sw-node={id}
    >
      <Handle type="target" position={Position.Left} id="left" className={hiddenHandle} isConnectable={false} />
      <Handle type="source" position={Position.Right} id="right" className={hiddenHandle} isConnectable={false} />
      <CardHeader
        width={width || 200}
        title={
          <span className="inline-flex min-w-0 items-center gap-1">
            <Lightbulb size={12} className="shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate">{variant.title}</span>
          </span>
        }
        tip={<TitleTip title={`Variant: ${variant.title}`} path={variant.source} note={variant.note} />}
        tag="Variant"
        badges={
          <>
            {liveSingle ? <LiveChip /> : null}
            <CountBadge count={board.counts[id]} />
          </>
        }
        onTitle={(event) => {
          event.stopPropagation()
          if (frames[0]) board.onFocusFrame(id, frames[0].viewport)
        }}
      />
      {only ? (
        <div className="flex h-11 items-center gap-2 px-2.5 text-[11px] text-muted" data-sw-variant-collapsed={only.join(',')}>
          <span className="min-w-0 flex-1 truncate">{only.map((name) => name[0].toUpperCase() + name.slice(1)).join(' and ')} only</span>
          {board.onShowViewport ? (
            <button
              type="button"
              tabIndex={-1}
              className={cn('nodrag nopan relative rounded px-1.5 py-0.5 font-semibold text-accent hover:bg-surface-2', COARSE_HIT)}
              onClick={(event) => {
                event.stopPropagation()
                board.onShowViewport(only[0])
              }}
              data-sw-variant-show={only[0]}
            >
              Show {only[0]}
            </button>
          ) : null}
        </div>
      ) : null}
      {frames.map((frame) => (
        <Frame
          key={frame.viewport}
          targetId={id}
          frame={frame}
          kind="variants"
          version={variant.createdAt}
          image={variant.files?.[frame.viewport]}
          emptyText={`No ${frame.viewport} version of this variant.`}
        />
      ))}
    </div>
  )
})

// A group: a quiet frame with a hairline border, its name above it in
// screen pixels (Figma style), cut short rather than outgrow its frame.
export const GroupFrameNode = memo(function GroupFrameNode({ data, width }) {
  const scale = 'var(--sw-group-scale, 1)'
  return (
    <div className="pointer-events-none relative h-full w-full rounded-2xl border border-fg/10 bg-fg/[0.025]" data-sw-group={data.group}>
      <p
        className="@container absolute bottom-full left-0 flex origin-bottom-left items-baseline gap-1.5 pb-1.5 pl-1 text-ui font-semibold whitespace-nowrap text-fg"
        style={{ width: `calc(${width || 600}px / ${scale})`, transform: `scale(${scale})` }}
        data-sw-group-label="true"
      >
        <span className="truncate">{data.group}</span>
        <span className="tabular hidden shrink-0 text-xs font-medium text-faint @min-[120px]:inline">
          {data.count} page{data.count === 1 ? '' : 's'}
        </span>
      </p>
    </div>
  )
})

export const NODE_TYPES = { page: PageNode, variant: VariantNode, groupFrame: GroupFrameNode }
