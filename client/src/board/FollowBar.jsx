import { Crosshair, Layers, X } from 'lucide-react'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui'
import { cn } from '../lib/utils'
import { ANY_AGENT } from './followAgent'
import { viewportLabel } from './viewports'

// Follow an agent (hooks/useFollowAgent.js), over the canvas at the top left.
// Off: a Follow button for each agent at work (hosted: the project's agents
// that are online or busy; local: one, while an agent works on a comment).
// On: who is followed, what it is doing, the quiet "2 more screens changed"
// (a menu of those screens' before and after) and Stop following.
// Presses here never count as moving the canvas (data-sw-follow-bar).
export function FollowBar({ following, candidates, touch, titleOf, belowPresence = false }) {
  // On a narrow hosted board the presence bar has the top row: this goes under it.
  const top = belowPresence ? 'top-28' : 'top-14'
  const { state } = following
  const size = touch ? 'touch' : 'xs'
  if (state.mode === 'off') {
    if (!candidates.length) return null
    return (
      <div className={cn('absolute left-2 z-30 flex max-w-[calc(100%-1rem)] flex-wrap gap-1', top)} data-sw-follow-bar="off">
        {candidates.slice(0, 3).map((agent) => (
          <Button
            key={agent.id}
            size={size}
            variant="secondary"
            className="shadow-pop"
            onClick={() => following.follow(agent.id)}
            data-sw-follow-agent={agent.id}
          >
            <Crosshair size={13} aria-hidden="true" />
            {agent.id === ANY_AGENT ? 'Follow agent' : `Follow ${agent.name}`}
          </Button>
        ))}
      </div>
    )
  }
  const others = state.others || []
  return (
    <div
      className={cn(
        'absolute left-2 z-30 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1 rounded-xl border border-line bg-surface/95 p-1 shadow-pop',
        top,
      )}
      role="status"
      aria-live="polite"
      data-sw-follow-bar={state.mode}
      data-sw-follow-agent-id={state.agentId}
      data-sw-follow-comment={state.comment?.id ?? undefined}
      data-sw-follow-compare={state.compare ? `${state.compare.pageId}|${state.compare.viewport}` : undefined}
      data-sw-follow-others={others.length}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 px-1.5 text-xs">
        <Crosshair size={13} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="font-medium">Following {following.name === 'the agent' ? 'the agent' : following.name}</span>
        <span className="truncate text-muted" data-sw-follow-line="true">
          {following.line}
        </span>
      </span>
      {others.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size={size} variant="ghost" data-sw-follow-more="true">
              <Layers size={13} aria-hidden="true" />
              {following.othersText}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-sw-follow-bar="menu">
            {others.map((item) => (
              <DropdownMenuItem
                key={`${item.pageId}|${item.viewport}`}
                onSelect={() => following.openOther(item)}
                data-sw-follow-screen={`${item.pageId}|${item.viewport}`}
              >
                Before and after: {titleOf(item.pageId) || item.pageId}, {viewportLabel(item.viewport)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button size={size} variant="ghost" onClick={following.stop} data-sw-stop-follow-agent="true">
        <X size={13} aria-hidden="true" />
        Stop following
      </Button>
    </div>
  )
}
