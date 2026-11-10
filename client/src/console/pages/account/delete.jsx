import { useRef, useState } from 'react'
import { ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui'
import { Card, CardHeader, ConfirmDialog, LoadError, Loading, Notice, demoNote } from '../../components'
import { DEMO } from '../../../lib/demo'
import { api } from '../../lib/api'
import { useAction, useSession } from '../../state'
import { leaveTo } from '../../lib/router'

// Deleting the account. The plan comes from the server: workspaces where you
// are alone go with the account; in the others you leave; a workspace where
// you are the only owner and others remain blocks it.
export function DeleteAccount() {
  const { me } = useSession()
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState(null)
  const [planError, setPlanError] = useState(null)
  const { run, busy, error } = useAction()
  // Each opening asks again; an answer for an earlier opening is dropped.
  const asked = useRef(0)
  const start = async () => {
    const mine = ++asked.current
    setPlan(null)
    setPlanError(null)
    setOpen(true)
    try {
      const next = await api.post('/auth/delete-account/preview', {})
      if (mine === asked.current) setPlan(next)
    } catch (failure) {
      if (mine === asked.current) setPlanError(failure)
    }
  }
  const blocked = Boolean(plan?.blocked.length)
  const names = (list) => list.map((item) => item.name).join(', ')
  if (me?.local)
    return (
      <Card>
        <CardHeader
          icon={ShieldCheck}
          title="Installation account"
          description="At least one account must remain to protect this installation. Your boards and captures are stored separately."
        />
      </Card>
    )
  return (
    <Card data-sw-delete-account>
      <CardHeader
        icon={Trash2}
        title="Delete account"
        description={demoNote('Removes your account, passkeys and sessions. Comments you wrote keep your name.')}
        actions={
          <Button size="touch" variant="danger" onClick={start} disabled={DEMO} className="lg:h-9" data-sw-delete-account-open>
            Delete account
          </Button>
        }
      />
      <ConfirmDialog
        open={open}
        onClose={() => {
          asked.current += 1
          setOpen(false)
        }}
        title="Delete your account?"
        confirmLabel="Delete my account"
        tone="danger"
        busy={busy}
        disabled={!plan || blocked}
        error={error}
        confirmText={plan && !blocked ? me.user.handle : null}
        onConfirm={() =>
          run(async () => {
            await api.delete('/auth/me', { confirm: me.user.handle })
            leaveTo('/signin')
          })
        }
      >
        {planError ? <LoadError error={planError} onRetry={start} /> : null}
        {!plan && !planError ? <Loading /> : null}
        {plan ? (
          <div className="space-y-3" data-sw-delete-plan>
            {blocked ? (
              <Notice tone="bad" title="Make someone else an owner first">
                You are the only owner of {names(plan.blocked)}, and other people use it. Give one of them the owner role (Members page),
                then come back.
              </Notice>
            ) : null}
            {plan.deleted.length ? (
              <p>
                <span className="font-medium text-fg">Deleted with your account</span> (you are the only member): {names(plan.deleted)}.
                Every project, board and comment in {plan.deleted.length === 1 ? 'it' : 'them'} goes. Export it first from its Settings page
                if you want a copy.
              </p>
            ) : null}
            {plan.left.length ? (
              <p>
                <span className="font-medium text-fg">You leave</span>: {names(plan.left)}. Your pending invites, share links and API tokens
                there are revoked.
              </p>
            ) : null}
            {!blocked ? <p className="text-bad">This cannot be undone. A fresh passkey check is needed.</p> : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </Card>
  )
}
