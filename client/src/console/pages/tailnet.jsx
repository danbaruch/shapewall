// Tailnet sign-in in the console (a server run with --tailscale
// --tailnet-sign-in): the server knows who arrives by their tailnet login.
//
//   TailnetArrival    on the sign-in page: continue after a sign-out, join by
//                     an invite made for the login, or who to ask
//   TailnetAccount    Account and security: the linked login, link, unlink
//   TailnetInvites    the workspaces page: invites made for my login
//   TailnetVisitors   Members: who arrived and belongs to nobody yet
//
// Being on the tailnet gives nothing by itself: an admin invites a login
// with a role. What the server says decides everything shown here.

import { useEffect, useState } from 'react'
import { ArrowRight, Network, UserPlus, X } from 'lucide-react'
import { Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner } from '../../components/ui'
import { Card, CardHeader, ConfirmDialog, Field, FormError, Notice, Time } from '../components'
import { api, wsUrl } from '../lib/api'
import { ROLE_LABEL } from '../lib/format'
import { useAction, useLoad, useSession, useToast } from '../state'
import { useWorkspace } from './workspace'
import { invitableRoles } from '../../../../src/hosted/permissions.js'

const roleWords = (role) => `${role === 'owner' || role === 'admin' ? 'an' : 'a'} ${ROLE_LABEL[role].toLowerCase()}`

// "Team as a member, Docs as a viewer"
const inviteWords = (invites) => invites.map((item) => `${item.workspace} as ${roleWords(item.role)}`).join(', ')

// ---- The sign-in page -------------------------------------------------------------

// `tailnet`: what GET /auth/me said about a visitor ({ state, login, name,
// invites, suggested }). `onSignedIn(result)`: where to go next.
export function TailnetArrival({ tailnet, signup, onSignedIn }) {
  const [handle, setHandle] = useState(tailnet.suggested?.handle || '')
  const [name, setName] = useState(tailnet.suggested?.displayName || tailnet.name || '')
  const go = useAction()
  if (tailnet.state === 'self')
    return (
      <Notice tone="info" className="mt-4" title="This is the server’s own machine" data-sw-tailnet="self">
        This server signs tailnet users in, but never from the machine it runs on: any program on this machine could ask the same way. Sign
        in with a passkey here, or open the server from another of your tailnet devices.
      </Notice>
    )
  if (tailnet.state === 'changed')
    return (
      <Notice tone="warn" className="mt-4" title="This tailnet login belongs to someone else here" data-sw-tailnet="changed">
        An account on this server is linked to {tailnet.login}, but for a different tailnet user than the one your device is signed in as:
        the name was given to someone else, or your device is shared in from another tailnet. Sign in with a passkey, or ask whoever runs
        this server.
      </Notice>
    )
  if (tailnet.state === 'none')
    return (
      <Notice tone="info" className="mt-4" title="Your tailnet did not say who you are" data-sw-tailnet="none">
        This server signs tailnet users in, but this device is not a person’s (a tagged device, or a node shared in without a user). Sign in
        with a passkey instead.
      </Notice>
    )
  if (tailnet.state === 'signed_out')
    return (
      <div className="mt-4 space-y-3" data-sw-tailnet="signed_out">
        <Notice tone="info" title="You signed out on this browser">
          Your tailnet still says you are <span className="font-medium text-fg">{tailnet.login}</span>, and arriving here would sign you
          straight back in. So this browser stays signed out until you continue.
        </Notice>
        <Button
          variant="default"
          size="touch"
          className="w-full text-[15px]"
          disabled={go.busy}
          onClick={() => go.run(async () => onSignedIn(await api.post('/auth/tailnet/sign-in', {})))}
          data-sw-tailnet-continue
        >
          {go.busy ? <Spinner /> : <ArrowRight size={17} aria-hidden="true" />}
          Continue as {tailnet.login}
        </Button>
        <FormError error={go.error} />
      </div>
    )
  const invited = tailnet.state === 'invited'
  const mayOpen = !invited && signup === 'open'
  const join = (event) => {
    event.preventDefault()
    go.run(async () => onSignedIn(await api.post('/auth/tailnet/join', { handle, displayName: name })))
  }
  return (
    <div className="mt-4 space-y-4" data-sw-tailnet={tailnet.state}>
      <Notice
        tone={invited ? 'ok' : 'info'}
        title={invited ? `You are invited: ${inviteWords(tailnet.invites)}` : `You arrived as ${tailnet.login}`}
      >
        {invited ? (
          <>
            Your tailnet says you are <span className="font-medium text-fg">{tailnet.login}</span>, and that is your sign-in here: no
            passkey and no password. You can add a passkey later.
          </>
        ) : mayOpen ? (
          <>Nobody has invited you to a workspace here yet. You can start a workspace of your own, signed in by your tailnet login.</>
        ) : (
          <>
            Your tailnet says who you are, but being on the tailnet does not put you in a workspace: an admin decides who is in, and with
            which role. Ask an admin of a workspace here to invite <span className="font-medium text-fg">{tailnet.login}</span>. They see
            that you arrived on their Members page.
          </>
        )}
      </Notice>
      {invited || mayOpen ? (
        <form className="space-y-4" onSubmit={join} noValidate>
          <Field label="Your name">
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                data-sw-tailnet-name
              />
            )}
          </Field>
          <Field label="Handle" hint="People @mention you with it. Lowercase letters, digits and dashes.">
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={handle}
                onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/\s+/g, '-'))}
                autoCapitalize="none"
                spellCheck={false}
                maxLength={32}
                data-sw-tailnet-handle
              />
            )}
          </Field>
          <FormError error={go.error} />
          <Button
            type="submit"
            variant="default"
            size="touch"
            className="w-full text-[15px]"
            disabled={go.busy || !name.trim() || handle.length < 3}
            data-sw-tailnet-join
          >
            {go.busy ? <Spinner /> : <ArrowRight size={17} aria-hidden="true" />}
            {invited ? 'Join' : 'Start a workspace'} as {tailnet.login}
          </Button>
        </form>
      ) : null}
    </div>
  )
}

