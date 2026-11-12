// Sign in (passkey or recovery code) and sign up (from an invite or the
// one-time setup link). Invite and setup tokens arrive in the URL fragment,
// which browsers never send to the server.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Copy, Download, KeyRound, LifeBuoy } from 'lucide-react'
import { Button, Input, Spinner } from '../../components/ui'
import { Card, CheckToggle, CopyFallback, Field, FormError, Notice } from '../components'
import { api, ApiError, saveBlob } from '../lib/api'
import { ROLE_LABEL, formatDateTime } from '../lib/format'
import { useFragmentSecret } from '../lib/fragment'
import { Link, navigate, safeNext } from '../lib/router'
import { createPasskey, errorMessage, getPasskey, supportsAutofill, supportsPasskeys } from '../lib/webauthn'
import { TurnstileWidget } from '../lib/turnstile'
import { useSession } from '../state'
import { AuthLayout } from '../shell'
import { TailnetArrival } from './tailnet'

export const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/
export const INVITE_KEY = 'shapewall.invite'
const SETUP_KEY = 'shapewall.setup'

export const hostOf = (origin) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

export function SignIn() {
  const { me, anon: session, refresh } = useSession()
  const [next] = useState(() => safeNext(new URLSearchParams(window.location.search).get('next')))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [recovery, setRecovery] = useState(false)
  const [handle, setHandle] = useState('')
  const [code, setCode] = useState('')
  const [autofill, setAutofill] = useState(false)
  const can = supportsPasskeys()
  // The pending autofill request: aborted before a modal prompt (the browser
  // allows one WebAuthn request at a time) and started again after it.
  const pending = useRef(null)
  const autofillOptions = useRef(null)
  const manual = useRef(false)
  const [restart, setRestart] = useState(0)
  // A server moving origins: on the old one, sign in to move your sign-in;
  // on the new one, a passkey made for the old host name may still work.
  const moving = me?.moving || session?.moving || null
  const movedFrom = me?.movedFrom || session?.movedFrom || null

  const finish = useCallback(async () => {
    // One workspace and nowhere particular to go: straight into it.
    if (next === '/') {
      const fresh = await api.get('/auth/me').catch(() => null)
      if (fresh?.workspaces?.length === 1 && !fresh.moving) return window.location.assign(`/w/${fresh.workspaces[0].id}`)
    }
    window.location.assign(next)
  }, [next])

  const stopAutofill = () => {
    pending.current?.abort()
    pending.current = null
  }

  // Passkey autofill: the handle field offers this site's passkeys.
  useEffect(() => {
    if (!can || recovery || me) return undefined
    let stopped = false
    let timer = null
    ;(async () => {
      if (!(await supportsAutofill()) || stopped || manual.current) return
      setAutofill(true)
      const controller = new AbortController()
      pending.current = controller
      // The server's ceremony lives 5 minutes: start a new one before then.
      timer = window.setTimeout(() => {
        controller.abort()
        setRestart((value) => value + 1)
      }, 270_000)
      try {
        const request = api.post('/auth/login/options', {})
        autofillOptions.current = request
        const { options } = await request
        if (controller.signal.aborted) return
        const response = await getPasskey(options, { mediation: 'conditional', signal: controller.signal })
        setBusy(true)
        await api.post('/auth/login/verify', { response })
        await finish()
      } catch (failure) {
        if (controller.signal.aborted || failure?.name === 'AbortError') return
        setError(errorMessage(failure))
        setBusy(false)
        window.setTimeout(() => setRestart((value) => value + 1), 1000)
      } finally {
        window.clearTimeout(timer)
      }
    })()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      stopAutofill()
    }
  }, [can, recovery, me, restart, finish])

  const signIn = async ({ related = false } = {}) => {
    manual.current = true
    stopAutofill()
    setBusy(true)
    setError(null)
    try {
      // Let an in-flight autofill options response set its ceremony cookie
      // before the modal replaces it, including on slow connections.
      await autofillOptions.current?.catch(() => {})
      const { options } = await api.post('/auth/login/options', related ? { related: true } : {})
      const response = await getPasskey(options)
      await api.post('/auth/login/verify', related ? { response, related: true } : { response })
      await finish()
    } catch (failure) {
      setError(
        related && failure?.name === 'NotAllowedError'
          ? `This browser could not use a passkey from ${movedFrom?.rpId}. Use "Move my sign-in" on ${movedFrom?.origin}, or a recovery code.`
          : errorMessage(failure),
      )
      setBusy(false)
      manual.current = false
      setRestart((value) => value + 1)
    }
  }
  const recover = async (event) => {
    event.preventDefault()
    stopAutofill()
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/recovery', { handle, code })
      await refresh()
      window.location.assign('/account')
    } catch (failure) {
      setError(errorMessage(failure))
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card className="p-6 sm:p-8">
        <h1 className="text-xl font-semibold text-fg">Sign in</h1>
        <p className="mt-1 text-sm text-muted">
          {!me && session?.tailnet && !['none', 'self', 'changed'].includes(session.tailnet.state)
            ? 'On this server your tailnet login is the sign-in. A passkey works too, if you made one.'
            : 'Use the passkey you made for Shapewall: on this device, in a password manager or on your phone.'}
        </p>
        {moving ? (
          <Notice tone="info" className="mt-4" title={`This server is moving to ${hostOf(moving.to)}`} data-sw-moving-notice>
            Sign in here with your passkey to move your sign-in to the new address (until {formatDateTime(moving.endsAt)}), or{' '}
            <a href={moving.to} className="font-medium text-accent underline-offset-2 hover:underline">
              go to {hostOf(moving.to)}
            </a>{' '}
            and use a recovery code.
          </Notice>
        ) : null}
        {me ? (
          <Notice tone="info" className="mt-4">
            You are signed in as @{me.user.handle}.{' '}
            <Link to="/" className="font-medium text-accent underline-offset-2 hover:underline">
              Go to your workspaces
            </Link>
          </Notice>
        ) : null}
        {/* A server with tailnet sign-in: what it says about the login this browser arrives with. */}
        {!me && session?.tailnet ? (
          <TailnetArrival
            tailnet={session.tailnet}
            signup={session.signup}
            onSignedIn={(result) => (result?.workspaceId && next === '/' ? window.location.assign(`/w/${result.workspaceId}`) : finish())}
          />
        ) : null}
        {!me && session?.tailnet && !['none', 'self', 'changed'].includes(session.tailnet.state) ? (
          <p className="mt-6 text-xs font-medium tracking-wide text-muted uppercase">Or with a passkey</p>
        ) : null}
        {!recovery ? (
          <div
            className={
              !me && session?.tailnet && !['none', 'self', 'changed'].includes(session.tailnet.state) ? 'mt-3 space-y-3' : 'mt-6 space-y-3'
            }
          >
            {can ? (
              <>
                {autofill ? (
                  <Field label="Handle" hint="Pick your passkey from the suggestions, or use the button.">
                    {(props) => (
                      <Input
                        {...props}
                        size="touch"
                        value={handle}
                        onChange={(event) => setHandle(event.target.value)}
                        autoComplete="username webauthn"
                        autoCapitalize="none"
                        spellCheck={false}
                        data-sw-signin-autofill
                      />
                    )}
                  </Field>
                ) : null}
                <Button
                  variant="default"
                  size="touch"
                  className="w-full text-[15px]"
                  onClick={() => signIn()}
                  disabled={busy}
                  data-sw-passkey-signin
                >
                  {busy ? <Spinner /> : <KeyRound size={17} aria-hidden="true" />}
                  Sign in with a passkey
                </Button>
                {movedFrom ? (
                  <Button
                    variant="secondary"
                    size="touch"
                    className="w-full"
                    onClick={() => signIn({ related: true })}
                    disabled={busy}
                    data-sw-passkey-related
                  >
                    <KeyRound size={16} aria-hidden="true" /> Use a passkey from {movedFrom.rpId}
                  </Button>
                ) : null}
              </>
            ) : (
              <Notice tone="warn">This browser cannot use passkeys here. They need a secure (https) page.</Notice>
            )}
            <FormError error={error} />
            <Button
              variant="ghost"
              size="touch"
              className="w-full"
              onClick={() => {
                stopAutofill()
                setRecovery(true)
              }}
            >
              <LifeBuoy size={16} aria-hidden="true" /> Lost your passkey? Use a recovery code
            </Button>
          </div>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={recover}>
            <Field label="Handle">
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  value={handle}
                  onChange={(event) => setHandle(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-sw-recovery-handle
                />
              )}
            </Field>
            <Field label="Recovery code" hint="Each code works once. Add a new passkey right after.">
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono"
                  data-sw-recovery-code
                />
              )}
            </Field>
            <FormError error={error} />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" size="touch" onClick={() => setRecovery(false)}>
                Back
              </Button>
              <Button type="submit" variant="default" size="touch" disabled={busy || !handle || !code}>
                {busy ? <Spinner /> : null}
                Sign in with the code
              </Button>
            </div>
          </form>
        )}
      </Card>
      <p className="mt-5 text-center text-sm text-muted" data-sw-signin-new>
        {session?.signup === 'open' ? (
          <>
            New here?{' '}
            <Link to="/signup" className="font-medium text-accent underline-offset-2 hover:underline">
              Create an account
            </Link>
          </>
        ) : (
          'New here? Ask a workspace admin for an invite link.'
        )}
      </p>
    </AuthLayout>
  )
}

