// Account: recovery codes.

import { useState } from 'react'
import { LifeBuoy } from 'lucide-react'
import { Button } from '../../../components/ui'
import { Card, CardHeader, ConfirmDialog, Notice, demoNote } from '../../components'
import { DEMO } from '../../../lib/demo'
import { api } from '../../lib/api'
import { useAction, useSession } from '../../state'
import { RecoveryCodes } from '../auth'

export function Recovery() {
  const { me, refresh } = useSession()
  const [confirming, setConfirming] = useState(false)
  const [codes, setCodes] = useState(null)
  const { run, busy, error } = useAction()
  const left = me.recoveryCodesLeft
  return (
    <Card id="account-recovery" className="scroll-mt-20" data-sw-recovery>
      <CardHeader
        icon={LifeBuoy}
        title="Recovery codes"
        description={demoNote('One-time codes for when you have lost every passkey.')}
        actions={
          codes ? null : (
            <Button
              size="touch"
              variant="secondary"
              onClick={() => setConfirming(true)}
              disabled={DEMO}
              className="lg:h-9"
              data-sw-new-codes
            >
              Make new codes
            </Button>
          )
        }
      />
      <div className="px-4 py-4 sm:px-5">
        {codes ? (
          <RecoveryCodes
            codes={codes}
            doneLabel="Done"
            onDone={async () => {
              setCodes(null)
              await refresh()
            }}
          />
        ) : left <= 2 ? (
          <Notice tone="warn" title={left === 0 ? 'No recovery codes left' : `Only ${left} recovery ${left === 1 ? 'code' : 'codes'} left`}>
            Make new codes and save them, so a lost device does not lock you out.
          </Notice>
        ) : (
          <p className="text-sm text-muted">
            <span className="font-semibold text-fg tabular">{left}</span> of 10 unused. Each one signs you in once, then you add a new
            passkey.
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Make new recovery codes?"
        confirmLabel="Make new codes"
        busy={busy}
        error={error}
        onConfirm={() =>
          run(async () => {
            const result = await api.post('/auth/recovery-codes', {})
            setConfirming(false)
            setCodes(result.recoveryCodes)
          })
        }
      >
        <p>Your current codes stop working. The new ones are shown once.</p>
      </ConfirmDialog>
    </Card>
  )
}
