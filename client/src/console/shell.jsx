// The signed-in frame: a top bar with the workspace switcher and the account
// menu, and a banner after a recovery-code sign-in.

import { createContext, useContext, useEffect, useState } from 'react'
import { ConsoleFooter } from './legal-links'
import { Building2, Check, ChevronsUpDown, LayoutDashboard, LogOut, Plus, UserRound } from 'lucide-react'
import { AppRail, lastBoard, useSidebarExpanded } from '../components/app-rail'
import { cn } from '../lib/utils'
import { useMediaQuery } from '../lib/hooks'
import { ProfileMenu } from '../components/profile-menu'
import { DemoBanner } from '../components/demo-banner'
import { useDemo } from '../lib/demo'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui'
import { Logo, Notice } from './components'
import { api } from './lib/api'
import { Link, navigate, navigateSoon, usePath } from './lib/router'
import { ROLE_LABEL, formatDateTime } from './lib/format'
import { useAction, useSession, useSignOut, useToast } from './state'

// Told once on the next passkey sign-in: a recovery code was used on this
// account (by you, hopefully). Dismissing it marks it seen on the server.
function SecurityNotice({ notice, onSeen }) {
  const { run, busy, error } = useAction()
  const toast = useToast()
  useEffect(() => {
    if (error) toast(error, 'bad')
  }, [error, toast])
  const dismiss = () =>
    run(async () => {
      await api.post('/auth/security-notice/seen', {})
      await onSeen()
    })
  return (
    <div className="mx-auto max-w-6xl px-3 pt-4 sm:px-6" data-sw-security-notice>
      <Notice
        tone="warn"
        title="Someone signed in to your account with a recovery code"
        action={
          <div className="flex flex-wrap gap-2">
            <Button size="touch" variant="secondary" onClick={() => navigate('/account#activity')} className="lg:h-8">
              Review activity
            </Button>
            <Button size="touch" variant="ghost" onClick={dismiss} disabled={busy} className="lg:h-8" data-sw-security-notice-dismiss>
              That was me
            </Button>
          </div>
        }
      >
        {formatDateTime(notice.at)}
        {notice.ip ? ` from ${notice.ip}` : ''}. If that was not you, make new recovery codes and check your passkeys and devices.
      </Notice>
    </div>
  )
}

// The page's own sections for the sidebar (a workspace's members, settings,
// ...; the account's profile, passkeys, ...): the page publishes them with
// <SidebarSections>, the shell shows them under the places.
const SectionsContext = createContext(() => {})