// Ten codes, shown once. Continue waits until the person says they saved them.
export function RecoveryCodes({ codes, onDone, doneLabel = 'Continue' }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  // The browser refused the clipboard: the codes are selected instead.
  const [selected, setSelected] = useState(false)
  const list = useRef(null)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])
  const text = codes.join('\n')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setSelected(false)
      setCopied(true)
    } catch {
      if (list.current) {
        const range = document.createRange()
        range.selectNodeContents(list.current)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
      setSelected(true)
    }
  }
  const download = () =>
    saveBlob(new Blob([`Shapewall recovery codes\n\n${text}\n`], { type: 'text/plain' }), 'shapewall-recovery-codes.txt')
  return (
    <div className="space-y-4" data-sw-recovery-codes>
      <p className="text-sm text-muted">
        If you lose every passkey, one of these gets you back in. Each works once. They are shown only now: save them in a password manager.
      </p>
      <ol
        ref={list}
        className="grid grid-cols-1 gap-1.5 rounded-lg border border-line bg-surface-2 p-3 font-mono text-[13px] text-fg sm:grid-cols-2"
      >
        {codes.map((item, index) => (
          <li key={item} className="flex gap-2" data-sw-recovery-code-item>
            <span className="w-5 text-right text-faint tabular">{index + 1}.</span>
            <span className="sw-secret select-all">{item}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="touch" variant="secondary" onClick={copy} className="lg:h-9">
          <Copy size={15} aria-hidden="true" /> {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button size="touch" variant="secondary" onClick={download} className="lg:h-9">
          <Download size={15} aria-hidden="true" /> Download
        </Button>
      </div>
      <CopyFallback shown={selected} />
      <CheckToggle checked={saved} onChange={setSaved} id="saved">
        I saved these codes somewhere safe
      </CheckToggle>
      <Button variant="default" size="touch" className="w-full sm:w-auto" disabled={!saved} onClick={onDone} data-sw-codes-done>
        {doneLabel} <ArrowRight size={16} aria-hidden="true" />
      </Button>
    </div>
  )
}

// The handle rule the server enforces, checked as you type.
const HANDLE_RE = /^[a-z][a-z0-9-]{2,31}$/
export function handleProblem(value) {
  if (!value) return null
  if (!/^[a-z]/.test(value)) return 'Start with a letter.'
  if (/[^a-z0-9-]/.test(value)) return 'Only lowercase letters, digits and dashes.'
  if (value.length < 3) return 'At least 3 characters.'
  return HANDLE_RE.test(value) ? null : 'Up to 32 characters.'
}

// #invite=<token> or #setup=<code>. Kept in this tab's session storage until
// sign-up finishes, so a reload or a trip to sign-in does not lose it.
const fromParam = (name) => (fragment) => {
  const value = new URLSearchParams(fragment).get(name) || ''
  return TOKEN_RE.test(value) ? value : ''
}
const parseInviteParam = fromParam('invite')
const parseSetupParam = fromParam('setup')
const validToken = (value) => TOKEN_RE.test(value)

export function SignUp() {
  const { refresh, anon } = useSession()
  const invite = useFragmentSecret({ key: INVITE_KEY, path: '/signup', parse: parseInviteParam, valid: validToken })
  const setup = useFragmentSecret({ key: SETUP_KEY, path: '/signup', parse: parseSetupParam, valid: validToken })
  // An invite wins over a stale setup code in the same tab.
  const tokens = { invite: invite.value, setup: invite.value ? '' : setup.value }
  const needsCheck = Boolean(anon?.turnstile) && !tokens.invite && !tokens.setup
  const [preview, setPreview] = useState(tokens.invite ? 'loading' : null)
  const [previewError, setPreviewError] = useState(null)
  const [handle, setHandle] = useState('')
  const [handleTouched, setHandleTouched] = useState(false)
  const [name, setName] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceEdited, setWorkspaceEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  // Open sign-up behind a bot check (when the server has one).
  const [turnstileToken, setTurnstileToken] = useState(null)
  const [checkRound, setCheckRound] = useState(0)

  useEffect(() => {
    if (!tokens.invite) {
      setPreview(null)
      return
    }
    let live = true
    setPreview('loading')
    setPreviewError(null)
    api
      .post('/api/invites/preview', { token: tokens.invite })
      .then((data) => live && setPreview(data))
      .catch((failure) => {
        if (!live) return
        setPreview(null)
        setPreviewError(failure.message)
      })
    return () => {
      live = false
    }
  }, [tokens.invite])

  // A server with tailnet sign-in, arriving as a login that has no account
  // yet: the tailnet is the sign-in, and a passkey is optional.
  const visitor = anon?.tailnet && ['unknown', 'invited'].includes(anon.tailnet.state) ? anon.tailnet : null
  const visitorLogin = visitor?.login || null
  // "Also sign me in from this tailnet login": off unless the person says so.
  const [linkTailnet, setLinkTailnet] = useState(false)
  useEffect(() => {
    if (!visitor) return
    setHandle((current) => current || visitor.suggested?.handle || '')
    setName((current) => current || visitor.suggested?.displayName || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitorLogin])
  const joinByTailnet = async () => {
    setHandleTouched(true)
    if (problem) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.post('/auth/tailnet/join', {
        handle,
        displayName: name,
        ...(tokens.invite ? { invite: tokens.invite } : {}),
        ...(tokens.setup ? { setup: tokens.setup } : {}),
        ...(!tokens.invite && workspaceValue.trim() ? { workspaceName: workspaceValue.trim() } : {}),
      })
      invite.forget()
      setup.forget()
      await refresh()
      navigate(`/w/${result.workspaceId}`)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : errorMessage(failure))
      setBusy(false)
    }
  }

  const suggested = name.trim() ? `${name.trim()}'s workspace` : ''
  const workspaceValue = workspaceEdited ? workspaceName : suggested
  const problem = handleProblem(handle)

  const submit = async (event) => {
    event.preventDefault()
    setHandleTouched(true)
    if (problem) return
    setBusy(true)
    setError(null)
    try {
      const { options } = await api.post('/auth/register/options', {
        handle,
        displayName: name,
        ...(tokens.invite ? { invite: tokens.invite } : {}),
        ...(tokens.setup ? { setup: tokens.setup } : {}),
        ...(!tokens.invite && workspaceValue.trim() ? { workspaceName: workspaceValue.trim() } : {}),
        ...(needsCheck ? { turnstileToken } : {}),
        // Only when the person ticked it: a passkey account is not linked to the device's tailnet login by itself.
        ...(visitor && linkTailnet ? { linkTailnet: true } : {}),
      })
      const response = await createPasskey(options)
      const result = await api.post('/auth/register/verify', { response })
      invite.forget()
      setup.forget()
      setDone(result)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : errorMessage(failure))
      // A bot check token works once: a new check for the next try.
      if (needsCheck) {
        setTurnstileToken(null)
        setCheckRound((value) => value + 1)
      }
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthLayout wide>
        <Card className="p-6 sm:p-8">
          <h1 className="text-xl font-semibold text-fg">Welcome, {done.user.displayName}</h1>
          <h2 className="mt-5 mb-2 text-[15px] font-semibold text-fg">Your recovery codes</h2>
          <RecoveryCodes
            codes={done.recoveryCodes}
            onDone={async () => {
              await refresh()
              navigate(`/w/${done.workspaceId}`)
            }}
          />
        </Card>
      </AuthLayout>
    )
  }

  const noToken = !tokens.invite && !tokens.setup
  const openSignup = anon?.signup === 'open'
  const ownWorkspace = !tokens.invite
  return (
    <AuthLayout>
      <Card className="p-6 sm:p-8">
        <h1 className="text-xl font-semibold text-fg">{tokens.setup ? 'Set up this server' : 'Create your account'}</h1>
        {tokens.setup ? (
          <Notice tone="info" className="mt-4" title="You are creating this server's first owner account" data-sw-setup-notice>
            You will own the first workspace and can invite everyone else from it. The setup link works once.
          </Notice>
        ) : null}
        {preview === 'loading' ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-muted">
            <Spinner /> Checking your invite
          </p>
        ) : preview ? (
          <Notice tone="ok" className="mt-4" title={`You're invited to ${preview.workspace.name}`}>
            You will join as {ROLE_LABEL[preview.role].toLowerCase()}. The link works once and expires {formatDateTime(preview.expiresAt)}.
          </Notice>
        ) : null}
        {previewError ? (
          <Notice tone="bad" className="mt-4" title="This invite does not work">
            {previewError} Ask whoever sent it for a new one.
          </Notice>
        ) : null}
        {noToken && !openSignup ? (
          <Notice tone="info" className="mt-4">
            Sign-up on this server needs an invite link from a workspace admin. If you have one, open it again.
          </Notice>
        ) : null}
        <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
          <Field
            label="Handle"
            hint="Lowercase letters, digits and dashes, starting with a letter. People @mention you with it."
            error={handleTouched || handle.length >= 3 ? problem : null}
          >
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={handle}
                onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/\s+/g, '-'))}
                onBlur={() => setHandleTouched(true)}
                aria-invalid={problem && (handleTouched || handle.length >= 3) ? true : undefined}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={32}
                data-sw-signup-handle
              />
            )}
          </Field>
          <Field label="Your name">
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                maxLength={60}
                data-sw-signup-name
              />
            )}
          </Field>
          {ownWorkspace ? (
            <Field label="Workspace name" hint="Your team's space for projects. You can rename it later.">
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  value={workspaceValue}
                  onChange={(event) => {
                    setWorkspaceEdited(true)
                    setWorkspaceName(event.target.value)
                  }}
                  maxLength={60}
                  data-sw-signup-workspace
                />
              )}
            </Field>
          ) : null}
          {needsCheck ? <TurnstileWidget key={checkRound} siteKey={anon.turnstile} onToken={setTurnstileToken} onError={setError} /> : null}
          <FormError error={error} />
          {visitor && (tokens.invite || tokens.setup || visitor.state === 'invited' || openSignup) ? (
            <>
              <Notice tone="info" title={`Your tailnet signs you in as ${visitor.login}`} data-sw-signup-tailnet>
                No passkey is needed here. You can add one later in Account and security; a few things, like deleting a workspace, always
                ask for one, and a first passkey can confirm them 24 hours after it is added.
              </Notice>
              <Button
                type="button"
                variant="default"
                size="touch"
                className="w-full text-[15px]"
                disabled={busy || !handle || Boolean(problem) || !name || Boolean(previewError)}
                onClick={joinByTailnet}
                data-sw-signup-tailnet-submit
              >
                {busy ? <Spinner /> : <ArrowRight size={17} aria-hidden="true" />}
                Continue as {visitor.login}
              </Button>
            </>
          ) : null}
          {visitor ? (
            <div className="space-y-1" data-sw-signup-link-tailnet>
              <CheckToggle checked={linkTailnet} onChange={setLinkTailnet} id="link-tailnet">
                Also sign me in from this tailnet login: {visitor.login}
              </CheckToggle>
              <p className="text-xs text-muted">
                With a passkey account this is off unless you tick it. Ticked, anything that runs as you on a tailnet device of yours can
                act as you here, without the passkey.
              </p>
            </div>
          ) : null}
          <Button
            type="submit"
            variant={visitor ? 'secondary' : 'default'}
            size="touch"
            className="w-full text-[15px]"
            disabled={
              busy ||
              !handle ||
              Boolean(problem) ||
              !name ||
              Boolean(previewError) ||
              !supportsPasskeys() ||
              (needsCheck && !turnstileToken)
            }
            data-sw-signup-submit
          >
            {busy ? <Spinner /> : <KeyRound size={17} aria-hidden="true" />}
            Create a passkey and sign up
          </Button>
          <p className="text-xs text-muted">No email and no password: your device or password manager keeps a passkey for this site.</p>
        </form>
      </Card>
      <p className="mt-5 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link
          to={tokens.invite ? '/signin?next=%2Finvite' : '/signin'}
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
