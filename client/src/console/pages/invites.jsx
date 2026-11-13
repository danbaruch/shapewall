// Invites: one-time links with a role and an expiry, shown once, optionally
// emailed. Pending ones can be revoked; used, revoked and expired ones stay
// in the history.

import { useState } from 'react'
import { Mail, MailPlus, UserPlus } from 'lucide-react'
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../components/ui'
import {
  Card,
  ConfirmDialog,
  CopyField,
  Field,
  FormError,
  LoadError,
  Loading,
  Notice,
  PageHeader,
  RoleBadge,
  SecretResultDialog,
  Time,
  useSecretResult,
} from '../components'
import { DEMO } from '../../lib/demo'
import { api, wsUrl } from '../lib/api'
import { ROLE_LABEL, ROLE_SUMMARY, expiryLabel } from '../lib/format'
import { useAction, useLoad, useToast } from '../state'
import { useWorkspace } from './workspace'
import { invitableRoles } from '../../../../src/hosted/permissions.js'

export function InvitesSection() {
  const { workspaceId } = useWorkspace()
  const invites = useLoad(wsUrl(workspaceId, '/invites'))
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState(null)
  const revoke = useAction()
  const toast = useToast()
  const pending = invites.data?.pending || []
  const history = invites.data?.history || []
  return (
    <>
      <PageHeader
        title="Invites"
        description="Each link works once, for one person, until it expires. Whoever opens it first joins with its role."
        actions={
          <Button variant="default" size="touch" onClick={() => setCreating(true)} className="lg:h-9" data-sw-new-invite>
            <UserPlus size={16} aria-hidden="true" /> New invite
          </Button>
        }
      />
      {invites.loading ? <Loading /> : null}
      {invites.error ? <LoadError error={invites.error} onRetry={invites.reload} /> : null}
      {invites.data ? (
        <Tabs defaultValue="pending">
          <TabsList className="mb-3 w-full sm:inline-flex sm:w-auto">
            <TabsTrigger value="pending" className="h-11 px-3 lg:h-8" data-sw-tab="pending">
              Pending <span className="tabular ml-1 text-faint">{pending.length}</span>
            </TabsTrigger>
            <TabsTrigger value="history" className="h-11 px-3 lg:h-8" data-sw-tab="history">
              History <span className="tabular ml-1 text-faint">{history.length}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pending">
            <Card>
              {pending.length ? (
                <ul className="divide-y divide-line" data-sw-pending-invites>
                  {pending.map((invite) => (
                    <li key={invite.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5" data-sw-invite={invite.id}>
                      <RoleBadge role={invite.role} />
                      <div className="min-w-0 flex-1 text-xs text-muted">
                        <p className="text-sm text-fg">
                          {invite.note ? (
                            <span className="mr-2 font-medium" data-sw-invite-note>
                              {invite.note}
                            </span>
                          ) : null}
                          {invite.tailnetLogin ? (
                            <span data-sw-invite-tailnet>For the tailnet login {invite.tailnetLogin}</span>
                          ) : invite.email ? (
                            <span className="inline-flex items-center gap-1">
                              <Mail size={13} aria-hidden="true" /> {invite.email}
                            </span>
                          ) : invite.note ? null : (
                            'Link'
                          )}
                        </p>
                        <p className="mt-0.5">
                          By {invite.createdBy?.displayName || 'someone'} · <Time value={invite.createdAt} /> ·{' '}
                          <Time value={invite.expiresAt} prefix="expires " />
                        </p>
                      </div>
                      <Button size="touch" variant="danger" onClick={() => setRevoking(invite)} className="lg:h-8" data-sw-revoke-invite>
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={MailPlus} title="No pending invites">
                  New invite links show here until someone uses them or they expire.
                </EmptyState>
              )}
            </Card>
          </TabsContent>
          <TabsContent value="history">
            <Card>
              {history.length ? (
                <ul className="divide-y divide-line" data-sw-invite-history>
                  {history.map((invite) => (
                    <li
                      key={invite.id}
                      className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5"
                      data-sw-invite-status={invite.status}
                    >
                      <RoleBadge role={invite.role} />
                      <div className="min-w-0 flex-1 text-xs text-muted">
                        <p className="text-sm text-fg">
                          {invite.status === 'used'
                            ? `Joined: ${invite.usedBy?.displayName || 'a deleted account'}${invite.usedBy ? ` (@${invite.usedBy.handle})` : ''}`
                            : invite.note || invite.email || 'Link'}
                          {invite.status === 'used' && invite.note ? <span className="text-muted"> · {invite.note}</span> : null}
                        </p>
                        <p className="mt-0.5">
                          By {invite.createdBy?.displayName || 'someone'} · created <Time value={invite.createdAt} />
                          {invite.status === 'used' ? (
                            <>
                              {' '}
                              · used <Time value={invite.usedAt} />
                            </>
                          ) : null}
                          {invite.status === 'revoked' ? (
                            <>
                              {' '}
                              · revoked <Time value={invite.revokedAt} />
                            </>
                          ) : null}
                          {invite.status === 'expired' ? (
                            <>
                              {' '}
                              · expired <Time value={invite.expiresAt} />
                            </>
                          ) : null}
                        </p>
                      </div>
                      <Badge tone={invite.status === 'used' ? 'ok' : 'neutral'} className="px-2 py-0.5 text-[11px]">
                        {invite.status === 'used' ? 'Used' : invite.status === 'revoked' ? 'Revoked' : 'Expired'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState icon={MailPlus} title="No history yet">
                  Used, revoked and expired invites show here.
                </EmptyState>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      ) : null}
      <InviteDialog open={creating} onClose={() => setCreating(false)} onCreated={invites.reload} />
      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title="Revoke this invite?"
        confirmLabel="Revoke invite"
        tone="danger"
        busy={revoke.busy}
        error={revoke.error}
        onConfirm={() =>
          revoke.run(async () => {
            await api.delete(wsUrl(workspaceId, `/invites/${revoking.id}`))
            setRevoking(null)
            toast('Invite revoked')
            await invites.reload()
          })
        }
      >
        <p>The link stops working. Nobody has joined with it yet.</p>
      </ConfirmDialog>
    </>
  )
}

// Create an invite: role (owners only for owner), expiry, and an email when
// the server can send one. The link is shown once.
export function InviteDialog({ open, onClose, onCreated }) {
  const { workspaceId, data, role: myRole } = useWorkspace()
  const features = data.features
  const [role, setRole] = useState('member')
  const [days, setDays] = useState('7')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [login, setLogin] = useState('')
  const { run, busy, error, setError } = useAction()
  const [result, setResult] = useSecretResult(open, () => {
    setRole('member')
    setDays('7')
    setEmail('')
    setNote('')
    setLogin('')
    setError(null)
  })
  const roles = invitableRoles(myRole)
  const create = (event) => {
    event.preventDefault()
    run(async () => {
      const made = await api.post(wsUrl(workspaceId, '/invites'), {
        role,
        expiresInDays: Number(days),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(login.trim() ? { tailnetLogin: login.trim() } : {}),
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
      title="Invite someone"
      resultTitle="Invite ready"
      resultProps={{ 'data-sw-invite-result': true }}
      doneProps={{ 'data-sw-invite-done': true }}
      renderResult={(made) => (
        <>
          {made.emailed?.ok ? (
            <Notice tone="ok" title={`Emailed to ${made.invite.email}`}>
              You can also send the link yourself.
            </Notice>
          ) : made.emailed ? (
            <Notice tone="warn" title="The email did not go out">
              {made.emailed.error}. Copy the link and send it yourself.
            </Notice>
          ) : null}
          {made.invite.tailnetLogin ? (
            <Notice tone="ok" title={`${made.invite.tailnetLogin} is invited`} data-sw-invite-tailnet-result>
              They join as {ROLE_LABEL[made.invite.role].toLowerCase()} the next time they open this server through the tailnet (or with
              shapewall join). Only that tailnet login can use this invite, so the link below is optional.
            </Notice>
          ) : DEMO ? (
            <Notice tone="info" title="A sample link" data-sw-invite-sample>
              The demo has no server, so this link opens nothing. On a real server it makes one {ROLE_LABEL[made.invite.role].toLowerCase()}
              , works once and expires <Time value={made.invite.expiresAt} />.
            </Notice>
          ) : (
            <Notice tone="info" title="Copy the link now: it is shown once">
              It makes one {ROLE_LABEL[made.invite.role].toLowerCase()} and expires <Time value={made.invite.expiresAt} />. Send it to one
              person.
            </Notice>
          )}
          <CopyField value={made.url} testId="invite" />
        </>
      )}
    >
      {
        <form onSubmit={create} className="space-y-4 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role">
              {(props) => (
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger size="touch" className="w-full" {...props} data-sw-invite-role>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((item) => (
                      <SelectItem key={item} value={item}>
                        {ROLE_LABEL[item]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Link expires after">
              {(props) => (
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger size="touch" className="w-full" {...props} data-sw-invite-expiry>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {features.inviteDays.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {expiryLabel(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <p className="-mt-1 text-xs text-muted">{ROLE_SUMMARY[role]}</p>
          <Field label="Who it is for (optional)" hint="A note for the pending list, like Ada (design). Only admins see it.">
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={80}
                autoComplete="off"
                placeholder="Ada (design)"
                data-sw-invite-note-input
              />
            )}
          </Field>
          {features.tailnetSignIn ? (
            <Field
              label="Tailnet login (optional)"
              hint="The name they sign in to Tailscale with. Only that login can use the invite, and they need no link."
            >
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  value={login}
                  onChange={(event) => setLogin(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="ada@example.com"
                  data-sw-invite-tailnet-login
                />
              )}
            </Field>
          ) : null}
          {features.inviteEmail ? (
            <Field label="Email (optional)" hint="We email the link to this address. Leave it empty to copy the link yourself.">
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="off"
                  placeholder="name@example.com"
                  data-sw-invite-email
                />
              )}
            </Field>
          ) : (
            <p className="text-xs text-muted">This server does not send email: you copy the link and send it yourself.</p>
          )}
          {role === 'owner' ? (
            <Notice tone="warn">An owner can change or remove anyone, you included. Inviting one always asks you to confirm.</Notice>
          ) : null}
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
              Cancel
            </Button>
            <Button type="submit" size="touch" variant="default" disabled={busy} className="lg:h-10" data-sw-invite-create>
              {busy ? <Spinner /> : null} {login.trim() ? 'Invite this login' : email.trim() ? 'Create and email' : 'Create invite link'}
            </Button>
          </div>
        </form>
      }
    </SecretResultDialog>
  )
}
