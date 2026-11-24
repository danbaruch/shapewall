// Hosted boards: "Send to <agent>" on an open thread. A hosted server runs
// no agent: machines that have the code run `shapewall watch --remote`, and
// each one is an agent of the project with a name, a face and a state
// (src/hosted/agents.js). This is the split control the local board has for
// "Fix with <agent>": the main part names the project's default agent, the
// caret lists every agent with its state, and "Any agent" hands the comment
// to whichever takes it first. An agent this person may not use is listed
// too, disabled, with the reason under its name.
//
// Once sent, the control gives way to where the comment stands: sent to
// Builder, Builder is working on it, or waiting for an agent that is
// offline, with "Let any agent take it".
import { ChevronDown, Send, Users } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui'
import { cn } from '../lib/utils'
import { AgentMark } from '../chat/AgentPicker'
import { AgentFace } from '../chat/agentIcons'
import { agentOptions, sendDefault, sentState } from './hostedAgents'

const ADMINS = ['admin', 'owner']

function AgentMenu({ comment, list, onChoose, touch, align = 'end', heading, children }) {
  const options = agentOptions(list)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn('w-[min(20rem,calc(100vw-1.5rem))]', touch && 'p-1.5')}
        data-sw-send-agent-menu={comment.id}
      >
        <DropdownMenuLabel className="tracking-normal normal-case">{heading}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            disabled={option.disabled}
            textValue={option.label}
            onSelect={() => onChoose(option.id)}
            className="h-auto min-h-11 items-start py-2 data-[disabled]:opacity-100 lg:h-auto lg:min-h-11"
            aria-label={`${option.label}${option.isDefault ? ', default' : ''}, ${option.line}`}
            data-sw-send-agent-option={option.id}
            data-sw-send-agent-name={option.label}
            data-sw-agent-state={option.state}
            data-sw-send-agent-blocked={option.disabled ? 'true' : undefined}
          >
            <AgentMark
              label={option.label}
              state={option.mark}
              icon={option.icon}
              tint={option.tint}
              logo={option.logo}
              className={cn('mt-0.5', option.disabled && 'opacity-50')}
            />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn('truncate font-medium', option.disabled ? 'text-muted' : 'text-fg')}>{option.label}</span>
                {option.isDefault ? (
                  <span
                    className="shrink-0 rounded-full border border-line px-1.5 text-[10px] leading-4 font-medium text-muted"
                    data-sw-agent-default="true"
                  >
                    Default
                  </span>
                ) : null}
              </span>
              <span className="line-clamp-3 text-[11.5px] leading-4 font-normal text-muted" data-sw-send-agent-line>
                {option.line}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        {options.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          onSelect={() => onChoose(null)}
          className="h-auto min-h-11 items-start py-2 lg:h-auto lg:min-h-11"
          data-sw-send-agent-option="any"
        >
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-muted">
            <Users size={14} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-fg">Any agent</span>
            <span className="block text-[11.5px] leading-4 font-normal text-muted">The first one that is free takes it.</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// `list`: the project's agents (null while not known: a plain button that
// lets the server choose). `onSend(comment, agentId)`: agentId is an agent's
// id, null for any agent, or undefined for the server's choice.
// `onRelease(comment)`: let any agent take a comment that waits for one.
export default function SendToAgent({ comment, list = null, role = null, busy = false, touch = false, onSend, onRelease }) {
  const size = touch ? 'touch' : 'sm'
  const admin = ADMINS.includes(role)
  const sent = sentState(comment, list)
  const known = Boolean(list)
  const hasAgents = Boolean(list?.agents?.length)

  // A run someone else asked for: an admin approves it (as before). It
  // keeps going where it was sent; an admin that agent does not take work
  // from can send it to another one, or to any.
  if (comment.needsRunApproval && !comment.dispatchable) {
    const target = (list?.agents || []).find((agent) => agent.id === comment.agentId) || null
    return (
      <div className="space-y-1.5 py-2" data-sw-send-agent-block={comment.id}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size={size} disabled={busy || !admin} onClick={() => onSend(comment)} data-sw-send-agent={comment.id}>
            {admin ? 'Approve agent run' : 'Awaiting run approval'}
          </Button>
          {admin && hasAgents ? (
            <AgentMenu
              comment={comment}
              list={list}
              onChoose={(id) => onSend(comment, id)}
              touch={touch}
              align="start"
              heading="Approve it and send it to"
            >
              <Button size={size} variant="ghost" disabled={busy} data-sw-send-agent-choose={comment.id}>
                Choose another <ChevronDown size={13} aria-hidden="true" />
              </Button>
            </AgentMenu>
          ) : null}
        </div>
        {known ? (
          <p className="text-xs text-muted" data-sw-send-agent-asked={target ? target.id : 'any'}>
            {target ? `Asked for ${target.name}.` : 'Asked for any agent.'}
            {target && !target.canSend && admin ? ` ${target.reason}` : ''}
          </p>
        ) : null}
      </div>
    )
  }

  if (comment.dispatchable) {
    // The status chip above already says done, needs a person or fix ready.
    if (!sent) return null
    return (
      <div className="space-y-1.5 py-2" data-sw-send-agent-block={comment.id}>
        <p className="flex min-w-0 items-start gap-2 text-xs text-fg" role="status" data-sw-sent-agent={sent.kind}>
          {sent.agent ? (
            <AgentFace label={sent.agent.name} icon={sent.agent.icon} tint={sent.agent.tint} logo={sent.agent.logo} size="sm" />
          ) : (
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border border-line bg-surface-2 text-muted">
              <Users size={11} aria-hidden="true" />
            </span>
          )}
          <span className={cn('min-w-0 pt-0.5', sent.kind === 'waiting' ? 'text-fg' : 'text-muted')}>{sent.text}</span>
        </p>
        {sent.kind !== 'working' && (sent.canRelease || hasAgents) ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {sent.canRelease && onRelease ? (
              <Button
                size={size}
                variant={sent.kind === 'waiting' ? 'default' : 'secondary'}
                disabled={busy}
                onClick={() => onRelease(comment)}
                data-sw-release-agent={comment.id}
              >
                Let any agent take it
              </Button>
            ) : null}
            {hasAgents ? (
              <AgentMenu
                comment={comment}
                list={list}
                onChoose={(id) => onSend(comment, id)}
                touch={touch}
                align="start"
                heading="Send it to"
              >
                <Button size={size} variant="ghost" disabled={busy} data-sw-send-agent-choose={comment.id}>
                  Choose another <ChevronDown size={13} aria-hidden="true" />
                </Button>
              </AgentMenu>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  const main = sendDefault(list)
  // Nobody to choose between: one button, and the server decides.
  if (!known || !hasAgents) {
    return (
      <div className="py-2" data-sw-send-agent-block={comment.id}>
        <Button size={size} disabled={busy} onClick={() => onSend(comment)} data-sw-send-agent={comment.id}>
          <Send size={13} aria-hidden="true" /> Send to agent
        </Button>
        {known ? (
          // Nothing acts on it until an agent connects: say so, instead of
          // leaving the comment looking stuck later.
          <p className="mt-1.5 text-xs text-muted" role="status" data-sw-no-agent-listening="true">
            No agent is connected to this project yet: a comment sent to an agent waits until one is (shapewall watch --remote).
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <div className="py-2" data-sw-send-agent-block={comment.id}>
      <span className="inline-flex min-w-0 max-w-full" data-sw-send-agent-split={comment.id}>
        <Button
          size={size}
          className="min-w-0 rounded-r-none pr-2.5"
          disabled={busy}
          onClick={() => onSend(comment, main.agentId)}
          data-sw-send-agent={comment.id}
          data-sw-send-agent-target={main.agentId || 'any'}
        >
          <Send size={13} className="shrink-0" aria-hidden="true" /> <span className="truncate">{main.label}</span>
        </Button>
        <AgentMenu comment={comment} list={list} onChoose={(id) => onSend(comment, id)} touch={touch} heading="Send this comment to">
          <Button
            size={size}
            className="-ml-px rounded-l-none px-2"
            disabled={busy}
            aria-label="Send to another agent"
            data-sw-send-agent-choose={comment.id}
          >
            <ChevronDown size={13} aria-hidden="true" />
          </Button>
        </AgentMenu>
      </span>
    </div>
  )
}
