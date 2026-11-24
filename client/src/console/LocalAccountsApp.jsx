import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, KeyRound, LogOut, UserRound } from 'lucide-react'
import { ConsoleFooter } from './legal-links'
import { ProfileMenu } from '../components/profile-menu'
import { Button, Input, Spinner, TooltipProvider } from '../components/ui'
import { Card, Field, FormError, Loading, Logo, Notice } from './components'
import LocalConsole from './LocalConsole'
import { api } from './lib/api'
import { navigateSoon, usePath } from './lib/router'
import { createPasskey, errorMessage, supportsPasskeys } from './lib/webauthn'
import { AccountPage } from './pages/account'
import { handleProblem, RecoveryCodes, SignIn } from './pages/auth'
import { AuthLayout } from './shell'
import { ReauthProvider, SessionProvider, ToastProvider, useSession, useSignOut } from './state'

const enabled = Boolean(document.querySelector('meta[name="shapewall-local-accounts"]'))

export default function LocalAccountsApp() {
  if (!enabled)
    return (
      <TooltipProvider>
        <AccountsNotEnabled />
      </TooltipProvider>
    )
  return (
    <TooltipProvider>
      <ToastProvider>
        <SessionProvider>
          <ReauthProvider>
            <AccountRoutes />
          </ReauthProvider>
        </SessionProvider>
      </ToastProvider>
    </TooltipProvider>
  )
}

function AccountRoutes() {
  const { me, anon, loading, error, refresh } = useSession()
  const path = usePath()
  const signOut = useSignOut('/signin?next=%2Fconsole')
  useEffect(() => {
    if (me && (path === '/signin' || path === '/signup')) window.location.replace('/console')
    if (!loading && !error && !me && anon && !anon.setupRequired && path !== '/signin')
      window.location.replace(`/signin?next=${encodeURIComponent(path === '/account' ? '/account' : '/console')}`)
  }, [me, anon, path, loading, error])
  if (loading) return <Loading />
  if (error)
    return (
      <AuthLayout>
        <Card className="space-y-4 p-6">
          <h1 className="text-xl font-semibold text-fg">Could not load your account</h1>
          <p role="alert" className="text-sm text-bad">
            {error.message}
          </p>
          <Button size="touch" onClick={refresh}>
            Try again
          </Button>
        </Card>
      </AuthLayout>
    )
  if (!me) {
    if (anon?.setupRequired) {
      if (path === '/console' || path.startsWith('/console/')) return <LocalConsole />
      return <LocalSetup allowed={Boolean(anon.setupAllowed)} />
    }
    if (path !== '/signin') return <Loading />
    return <SignIn />
  }
  if (path !== '/account') return <LocalConsole account={me} onSignOut={signOut} />
  return (
    <div className="flex min-h-dvh flex-col" data-sw-local-account>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-3 sm:px-6">
          <a href="/console" className="flex min-w-0 items-center gap-2 font-semibold text-fg">
            <Logo /> Shapewall
          </a>
          <div className="flex-1" />
          <ProfileMenu
            name={me.user.displayName}
            avatarUrl={me.user.avatarUrl}
            detail={`@${me.user.handle}`}
            items={[
              { id: 'account', label: 'Account and security', icon: UserRound, onSelect: () => navigateSoon('/account') },
              { id: 'sign-out', label: 'Sign out', icon: LogOut, onSelect: signOut },
            ]}
          />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-6 sm:px-6">
        <a href="/console" className="mb-5 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-accent">
          <ArrowLeft size={15} aria-hidden="true" /> Workspace Console
        </a>
        <AccountPage />
      </main>
      <ConsoleFooter legal={false} />
    </div>
  )
}

function LocalSetup({ allowed }) {
  const { refresh } = useSession()
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)
  // A successful registration establishes the session. Keep the recovery
  // codes on this screen until the person has explicitly saved them.
  const registering = useRef(false)
  const problem = handleProblem(handle)
  const submit = async (event) => {
    event.preventDefault()
    if (problem || registering.current) return
    registering.current = true
    setBusy(true)
    setError('')
    try {
      const { options } = await api.post('/auth/register/options', { handle, displayName: name })
      const response = await createPasskey(options)
      setDone(await api.post('/auth/register/verify', { response }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      registering.current = false
      setBusy(false)
    }
  }
  return (
    <AuthLayout wide={Boolean(done)}>
      <Card className="space-y-4 p-6 sm:p-8" data-sw-local-account-setup>
        <h1 className="text-xl font-semibold text-fg">{done ? 'Save your recovery codes' : 'Set up your account'}</h1>
        {done ? (
          <RecoveryCodes
            codes={done.recoveryCodes}
            onDone={async () => {
              await refresh()
              window.location.assign('/account')
            }}
          />
        ) : !allowed ? (
          <Notice title="Account setup needs the installation owner">
            Open the owner’s setup link on the computer serving Shapewall, or ask the installer to grant setup access. Your boards remain
            stored on this installation.
          </Notice>
        ) : (
          <>
            <p className="text-sm text-muted">
              Create a passkey to protect this installation and use the same profile on your other devices. Your existing boards and
              comments stay in place.
            </p>
            {!supportsPasskeys() ? <Notice tone="warn">Use a browser with passkey support over HTTPS or localhost.</Notice> : null}
            <form className="space-y-4" onSubmit={submit}>
              <Field label="Name">
                {(props) => (
                  <Input
                    {...props}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={60}
                    required
                    size="touch"
                    autoComplete="name"
                    data-sw-local-account-name
                  />
                )}
              </Field>
              <Field label="Handle" hint={problem || 'Lowercase letters, digits and dashes. Starts with a letter.'}>
                {(props) => (
                  <Input
                    {...props}
                    value={handle}
                    onChange={(event) => setHandle(event.target.value)}
                    minLength={3}
                    maxLength={32}
                    required
                    size="touch"
                    autoComplete="username webauthn"
                    autoCapitalize="none"
                    spellCheck={false}
                    data-sw-local-account-handle
                  />
                )}
              </Field>
              <FormError error={error} />
              <Button
                type="submit"
                size="touch"
                disabled={busy || !supportsPasskeys() || !name.trim() || !handle || Boolean(problem)}
                data-sw-local-account-create
              >
                {busy ? <Spinner /> : <KeyRound size={16} aria-hidden="true" />} Create passkey
              </Button>
            </form>
          </>
        )}
      </Card>
    </AuthLayout>
  )
}

function AccountsNotEnabled() {
  return (
    <AuthLayout>
      <Card className="space-y-4 p-6">
        <h1 className="text-xl font-semibold text-fg">Account and security</h1>
        <Notice title="Account sign-in is not enabled on this installation">
          Ask the installer to enable accounts to create a passkey, upload a profile photo and manage signed-in devices. Existing network
          and device access controls still apply.
        </Notice>
        <Button asChild size="touch" variant="secondary">
          <a href="/console">Back to Workspace Console</a>
        </Button>
      </Card>
    </AuthLayout>
  )
}
