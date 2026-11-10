// The unconnected chat panel on a board opened from the `shapewall serve`
// link (it holds the settings token): the agent CLIs found on this machine,
// each with Connect. Connect adds a native agent profile exactly like the console's
// Agents page "Connect" (settings/AgentsCard.jsx): it sends only the agent id to
// /api/agent/settings/profiles/connect, the server saves its own restricted
// command for it (src/agent/acp/detect.js) after the same confirmation dialog
// as any new command, makes it the default when nothing is connected yet,
// runs the connection test, and puts the settings back when the agent does
// not start.
//
// Nothing is installed from here: an agent without its ACP adapter shows the
// line to run in a terminal, and Check again looks once more.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bot, CheckCircle2, ChevronRight, ExternalLink, Plug, RefreshCw, Settings2, X, XCircle } from 'lucide-react'
import { Button, Spinner, Tooltip } from '../components/ui'
import { api, forgetSettingsToken } from '../lib/api'
import { cn } from '../lib/utils'
import { ConfirmDialog, CopyLine } from '../settings/AgentSettings'
import { SettingsHint, TOKEN_HINT } from '../settings/SettingsHint'

export const DOCS_URL = 'https://shapewall.com/docs/chat'
const HARDENING_URL = `${DOCS_URL}#restrict-the-agents-own-tools`

function OtherOptions({ onOpenSettings, docsUrl, touch, open = false }) {
  return (
    <details className="group rounded-md border border-line text-left" open={open} data-sw-chat-other-options="true">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 text-xs font-medium text-fg lg:min-h-9 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} className="text-muted transition-transform group-open:rotate-90" aria-hidden="true" /> Other options
      </summary>
      <div className="space-y-2 border-t border-line p-3 text-xs text-muted">
        <p>An OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio) or another agent command:</p>
        <div className="flex flex-wrap gap-1.5">
          <Button size={touch ? 'touch' : 'sm'} onClick={onOpenSettings} data-sw-settings-open="connect">
            <Settings2 size={13} aria-hidden="true" /> Open agent settings
          </Button>
          <Button asChild variant="ghost" size={touch ? 'touch' : 'sm'}>
            <a href={docsUrl || DOCS_URL} target="_blank" rel="noreferrer" data-sw-chat-docs="true">
              <ExternalLink size={13} aria-hidden="true" /> Chat docs
            </a>
          </Button>
        </div>
      </div>
    </details>
  )
}

