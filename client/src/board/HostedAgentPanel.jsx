// Hosted boards: the Agent panel in the side rail (a sheet on a phone). A
// hosted server runs no agent itself: each machine that runs `shapewall
// agent connect` (an agent members can chat with, read and answer only) or
// `shapewall watch --remote` (one that takes comments) with its own project
// token is an agent of the project (src/hosted/agents.js). This panel lists them: face,
// name, machine, state, what each is working on and what waits for it, and
// who may send it work. Below: what waits for a person. Only for people who
// can send comments to an agent (never a share link guest or a public
// viewer).
import { Bot, MessageSquare, Settings2 } from 'lucide-react'
import { Button } from '../components/ui'
import { PanelHeader } from '../components/panel-header'
import { AgentMark } from '../chat/AgentPicker'
import { useState } from 'react'
import { cn, formatRelative } from '../lib/utils'
import { STATE_MARK, stateWords } from './hostedAgents'

const DOCS_URL = 'https://shapewall.com/docs/where-to-run#where-the-work-happens'
const WHY = { approval: 'needs your OK', 'needs-human': 'needs a person', 'branch-ready': 'fix ready to apply' }
const ITEM =
  'flex min-h-11 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-sm text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent lg:min-h-9'

function Items({ title, items, tone, note, onOpen, hook }) {
  if (!items.length) return null
  return (
    <section className="space-y-1.5" data-sw-hosted-agent-list={hook}>
      <h3 className="text-xs font-semibold text-muted">{title}</h3>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpen(item.id)} className={ITEM} data-sw-hosted-agent-item={item.id}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {note(item) ? <span className="shrink-0 text-xs text-muted">{note(item)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// The comments an agent holds or that wait for it, as small buttons.
function Chips({ label, ids, nameOf, onOpen, hook, tone }) {
  if (!ids.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1" data-sw-hosted-agent-comments={hook}>
      <span className="text-[11px] text-muted">{label}</span>
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onOpen(id)}
          className={cn(
            'inline-flex min-h-11 max-w-full items-center rounded-full border px-2 text-xs font-medium outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent lg:min-h-6',
            tone,
          )}
          data-sw-hosted-agent-comment={id}
        >
          <span className="truncate">{nameOf(id)}</span>
        </button>
      ))}
    </div>
  )
}

function AgentRow({ agent, nameOf, onOpen, onChat }) {
  const waiting = agent.state === 'offline' && agent.queued.length > 0
  // Connected with `shapewall agent connect`: it chats.
  const chats = Boolean(onChat && agent.link?.connected && agent.link.chats)
  const [opening, setOpening] = useState(false)
  const elsewhere = (agent.elsewhere?.working || 0) + (agent.elsewhere?.queued || 0)
  return (
    <li
      className="space-y-1.5 rounded-lg border border-line bg-surface p-2.5"
      data-sw-hosted-agent-row={agent.id}
      data-sw-hosted-agent-name={agent.name}
      data-sw-agent-state={agent.state}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AgentMark
          label={agent.name}
          state={STATE_MARK[agent.state]}
          icon={agent.icon}
          tint={agent.tint}
          logo={agent.logo}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="truncate font-medium text-fg">{agent.name}</span>
            {agent.isDefault ? (
              <span
                className="shrink-0 rounded-full border border-line px-1.5 text-[10px] leading-4 font-medium text-muted"
                data-sw-agent-default="true"
              >
                Default
              </span>
            ) : null}
          </p>
          <p className={cn('text-xs', waiting ? 'text-fg' : 'text-muted')} data-sw-hosted-agent-state>
            {stateWords(agent)}
            {agent.machine ? ` · ${agent.machine}` : ''}
          </p>
        </div>
        {chats ? (
          <Button
            size="sm"
            variant={agent.chat?.ok ? 'default' : 'secondary'}
            className="min-h-11 shrink-0 lg:min-h-8"
            disabled={!agent.chat?.ok || opening}
            onClick={async () => {
              setOpening(true)
              try {
                await onChat(agent)
              } finally {
                setOpening(false)
              }
            }}
            aria-label={`Chat with ${agent.name}`}
            data-sw-hosted-agent-chat={agent.id}
          >
            <MessageSquare size={14} aria-hidden="true" /> Chat
          </Button>
        ) : null}
      </div>
      {chats ? (
        <p className="text-[11px] text-muted" data-sw-hosted-agent-chat-note={agent.chat?.ok ? 'ok' : agent.chat?.code || 'no'}>
          {agent.chat?.ok
            ? 'Reads the project and answers. No edits, no commands.'
            : agent.chat?.code === 'agent_offline'
              ? `${agent.name} is offline: chat needs it online. A comment sent to it waits.`
              : agent.chat?.reason}
        </p>
      ) : null}
      <Chips
        label="Working on"
        ids={agent.working}
        nameOf={nameOf}
        onOpen={onOpen}
        hook="working"
        tone="border-accent/40 bg-accent/10 text-fg"
      />
      <Chips
        label={waiting ? 'Waiting for it' : 'Next'}
        ids={agent.queued}
        nameOf={nameOf}
        onOpen={onOpen}
        hook="queued"
        tone={waiting ? 'border-warn/50 bg-warn/10 text-fg' : 'border-line bg-surface text-fg'}
      />
      {elsewhere ? (
        <p className="text-[11px] text-muted">
          {elsewhere === 1 ? '1 more comment' : `${elsewhere} more comments`} on other boards of this project.
        </p>
      ) : null}
      <p className="text-[11px] text-muted" data-sw-hosted-agent-audience={agent.audience.kind}>
        {agent.canSend ? `Takes work from: ${lowerFirst(agent.audience.text)}.` : agent.reason}
        {agent.canSend && agent.audience.inherited ? ' (As before 0.4.0.)' : ''}
      </p>
    </li>
  )
}
const lowerFirst = (text) => (/^(Only|Everyone)/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text)