export function SidebarSections({ label, sections }) {
  const set = useContext(SectionsContext)
  const key = sections.map((item) => `${item.id}:${item.active ? 1 : 0}`).join(',')
  useEffect(() => {
    set({ label, sections })
    return () => set(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, label, key])
  return null
}

export function AppShell({ children }) {
  const { me, refresh } = useSession()
  const demo = useDemo()
  const path = usePath()
  const current = /^\/w\/(ws_[a-f0-9]{24})/.exec(path)?.[1] || null
  const workspace = me.workspaces.find((item) => item.id === current)

  const wide = useMediaQuery('(min-width: 1024px)')
  const [expanded, toggle] = useSidebarExpanded(wide)
  const [pageSections, setPageSections] = useState(null)
  const board = lastBoard() || (demo ? 'index.html' : null)
  const signOut = useSignOut()

  const profile = (inRail, named) => (
    <ProfileMenu
      name={me.user.displayName}
      avatarUrl={me.user.avatarUrl}
      detail={`@${me.user.handle}${workspace ? ` · ${ROLE_LABEL[workspace.role]} in ${workspace.name}` : ''}`}
      showName={named}
      side={inRail ? 'right' : undefined}
      triggerClassName={inRail ? (named ? 'w-full justify-start' : 'w-10 min-w-10 px-0') : undefined}
      label="Account menu"
      data-sw-account-menu
      items={[
        ...(demo ? demo.consoleItems(current) : []),
        { id: 'account', label: 'Account and security', icon: UserRound, onSelect: () => navigateSoon('/account') },
        ...(demo ? [demo.resetItem] : []),
        { id: 'sign-out', label: 'Sign out', icon: LogOut, onSelect: signOut, 'data-sw-sign-out': true },
      ]}
      workspaces={{
        list: me.workspaces.map((item) => ({ ...item, roleLabel: ROLE_LABEL[item.role] })),
        current,
        onPick: (id) => navigateSoon(`/w/${id}`),
      }}
      viewAs={demo?.viewAs || null}
    />
  )
  // Desktop: the app rail, the same as on the board (components/app-rail.jsx).
  const railItems = [
    ...(board ? [{ id: 'board', label: 'Board', icon: LayoutDashboard, href: board }] : []),
    {
      id: 'workspace',
      label: workspace ? `Workspace: ${workspace.name}` : 'Workspaces',
      icon: Building2,
      to: workspace ? `/w/${workspace.id}` : '/',
      active: path !== '/account' && path !== '/device',
    },
    { id: 'account', label: 'Account and security', icon: UserRound, to: '/account', active: path === '/account' },
  ]

  return (
    <SectionsContext.Provider value={setPageSections}>
      <div className="flex min-h-dvh">
        {wide ? (
          <AppRail
            expanded={expanded}
            onToggle={toggle}
            homeTo="/"
            homeLabel="Shapewall, your workspaces"
            title={workspace?.name || 'Shapewall'}
            link={Link}
            logo={<Logo />}
            items={railItems}
            sections={pageSections?.sections || []}
            sectionsLabel={pageSections?.label}
            profile={(named) => profile(true, named)}
            className="sticky top-0 h-dvh"
          />
        ) : null}
        <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:px-6">
              {wide ? null : (
                <>
                  <Link
                    to="/"
                    className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
                    aria-label="Shapewall, your workspaces"
                  >
                    <Logo />
                    <span className="hidden text-[15px] font-semibold text-fg sm:inline">Shapewall</span>
                  </Link>
                  <span className="hidden text-line sm:inline" aria-hidden="true">
                    /
                  </span>
                </>
              )}
              {/* Beside the sidebar, the switcher's name lines up with the page heading below. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="touch"
                    className={cn('min-w-0 shrink gap-2 px-2 text-fg lg:h-9', wide && '-ml-2')}
                    data-sw-workspace-switcher
                  >
                    <span className="truncate font-semibold">{workspace ? workspace.name : 'Workspaces'}</span>
                    <ChevronsUpDown size={14} className="shrink-0 text-faint" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
                  {me.workspaces.map((item) => (
                    <DropdownMenuItem key={item.id} onSelect={() => navigateSoon(`/w/${item.id}`)} data-sw-workspace={item.id}>
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="text-xs text-faint">{ROLE_LABEL[item.role]}</span>
                      {item.id === current ? <Check size={14} className="text-accent" aria-hidden="true" /> : null}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigateSoon('/#new')}>
                    <Plus size={14} aria-hidden="true" /> New workspace
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="flex-1" />
              <DemoBanner variant="chip" />
              {wide ? null : profile(false, true)}
            </div>
          </header>
          {me.viaRecovery ? (
            <div className="mx-auto max-w-6xl px-3 pt-4 sm:px-6">
              <Notice
                tone="warn"
                title="You signed in with a recovery code"
                action={
                  path === '/account' ? null : (
                    <Button size="touch" variant="secondary" onClick={() => navigate('/account#add-passkey')} className="lg:h-8">
                      Add a passkey
                    </Button>
                  )
                }
              >
                Add a new passkey now. For the next 30 minutes this session can add one, and nothing else that is sensitive.
              </Notice>
            </div>
          ) : null}
          {me.securityNotice ? <SecurityNotice notice={me.securityNotice} onSeen={refresh} /> : null}
          {demo?.storageFull ? (
            <div className="mx-auto max-w-6xl px-3 pt-4 sm:px-6" data-sw-demo-storage-full>
              <Notice
                tone="warn"
                title="The demo ran out of browser storage"
                action={
                  <Button size="touch" variant="secondary" onClick={demo.reset} className="lg:h-8">
                    Reset the demo
                  </Button>
                }
              >
                New changes last only until you leave this page. Resetting the demo frees the space.
              </Notice>
            </div>
          ) : null}
          <main className="mx-auto w-full max-w-6xl flex-1 animate-fade-in px-3 pt-5 pb-10 sm:px-6 sm:pt-8" id="main">
            {children}
          </main>
          <ConsoleFooter transport={api} />
        </div>
      </div>
    </SectionsContext.Provider>
  )
}

// The frame for sign-in, sign-up, invites and share links: one centered card.
export function AuthLayout({ children, wide = false }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 pt-10 sm:pt-20">
      <Link to="/" className="mb-6 flex items-center gap-2 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-accent">
        <Logo className="h-8 w-8" />
        <span className="text-lg font-semibold text-fg">Shapewall</span>
      </Link>
      <main className={wide ? 'w-full max-w-lg flex-1 animate-fade-in' : 'w-full max-w-md flex-1 animate-fade-in'} id="main">
        {children}
      </main>
      <ConsoleFooter transport={api} className="px-0 sm:px-0" />
    </div>
  )
}
