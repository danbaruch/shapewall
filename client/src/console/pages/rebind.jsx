// Moving a server to a new origin (src/hosted/rebind.js).
// - /moving (and every page) on the old origin, signed in: "Move my sign-in"
//   makes a one-time link for this account (after a passkey check) and opens
//   the new origin with it.
// - /rebind#<token> on the new origin: makes a passkey for the new host name
//   and signs in. The token sits in the fragment, so it never reaches a log.

import { useEffect, useState } from 'react'
import { ArrowRight, KeyRound, LogOut, MoveRight } from 'lucide-react'
import { Button, Spinner } from '../../components/ui'
import { Card, FormError, Loading, Notice } from '../components'
import { api } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useFragmentSecret } from '../lib/fragment'
import { leaveTo } from '../lib/router'
import { createPasskey, errorMessage, supportsPasskeys } from '../lib/webauthn'
import { useReauth, useSession } from '../state'
import { AuthLayout } from '../shell'
import { hostOf } from './auth'

const REBIND_KEY = 'shapewall.rebind'
const parseRebind = (fragment) => (/^[A-Za-z0-9_-]{40,60}$/.test(fragment) ? fragment : '')

// The old origin: the only thing left to do here is move.
export function MovingPage() {
  const { me } = useSession()
  const withReauth = useReauth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const to = me.moving.to
  const move = async () => {
    setBusy(true)
    setError(null)
    try {
      const { url } = await withReauth(() => api.post('/auth/rebind/start', {}))
      window.location.assign(url)
    } catch (failure) {
      if (!failure?.cancelled) setError(errorMessage(failure))
      setBusy(false)
    }
  }
  const signOut = async () => {
    try {
      await api.post('/auth/logout', {})
    } finally {
      leaveTo('/signin')
    }
  }
  return (
    <AuthLayout>
      <Card className="p-6 sm:p-8" data-sw-moving>
        <h1 className="text-xl font-semibold text-fg">This server is moving to {hostOf(to)}</h1>
        <p className="mt-2 text-sm text-muted">
          Your projects, comments and tokens are already there. Passkeys belong to an address, so make one for {hostOf(to)}: confirm with
          your passkey here, then create a new one there. It takes a minute and works until {formatDateTime(me.moving.endsAt)}.
        </p>
        <div className="mt-6 space-y-3">
          <Button variant="default" size="touch" className="w-full text-[15px]" onClick={move} disabled={busy} data-sw-move-signin>
            {busy ? <Spinner /> : <MoveRight size={17} aria-hidden="true" />} Move my sign-in
          </Button>
          <FormError error={error} />
          <Button variant="ghost" size="touch" className="w-full" onClick={signOut}>
            <LogOut size={16} aria-hidden="true" /> Sign out
          </Button>
        </div>
        <Notice tone="info" className="mt-5">
          Missed it, or no passkey at hand? Sign in at {hostOf(to)} with your handle and a recovery code, then add a passkey there.
        </Notice>
      </Card>
    </AuthLayout>
  )
}

// The new origin: a passkey for this host name from a move link.
export function RebindPage() {
  const { refresh } = useSession()
  const { value: token, forget } = useFragmentSecret({ key: REBIND_KEY, path: '/rebind', parse: parseRebind })
  const [preview, setPreview] = useState(null)
  const [state, setState] = useState(token ? 'loading' : 'missing')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!token) {
      setState('missing')
      return
    }
    setState('loading')
    api
      .post('/auth/rebind/preview', { token })
      .then((data) => {
        setPreview(data)
        setState('ready')
      })
      .catch((failure) => {
        setError(failure.message)
        if (failure.status === 404) forget()
        setState('invalid')
      })
  }, [token, forget])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { options } = await api.post('/auth/rebind/options', { token })
      const response = await createPasskey(options)
      await api.post('/auth/rebind/verify', { response })
      forget()
      await refresh()
      setState('done')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card className="p-6 sm:p-8" data-sw-rebind={state}>
        <h1 className="text-xl font-semibold text-fg">Move your sign-in</h1>
        {state === 'loading' ? <Loading /> : null}
        {state === 'missing' || state === 'invalid' ? (
          <Notice tone="bad" className="mt-4" title="This move link does not work">
            {error || 'The link is incomplete.'} Open the old address and use "Move my sign-in" again, or sign in here with your handle and
            a recovery code.
          </Notice>
        ) : null}
        {state === 'ready' && preview ? (
          <>
            <p className="mt-2 text-sm text-muted">
              Signed in as @{preview.user.handle} on {hostOf(preview.from)}. Create a passkey for {window.location.host}: your browser asks
              where to save it. The link works once, until {formatDateTime(preview.expiresAt)}.
            </p>
            <div className="mt-6 space-y-3">
              <Button
                variant="default"
                size="touch"
                className="w-full text-[15px]"
                onClick={create}
                disabled={busy || !supportsPasskeys()}
                data-sw-rebind-create
              >
                {busy ? <Spinner /> : <KeyRound size={17} aria-hidden="true" />} Create a passkey here
              </Button>
              <FormError error={error} />
            </div>
          </>
        ) : null}
        {state === 'done' ? (
          <div className="mt-4 space-y-4">
            <Notice tone="ok" title="Your sign-in moved">
              You are signed in at {window.location.host} with your new passkey. The old one keeps working on the old address until the move
              ends; remove it from Account later.
            </Notice>
            <Button variant="default" size="touch" className="w-full" onClick={() => leaveTo('/')} data-sw-rebind-continue>
              Continue <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </Card>
    </AuthLayout>
  )
}
