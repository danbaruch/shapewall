import { useState } from 'react'
import { cx } from './ui.jsx'

const Prompt = () => <span className="text-wall-bright select-none">$</span>
const Dim = ({ children }) => <span className="text-zinc-400">{children}</span>
const Key = ({ children }) => <span className="text-sky-300">{children}</span>
const Str = ({ children }) => <span className="text-amber-200">{children}</span>
const Num = ({ children }) => <span className="text-violet-300">{children}</span>
const Ok = ({ children }) => <span className="text-wall-bright">{children}</span>

// What an agent sees. The JSON is real output from the bundled demo board (abridged).
const TABS = [
  {
    id: 'json',
    label: 'comments --json',
    body: (
      <>
        <Prompt /> shapewall comments --open --json{'\n'}
        <Dim>{'{ "comments": [ {'}</Dim>
        {'\n'}
        {'    '}
        <Key>"id"</Key>: <Num>1</Num>,{'\n'}
        {'    '}
        <Key>"body"</Key>: <Str>"Make the Plus button stand out more. Maybe show the yearly price too?"</Str>,{'\n'}
        {'    '}
        <Key>"page"</Key>: {'{ '}
        <Key>"id"</Key>: <Str>"pricing"</Str>, <Key>"path"</Key>: <Str>"/pricing/"</Str>
        {' },'}
        {'\n'}
        {'    '}
        <Key>"viewport"</Key>: {'{ '}
        <Key>"name"</Key>: <Str>"desktop"</Str>, <Key>"width"</Key>: <Num>1440</Num>
        {' },'}
        {'\n'}
        {'    '}
        <Key>"element"</Key>: {'{'}
        {'\n'}
        {'      '}
        <Key>"selector"</Key>: <Str>{'"a[data-testid=\\"plus-cta\\"]"'}</Str>,{'\n'}
        {'      '}
        <Key>"text"</Key>: <Str>"Try Plus free"</Str>
        {'\n'}
        {'    },'}
        {'\n'}
        {'    '}
        <Key>"files"</Key>: {'{ '}
        <Key>"screenshot"</Key>: <Str>".shapewall/demo/captures/pricing.desktop.png"</Str>
        {' }'}
        {'\n'}
        <Dim>{'} ] }'}</Dim>
      </>
    ),
  },
  {
    id: 'watch',
    label: 'watch',
    body: (
      <>
        <Dim># run your agent once per new open comment</Dim>
        {'\n'}
        <Prompt /> shapewall watch --exec <Str>"./fix-comment.sh"</Str>
        {'\n\n'}
        <Dim># each comment moves through</Dim>
        {'\n'}
        <Ok>queued</Ok> <Dim>{'->'}</Dim> <Ok>working</Ok> <Dim>{'->'}</Dim> <Ok>done</Ok> <Dim>or</Dim> <Str>needs-human</Str>
        {'\n\n'}
        <Dim># the comment JSON arrives on stdin, never on the command line</Dim>
        {'\n\n'}
        <Dim># or print one JSON line per comment and pipe it</Dim>
        {'\n'}
        <Prompt /> shapewall watch --new-only
      </>
    ),
  },
  {
    id: 'mcp',
    label: 'MCP',
    body: (
      <>
        <Dim># Claude Code</Dim>
        {'\n'}
        <Prompt /> claude mcp add shapewall -- shapewall mcp{'\n\n'}
        <Dim># Codex</Dim>
        {'\n'}
        <Prompt /> codex mcp add shapewall -- shapewall mcp{'\n\n'}
        <Dim># tools the agent gets</Dim>
        {'\n'}
        <Key>list_comments</Key> <Key>get_comment</Key> <Key>reply_to_comment</Key>
        {'\n'}
        <Key>set_comment_status</Key> <Key>resolve_comment</Key> <Key>recapture_pages</Key>
      </>
    ),
  },
]

export function AgentTerminal() {
  const [tab, setTab] = useState('json')
  const active = TABS.find((item) => item.id === tab)
  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-night-line bg-night-2 shadow-2xl shadow-black/40">
      <div
        className="flex items-center gap-1 overflow-x-auto border-b border-night-line px-2 py-2"
        role="tablist"
        aria-label="Agent interfaces"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="agent-terminal-panel"
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((entry) => entry.id === item.id)
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % TABS.length
                  : event.key === 'ArrowLeft'
                    ? (index + TABS.length - 1) % TABS.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? TABS.length - 1
                        : null
              if (next === null) return
              event.preventDefault()
              setTab(TABS[next].id)
              document.getElementById(`tab-${TABS[next].id}`)?.focus()
            }}
            className={cx(
              'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 font-mono text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wall-bright lg:h-8',
              tab === item.id ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white',
            )}
          >
            {item.label}
            {item.badge ? <span className="rounded bg-pin/20 px-1 text-[10px] font-semibold text-amber-300">{item.badge}</span> : null}
          </button>
        ))}
      </div>
      <pre
        id="agent-terminal-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
        className="h-[340px] overflow-auto px-5 py-4 font-mono text-[12.5px] leading-6 text-zinc-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-wall-bright sm:text-[13px]"
      >
        <code>{active.body}</code>
      </pre>
    </div>
  )
}
