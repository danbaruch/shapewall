// /invite#<token>: shows the workspace and role, then joins (signed in) or
// leads to sign-up or sign-in. The token is kept in this tab's session
// storage for the sign-in round trip and dropped once used. Someone who is
// already in the workspace (often: they used this link before) is told so,
// with the way in.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, RefreshCw, UserPlus } from 'lucide-react'
import { Button, Spinner } from '../../components/ui'
import { Card, FormError, Loading, Notice, RoleBadge } from '../components'
import { api } from '../lib/api'
import { ROLE_LABEL, ROLE_SUMMARY, formatDateTime } from '../lib/format'
import { useFragmentSecret } from '../lib/fragment'
import { Link, navigate } from '../lib/router'
import { useAction, useSession } from '../state'
import { AuthLayout } from '../shell'
import { INVITE_KEY, TOKEN_RE } from './auth'
import { PasteLink } from './share'

const parseInvite = (fragment) => (TOKEN_RE.test(fragment) ? fragment : '')

export function InvitePage() {
  const { me, refresh } = useSession()
  const { value: token, forget, accept: acceptPasted } = useFragmentSecret({ key: INVITE_KEY, path: '/invite', parse: parseInvite })
  const [preview, setPreview] = useState(null)
  const [state, setState] = useState(token ? 'loading' : 'missing')
  const [error, setError] = useState(null)
  const joining = useAction()

  // Each preview, and each token change, gets a new ticket: a late answer for
  // an older token must not show, or forget the link pasted since.
  const ticket = useRef(0)
  const load = useCallback(() => {
    const mine = ++ticket.current
    if (!token) {
      setState('missing')
      return
    }
    setState('loading')
    setError(null)
    api
      .post('/api/invites/preview', { token })
      .then((data) => {
        if (mine !== ticket.current) return
        setPreview(data)
        if (data.alreadyMember) forget()
        setState(data.alreadyMember ? 'member' : 'ready')
      })
      .catch((failure) => {
        if (mine !== ticket.current) return
        setError(failure.message)
        if (failure.status === 404) {
          forget()
          setState('invalid')
        } else setState('error')
      })
  }, [token, forget])

  // Signed in or out changes what the preview says (already a member).
  const signedIn = Boolean(me)
  useEffect(() => {
    // Only a token to check: forgetting a dead or used one keeps the page
    // saying why, rather than "incomplete".
    if (token) load()
    return () => {
      ticket.current += 1
    }
  }, [load, token, signedIn])

  const join = () =>
    joining.run(async () => {
      let result
      try {
        result = await api.post('/api/invites/accept', { token })
      } catch (failure) {
        // Joined meanwhile (another tab): the preview says so, with the way in.
        if (failure.code === 'already_member') return load()
        throw failure
      }
      forget()
      await refresh()
      return navigate(`/w/${result.workspaceId}`)
    })

  const goTo = async (id) => {
    await refresh()
    navigate(`/w/${id}`)
  }

  return (
    <AuthLayout>
      <Card className="p-6 sm:p-8">
        {state === 'loading' ? <Loading label="Checking your invite" /> : null}
        {state === 'missing' ? (
          <>
            <h1 className="text-xl font-semibold text-fg">Invite</h1>
            <Notice tone="warn" className="mt-4" title="This invite link is incomplete">
              Open the full link you were sent. It ends with a # and a long code.
            </Notice>
            <PasteLink onPaste={acceptPasted} testId="invite" />
          </>
        ) : null}
        {state === 'invalid' ? (
          <>
            <h1 className="text-xl font-semibold text-fg">Invite</h1>
            <Notice tone="bad" className="mt-4" title="This invite does not work">
              {error} Ask whoever sent it for a new one.
            </Notice>
            {!me ? (
              <p className="mt-4 text-sm text-muted">
                Already joined with it?{' '}
                <Link to="/signin?next=%2F" className="font-medium text-accent underline-offset-2 hover:underline">
                  Sign in
                </Link>{' '}
                to get to your workspaces.
              </p>
            ) : null}
          </>
        ) : null}
        {state === 'error' ? (
          <div data-sw-invite-retry>
            <h1 className="text-xl font-semibold text-fg">The invite did not load</h1>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <Button size="touch" variant="default" className="mt-5 w-full" onClick={load}>
              <RefreshCw size={15} aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : null}
        {state === 'member' ? (
          <div data-sw-invite-member>
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ok/10 text-ok">
              <CheckCircle2 size={20} aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-xl font-semibold text-fg">You are already in {preview.workspace.name}</h1>
            <p className="mt-2 text-sm text-muted">
              You are signed in as @{me?.user.handle}, a {ROLE_LABEL[preview.role].toLowerCase()} there.
              {preview.usable ? ' The invite is still unused: send it to whoever it was meant for.' : ''}
            </p>
            <Button size="touch" variant="default" className="mt-5 w-full" onClick={() => goTo(preview.workspace.id)} data-sw-invite-go>
              Go to {preview.workspace.name} <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        {state === 'ready' ? (
          <>
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <UserPlus size={20} aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-xl font-semibold text-fg" data-sw-invite-title>
              Join {preview.workspace.name}
            </h1>
            <div className="mt-3 flex items-center gap-2 text-sm text-muted">
              <RoleBadge role={preview.role} /> {ROLE_SUMMARY[preview.role]}
            </div>
            <p className="mt-3 text-xs text-muted">The link works once and expires {formatDateTime(preview.expiresAt)}.</p>
            <div className="mt-6 space-y-2">
              {me ? (
                <Button variant="default" size="touch" className="w-full" onClick={join} disabled={joining.busy} data-sw-invite-accept>
                  {joining.busy ? <Spinner /> : null}
                  Join as @{me.user.handle}
                </Button>
              ) : (
                <>
                  <Button
                    variant="default"
                    size="touch"
                    className="w-full"
                    onClick={() => navigate(`/signup#invite=${encodeURIComponent(token)}`)}
                    data-sw-invite-signup
                  >
                    Create an account
                  </Button>
                  <Button variant="secondary" size="touch" className="w-full" onClick={() => navigate('/signin?next=%2Finvite')}>
                    I have an account
                  </Button>
                </>
              )}
              <FormError error={joining.error} />
            </div>
          </>
        ) : null}
      </Card>
    </AuthLayout>
  )
}
