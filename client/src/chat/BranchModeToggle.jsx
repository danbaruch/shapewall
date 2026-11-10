// Agent branch mode, in the chat's settings popover: when on, the agent's
// fixes and chat turns run in a worktree of their own and wait on a branch
// until you apply them (src/agent/branch-mode.js). Per project, off by
// default. Hidden when the server does not offer it (no ACP agent, a remote
// device, an older server).

import { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { api } from '../lib/api'
import { Input } from '../components/ui'
import { cn } from '../lib/utils'

const PATH = '/api/agent/settings/branch-mode'
const BRANCH_STATES = { ready: 'ready', moved: 'changed by hand', gone: 'branch deleted', pending: 'in progress' }

export default function BranchModeToggle({ touch = false, disabled = false }) {
  const [state, setState] = useState(null)
  const [prefix, setPrefix] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [branches, setBranches] = useState([])
  useEffect(() => {
    let live = true
    api
      .get(PATH)
      .then((data) => {
        if (!live) return
        setState(data)
        setPrefix(data?.prefix || '')
      })
      .catch(() => live && setState(null))
    // The agent's branches waiting in this project (applied and discarded ones are gone).
    api
      .get('/api/agent/branches')
      .then((data) => live && setBranches(Array.isArray(data?.branches) ? data.branches : []))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  if (!state) return null
  // Set by SHAPEWALL_AGENT_BRANCH_MODE: the switch shows it but cannot change it.
  const fromEnv = state.sources?.enabled === 'env'
  const save = async (body) => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.post(PATH, body)
      setState(data)
      setPrefix(data?.prefix || '')
    } catch (failure) {
      setError(failure.message || 'Not saved.')
      setPrefix(state.prefix || '')
    } finally {
      setBusy(false)
    }
  }
  const on = Boolean(state.enabled)
  return (
    <div className="space-y-1.5 border-t border-line pt-3 text-xs" data-sw-chat-branch-mode={on ? 'on' : 'off'}>
      <div className="flex items-center gap-2">
        <GitBranch size={13} className="shrink-0 text-muted" aria-hidden="true" />
        <span id="sw-branch-mode-label" className="min-w-0 flex-1 font-medium text-fg">
          Agent works on a branch
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="sw-branch-mode-label"
          disabled={busy || disabled || fromEnv}
          onClick={() => save({ enabled: !on })}
          className={cn(
            'relative inline-flex shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50',
            touch ? 'h-7 w-12' : 'h-5 w-9',
            on ? 'border-accent bg-accent' : 'border-line-strong bg-surface-2',
          )}
          data-sw-chat-branch-mode-switch="true"
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute rounded-full bg-white shadow-card transition-transform duration-(--motion-fast)',
              touch ? 'size-5' : 'size-3.5',
              on ? (touch ? 'translate-x-6' : 'translate-x-4.5') : 'translate-x-0.5',
            )}
          />
        </button>
      </div>
      <p className="text-muted">
        {on
          ? 'Fixes and chat turns run in a separate folder and are committed on a branch. Your checkout changes only when you apply one. Uncommitted changes in your checkout are not carried over.'
          : 'Off: the agent edits your checkout directly.'}
        {on && !state.acp ? ' It applies to a coding agent connected over ACP; this agent edits the checkout as before.' : ''}
        {fromEnv ? ' Set by SHAPEWALL_AGENT_BRANCH_MODE.' : ''}
      </p>
      {on ? (
        <label className="flex items-center gap-2 text-muted">
          <span className="shrink-0">Branch prefix</span>
          <Input
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            onBlur={() => {
              if (prefix !== state.prefix) save({ enabled: on, prefix: prefix || state.defaultPrefix })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            disabled={busy || disabled || state.sources?.prefix === 'env'}
            placeholder={state.defaultPrefix}
            maxLength={40}
            spellCheck={false}
            className="h-7 min-w-0 flex-1 font-mono text-[11px]"
            data-sw-chat-branch-prefix="true"
          />
        </label>
      ) : null}
      {branches.length ? (
        <div className="space-y-1" data-sw-chat-agent-branches={branches.length}>
          <p className="font-medium text-fg">Agent branches</p>
          <ul className="space-y-0.5">
            {branches.map((item) => (
              <li key={item.id} className="flex min-w-0 items-center gap-1.5 text-muted" data-sw-chat-agent-branch={item.branch}>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{item.branch}</span>
                {item.commentId ? <span className="shrink-0">#{item.commentId}</span> : null}
                <span className="shrink-0">{BRANCH_STATES[item.state] || item.state}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted">Apply or discard each one from its answer in the chat.</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-bad" data-sw-chat-branch-mode-error="true">
          {error}
        </p>
      ) : null}
    </div>
  )
}