// ---- Account and security ---------------------------------------------------------

export function TailnetAccount() {
  const { me, refresh } = useSession()
  const toast = useToast()
  const act = useAction()
  const [unlinking, setUnlinking] = useState(false)
  const tailnet = me?.tailnet
  // Off on this server.
  if (!tailnet) return null
  const viaTailnet = me.via === 'tailnet'
  const noPasskey = me.passkeys.length === 0
  return (
    <Card id="account-tailnet" data-sw-account-tailnet>
      <CardHeader
        icon={Network}
        title="Tailnet sign-in"
        description="This server signs you in by your tailnet login when you arrive through the tailnet, with no passkey."
        actions={
          tailnet.linked ? (
            <Button size="touch" variant="secondary" className="lg:h-9" onClick={() => setUnlinking(true)} data-sw-tailnet-unlink>
              Unlink
            </Button>
          ) : tailnet.here ? (
            <Button
              size="touch"
              variant="default"
              className="lg:h-9"
              disabled={act.busy}
              onClick={() =>
                act.run(async () => {
                  await api.post('/auth/tailnet/link', {})
                  await refresh()
                  toast(`Linked to ${tailnet.here}`)
                })
              }
              data-sw-tailnet-link
            >
              {act.busy ? <Spinner /> : null} Link {tailnet.here}
            </Button>
          ) : null
        }
      />
      <div className="space-y-2 px-4 py-4 text-sm text-muted sm:px-5">
        {tailnet.linked ? (
          <p>
            Linked to <span className="font-medium text-fg">{tailnet.linked}</span>
            {tailnet.linkedAt ? (
              <>
                {' '}
                since <Time value={tailnet.linkedAt} />
              </>
            ) : null}
            . {viaTailnet ? 'You are signed in that way now.' : 'Arriving through the tailnet as that login signs you in.'}
          </p>
        ) : tailnet.here ? (
          <p>
            You arrive as <span className="font-medium text-fg">{tailnet.here}</span>. Link it and that login signs you in here from any of
            your tailnet devices. Linking asks for your passkey, like adding one.
          </p>
        ) : (
          <p>Not linked. Open this page through the tailnet, from one of your own devices, to link your tailnet login.</p>
        )}
        {tailnet.ownMachine ? (
          <Notice tone="info" data-sw-tailnet-own-machine>
            This browser is on the server’s own machine. Your tailnet identity is never taken from here (any program on this machine could
            ask the same way), so linking and tailnet sign-in work from your other tailnet devices.
          </Notice>
        ) : null}
        {tailnet.linked && tailnet.here && tailnet.here !== tailnet.linked ? (
          <Notice tone="warn">
            This device arrives as {tailnet.here}, not as the login your account is linked to. Tailnet sign-in will not sign you in from it.
          </Notice>
        ) : null}
        {viaTailnet ? (
          <p>
            {noPasskey
              ? 'You have no passkey. That is fine for everything in a workspace. A few things always need one: deleting a workspace or your account, changing owners, recovery codes. Add a passkey above before you need them: a first passkey signs in at once, and can confirm those things 24 hours after it is added.'
              : 'A tailnet session works only on requests that arrive as your login: its cookie is worth nothing off the tailnet.'}{' '}
            Your tailnet identity is per device, not per person: anything running as you on a tailnet device of yours can act as you here.
            Signing out keeps this browser signed out until you press Continue on the sign-in page.
          </p>
        ) : null}
        <FormError error={act.error} />
      </div>
      <ConfirmDialog
        open={unlinking}
        onClose={() => setUnlinking(false)}
        title={`Unlink ${tailnet.linked}?`}
        confirmLabel="Unlink"
        tone="danger"
        busy={act.busy}
        error={act.error}
        onConfirm={() =>
          act.run(async () => {
            const result = await api.delete('/auth/tailnet/link')
            setUnlinking(false)
            if (result.signedOut) return window.location.assign('/signin')
            await refresh()
            toast('Unlinked. Your tailnet no longer signs you in here.')
          })
        }
      >
        <p>
          Your tailnet login stops signing you in, and sessions that came in that way end. You sign in with a passkey from then on.
          {noPasskey ? ' You have no passkey yet: add one first, or you would be locked out.' : ''} Unlinking asks for your passkey.
        </p>
      </ConfirmDialog>
    </Card>
  )
}

