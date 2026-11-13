import { useEffect } from 'react'
import { TooltipProvider } from '../components/ui'
import { Button } from '../components/ui'
import { Card, Loading } from './components'
import { currentPath, navigate, usePath } from './lib/router'
import { ReauthProvider, SessionProvider, ToastProvider, useSession } from './state'
import { AppShell, AuthLayout } from './shell'
import { SignIn, SignUp } from './pages/auth'
import { InvitePage } from './pages/invite'
import { SharePage } from './pages/share'
import { Home } from './pages/home'
import { AccountPage } from './pages/account'
import { WorkspacePage } from './pages/workspace'
import { DemoGuestConsole, DemoSignIn } from './pages/demo'
import { DevicePage } from './pages/device'
import { NoBoardAccess } from './pages/no-access'
import { MovingPage, RebindPage } from './pages/rebind'
import { DEMO, useDemo } from '../lib/demo'

// A board page the server answered with the console: no access to it (any more).
const BOARD_RE = /^\/w\/[^/]+\/p\/[^/]+\/?$/
const WS_RE = /^\/w\/(ws_[a-f0-9]{24})(?:\/([a-z]+))?(?:\/((?:pr|us|ag)_[a-f0-9]{24}))?\/?$/

export default function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <SessionProvider>
          <ReauthProvider>
            <Routes />
          </ReauthProvider>
        </SessionProvider>
      </ToastProvider>
    </TooltipProvider>
  )
}

function Routes() {
  const path = usePath()
  const { me, loading, error, refresh } = useSession()
  const demo = useDemo()
  const publicPage = ['/signin', '/signup', '/invite', '/share', '/rebind'].includes(path)
  // The demo's share link guest has no account: a page that says so.
  const demoGuest = DEMO && demo?.role === 'guest'

  useEffect(() => {
    // Signed out for certain (the server said so), not "could not ask".
    if (!loading && !error && !me && !publicPage && !demoGuest) {
      navigate(`/signin?next=${encodeURIComponent(currentPath())}`, { replace: true })
    }
  }, [loading, error, me, publicPage, demoGuest])

  useEffect(() => {
    const titles = {
      '/signin': 'Sign in',
      '/signup': 'Create your account',
      '/invite': 'Invite',
      '/share': 'Shared board',
      '/account': 'Account',
      '/device': 'Sign in a terminal',
      '/rebind': 'Move your sign-in',
      '/moving': 'This server is moving',
    }
    // A workspace page names itself once it knows the workspace (workspace.jsx).
    if (WS_RE.test(path)) return
    document.title = [titles[path] || (path === '/' ? 'Workspaces' : null), 'Shapewall'].filter(Boolean).join(' · ')
  }, [path])

  if (demoGuest) return <DemoGuestConsole />
  if (DEMO && (path === '/signin' || path === '/signup')) return <DemoSignIn signup={path === '/signup'} />
  if (path === '/signin') return <SignIn />
  if (path === '/signup') return <SignUp />
  if (path === '/invite') return <InvitePage />
  if (path === '/share') return <SharePage />
  if (path === '/rebind') return <RebindPage />
  // The account did not load (offline, a server hiccup): say so and offer a
  // retry, rather than send a signed-in person to the sign-in page.
  if (!loading && !me && error) return <SessionError error={error} onRetry={refresh} />
  if (loading || !me) return <Loading />
  // The old address of a server that is moving: only the move is left here.
  if (me.moving) return <MovingPage />

  const match = WS_RE.exec(path)
  let page
  if (BOARD_RE.test(path)) return <NoBoardAccess />
  if (path === '/account') page = <AccountPage />
  else if (path === '/device') page = <DevicePage />
  else if (match)
    page = (
      <WorkspacePage
        key={match[1]}
        workspaceId={match[1]}
        section={match[2] || 'projects'}
        projectId={match[3]?.startsWith('pr_') ? match[3] : null}
        subjectId={match[3] && !match[3].startsWith('pr_') ? match[3] : null}
      />
    )
  else page = <Home />
  return <AppShell>{page}</AppShell>
}

function SessionError({ error, onRetry }) {
  return (
    <AuthLayout>
      <Card className="space-y-4 p-6 sm:p-8" data-sw-session-error>
        <h1 className="text-xl font-semibold text-fg">Could not load your account</h1>
        <p role="alert" className="text-sm text-bad">
          {error.message}
        </p>
        <Button size="touch" variant="default" onClick={onRetry}>
          Try again
        </Button>
      </Card>
    </AuthLayout>
  )
}
