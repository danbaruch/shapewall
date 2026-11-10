// Agents > How fixes run: "Work on a branch" (chat/BranchModeToggle.jsx, the
// same setting as the chat panel's switch) and "Fix several comments at once"
// (batch fixes, src/agent/batch-fixes.js) with its limit. Both are saved for
// this project on this computer, off by default, and follow a change made
// anywhere else ("agents changed", lib/agentEvents.js). A row the server
// does not offer (an older server) is left out; the page shows the card only
// to the owner (the same rule as the Agents card's editable view).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Layers, Wrench } from 'lucide-react'
import { api } from '../lib/api'
import { useAgentsChanged } from '../lib/agentEvents'
import { Input } from '../components/ui'
import { BranchModeRow, SwitchButton } from '../chat/BranchModeToggle'

const BATCH_PATH = '/api/agent/settings/batch-fixes'

export function useBatchSetting() {
  const [state, setState] = useState(null)
  const [max, setMax] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const editing = useRef(false)
  const load = useCallback(async () => {
    try {
      const data = await api.get(BATCH_PATH)
      setState(data)
      if (!editing.current) setMax(String(data?.max ?? ''))
    } catch {
      setState(null)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])
  useAgentsChanged(() => {
    if (!busy) load()
  })
  const save = async (body) => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.post(BATCH_PATH, body)
      setState(data)
      setMax(String(data?.max ?? ''))
    } catch (failure) {
      setError(failure.message || 'Not saved.')
      setMax(String(state?.max ?? ''))
    } finally {
      setBusy(false)
    }
  }
  return { state, max, setMax, busy, error, save, editing }
}

export function BatchFixesRow({ touch = false, disabled = false }) {
  const setting = useBatchSetting()
  const { state, max, setMax, busy, error, save, editing } = setting
  if (!state) return null
  const on = Boolean(state.enabled)
  const ceiling = state.ceiling || 20
  const commit = () => {
    editing.current = false
    const value = Number(max)
    if (!Number.isInteger(value) || value < 1 || value > ceiling) {
      setMax(String(state.max))
      return
    }
    if (value !== state.max) save({ enabled: on, max: value })
  }
  return (
    <li className="space-y-2 p-3" data-sw-agents-batch-fixes={on ? 'on' : 'off'}>
      <div className="flex items-start gap-3">
        <Layers size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p id="sw-agents-batch-label" className="text-sm font-medium text-fg">
            Fix several comments at once
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {on
              ? 'The comments list gets Select: pick open comments and the agent fixes them one after another, each as its own fix with its own Undo. A batch stops when you cancel it or after two failures in a row.'
              : 'Off: Fix with agent works on one comment at a time.'}
          </p>
        </div>
        <SwitchButton
          on={on}
          onChange={(next) => save({ enabled: next })}
          disabled={busy || disabled}
          labelledBy="sw-agents-batch-label"
          touch={touch}
          data-sw-agents-batch-switch="true"
        />
      </div>
      {on ? (
        <label className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-7 text-xs text-muted">
          <span className="shrink-0">At most this many in one batch (1 to {ceiling})</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={ceiling}
            value={max}
            onChange={(event) => setMax(event.target.value.slice(0, 2))}
            onFocus={() => {
              editing.current = true
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            disabled={busy || disabled}
            size={touch ? 'touch' : 'sm'}
            className="w-20 tabular-nums"
            data-sw-agents-batch-max="true"
          />
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="pl-7 text-xs text-bad" data-sw-agents-batch-error="true">
          {error}
        </p>
      ) : null}
    </li>
  )
}

// The rows as one list, in the Agents card's look. `Card` and `CardHeader`
// come from the page (console components) so this file stays settings-only.
export function AgentWorkOptions({ touch = false, Card, CardHeader }) {
  return (
    <Card className="scroll-mt-20" data-sw-agents-work>
      <CardHeader
        icon={Wrench}
        title="How fixes run"
        description="Where the agent makes its changes, and whether it takes several comments in one go."
      />
      <div className="px-4 py-4 sm:px-5">
        <ul className="divide-y divide-line rounded-md border border-line empty:hidden" aria-label="How fixes run">
          <BranchModeRow touch={touch} />
          <BatchFixesRow touch={touch} />
        </ul>
      </div>
    </Card>
  )
}
