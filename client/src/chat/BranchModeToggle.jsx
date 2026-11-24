// Agent branch mode, in the chat's settings popover and on the Agents page:
// when on, the agent's fixes and chat turns run in a worktree of their own and
// wait on a branch until you apply them (src/agent/branch-mode.js). Per
// project, off by default. Hidden when the server does not offer it (no ACP
// agent, a remote device, an older server). Both places follow a change made
// anywhere else ("agents changed", lib/agentEvents.js), never over a prefix
// being typed.

import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch } from 'lucide-react'
import { api } from '../lib/api'
import { useAgentsChanged } from '../lib/agentEvents'
import { Input } from '../components/ui'
import { cn } from '../lib/utils'

const PATH = '/api/agent/settings/branch-mode'
const BRANCH_STATES = { ready: 'ready', moved: 'changed by hand', gone: 'branch deleted', pending: 'in progress' }

// The on/off switch of the agent work rows (branch mode, batch fixes).
// `touch`: a 44 px hit area around the same track.
export function SwitchButton({ on, onChange, disabled, labelledBy, touch = false, ...props }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50',
        touch ? 'h-11 w-14' : 'h-6 w-10',
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex items-center rounded-full border transition-colors',
          touch ? 'h-7 w-12' : 'h-5 w-9',
          on ? 'border-accent bg-accent' : 'border-line-strong bg-surface-2',
        )}
      >
        <span
          className={cn(
            'absolute rounded-full bg-white shadow-card transition-transform duration-(--motion-fast)',
            touch ? 'size-5' : 'size-3.5',
            on ? (touch ? 'translate-x-6' : 'translate-x-4.5') : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  )
}

// The setting as the server has it ({ enabled, prefix, sources, defaultPrefix,
// acp, filters }) or null (not offered), and save(body).
export function useBranchMode() {
  const [state, setState] = useState(null)
  const [prefix, setPrefix] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [branches, setBranches] = useState([])
  const editing = useRef(false)
  const live = useRef(true)
  const load = useCallback(async () => {
    try {
      const data = await api.get(PATH)
      if (!live.current) return
      setState(data)
      if (!editing.current) setPrefix(data?.prefix || '')
    } catch {
      if (live.current) setState(null)
    }
    // The agent's branches waiting in this project (applied and discarded ones are gone).
    api
      .get('/api/agent/branches')
      .then((data) => live.current && setBranches(Array.isArray(data?.branches) ? data.branches : []))
      .catch(() => {})
  }, [])
  useEffect(() => {
    live.current = true
    load()
    return () => {
      live.current = false
    }
  }, [load])
  useAgentsChanged(() => {
    if (!busy) load()
  })
  const save = async (body) => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.post(PATH, body)
      setState(data)
      setPrefix(data?.prefix || '')
    } catch (failure) {
      setError(failure.message || 'Not saved.')
      setPrefix(state?.prefix || '')
    } finally {
      setBusy(false)
    }
  }
  return { state, prefix, setPrefix, busy, error, branches, save, editing }
}

