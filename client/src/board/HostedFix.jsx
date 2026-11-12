// Hosted boards: "Fix with <agent>" on an open thread. An agent connected
// with `shapewall agent connect --approvals ...` makes the fix on its own
// machine, on a branch, and asks before each edit: the request shows as a
// card in the comment's chat, where someone the agent's machine allows
// answers it (chat/cards.jsx). Pressing the button starts the fix and opens
// that chat, so the progress, the cards and the result are in one place.
//
// The button names the agent the fix goes to (the one the comment is
// addressed to, else the project's default, else the first that can fix),
// and with several its caret opens the same picker the local board uses.
// When no connected agent makes fixes for this person, there is no button:
// one line says why (hostedAgents.js fixChoice). "Send to agent" stays
// beside it, for agents that take comments on their own.
import { Bot, ChevronDown, GitBranch, ShieldQuestion, Sparkles } from 'lucide-react'
import { Button } from '../components/ui'
import { cn } from '../lib/utils'
import { AgentPicker } from '../chat/AgentPicker'
import { useCommentAgentFocus } from '../chat/agentFocus'
import { fixLabel } from '../chat/profiles'
import { useAgentWork } from './FixWithAgent'
import { fixChoice } from './hostedAgents'

// `list`: GET api/boards/:id/agents (null: not known yet, nothing shows).
// `onFix(comment, agentId)`: starts the fix and opens the comment's chat.
// `onOpenChat(comment)`: opens the chat without starting anything.
// `slot`: the thread shows this in two places around "Send to agent".
// 'action' (above it): the button. 'status' (below it): the way into the
// chat of a running or finished fix, or the line that says why there is no
// button.
export default function HostedFix({ comment, list = null, busy = false, touch = false, slot = 'action', onFix, onOpenChat = null }) {
  const work = useAgentWork(comment)
  const focus = useCommentAgentFocus(comment.id)
  if (!list || comment.status !== 'open') return null
  const size = touch ? 'touch' : 'sm'
  // With an agent: the way into its chat ("Send to agent" says who has it).
  if (work || comment.agentStatus === 'branch-ready') {
    if (!onOpenChat || slot !== 'status') return null
    const holder = (list.agents || []).find((agent) => (agent.working || []).includes(comment.id)) || null
    // An agent that takes comments on its own (shapewall watch --remote) has
    // no chat to open: only a connected agent's fix, or this tab's own turn.
    if (work && !focus && !holder?.link?.connected) return null
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 pb-2" data-sw-hosted-fix-block={comment.id}>
        {work === 'waiting' ? (
          <span
            className="inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-full bg-warn/15 px-2.5 text-xs font-medium text-fg"
            role="status"
            data-sw-hosted-fix-state="waiting"
          >
            <ShieldQuestion size={13} className="shrink-0 text-warn" aria-hidden="true" />
            <span className="truncate">{holder?.name || 'The agent'} asks before it acts</span>
          </span>
        ) : null}
        <Button
          size={size}
          variant={work === 'working' ? 'secondary' : 'default'}
          onClick={() => onOpenChat(comment)}
          data-sw-hosted-fix-open={comment.id}
          data-sw-hosted-fix-view={work || 'branch'}
        >
          {work ? <Bot size={13} aria-hidden="true" /> : <GitBranch size={13} aria-hidden="true" />}{' '}
          {work === 'waiting' ? 'Review the request' : work ? 'Watch it work' : 'View the fix'}
        </Button>
      </div>
    )
  }
  const { agent, options, reason } = fixChoice(list, comment)
  if (!agent) {
    if (!reason || slot !== 'status') return null
    return (
      <p className="pb-2 text-xs text-muted" role="note" data-sw-hosted-fix-reason={comment.id}>
        {reason}
      </p>
    )
  }
  if (slot !== 'action') return null
  const again = comment.agentStatus === 'done'
  const variant = again ? 'secondary' : 'default'
  const split = options.length > 0
  return (
    <div className="space-y-1 pt-2" data-sw-hosted-fix-block={comment.id}>
      <span className="inline-flex max-w-full min-w-0" data-sw-hosted-fix-split={split ? comment.id : undefined}>
        <Button
          size={size}
          variant={variant}
          className={cn('min-w-0', split && 'rounded-r-none pr-2.5')}
          disabled={busy}
          onClick={() => onFix(comment, agent.id)}
          data-sw-hosted-fix={comment.id}
          data-sw-hosted-fix-agent={agent.name}
        >
          <Sparkles size={13} className="shrink-0" aria-hidden="true" />{' '}
          <span className="truncate">{again ? 'Fix again with ' + agent.name : fixLabel({ again: false, name: agent.name })}</span>
        </Button>
        {split ? (
          <AgentPicker
            options={options}
            value={null}
            onChoose={(id) => onFix(comment, id)}
            heading="Fix this comment with"
            align="end"
            touch={touch}
            data-sw-hosted-fix-menu={comment.id}
          >
            <Button
              size={size}
              variant={variant}
              className={cn('rounded-l-none px-2', again ? '-ml-px' : 'border-l border-accent-fg/30')}
              disabled={busy}
              aria-label="Fix with another agent"
              data-sw-hosted-fix-choose={comment.id}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </Button>
          </AgentPicker>
        ) : null}
      </span>
      {agent.edits?.text ? (
        <p className="text-xs text-muted" data-sw-hosted-fix-mode={agent.edits.mode}>
          {agent.edits.text}. The fix shows in the Agent panel.
        </p>
      ) : null}
    </div>
  )
}
