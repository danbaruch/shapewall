// When this thread's agent answers, in the chat settings popover: a private
// chat answers every message; a shared thread (the board chat, a comment's)
// answers an @mention of the agent or Send to agent, unless the person who
// connected the agent switched "Answer every message" on for it
// (src/agent/triggers.js). Shown only for a shared thread. The switch is
// there only for someone who may change it (the server says: `canSet`).

import { useState } from 'react'
import { api } from '../lib/api'
import { threadPath } from './stream'
import { SwitchButton } from './BranchModeToggle'

export function RespondSetting({ boardId, threadId, respond, onChanged, touch = false, disabled = false }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  if (!respond?.shared) return null
  const always = respond.mode === 'always'
  const may = always ? respond.canSet?.mention : respond.canSet?.always
  const change = async (on) => {
    setBusy(true)
    setError(null)
    try {
      await api.patch(threadPath(boardId, threadId), { respond: on ? 'always' : 'mention' })
      await onChanged?.()
    } catch (failure) {
      setError(failure?.message || 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1 border-t border-line pt-3 text-xs" data-sw-chat-respond={respond.mode}>
      <div className="flex items-center justify-between gap-2">
        <p id="sw-chat-respond-label" className="font-medium text-fg">
          Answer every message
        </p>
        {may ? (
          <SwitchButton
            on={always}
            onChange={change}
            disabled={busy || disabled}
            labelledBy="sw-chat-respond-label"
            touch={touch}
            data-sw-chat-respond-switch="true"
          />
        ) : null}
      </div>
      <p className="text-muted">{respond.line}</p>
      {respond.note ? <p className="text-muted">{respond.note}</p> : null}
      <p className="text-muted">Messages other agents write never wake it.</p>
      {error ? (
        <p className="text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