// ---- Invites made for my login (signed in) -------------------------------------------

export function TailnetInvites({ onJoined }) {
  const { me, refresh } = useSession()
  const act = useAction()
  const invites = me?.tailnet?.invites || []
  if (!invites.length) return null
  return (
    <Notice
      tone="ok"
      className="mb-5"
      title={`You are invited: ${inviteWords(invites)}`}
      data-sw-tailnet-invites
      action={
        <Button
          size="touch"
          variant="default"
          className="lg:h-8"
          disabled={act.busy}
          onClick={() =>
            act.run(async () => {
              const result = await api.post('/auth/tailnet/join', {})
              await refresh()
              onJoined?.(result)
            })
          }
          data-sw-tailnet-accept
        >
          {act.busy ? <Spinner /> : null} Join
        </Button>
      }
    >
      An admin invited your tailnet login. {act.error || ''}
    </Notice>
  )
}

// ---- Members: who arrived through the tailnet ---------------------------------------

export function TailnetVisitors({ onInvited }) {
  const { workspaceId, data, role: myRole } = useWorkspace()
  const toast = useToast()
  const on = Boolean(data.features?.tailnetSignIn)
  const visitors = useLoad(on ? wsUrl(workspaceId, '/tailnet-visitors') : null)
  const act = useAction()
  const [roles, setRoles] = useState({})
  const choices = invitableRoles(myRole)
  useEffect(() => setRoles({}), [workspaceId])
  const list = visitors.data?.visitors || []
  if (!on || !list.length) return null
  const admit = (visitor) =>
    act.run(async () => {
      const role = roles[visitor.login] || 'member'
      await api.post(wsUrl(workspaceId, '/invites'), { role, tailnetLogin: visitor.login, expiresInDays: 7 })
      await visitors.reload()
      await onInvited?.()
      toast(`${visitor.login} can join as ${roleWords(role)} the next time they open this server`)
    })
  const dismiss = (visitor) =>
    act.run(async () => {
      await api.delete(wsUrl(workspaceId, `/tailnet-visitors/${encodeURIComponent(visitor.login)}`))
      await visitors.reload()
    })
  return (
    <Card className="mb-5" data-sw-tailnet-visitors>
      <CardHeader
        icon={Network}
        title="Arrived through the tailnet"
        description="People on your tailnet who opened this server and are in no workspace. Being on the tailnet gives them nothing: invite the ones who belong here, with a role."
      />
      <ul className="divide-y divide-line">
        {list.map((visitor) => (
          <li key={visitor.login} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5" data-sw-tailnet-visitor={visitor.login}>
            <div className="min-w-0 flex-[1_1_14rem]">
              <p className="truncate text-sm font-medium text-fg">
                {visitor.name || visitor.login} <Badge className="ml-1 px-2 py-0.5 text-[11px]">not a member</Badge>
              </p>
              <p className="mt-0.5 truncate text-xs text-muted">
                {visitor.login} · last here <Time value={visitor.lastSeenAt} />
              </p>
            </div>
            <Select
              value={roles[visitor.login] || 'member'}
              onValueChange={(value) => setRoles((all) => ({ ...all, [visitor.login]: value }))}
            >
              <SelectTrigger size="touch" className="w-32 lg:h-9" aria-label={`Role for ${visitor.login}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((item) => (
                  <SelectItem key={item} value={item}>
                    {ROLE_LABEL[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="touch"
              variant="default"
              className="lg:h-9"
              disabled={act.busy}
              onClick={() => admit(visitor)}
              data-sw-tailnet-admit
            >
              <UserPlus size={15} aria-hidden="true" /> Invite
            </Button>
            <Button
              size="touch"
              variant="ghost"
              className="lg:h-9"
              disabled={act.busy}
              onClick={() => dismiss(visitor)}
              aria-label={`Take ${visitor.login} off this list`}
              title="Take off this list"
            >
              <X size={15} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      {act.error ? (
        <div className="px-4 pb-4 sm:px-5">
          <FormError error={act.error} />
        </div>
      ) : null}
    </Card>
  )
}
