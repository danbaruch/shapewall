import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { Button } from '../components/ui'
import { ConfirmDialog } from './AgentSettingsParts'

// Native profiles are independent ACP sessions, connected only after owner confirmation.
export function NativeProfiles({ view, disabled, touch, onBusy, onChanged, buzz }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => onBusy?.(busy), [busy, onBusy])
  const [confirm, setConfirm] = useState(null)
  const [result, setResult] = useState(null)
  const connect = async (agentId, hash = null) => {
    setBusy(true)
    setResult(null)
    try {
      const next = await api.post('/api/agent/settings/profiles/connect', { agentId, confirm: hash })
      if (next.confirm) {
        setConfirm({ agentId, items: next.confirm, hash: next.confirmHash })
        return
      }
      setConfirm(null)
      setResult(next.result)
      if (next.connected) await onChanged()
    } catch (error) {
      setConfirm(null)
      setResult({ ok: false, message: error.message })
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id) => {
    setBusy(true)
    try {
      await api.delete(`/api/agent/settings/profiles/${encodeURIComponent(id)}`)
      await onChanged()
    } catch (error) {
      setResult({ ok: false, message: error.message })
    } finally {
      setBusy(false)
    }
  }
  // Every connected agent (src/agent/settings-routes.js view.profiles); an
  // older server sends only the saved list.
  const saved = view.profiles || view.saved?.profiles || []
  return (
    <section className="space-y-3 rounded-md border border-line p-3" data-sw-native-profiles>
      <h3 className="text-sm font-semibold text-fg">Native agent profiles</h3>
      <p className="text-xs text-muted">
        Connect several agents, then choose one per chat thread. Each runs its own ACP session using its existing CLI login.
        {buzz ? ' Buzz conversations are separate.' : ''}
      </p>
      {view.env?.acp ? (
        <p className="text-xs text-muted">
          Profiles are locked while an agent command is set on the command line or in the environment (see below).
        </p>
      ) : (
        <>
          {saved.map((profile) => (
            <div key={profile.id} className="flex items-center justify-between gap-2 text-sm text-fg" data-sw-native-profile={profile.id}>
              <span>
                {profile.label}
                {profile.default ? <span className="text-xs text-muted"> (new chats use it)</span> : null}
              </span>
              <Button size={touch ? 'touch' : 'sm'} disabled={busy || disabled} onClick={() => remove(profile.id)}>
                Remove profile
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {(view.detected || []).map((agent) => (
              <Button
                key={agent.id}
                size={touch ? 'touch' : 'sm'}
                disabled={busy || disabled || agent.state !== 'ready'}
                onClick={() => connect(agent.id)}
                data-sw-profile-connect={agent.id}
              >
                {saved.some((item) => item.id === agent.id) ? 'Reconnect' : 'Add'} {agent.label}
                {agent.state !== 'ready' ? ' (adapter needed)' : ''}
              </Button>
            ))}
          </div>
          {!(view.detected || []).length ? (
            <p className="text-xs text-muted">
              No native agent CLI was found on this server's PATH. Install Claude Code with its ACP adapter, Codex with codex-acp, or goose,
              then reopen Settings.
            </p>
          ) : null}
          {disabled ? <p className="text-xs text-muted">Save or discard your changes below before changing profiles.</p> : null}
        </>
      )}
      {result ? (
        <p role="status" className={cn('text-xs', result.ok ? 'text-muted' : 'text-bad')}>
          {result.message}
        </p>
      ) : null}
      <ConfirmDialog
        items={confirm?.items || null}
        keyVar=""
        busy={busy}
        touch={touch}
        onCancel={() => setConfirm(null)}
        onConfirm={() => connect(confirm.agentId, confirm.hash)}
        confirmLabel="Allow and connect"
      />
    </section>
  )
}
