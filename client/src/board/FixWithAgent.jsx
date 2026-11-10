// "Fix with agent": the open thread's primary action when the board's agent
// may edit the project. While the agent works on the comment (its agent
// status, or the live chat turn in agentFocus.js) the button gives way to
// a status with a way into the chat.
import { Loader2, ShieldQuestion, Sparkles } from 'lucide-react'
import { Button } from '../components/ui'
import { cn } from '../lib/utils'
import { useCommentAgentFocus } from '../chat/agentFocus'

export function useAgentWork(comment) {
  const focus = useCommentAgentFocus(comment.id)
  if (focus?.state === 'waiting') return 'waiting'
  if (focus?.state === 'working' || ['queued', 'working'].includes(comment.agentStatus)) return 'working'
  return null
}

export default function FixWithAgent({ comment, onFix, onOpenChat = null, busy, touch, className }) {
  const work = useAgentWork(comment)
  if (!onFix || comment.status !== 'open') return null
  if (work) {
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-sw-fix-agent-state={work}>
        <span
          className={cn(
            'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
            work === 'waiting' ? 'bg-warn/15 text-fg' : 'bg-accent/10 text-accent',
          )}
          role="status"
        >
          {work === 'waiting' ? (
            <ShieldQuestion size={13} className="shrink-0 text-warn" aria-hidden="true" />
          ) : (
            <Loader2 size={13} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          )}
          <span className="truncate">{work === 'waiting' ? 'Agent needs your OK' : 'Agent working'}</span>
        </span>
        {onOpenChat ? (
          <Button
            size={touch ? 'touch' : 'xs'}
            variant={work === 'waiting' ? 'default' : 'ghost'}
            onClick={() => onOpenChat(comment)}
            data-sw-fix-agent-open={comment.id}
          >
            {work === 'waiting' ? 'Review' : 'View'}
          </Button>
        ) : null}
      </span>
    )
  }
  // Done once already: the person reviews first, so running it again is the quieter choice.
  const again = comment.agentStatus === 'done'
  return (
    <Button
      size={touch ? 'touch' : 'xs'}
      variant={again ? 'secondary' : 'default'}
      className={cn('rounded-full pr-3 pl-2.5', className)}
      disabled={busy}
      onClick={() => onFix(comment)}
      data-sw-fix-agent={comment.id}
    >
      <Sparkles size={13} aria-hidden="true" /> {again ? 'Fix again' : 'Fix with agent'}
    </Button>
  )
}
