// "Fix with Codex": the open thread's primary action when the board's agent
// may edit the project. It names the default agent (the one new chats and
// fixes use); with more than one agent connected it is a split button whose
// caret opens the agent picker (chat/AgentPicker.jsx) to run this fix with
// another agent once. That moves only this comment's chat to that agent
// (the next fix from the main part moves it back); the default stays.
// While the agent works on the comment (its agent status, or the live chat
// turn in agentFocus.js) the button gives way to a status with a way into
// the chat.
import { useContext, useState } from 'react'
import { ChevronDown, GitBranch, Loader2, ShieldQuestion, Sparkles } from 'lucide-react'
import { Button } from '../components/ui'
import { api } from '../lib/api'
import { useResource } from '../lib/hooks'
import { useAgentsChanged } from '../lib/agentEvents'
import { cn } from '../lib/utils'
import { useCommentAgentFocus } from '../chat/agentFocus'
import { AgentPicker } from '../chat/AgentPicker'
import { fixChoices, fixLabel, profileToSet } from '../chat/profiles'
import { threadPath } from '../chat/stream'
import { threadForComment } from '../chat/threads'
import { BoardContext } from './boardContext'

export function useAgentWork(comment) {
  const focus = useCommentAgentFocus(comment.id)
  if (focus?.state === 'waiting') return 'waiting'
  if (focus?.state === 'working' || ['queued', 'working'].includes(comment.agentStatus)) return 'working'
  return null
}

export default function FixWithAgent({ comment, onFix, onOpenChat = null, busy, touch, className }) {
  const work = useAgentWork(comment)
  const boardId = useContext(BoardContext)?.boardId || null
  const offered = Boolean(onFix) && comment.status === 'open'
  // The connected agents and the default's name: read when the thread
  // opens, and again when they change (lib/agentEvents.js; no polling).
  const status = useResource(offered ? '/api/agent/status' : null)
  useAgentsChanged(status.refetch, offered)
  const [preparing, setPreparing] = useState(false)
  const [failed, setFailed] = useState(null)
  if (!offered) return null
  // Agent branch mode: the fix waits on its branch; Apply or Discard it in the chat.
  if (!work && comment.agentStatus === 'branch-ready') {
    if (!onOpenChat) return null
    return (
      <Button
        size={touch ? 'touch' : 'xs'}
        variant="default"
        className={cn('rounded-full pr-3 pl-2.5', className)}
        onClick={() => onOpenChat(comment)}
        data-sw-fix-agent-open={comment.id}
        data-sw-fix-agent-state="branch"
      >
        <GitBranch size={13} aria-hidden="true" /> Review branch
      </Button>
    )
  }
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
  const { name, options, defaultId } = fixChoices(status.data)
  // Done once already: the person reviews first, so running it again is the quieter choice.
  const again = comment.agentStatus === 'done'
  const variant = again ? 'secondary' : 'default'
  const size = touch ? 'touch' : 'xs'
  // With a choice of agents: this comment's chat uses `wanted` ('default' or
  // a profile id) before the fix starts.
  const run = async (wanted) => {
    setFailed(null)
    if (options.length && boardId) {
      setPreparing(true)
      try {
        const path = threadPath(boardId, threadForComment(comment.id))
        const thread = await api.get(path)
        const next = profileToSet({ threadProfile: thread?.profileId, wanted, defaultId })
        if (next) await api.post(`${path}/profile`, { profileId: next })
      } catch (error) {
        setFailed(error.message)
        return
      } finally {
        setPreparing(false)
      }
    }
    onFix(comment)
  }
  const split = options.length > 0
  const main = (
    <Button
      size={size}
      variant={variant}
      className={cn(split ? 'rounded-l-full rounded-r-none pr-2.5 pl-2.5' : 'rounded-full pr-3 pl-2.5', !split && className)}
      disabled={busy || preparing}
      onClick={() => run('default')}
      data-sw-fix-agent={comment.id}
      data-sw-fix-agent-name={name || undefined}
    >
      {preparing ? (
        <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <Sparkles size={13} aria-hidden="true" />
      )}{' '}
      {fixLabel({ again, name })}
    </Button>
  )
  const error = failed ? (
    <span className="min-w-0 text-xs text-bad" role="alert">
      {failed}
    </span>
  ) : null
  if (!split) {
    if (!error) return main
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {error}
        {main}
      </span>
    )
  }
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center justify-end gap-1.5', className)} data-sw-fix-agent-split={comment.id}>
      {error}
      <span className="inline-flex min-w-0">
        {main}
        <AgentPicker
          options={options}
          value={null}
          onChoose={(id) => run(id === defaultId ? 'default' : id)}
          heading="Run this fix once with"
          align="end"
          touch={touch}
        >
          <Button
            size={touch ? 'icon' : 'icon-xs'}
            variant={variant}
            className={cn('rounded-l-none rounded-r-full', again ? '-ml-px' : 'border-l border-accent-fg/30')}
            disabled={busy || preparing}
            aria-label="Fix with another agent"
            data-sw-fix-agent-choose={comment.id}
          >
            <ChevronDown size={13} aria-hidden="true" />
          </Button>
        </AgentPicker>
      </span>
    </span>
  )
}
