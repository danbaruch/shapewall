// The Agents card: the home for choosing and setting up agents. It lives in
// the local Workspace Console's Settings page (console/LocalConsole.jsx), in
// the agent dialog the chat opens (Connect another agent...), and in the
// host-only settings window (Management.jsx); the board's general Settings
// dialog links to it.
//
// - Every agent Shapewall knows how to run (src/agent/acp/detect.js), with
//   its state on this machine: Connected; Found, not connected (Connect,
//   with the same confirmation as anywhere else); the CLI without its ACP
//   adapter (the install line to copy, and Check again: Shapewall never
//   installs or downloads anything); Not installed (where to get it).
// - The default agent for new chats and fixes, saved through
//   POST /api/agent/settings/profiles/:id/default.
// - Per connected agent: Test connection, Remove, and how to sign in.
// - Other: an OpenAI-compatible endpoint, in the existing form.
//
// Connecting and removing run commands as this machine's owner, so they need
// the settings token (src/agent/settings-routes.js). Without it the card is
// read-only: the connected agents from /api/agent/status, and how to open
// the owner link. The public demo shows the full card from sample data
// (client/src/demo/backend/routes-agents.js): an action that would run a
// command there answers `{ demoNote }`, shown as a neutral note on its row.

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bot, ExternalLink, Globe, Lock, Plug, RefreshCw, Trash2 } from 'lucide-react'
import { api, forgetSettingsToken } from '../lib/api'
import { cn } from '../lib/utils'
import { Badge, Button, Dialog, Spinner } from '../components/ui'
import { AgentMark } from '../chat/AgentPicker'
import { pickerProfiles, signInHint, stateLine } from '../chat/profiles'
import { DOCS_URL } from '../chat/QuickConnect'
import { ConfirmDialog, CopyLine, TestResult } from './AgentSettingsParts'
import { agentRows } from './agentRows'

// Where to get an agent that is not on this machine: one line and its docs.
const GET_IT = {
  claude: { text: 'Install Claude Code and its adapter, then check again.', anchor: 'claude-code' },
  codex: { text: 'Install Codex and its adapter, then check again.', anchor: 'codex' },
  goose: { text: 'Install goose from its install guide, then check again.', anchor: 'goose' },
  gemini: { text: 'Install Gemini CLI, then check again.', anchor: 'gemini-cli' },
}

const DEMO_CHECK = 'In the demo nothing runs on a computer. On your install this looks for the agent again.'

const ROW_STATE = {
  connected: 'Connected',
  found: 'Found, not connected',
  'needs-adapter': 'Found, but its adapter is missing',
  'needs-shell': 'Found, but only as a .cmd wrapper',
  missing: 'Not installed',
}