function PrefixField({ mode, disabled, className, touch, ...props }) {
  const { state, prefix, setPrefix, save, editing } = mode
  return (
    <Input
      value={prefix}
      onChange={(event) => setPrefix(event.target.value)}
      onFocus={() => {
        editing.current = true
      }}
      onBlur={() => {
        editing.current = false
        if (prefix !== state.prefix) save({ enabled: Boolean(state.enabled), prefix: prefix || state.defaultPrefix })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      disabled={disabled || state.sources?.prefix === 'env'}
      placeholder={state.defaultPrefix}
      maxLength={40}
      spellCheck={false}
      size={touch ? 'touch' : 'sm'}
      className={cn('min-w-0 font-mono', className)}
      {...props}
    />
  )
}

const explain = (state, on) =>
  `${
    on
      ? 'Fixes and chat turns run in a separate folder and are committed on a branch. Your checkout changes only when you apply one. Uncommitted changes in your checkout are not carried over.'
      : 'Off: the agent edits your checkout directly.'
  }${on && !state.acp ? ' It applies to a coding agent connected over ACP; this agent edits the checkout as before.' : ''}${
    state.sources?.enabled === 'env' ? ' Set by SHAPEWALL_AGENT_BRANCH_MODE.' : ''
  }`

// This repository names Git filters (Git LFS is one): branch mode runs none
// of them, so the agent sees those files in their stored form (an LFS
// pointer file), and Apply refuses a change to one.
function FilterNote({ state, className }) {
  const filters = Array.isArray(state.filters) ? state.filters.slice(0, 4) : []
  if (!filters.length) return null
  const lfs = filters.includes('lfs')
  return (
    <p className={cn('text-warn', className)} data-sw-branch-mode-filters={filters.join(' ')}>
      This repository uses {lfs ? 'Git LFS' : `the Git filter ${filters.join(', ')}`}. On a branch, the agent sees those files as Git stores
      them{lfs ? ' (small pointer files)' : ''}, not as you see them, and Apply refuses a change to one.
    </p>
  )
}

// The chat panel's compact row.
export default function BranchModeToggle({ touch = false, disabled = false }) {
  const mode = useBranchMode()
  const { state, busy, error, branches, save } = mode
  if (!state) return null
  // Set by SHAPEWALL_AGENT_BRANCH_MODE: the switch shows it but cannot change it.
  const fromEnv = state.sources?.enabled === 'env'
  const on = Boolean(state.enabled)
  return (
    <div className="space-y-1.5 border-t border-line pt-3 text-xs" data-sw-chat-branch-mode={on ? 'on' : 'off'}>
      <div className="flex items-center gap-2">
        <GitBranch size={13} className="shrink-0 text-muted" aria-hidden="true" />
        <span id="sw-branch-mode-label" className="min-w-0 flex-1 font-medium text-fg">
          Agent works on a branch
        </span>
        <SwitchButton
          on={on}
          onChange={(next) => save({ enabled: next })}
          disabled={busy || disabled || fromEnv}
          labelledBy="sw-branch-mode-label"
          touch={touch}
          data-sw-chat-branch-mode-switch="true"
        />
      </div>
      <p className="text-muted">{explain(state, on)}</p>
      <FilterNote state={state} />
      {on ? (
        <label className="flex items-center gap-2 text-muted">
          <span className="shrink-0">Branch prefix</span>
          <PrefixField
            mode={mode}
            disabled={busy || disabled}
            touch={touch}
            className={touch ? 'flex-1' : 'h-7 flex-1 text-[11px]'}
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

// The Agents page's row (settings/AgentWorkOptions.jsx), styled like its
// neighbours: title, one line, the switch on the right, the prefix below.
export function BranchModeRow({ touch = false, disabled = false }) {
  const mode = useBranchMode()
  const { state, busy, error, save } = mode
  if (!state) return null
  const fromEnv = state.sources?.enabled === 'env'
  const on = Boolean(state.enabled)
  return (
    <li className="space-y-2 p-3" data-sw-agents-branch-mode={on ? 'on' : 'off'}>
      <div className="flex items-start gap-3">
        <GitBranch size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p id="sw-agents-branch-mode-label" className="text-sm font-medium text-fg">
            Work on a branch
          </p>
          <p className="mt-0.5 text-xs text-muted">{explain(state, on)}</p>
          <FilterNote state={state} className="mt-1 text-xs" />
        </div>
        <SwitchButton
          on={on}
          onChange={(next) => save({ enabled: next })}
          disabled={busy || disabled || fromEnv}
          labelledBy="sw-agents-branch-mode-label"
          touch={touch}
          data-sw-agents-branch-mode-switch="true"
        />
      </div>
      {on ? (
        <label className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-7 text-xs text-muted">
          <span className="shrink-0">Branch prefix (optional)</span>
          <PrefixField
            mode={mode}
            disabled={busy || disabled}
            touch={touch}
            className="w-48 max-w-full"
            data-sw-agents-branch-prefix="true"
          />
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="pl-7 text-xs text-bad" data-sw-agents-branch-mode-error="true">
          {error}
        </p>
      ) : null}
    </li>
  )
}
