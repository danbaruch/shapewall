// Hosted boards: the Agent panel in the side rail. A hosted server runs no
// agent itself and has no chat: a machine somewhere runs `shapewall watch
// --remote` with a project token and picks up the comments sent to it. This
// panel says whether one is listening, what is running and what waits for a
// person. Only for people who can send comments to the agent (never a share
// link guest or a public viewer).
import { Bot } from 'lucide-react'
import { PanelHeader } from '../components/panel-header'
import { formatRelative } from '../lib/utils'

const DOCS_URL = 'https://shapewall.com/docs/where-to-run#where-the-work-happens'
const WHY = { approval: 'needs your OK', 'needs-human': 'needs a person', 'branch-ready': 'fix ready to apply' }

function Items({ title, items, tone, note, onOpen, hook }) {
  if (!items.length) return null
  return (
    <section className="space-y-1.5" data-sw-hosted-agent-list={hook}>
      <h3 className="text-xs font-semibold text-muted">{title}</h3>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              className="flex min-h-11 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-sm text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent lg:min-h-9"
              data-sw-hosted-agent-item={item.id}
            >
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

// `listening`: { online, name, lastSeenAt } from the server (null: not told).
// `activity`: agentActivity(). `approvals`: how many commands wait for an
// admin's OK (they are answered in the strip at the top of the board).
export function HostedAgentPanel({ listening, activity, approvals = 0, onOpenComment, onClose, heading = true }) {
  const online = Boolean(listening?.online)
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-sw-hosted-agent="true">
      {heading ? (
        <PanelHeader
          icon={Bot}
          title="Agent"
          onClose={onClose}
          closeLabel="Close the agent panel"
          closeProps={{ 'data-sw-hosted-agent-close': 'true' }}
        />
      ) : null}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-line p-3">
        <section
          className="rounded-lg border border-line bg-surface-2/60 p-3 text-sm"
          role="status"
          data-sw-hosted-agent-listening={online ? 'online' : 'none'}
        >
          <p className="flex items-center gap-2 font-medium text-fg">
            <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-ok' : 'bg-faint'}`} aria-hidden="true" />
            {online ? `Agent online: ${listening.name || 'agent'}` : 'No agent is listening'}
          </p>
          {online ? (
            <p className="mt-1 text-xs text-muted">
              Last heard {formatRelative(listening.lastSeenAt)}. Comments sent to the agent are picked up by it.
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted">
                Comments sent to the agent wait until one connects. On the machine that has the code, with a project token that may take
                work, run:
              </p>
              <code className="mt-1.5 block rounded bg-surface px-2 py-1.5 font-mono text-xs break-all text-fg">
                shapewall watch --remote {origin}
              </code>
              {listening?.name ? (
                <p className="mt-1.5 text-xs text-muted">
                  Last heard from {listening.name} {formatRelative(listening.lastSeenAt)}.
                </p>
              ) : null}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-block text-xs font-medium text-accent underline-offset-2 hover:underline"
                data-sw-hosted-agent-docs="true"
              >
                Where the agent runs
              </a>
            </>
          )}
        </section>
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
        <Items title="Working" hook="working" items={activity.working} tone="bg-accent" note={() => ''} onOpen={onOpenComment} />
        {!activity.waiting.length && !activity.working.length ? (
          <p className="text-xs text-muted" data-sw-hosted-agent-idle="true">
            Nothing is running, and nothing waits for you. To hand a comment to the agent, open it and choose Send to agent.
          </p>
        ) : null}
      </div>
    </div>
  )
}
