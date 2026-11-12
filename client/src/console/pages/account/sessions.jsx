// Account: signed-in devices (sign out one, or all others).

import { useEffect, useRef, useState } from 'react'
import { LogOut, Monitor, ShieldAlert, Smartphone } from 'lucide-react'
import { Badge, Button } from '../../../components/ui'
import { Card, CardHeader, ConfirmDialog, LoadError, Loading, Time } from '../../components'
import { api } from '../../lib/api'
import { useAction, useLoad, useSession, useSignOut, useToast } from '../../state'

export function Sessions() {
  const toast = useToast()
  const sessions = useLoad('/auth/sessions')
  const { me } = useSession()
  // Removing a passkey signs out the other devices: show that.
  const passkeyCount = me.passkeys.length
  const reloadSessions = sessions.reload
  const shownCount = useRef(passkeyCount)
  useEffect(() => {
    if (shownCount.current === passkeyCount) return
    shownCount.current = passkeyCount
    reloadSessions()
  }, [passkeyCount, reloadSessions])
  const [ending, setEnding] = useState(null)
  const [allOthers, setAllOthers] = useState(false)
  const end = useAction()
  const list = sessions.data?.sessions || []
  const others = list.filter((item) => !item.current)
  const signOut = useSignOut()
  return (
    <Card id="account-devices" className="scroll-mt-20" data-sw-sessions>
      <CardHeader
        icon={Monitor}
        title="Signed-in devices"
        description="Sessions last 30 days from last use (90 at most)."
        actions={
          <>
            {others.length ? (
              <Button size="touch" variant="secondary" onClick={() => setAllOthers(true)} className="lg:h-9" data-sw-signout-others>
                Sign out other devices
              </Button>
            ) : null}
            <Button size="touch" variant="ghost" onClick={signOut} className="lg:h-9" data-sw-signout>
              <LogOut size={15} aria-hidden="true" /> Sign out
            </Button>
          </>
        }
      />
      {sessions.loading ? <Loading /> : null}
      {sessions.error ? (
        <div className="p-4">
          <LoadError error={sessions.error} onRetry={sessions.reload} />
        </div>
      ) : null}
      <ul className="divide-y divide-line">
        {list.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5"
            data-sw-session={item.current ? 'current' : 'other'}
          >
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
              {/iOS|Android/.test(item.device || '') ? (
                <Smartphone size={16} aria-hidden="true" />
              ) : (
                <Monitor size={16} aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-fg">{item.device || 'Unknown device'}</p>
                {item.current ? (
                  <Badge tone="ok" className="px-2 py-0.5 text-[11px]">
                    This device
                  </Badge>
                ) : null}
                {item.via === 'tailnet' ? (
                  <Badge className="px-2 py-0.5 text-[11px]" data-sw-session-tailnet>
                    Signed in by tailnet
                  </Badge>
                ) : null}
                {item.via === 'recovery' ? (
                  <Badge tone="warn" className="px-2 py-0.5 text-[11px]">
                    <ShieldAlert size={11} aria-hidden="true" /> Recovery code
                  </Badge>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-muted">
                Signed in <Time value={item.createdAt} /> · Active <Time value={item.lastSeenAt} />
                {item.ip ? ` · ${item.ip}` : ''}
              </p>
            </div>
            {item.current ? null : (
              <Button size="touch" variant="danger" onClick={() => setEnding(item)} className="lg:h-8" data-sw-end-session>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(ending)}
        onClose={() => setEnding(null)}
        title={`Sign out ${ending?.device || 'this device'}?`}
        confirmLabel="Sign it out"
        tone="danger"
        busy={end.busy}
        error={end.error}
        onConfirm={() =>
          end.run(async () => {
            const result = await api.delete(`/auth/sessions/${ending.id}`)
            sessions.setData(result)
            setEnding(null)
            toast('Signed out that device')
          })
        }
      >
        <p>That browser has to sign in again.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={allOthers}
        onClose={() => setAllOthers(false)}
        title="Sign out every other device?"
        confirmLabel="Sign out others"
        tone="danger"
        busy={end.busy}
        error={end.error}
        onConfirm={() =>
          end.run(async () => {
            const result = await api.post('/auth/sessions/revoke-others', {})
            sessions.setData(result)
            setAllOthers(false)
            toast('Signed out everywhere else')
          })
        }
      >
        <p>Only this browser stays signed in.</p>
      </ConfirmDialog>
    </Card>
  )
}
