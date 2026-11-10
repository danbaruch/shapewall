// Account: the passkeys you sign in with (add, rename, remove).

import { useEffect, useState } from 'react'
import { Cloud, KeyRound, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react'
import { Badge, Button, Dialog, Input, Spinner } from '../../../components/ui'
import { Card, CardHeader, ConfirmDialog, Field, FormError, Notice, Time, demoNote } from '../../components'
import { DEMO } from '../../../lib/demo'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { createPasskey } from '../../lib/webauthn'
import { useAction, useSession, useToast } from '../../state'
import { currentHash, navigate } from '../../lib/router'
import { ADD_PASSKEY_EVENT } from '../../lib/events'

// Where a passkey lives: synced by a cloud keychain or password manager
// (backed up), only on one authenticator, or one that could sync but has not.
const STORAGE_LABEL = { synced: 'Synced', device: 'This device only', unsynced: 'Not synced yet' }
const TRANSPORT_LABEL = { internal: 'built in', hybrid: 'phone', usb: 'security key (USB)', nfc: 'security key (NFC)', ble: 'Bluetooth' }
export function passkeyStorage(key) {
  return STORAGE_LABEL[key.storage] || (key.synced ? STORAGE_LABEL.synced : STORAGE_LABEL.device)
}
export function passkeyTransports(key) {
  return (key.transports || [])
    .map((item) => TRANSPORT_LABEL[item])
    .filter(Boolean)
    .join(', ')
}

export function Passkeys() {
  const { me, refresh } = useSession()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [removing, setRemoving] = useState(null)
  const remove = useAction()
  const keys = me.passkeys
  // Mid-move: passkeys made for the old host name stop working when it ends.
  const oldKey = (key) => Boolean(me.movedFrom && key.rpId && key.rpId !== me.rpId)
  const noneHere = Boolean(me.movedFrom) && !keys.some((key) => !oldKey(key))
  // The last passkey that will keep working: old-address ones do not count.
  const working = keys.filter((key) => !oldKey(key))
  const isLast = (key) => (working.length ? working.length === 1 && working[0].id === key.id : keys.length === 1)
  const cannotRemove = (key) => isLast(key) && me.recoveryCodesLeft === 0
  const cannotRemoveLast = keys.some(cannotRemove)
  const onlyOneDevice = keys.length === 1 && !keys[0].synced
  useEffect(() => {
    const open = () => {
      if (currentHash() !== '#add-passkey') return
      navigate('/account', { replace: true })
      setAdding(true)
    }
    open()
    window.addEventListener(ADD_PASSKEY_EVENT, open)
    return () => window.removeEventListener(ADD_PASSKEY_EVENT, open)
  }, [])

  return (
    <Card id="account-passkeys" className="scroll-mt-20" data-sw-passkeys>
      <CardHeader
        icon={KeyRound}
        title="Passkeys"
        description={demoNote('Add one for each device or password manager you sign in from.')}
        actions={
          <Button size="touch" variant="default" onClick={() => setAdding(true)} disabled={DEMO} className="lg:h-9" data-sw-add-passkey>
            <Plus size={16} aria-hidden="true" /> Add a passkey
          </Button>
        }
      />
      <ul className="divide-y divide-line">
        {keys.map((key) => (
          <li key={key.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5" data-sw-passkey={key.nickname || 'Passkey'}>
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
              {key.synced ? <Cloud size={16} aria-hidden="true" /> : <Smartphone size={16} aria-hidden="true" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium text-fg">{key.nickname || 'Passkey'}</p>
                <Badge tone={key.synced ? 'accent' : 'neutral'} className="px-2 py-0.5 text-[11px]" data-sw-passkey-storage={key.storage}>
                  {passkeyStorage(key)}
                </Badge>
                {key.onHoldUntil ? (
                  <Badge tone="warn" className="px-2 py-0.5 text-[11px]">
                    On hold until {formatDateTime(key.onHoldUntil)}
                  </Badge>
                ) : null}
                {oldKey(key) ? (
                  <Badge tone="warn" className="px-2 py-0.5 text-[11px]" data-sw-passkey-old>
                    For {key.rpId}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {passkeyTransports(key) ? `${passkeyTransports(key)} · ` : ''}Added <Time value={key.createdAt} /> · Last used{' '}
                <Time value={key.lastUsedAt} empty="never" />
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                size="touch"
                variant="ghost"
                onClick={() => setRenaming(key)}
                className="lg:h-8"
                aria-label={`Rename ${key.nickname || 'passkey'}`}
              >
                <Pencil size={15} aria-hidden="true" /> <span className="hidden sm:inline">Rename</span>
              </Button>
              <Button
                size="touch"
                variant="danger"
                onClick={() => setRemoving(key)}
                disabled={cannotRemove(key)}
                className="lg:h-8"
                aria-label={`Remove ${key.nickname || 'passkey'}`}
              >
                <Trash2 size={15} aria-hidden="true" /> <span className="hidden sm:inline">Remove</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {noneHere ? (
        <div className="px-4 pb-4 sm:px-5">
          <Notice tone="warn" title={`Add a passkey for ${me.rpId}`} data-sw-passkey-move-notice>
            This server moved from {me.movedFrom.rpId}. Your passkeys belong to the old address and stop working after{' '}
            {formatDateTime(me.movedFrom.endsAt)}. Add one for this address now.
          </Notice>
        </div>
      ) : null}
      {onlyOneDevice && !noneHere ? (
        <div className="px-4 pb-4 sm:px-5">
          <Notice tone="info" title="Add a passkey on another device" data-sw-passkey-another>
            Your only passkey lives on this device. Add one on your phone or in a password manager, so losing this device does not lock you
            out.
          </Notice>
        </div>
      ) : null}
      {cannotRemoveLast ? (
        <div className="px-4 pb-4 sm:px-5">
          <Notice tone="warn">
            {keys.length === 1 ? 'This is your only passkey' : 'Only one of your passkeys works at this address'} and you have no recovery
            codes left, so it cannot be removed. Add another passkey first.
          </Notice>
        </div>
      ) : keys.some((key) => key.onHoldUntil) ? (
        <div className="px-4 pb-4 sm:px-5">
          <Notice tone="info">
            A passkey added after a recovery-code sign-in signs you in at once, but confirms sensitive changes only after 24 hours.
          </Notice>
        </div>
      ) : null}
      <AddPasskey
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={async () => {
          await refresh()
          setAdding(false)
          toast('Passkey added')
        }}
      />
      <RenamePasskey
        passkey={renaming}
        onClose={() => setRenaming(null)}
        onSaved={async () => {
          await refresh()
          setRenaming(null)
          toast('Passkey renamed')
        }}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.nickname || 'this passkey'}?`}
        confirmLabel="Remove passkey"
        tone="danger"
        busy={remove.busy}
        error={remove.error}
        onConfirm={() =>
          remove.run(async () => {
            await api.delete(`/auth/passkeys/${encodeURIComponent(removing.id)}`)
            await refresh()
            setRemoving(null)
            toast('Passkey removed. Other devices were signed out.')
          })
        }
      >
        <p>It stops working at once, and every other device signed in to your account is signed out (this one stays).</p>
        {removing && isLast(removing) ? (
          <p className="text-warn">This is your last working passkey: after this you can only sign in with a recovery code.</p>
        ) : null}
      </ConfirmDialog>
    </Card>
  )
}

function AddPasskey({ open, onClose, onAdded }) {
  const [nickname, setNickname] = useState('')
  const { run, busy, error, setError } = useAction()
  useEffect(() => {
    if (open) {
      setNickname('')
      setError(null)
    }
  }, [open, setError])
  const add = (event) => {
    event.preventDefault()
    run(async () => {
      const { options } = await api.post('/auth/passkeys/options', {})
      const response = await createPasskey(options)
      await api.post('/auth/passkeys/verify', { response, nickname })
      await onAdded()
    })
  }
  return (
    <Dialog open={open} onClose={() => (busy ? null : onClose())} title="Add a passkey" description="Your browser asks where to save it.">
      <form onSubmit={add} className="space-y-4 px-5 py-4">
        <Field label="Name" hint="So you can tell your passkeys apart.">
          {(props) => (
            <Input
              {...props}
              size="touch"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={60}
              placeholder="Work laptop"
              data-sw-passkey-name
            />
          )}
        </Field>
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
            Cancel
          </Button>
          <Button type="submit" size="touch" variant="default" disabled={busy} className="lg:h-10" data-sw-passkey-create>
            {busy ? <Spinner /> : <KeyRound size={16} aria-hidden="true" />} Create passkey
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function RenamePasskey({ passkey, onClose, onSaved }) {
  const [nickname, setNickname] = useState('')
  const { run, busy, error } = useAction()
  useEffect(() => {
    if (passkey) setNickname(passkey.nickname || '')
  }, [passkey])
  const save = (event) => {
    event.preventDefault()
    run(async () => {
      await api.patch(`/auth/passkeys/${encodeURIComponent(passkey.id)}`, { nickname })
      await onSaved()
    })
  }
  return (
    <Dialog open={Boolean(passkey)} onClose={() => (busy ? null : onClose())} title="Rename passkey">
      <form onSubmit={save} className="space-y-4 px-5 py-4">
        <Field label="Name">
          {(props) => (
            <Input {...props} size="touch" value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={60} />
          )}
        </Field>
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
            Cancel
          </Button>
          <Button type="submit" size="touch" variant="default" disabled={busy} className="lg:h-10">
            {busy ? <Spinner /> : null} Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