// `agents`: GET api/boards/:id/agents (null: not loaded yet). `listening`:
// { online, name, lastSeenAt } of the project as a whole (0.3.3 servers).
// `activity`: agentActivity(). `approvals`: how many commands wait for an
// admin's OK (answered in the strip at the top of the board). `manageUrl`:
// the project's Agents page in the console, for admins.
export function HostedAgentPanel({
  agents = null,
  listening = null,
  activity,
  approvals = 0,
  titleOf = () => '',
  manageUrl = null,
  onOpenComment,
  onClose,
  heading = true,
  // Chat with a connected agent: (agent) => opens a chat of this person's
  // own; onBoardChat opens the board's shared chat. null: no chat here.
  onChat = null,
  onBoardChat = null,
  // An admin sees the command that connects an agent.
  admin = false,
}) {
  const list = agents?.agents || []
  const known = Boolean(agents)
  const online = known ? list.some((agent) => agent.state !== 'offline') : Boolean(listening?.online)
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const nameOf = (id) => {
    const title = titleOf(id)
    return title ? `#${id} ${title}` : `#${id}`
  }
  const unassigned = agents?.unassigned || []
  const busy = list.some((agent) => agent.working.length || agent.queued.length) || unassigned.length
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-sw-hosted-agent="true">
      {heading ? (
        <PanelHeader
          icon={Bot}
          title="Agents"
          onClose={onClose}
          closeLabel="Close the agent panel"
          closeProps={{ 'data-sw-hosted-agent-close': 'true' }}
        />
      ) : null}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-line p-3">
        {list.length ? (
          <section className="space-y-1.5" data-sw-hosted-agent-listening={online ? 'online' : 'none'}>
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-xs font-semibold text-muted" role="status">
                {online ? 'Agents of this project' : 'No agent is online'}
              </h3>
              {manageUrl ? (
                <a
                  href={manageUrl}
                  className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline lg:min-h-0"
                  data-sw-hosted-agent-manage="true"
                >
                  <Settings2 size={12} aria-hidden="true" /> Manage
                </a>
              ) : null}
            </div>
            {online ? null : <p className="text-xs text-muted">Comments sent to an agent wait until it is back. Nothing is lost.</p>}
            <ul className="space-y-1.5" data-sw-hosted-agent-rows>
              {list.map((agent) => (
                <AgentRow key={agent.id} agent={agent} nameOf={nameOf} onOpen={onOpenComment} onChat={onChat} />
              ))}
            </ul>
            {onBoardChat && list.some((agent) => agent.link?.connected && agent.link.chats) ? (
              <button
                type="button"
                onClick={onBoardChat}
                className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-accent underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-accent lg:min-h-0"
                data-sw-hosted-agent-board-chat="true"
              >
                <MessageSquare size={12} aria-hidden="true" /> Open the board chat (everyone in the workspace reads it)
              </button>
            ) : null}
          </section>
        ) : (
          <section
            className="rounded-lg border border-line bg-surface-2/60 p-3 text-sm"
            role="status"
            data-sw-hosted-agent-listening={online ? 'online' : 'none'}
          >
            <p className="flex items-center gap-2 font-medium text-fg">
              <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-ok' : 'bg-faint'}`} aria-hidden="true" />
              {online ? `Agent online: ${listening?.name || 'agent'}` : 'No agent is connected to this project'}
            </p>
            {online ? (
              <p className="mt-1 text-xs text-muted">Last heard {formatRelative(listening.lastSeenAt)}.</p>
            ) : (
              <>
                {admin ? (
                  <>
                    <p className="mt-1 text-xs text-muted">
                      Comments sent to an agent wait until one connects. To chat with your coding agent here, run this in the project's
                      folder, on the machine that has the code:
                    </p>
                    <code
                      className="mt-1.5 block rounded bg-surface px-2 py-1.5 font-mono text-xs break-all text-fg"
                      data-sw-hosted-agent-command="connect"
                    >
                      shapewall agent connect --remote {origin}
                    </code>
                    <p className="mt-1.5 text-xs text-muted">
                      It reads and answers only. For an agent that fixes comments, run{' '}
                      <code className="font-mono">shapewall watch --remote</code> with a project token.
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    Comments sent to an agent wait until one connects. An admin of this workspace connects one from the machine that has the
                    code.
                  </p>
                )}
                <span className="mt-1.5 flex flex-wrap gap-x-3">
                  <a
                    href={DOCS_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center text-xs font-medium text-accent underline-offset-2 hover:underline lg:min-h-0"
                    data-sw-hosted-agent-docs="true"
                  >
                    Where the agent runs
                  </a>
                  {manageUrl ? (
                    <a
                      href={manageUrl}
                      className="inline-flex min-h-11 items-center text-xs font-medium text-accent underline-offset-2 hover:underline lg:min-h-0"
                      data-sw-hosted-agent-manage="true"
                    >
                      Connect an agent
                    </a>
                  ) : null}
                </span>
              </>
            )}
          </section>
        )}
        {unassigned.length ? (
          <section className="space-y-1.5" data-sw-hosted-agent-list="unassigned">
            <h3 className="text-xs font-semibold text-muted">Waiting for any agent</h3>
            <Chips
              label=""
              ids={unassigned}
              nameOf={nameOf}
              onOpen={onOpenComment}
              hook="unassigned"
              tone="border-line bg-surface text-fg"
            />
          </section>
        ) : null}
        {approvals ? (
          <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg" data-sw-hosted-agent-approvals={approvals}>
            {approvals === 1 ? 'A command waits' : `${approvals} commands wait`} for your OK: see the strip at the top of the board.
          </p>
        ) : null}
        <Items
          title="Needs you"
          hook="waiting"
          items={activity.waiting}
          tone="bg-warn"
          note={(item) => WHY[item.why] || ''}
          onOpen={onOpenComment}
        />
        {/* Without the per-agent list (an older server), what runs is listed here. */}
        {known ? null : (
          <Items title="Working" hook="working" items={activity.working} tone="bg-accent" note={() => ''} onOpen={onOpenComment} />
        )}
        {!activity.waiting.length && !activity.working.length && !busy ? (
          <p className="text-xs text-muted" data-sw-hosted-agent-idle="true">
            Nothing is running, and nothing waits for you. To hand a comment to an agent, open it and choose Send to agent.
          </p>
        ) : null}
      </div>
    </div>
  )
}
