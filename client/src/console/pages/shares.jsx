// Share links of a project: view-only or guest-comment links for people
// outside the workspace, with an expiry and an optional passcode.

import { useState } from 'react'
import { Eye, Link2, Lock, MessageSquare, Users } from 'lucide-react'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  ToggleGroup,
  Toggle,
} from '../../components/ui'
import {
  ConfirmDialog,
  CopyField,
  Field,
  FormError,
  LoadError,
  Loading,
  Notice,
  SecretResultDialog,
  Time,
  useSecretResult,
} from '../components'
import { api, wsUrl } from '../lib/api'
import { expiryLabel } from '../lib/format'
import { Link } from '../lib/router'
import { useAction, useLoad, useToast } from '../state'
import { useWorkspace } from './workspace'

export function ShareModeBadge({ mode }) {
  return mode === 'comment' ? (
    <Badge tone="accent" className="px-2 py-0.5 text-[11px]">
      <MessageSquare size={11} aria-hidden="true" /> Guests comment
    </Badge>
  ) : (
    <Badge tone="neutral" className="px-2 py-0.5 text-[11px]">
      <Eye size={11} aria-hidden="true" /> View only
    </Badge>
  )
}

// Who opened a link: one row per browser, each can be ended at once.
function GuestList({ share, projectId, onClose }) {
  const { workspaceId } = useWorkspace()
  const toast = useToast()
  const base = wsUrl(workspaceId, `/projects/${projectId}/shares/${share.id}/guests`)
  const guests = useLoad(base)
  const end = useAction()
  const list = guests.data?.guests || []
  return (
    <Dialog open onClose={onClose} title={`Guests of "${share.name}"`} description="One row per browser that opened the link" size="md">
      <div className="px-5 py-4" data-sw-guest-list>
        {guests.loading && !guests.data ? <Loading /> : null}
        {guests.error ? <LoadError error={guests.error} onRetry={guests.reload} /> : null}
        {guests.data && !list.length ? <p className="text-sm text-muted">Nobody has opened this link yet.</p> : null}
        {list.length ? (
          <ul className="divide-y divide-line">
            {list.map((guest) => (
              <li
                key={guest.id}
                className="flex flex-wrap items-center gap-3 py-2.5"
                data-sw-guest={guest.name}
                data-sw-guest-status={guest.status}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-fg">{guest.name}</p>
                    {guest.status !== 'active' ? (
                      <Badge tone="neutral" className="px-2 py-0.5 text-[11px]">
                        {guest.status === 'ended' ? 'Ended' : 'Expired'}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {[guest.device, guest.ipPrefix].filter(Boolean).join(' · ')}
                    {guest.device || guest.ipPrefix ? ' · ' : ''}Opened <Time value={guest.createdAt} /> · Last seen{' '}
                    <Time value={guest.lastSeenAt} />
                  </p>
                </div>
                {guest.status === 'active' ? (
                  <Button
                    size="touch"
                    variant="danger"
                    className="lg:h-8"
                    disabled={end.busy}
                    data-sw-end-guest={guest.name}
                    onClick={() =>
                      end.run(async () => {
                        await api.delete(`${base}/${guest.id}`)
                        toast(`Ended ${guest.name}`)
                        await guests.reload()
                      })
                    }
                  >
                    End this guest
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <FormError error={end.error} />
        <p className="mt-3 text-xs text-muted">
          Ending a guest signs that browser out at once; their comments stay. They can open the link again while it works: revoke the link
          to stop everyone.
        </p>
      </div>
    </Dialog>
  )
}

export function ShareList({ shares, onChanged, projectId }) {
  const { workspaceId, data } = useWorkspace()
  const toast = useToast()
  const [revoking, setRevoking] = useState(null)
  const [viewing, setViewing] = useState(null)
  const guestsOn = Boolean(data?.features?.guestSessions)
  const revoke = useAction()
  if (!shares.length) {
    return (
      <EmptyState icon={Link2} title="No share links">
        Share links let people outside the workspace see this project's boards, and comment as guests if you allow it.
      </EmptyState>
    )
  }
  return (
    <>
      <ul className="divide-y divide-line" data-sw-share-list>
        {shares.map((share) => (
          <li
            key={share.id}
            className="grid gap-2 px-4 py-3 sm:px-5 md:grid-cols-[1.6fr_1fr_1fr_auto] md:items-center"
            data-sw-share={share.name}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium text-fg">{share.name}</p>
                <ShareModeBadge mode={share.mode} />
                {share.includeChecks ? (
                  <Badge tone="neutral" className="px-2 py-0.5 text-[11px]">
                    Checks included
                  </Badge>
                ) : null}
                {share.passcode ? (
                  <Badge tone="neutral" className="px-2 py-0.5 text-[11px]">
                    <Lock size={11} aria-hidden="true" /> Passcode
                  </Badge>
                ) : null}
                {share.status !== 'active' ? (
                  <Badge tone="neutral" className="px-2 py-0.5 text-[11px]">
                    {share.status === 'revoked' ? 'Revoked' : 'Expired'}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted">
                By {share.createdBy ? share.createdBy.displayName || `@${share.createdBy.handle}` : 'unknown'} ·{' '}
                <Time value={share.createdAt} />
              </p>
            </div>
            <div className="text-xs text-muted">
              <p>
                Opened {share.opens} {share.opens === 1 ? 'time' : 'times'}
              </p>
              <p className="mt-0.5">
                Last <Time value={share.lastUsedAt} empty="never" />
              </p>
            </div>
            <div className="text-xs text-muted">
              {share.status === 'revoked' ? (
                <Time value={share.revokedAt} prefix="Revoked " />
              ) : (
                <Time value={share.expiresAt} prefix={share.status === 'expired' ? 'Expired ' : 'Expires '} />
              )}
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              {guestsOn && (projectId || share.projectId) ? (
                <Button
                  size="touch"
                  variant="secondary"
                  onClick={() => setViewing(share)}
                  className="lg:h-8"
                  data-sw-share-guests={share.name}
                >
                  <Users size={14} aria-hidden="true" /> Guests
                </Button>
              ) : null}
              {share.status === 'active' ? (
                <Button
                  size="touch"
                  variant="danger"
                  onClick={() => setRevoking(share)}
                  className="lg:h-8"
                  data-sw-revoke-share={share.name}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revoking?.name}"?`}
        confirmLabel="Revoke link"
        tone="danger"
        busy={revoke.busy}
        error={revoke.error}
        onConfirm={() =>
          revoke.run(async () => {
            await api.delete(wsUrl(workspaceId, `/projects/${projectId || revoking.projectId}/shares/${revoking.id}`))
            setRevoking(null)
            toast('Share link revoked')
            await onChanged()
          })
        }
      >
        <p>The link stops working at once, including for anyone who has the board open now. Their comments stay.</p>
      </ConfirmDialog>
      {viewing ? <GuestList share={viewing} projectId={projectId || viewing.projectId} onClose={() => setViewing(null)} /> : null}
    </>
  )
}

export function CreateShare({ open, onClose, project, onCreated }) {
  const { workspaceId, data } = useWorkspace()
  const days = data.features.shareDays
  const [name, setName] = useState('')
  const [mode, setMode] = useState('view')
  const [expiry, setExpiry] = useState('7')
  const [passcode, setPasscode] = useState('')
  const [includeChecks, setIncludeChecks] = useState(false)
  const { run, busy, error, setError } = useAction()
  const [result, setResult] = useSecretResult(open, () => {
    setName('')
    setMode('view')
    setExpiry('7')
    setPasscode('')
    setIncludeChecks(false)
    setError(null)
  })
  const create = (event) => {
    event.preventDefault()
    run(async () => {
      const made = await api.post(wsUrl(workspaceId, `/projects/${project.id}/shares`), {
        name,
        mode,
        expiresInDays: Number(expiry),
        includeChecks,
        ...(passcode ? { passcode } : {}),
      })
      setResult(made)
      await onCreated?.()
    })
  }
  return (
    <SecretResultDialog
      open={open}
      onClose={onClose}
      busy={busy}
      result={result}
      title={`Share ${project.name}`}
      resultTitle="Share link created"
      doneProps={{ 'data-sw-share-done': true }}
      renderResult={(made) => (
        <>
          <Notice tone="warn" title="Copy it now: it is shown once">
            Anyone with this link{made.share.passcode ? ' and the passcode' : ''} can{' '}
            {made.share.mode === 'comment' ? 'see and comment on' : 'see'} this project's boards until <Time value={made.share.expiresAt} />
            .{made.share.passcode ? ' Send the passcode separately.' : ''}
          </Notice>
          <CopyField value={made.url} testId="share" />
        </>
      )}
    >
      {
        <form onSubmit={create} className="space-y-4 px-5 py-4">
          <Field label="Name" hint="For you: who it is for. Guests do not see it.">
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                placeholder="For the agency"
                data-sw-share-label
              />
            )}
          </Field>
          <fieldset>
            <legend className="mb-1.5 block text-[13px] font-medium text-fg">Guests can</legend>
            <ToggleGroup
              label="Guests can"
              value={mode}
              onChange={setMode}
              className="w-full"
              itemClassName="h-11 px-3 lg:h-9"
              options={[
                { id: 'view', label: 'View' },
                { id: 'comment', label: 'View and comment' },
              ]}
            />
            <p className="mt-1.5 text-xs text-muted">
              {mode === 'comment'
                ? 'Guests add comments and replies, signed "<name> (guest)". They cannot resolve, edit or delete, and their @mentions do nothing.'
                : 'Guests see the boards and comments, and change nothing.'}
            </p>
          </fieldset>
          <div className="space-y-1.5">
            <Toggle size="touch" pressed={includeChecks} onPressedChange={setIncludeChecks} data-sw-share-checks>
              Include page checks
            </Toggle>
            <p className="text-xs text-muted">
              {includeChecks
                ? 'Guests can read every retained check report in this project, including history, metrics and findings. Revoking this link ends access.'
                : 'Check reports stay private. Turn this on only when guests should see metrics, findings and report history.'}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Expires after">
              {(props) => (
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger size="touch" className="w-full" {...props} data-sw-share-expiry>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {days.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {expiryLabel(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Passcode (optional)" hint="4 to 64 characters.">
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  type="password"
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                  maxLength={64}
                  autoComplete="new-password"
                  data-sw-share-passcode-input
                />
              )}
            </Field>
          </div>
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
              Cancel
            </Button>
            <Button
              type="submit"
              size="touch"
              variant="default"
              disabled={busy || (passcode && passcode.length < 4)}
              className="lg:h-10"
              data-sw-share-create
            >
              {busy ? <Spinner /> : null} Create link
            </Button>
          </div>
        </form>
      }
    </SecretResultDialog>
  )
}

// When share links are off in the workspace.
export function SharesOff({ isAdmin }) {
  const { workspaceId } = useWorkspace()
  return (
    <Notice
      tone="info"
      title="Share links are off in this workspace"
      action={
        isAdmin ? (
          <Button asChild size="touch" variant="secondary" className="lg:h-8">
            <Link to={`/w/${workspaceId}/settings`}>Settings</Link>
          </Button>
        ) : null
      }
    >
      An admin turns them on in Settings. Then you can share a project with people outside the workspace.
    </Notice>
  )
}