function Section({ title, description, children, ...props }) {
  return (
    <section className="space-y-2.5" {...props}>
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

// `view`: the settings answer when the parent already has it (AgentSettings),
// else the card loads it. `disabled`: unsaved edits elsewhere on the screen.
// `onChanged`: after a connect, a removal or a new default. `onOpenEndpoint`:
// the Other row's form (null: the card opens it itself, in a dialog, through
// `endpointForm`).
export function AgentsCard({
  view: given = null,
  disabled = false,
  touch = false,
  onBusy = null,
  onChanged = null,
  endpointForm = null,
  onOpenEndpoint = null,
  // /api/info's `agent`, when the page has it: a tab without the owner's
  // settings token asks nothing of the agent routes and shows the default.
  agent = null,
}) {
  const [loaded, setLoaded] = useState(null)
  // null, or why the editable card is not there: 'owner' (no settings token),
  // or the server's message (a shared board, a remote browser).
  const [locked, setLocked] = useState(null)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [results, setResults] = useState({})
  const [endpointOpen, setEndpointOpen] = useState(false)
  useEffect(() => onBusy?.(Boolean(busy)), [busy, onBusy])

  const load = useCallback(async () => {
    if (agent && !agent.settingsEditable) {
      setLocked(agent.settingsReadonly ? 'Change agents on the computer running Shapewall.' : 'owner')
      setStatus(agent)
      return
    }
    try {
      const next = await api.get('/api/agent/settings')
      if (next.editable === false) {
        setLocked(next.message || 'owner')
        setStatus(await api.get('/api/agent/status').catch(() => null))
        return
      }
      setLoaded(next)
      setLocked(null)
    } catch (caught) {
      if (caught.status === 404) forgetSettingsToken()
      setLocked(caught.status === 404 ? 'owner' : caught.message)
      setStatus(await api.get('/api/agent/status').catch(() => null))
    }
  }, [agent])
  useEffect(() => {
    if (!given) load()
  }, [given, load])
  const view = given || loaded
  const changed = async (next) => {
    if (next && !given) setLoaded(next)
    else if (!given) await load()
    await onChanged?.()
  }

  // The demo's answer for something only a computer can do: a note, not an error.
  const noted = (id, next) => {
    if (!next?.demoNote) return false
    setConfirm(null)
    setResults((current) => ({ ...current, [id]: { note: next.demoNote } }))
    return true
  }

  // Connect: the server's own command for that agent, after the same
  // confirmation as any new command; then the handshake.
  const connect = async (agentId, hash = null) => {
    setBusy(agentId)
    setResults((current) => ({ ...current, [agentId]: null }))
    try {
      const next = await api.post('/api/agent/settings/profiles/connect', { agentId, confirm: hash })
      if (noted(agentId, next)) return
      if (next.confirm) {
        setConfirm({ agentId, items: next.confirm, hash: next.confirmHash })
        return
      }
      setConfirm(null)
      setResults((current) => ({ ...current, [agentId]: next.result }))
      if (next.connected) await changed(next)
    } catch (error) {
      setConfirm(null)
      setResults((current) => ({ ...current, [agentId]: { ok: false, message: error.message, details: [] } }))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (id) => {
    setBusy(id)
    try {
      const next = await api.delete(`/api/agent/settings/profiles/${encodeURIComponent(id)}`)
      if (noted(id, next)) return
      await changed(next)
      setResults((current) => ({ ...current, [id]: null }))
    } catch (error) {
      setResults((current) => ({ ...current, [id]: { ok: false, message: error.message, details: [] } }))
    } finally {
      setBusy(null)
    }
  }
  // `asDefault`: test the default connection (the endpoint, or a command
  // saved before profiles), not a profile.
  const test = async (id, asDefault = false) => {
    setBusy(id)
    setResults((current) => ({ ...current, [id]: null }))
    try {
      const result = await api.post('/api/agent/settings/test', asDefault ? {} : { profileId: id })
      if (noted(id, result)) return
      setResults((current) => ({ ...current, [id]: result }))
      if (!given) await load()
    } catch (error) {
      setResults((current) => ({ ...current, [id]: { ok: false, message: error.message, details: [] } }))
    } finally {
      setBusy(null)
    }
  }
  const makeDefault = async (id) => {
    setBusy(`default:${id}`)
    try {
      const next = await api.post(`/api/agent/settings/profiles/${encodeURIComponent(id)}/default`, {})
      if (noted('default', next)) return
      await changed(next)
    } catch (error) {
      setResults((current) => ({ ...current, default: { ok: false, message: error.message, details: [] } }))
    } finally {
      setBusy(null)
    }
  }

  const size = touch ? 'touch' : 'sm'

  if (locked) return <ReadOnlyAgents locked={locked} status={status} />
  if (!view) {
    return (
      <p className="flex items-center gap-2 p-1 text-sm text-muted" data-sw-agents-card="loading">
        <Spinner /> Looking for agents on this machine
      </p>
    )
  }
  const overridden = Boolean(view.env?.acp)
  const rows = agentRows(view)
  const connected = rows.filter((row) => row.kind === 'connected')
  const choices = [
    ...connected.map((row) => ({ id: row.id, label: row.label, state: row.profile.state, isDefault: row.profile.default })),
    ...(view.endpoint
      ? [{ id: 'endpoint', label: view.endpoint.label, state: view.endpoint.state, isDefault: view.endpoint.default }]
      : []),
  ]
  const off = Boolean(busy) || disabled || overridden

  return (
    <div className="space-y-6" data-sw-agents-card={view.demo ? 'demo' : 'editable'} data-sw-native-profiles>
      {view.demo ? (
        <p
          className="flex items-start gap-2 rounded-md border border-line bg-surface-2/60 px-3 py-2.5 text-xs text-muted"
          role="note"
          data-sw-agents-demo-note
        >
          <Bot size={14} className="mt-px shrink-0" aria-hidden="true" />
          <span>
            This is a demo with sample agents on a pretend computer. The two scripted agents answer in this browser, and nothing is sent
            anywhere. Choosing the default, testing, removing and connecting them works here; Reset puts everything back.
          </span>
        </p>
      ) : null}
      {overridden ? (
        <p className="flex items-start gap-1.5 text-xs text-fg" data-sw-agents-override>
          <AlertTriangle size={13} className="mt-px shrink-0 text-warn" aria-hidden="true" />
          <span>
            The agent command comes from {view.env.acp === 'flag' ? '--agent-acp' : 'SHAPEWALL_AGENT_ACP'}, which wins over these settings.
            Change it there, or restart <code className="font-mono">shapewall serve</code> without it.
          </span>
        </p>
      ) : null}
      {choices.length ? (
        <Section title="Default agent for new chats and fixes" description="Chats that chose another agent keep theirs.">
          <div role="radiogroup" aria-label="Default agent for new chats and fixes" className="grid gap-1.5" data-sw-agents-default>
            {choices.map((choice) => (
              <label
                key={choice.id}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm lg:min-h-10',
                  choice.isDefault ? 'border-accent/50 bg-accent/10' : 'border-line bg-surface hover:bg-surface-2',
                  off && 'cursor-default opacity-70',
                )}
                data-sw-agents-default-option={choice.id}
              >
                <input
                  type="radio"
                  name="sw-default-agent"
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                  checked={Boolean(choice.isDefault)}
                  disabled={off}
                  onChange={() => makeDefault(choice.id)}
                />
                {choice.id === 'endpoint' ? (
                  <Globe size={16} className="shrink-0 text-muted" aria-hidden="true" />
                ) : (
                  <AgentMark label={choice.label} state={choice.state} size="sm" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{choice.label}</span>
                {busy === `default:${choice.id}` ? <Spinner size={12} /> : null}
                {choice.isDefault ? <Badge tone="accent">Default</Badge> : null}
              </label>
            ))}
          </div>
          {results.default ? <TestResult result={results.default} /> : null}
        </Section>
      ) : null}

      <Section
        title="Agents on this machine"
        description="Shapewall looks for these on this computer's PATH. It never installs or downloads anything."
      >
        <ul className="divide-y divide-line rounded-md border border-line" aria-label="Agents on this machine">
          {rows.map((row) => (
            <li key={row.id} className="space-y-2 p-3" data-sw-agent-row={row.id} data-sw-agent-row-state={row.kind}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <AgentMark label={row.label} state={row.kind === 'connected' ? row.profile.state : 'unavailable'} />
                <div className="min-w-[10rem] flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                    {row.label}
                    {row.profile?.default ? <Badge tone="accent">Default</Badge> : null}
                  </p>
                  <p className={cn('text-xs', row.kind === 'connected' && row.profile.state === 'login' ? 'text-fg' : 'text-muted')}>
                    {row.kind === 'connected' ? `Connected. ${stateLine(row.profile)}` : ROW_STATE[row.kind]}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {row.kind === 'connected' ? (
                    <>
                      <Button size={size} disabled={off} onClick={() => test(row.id, row.profile.legacy)} data-sw-agent-test={row.id}>
                        {busy === row.id ? <Spinner /> : null} Test connection
                      </Button>
                      <Button size={size} variant="danger" disabled={off} onClick={() => remove(row.id)} data-sw-agent-remove={row.id}>
                        <Trash2 size={13} aria-hidden="true" /> Remove
                      </Button>
                    </>
                  ) : row.kind === 'found' ? (
                    <Button
                      size={size}
                      variant="default"
                      disabled={off}
                      onClick={() => connect(row.id)}
                      data-sw-profile-connect={row.id}
                      data-sw-agent-connect-row={row.id}
                    >
                      {busy === row.id ? <Spinner /> : <Plug size={13} aria-hidden="true" />}{' '}
                      {busy === row.id ? 'Connecting...' : 'Connect'}
                    </Button>
                  ) : row.kind === 'needs-adapter' || row.kind === 'missing' ? (
                    <Button
                      size={size}
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => (view.demo ? noted(row.id, { demoNote: DEMO_CHECK }) : changed())}
                      data-sw-agent-check={row.id}
                    >
                      <RefreshCw size={13} aria-hidden="true" /> Check again
                    </Button>
                  ) : null}
                </div>
              </div>
              {row.kind === 'connected' && row.profile.state === 'login' && row.profile.loginHint ? (
                <p className="text-xs text-muted" data-sw-agent-sign-in={row.id}>
                  {signInHint(row.profile.loginHint)}, then test again.
                </p>
              ) : null}
              {row.kind === 'needs-adapter' && row.install ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted">Install its adapter in a terminal, then check again:</p>
                  <CopyLine text={row.install} label={`${row.label} install`} touch={touch} />
                </div>
              ) : null}
              {row.kind === 'needs-shell' ? (
                <p className="text-xs text-muted">
                  It needs a shell, which Shapewall never starts. Under Other, set the agent command to{' '}
                  <code className="font-mono">node</code> and the path of its script (see the docs).
                </p>
              ) : null}
              {row.kind === 'missing' ? (
                <p className="text-xs text-muted">
                  {GET_IT[row.id]?.text || 'Install it, then check again.'}{' '}
                  <a
                    className="inline-flex items-center gap-0.5 text-accent underline-offset-2 hover:underline"
                    href={`${DOCS_URL}#${GET_IT[row.id]?.anchor || 'connect-an-agent-cli-over-acp'}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    How to set it up <ExternalLink size={11} aria-hidden="true" />
                  </a>
                </p>
              ) : null}
              <TestResult result={results[row.id]} />
            </li>
          ))}
          <li className="space-y-2 p-3" data-sw-agent-row="endpoint" data-sw-agent-row-state={view.endpoint ? 'connected' : 'none'}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-muted">
                <Globe size={14} aria-hidden="true" />
              </span>
              <div className="min-w-[10rem] flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                  Other
                  {view.endpoint?.default ? <Badge tone="accent">Default</Badge> : null}
                </p>
                <p className="text-xs text-muted">
                  {view.endpoint
                    ? `${view.endpoint.label}${view.endpoint.host ? ` at ${view.endpoint.host}` : ''}`
                    : 'An OpenAI-compatible endpoint: OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {view.endpoint?.default ? (
                  <Button size={size} disabled={off} onClick={() => test('endpoint', true)} data-sw-agent-test="endpoint">
                    {busy === 'endpoint' ? <Spinner /> : null} Test connection
                  </Button>
                ) : null}
                {endpointForm || onOpenEndpoint ? (
                  <Button
                    size={size}
                    disabled={Boolean(busy) || disabled}
                    onClick={() => (onOpenEndpoint ? onOpenEndpoint() : setEndpointOpen(true))}
                    data-sw-agent-endpoint
                  >
                    {view.endpoint ? 'Edit' : 'Set up'}
                  </Button>
                ) : null}
              </div>
            </div>
            <TestResult result={results.endpoint} />
          </li>
        </ul>
      </Section>
      <ConfirmDialog
        items={confirm?.items || null}
        keyVar=""
        busy={Boolean(busy)}
        touch={touch}
        onCancel={() => setConfirm(null)}
        onConfirm={() => connect(confirm.agentId, confirm.hash)}
        confirmLabel="Allow and connect"
      />
      {endpointForm ? (
        <Dialog
          open={endpointOpen}
          onClose={() => {
            setEndpointOpen(false)
            changed()
          }}
          title="Other agent settings"
          size="md"
        >
          <div className="p-5">{endpointOpen ? endpointForm({ onSaved: () => changed() }) : null}</div>
        </Dialog>
      ) : null}
    </div>
  )
}

// Without the owner's capability: the connected agents as
// they are, and one sentence on how to change them.
function ReadOnlyAgents({ locked, status }) {
  const { options } = pickerProfiles({ profileId: 'default', profiles: status?.profiles || [] })
  const list = options.length
    ? options
    : status?.configured
      ? [{ id: 'default', label: status.label || 'Agent', state: status.state || 'ready', isDefault: true, configured: true }]
      : []
  const note =
    locked === 'owner'
      ? 'To change agents, open the owner link that shapewall serve prints in your terminal (or run shapewall serve --open).'
      : locked
  return (
    <div className="space-y-3" data-sw-agents-card="readonly">
      <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2/60 px-3 py-2.5 text-xs text-muted" role="note">
        <Lock size={14} className="mt-px shrink-0" aria-hidden="true" />
        <span>{note}</span>
      </p>
      {list.length ? (
        <ul className="divide-y divide-line rounded-md border border-line" aria-label="Connected agents">
          {list.map((option) => (
            <li key={option.id} className="flex items-center gap-3 p-3" data-sw-agent-row={option.id} data-sw-agent-row-state="connected">
              <AgentMark label={option.label} state={option.state} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-fg">
                  {option.label}
                  {option.isDefault ? <Badge tone="accent">Default</Badge> : null}
                </p>
                <p className="text-xs text-muted">{stateLine(option)}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">No agent is connected.</p>
      )}
    </div>
  )
}