export function QuickConnect({ agent, touch, onOpenSettings, onConnected }) {
  const [view, setView] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [failure, setFailure] = useState(null)
  const [confirm, setConfirm] = useState(null)

  const load = useCallback(async () => {
    try {
      setView(await api.get('/api/agent/settings'))
      setLoadError(null)
    } catch (caught) {
      if (caught.status === 404) forgetSettingsToken()
      setLoadError(caught.status === 404 ? TOKEN_HINT : caught.message)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  // `confirmed`: the hash of the items the dialog showed.
  const connect = async (item, confirmed = null) => {
    setBusy(item.id)
    setFailure(null)
    try {
      const answer = await api.post('/api/agent/settings/profiles/connect', { agentId: item.id, confirm: confirmed })
      if (answer.confirm) {
        // A new command runs as you: the same dialog as Settings > Agent.
        setConfirm({ item, items: answer.confirm, hash: answer.confirmHash })
        return
      }
      setConfirm(null)
      if (!answer.connected) {
        setFailure({ id: item.id, result: answer.result })
        setView(answer)
        return
      }
      onConnected?.(answer.result)
    } catch (caught) {
      setConfirm(null)
      setFailure({ id: item.id, result: { ok: false, message: caught.message, details: [] } })
    } finally {
      setBusy(null)
    }
  }

  if (loadError) {
    return (
      <p className="text-xs text-bad" role="alert" data-sw-settings-error="load">
        {loadError === TOKEN_HINT ? <SettingsHint /> : `Could not look for agents: ${loadError}`}
      </p>
    )
  }
  if (!view) {
    return (
      <p className="flex items-center justify-center gap-2 text-xs text-muted" data-sw-chat-detect="loading">
        <Spinner size={12} /> Looking for agents on this machine
      </p>
    )
  }

  const detected = view.detected || []
  const ready = detected.filter((item) => item.state === 'ready')
  const missing = detected.filter((item) => item.state === 'needs-adapter')
  // Windows: only a .cmd wrapper, which needs a shell.
  const wrapped = detected.filter((item) => item.state === 'needs-shell')
  // --agent-acp or SHAPEWALL_AGENT_ACP wins over a save: Connect would change nothing.
  const overridden = Boolean(view.env?.acp)
  const size = touch ? 'touch' : 'sm'

  return (
    <div className="w-full space-y-3 text-left" data-sw-chat-connect="true">
      {overridden ? (
        <p className="flex items-start gap-1.5 text-xs text-fg" data-sw-chat-connect-override="true">
          <AlertTriangle size={13} className="mt-px shrink-0 text-warn" aria-hidden="true" />
          <span>
            The agent command comes from {view.env.acp === 'flag' ? '--agent-acp' : 'SHAPEWALL_AGENT_ACP'} and wins over the board. Fix it
            there, or restart <code className="font-mono">shapewall serve</code> without it.
          </span>
        </p>
      ) : null}
      {ready.length ? (
        <ul className="space-y-2" aria-label="Agents found on this machine">
          {ready.map((item) => {
            const failed = failure?.id === item.id ? failure.result : null
            return (
              <li key={item.id} className="space-y-2 rounded-md border border-line bg-surface-2/60 p-3" data-sw-chat-detected={item.id}>
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={15} className="shrink-0 text-ok" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">{item.label} found on this machine</p>
                    <Tooltip content={item.path || null}>
                      <p className="truncate font-mono text-[11px] text-muted">{item.command}</p>
                    </Tooltip>
                  </div>
                  <Button
                    variant="default"
                    size={size}
                    onClick={() => connect(item)}
                    disabled={Boolean(busy) || overridden}
                    data-sw-chat-connect-agent={item.id}
                  >
                    {busy === item.id ? <Spinner /> : <Plug size={13} aria-hidden="true" />}{' '}
                    {busy === item.id ? 'Connecting...' : 'Connect'}
                  </Button>
                </div>
                {failed ? (
                  <div className="rounded-md border border-bad/40 bg-bad/10 p-2 text-xs" role="alert" data-sw-chat-connect-result="failed">
                    <p className="flex items-start gap-1.5 font-medium text-bad">
                      <XCircle size={13} className="mt-px shrink-0" aria-hidden="true" /> {failed.message}
                    </p>
                    <p className="mt-1 text-muted">Nothing was changed. {item.login ? `To log it in: ${item.login}.` : ''}</p>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted" data-sw-chat-detected="none">
          No agent CLI with ACP found on this machine (Claude Code, Codex, goose, Gemini CLI).
          {missing.length ? null : <> For Claude Code, install its adapter in a terminal, then check again:</>}
        </p>
      )}
      {!ready.length && !missing.length ? (
        <CopyLine text="npm install -g @agentclientprotocol/claude-agent-acp" label="install" touch={touch} />
      ) : null}
      {missing.map((item) => (
        <div key={item.id} className="space-y-1.5 text-xs text-muted" data-sw-chat-needs-adapter={item.id}>
          <p>
            <span className="font-medium text-fg">{item.label}</span> is installed, but not its ACP adapter. Install it in a terminal, then
            check again:
          </p>
          {item.install ? <CopyLine text={item.install} label={`${item.label} install`} touch={touch} /> : null}
        </div>
      ))}
      {wrapped.map((item) => (
        <p key={item.id} className="text-xs text-muted" data-sw-chat-needs-shell={item.id}>
          <span className="font-medium text-fg">{item.label}</span> is installed only as a <code className="font-mono">.cmd</code> wrapper,
          which needs a shell, and Shapewall never starts one. In Other options, set the agent command to{' '}
          <code className="font-mono">node</code> and the path of its script (see the chat docs).
        </p>
      ))}
      {ready.length ? (
        <p className="text-[11px] leading-4 text-muted" data-sw-chat-connect-note="true">
          Connect asks first, then runs that command on this machine, as you, with the agent’s own login. It brings its own tools (a shell,
          file edits), which Shapewall does not sandbox:{' '}
          <a className="text-accent underline-offset-2 hover:underline" href={HARDENING_URL} target="_blank" rel="noreferrer">
            use a restricted profile
          </a>
          .
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button variant="ghost" size={touch ? 'touch' : 'xs'} onClick={load} disabled={Boolean(busy)} data-sw-chat-detect-again="true">
          <RefreshCw size={12} aria-hidden="true" /> Check again
        </Button>
      </div>
      <OtherOptions onOpenSettings={onOpenSettings} docsUrl={agent?.docsUrl} touch={touch} open={!ready.length && !missing.length} />
      <ConfirmDialog
        items={confirm?.items || null}
        busy={Boolean(busy)}
        touch={touch}
        confirmLabel="Allow and connect"
        onCancel={() => setConfirm(null)}
        onConfirm={() => connect(confirm.item, confirm.hash)}
      />
    </div>
  )
}

// After Connect: what the test found, and how to log the agent in.
export function ConnectedNote({ result, onDismiss, touch }) {
  if (!result) return null
  return (
    <div className={cn('rounded-md border border-ok/40 bg-ok/10 p-3 text-left text-xs')} role="status" data-sw-chat-connected-note="true">
      <p className="flex items-start gap-1.5 font-medium text-fg">
        <Bot size={14} className="mt-px shrink-0 text-ok" aria-hidden="true" />
        <span className="flex-1">
          Connected to {result.label}. {result.message}
        </span>
        <Button variant="ghost" size={touch ? 'icon' : 'icon-xs'} onClick={onDismiss} aria-label="Dismiss" className="-mt-1 -mr-1">
          <X size={13} aria-hidden="true" />
        </Button>
      </p>
      {result.details?.length ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">
          {result.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
