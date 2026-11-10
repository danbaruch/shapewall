import { useEffect, useRef } from 'react'
import { ArrowUpRight, Building2, FolderKanban, LayoutDashboard, LogOut, MessageSquareText, Settings, UserRound } from 'lucide-react'
import { AppRail, useSidebarExpanded } from '../components/app-rail'
import { api } from '../lib/api'
import { leavePage, useMediaQuery, useParams, useResource } from '../lib/hooks'
import { cn } from '../lib/utils'
import { Badge, Button, EmptyState, Spinner, TooltipProvider } from '../components/ui'
import { ProfileMenu } from '../components/profile-menu'
import { ConsoleFooter } from './legal-links'
import { PairingScreen } from '../pairing/Pairing'
import { LocalSettingsContent } from '../settings/LocalSettings'
import { Card, LoadError, Loading, Logo, PageHeader } from './components'
import { AgentFeedbackView } from './pages/agent-feedback'

const SECTIONS = [
  ['projects', 'Projects', FolderKanban],
  ['feedback', 'Agent feedback', MessageSquareText],
  ['settings', 'Settings', Settings],
]

// Local installations use their own board APIs and capabilities. They do not
// sign in to the hosted console or manufacture hosted workspaces/accounts.
export default function LocalConsole({ account = null, onSignOut = null }) {
  const info = useResource('/api/info')
  const list = useResource('/api/boards')
  const [params, updateParams] = useParams()
  const section = ['settings', 'feedback'].includes(params.get('section')) ? params.get('section') : 'projects'
  const wide = useMediaQuery('(min-width: 1024px)')
  const [expanded, toggle] = useSidebarExpanded(wide)
  const updates = useRef(null)
  const boards = Array.isArray(list.data?.boards) ? list.data.boards : []
  const name = info.data?.title || 'Shapewall'
  const navigate = (value) => updateParams({ section: value === 'projects' ? null : value })
  const retry = () => {
    void info.refetch()
    void list.refetch()
  }
  useEffect(() => {
    document.title = `${{ settings: 'Settings', feedback: 'Agent feedback' }[section] || 'Projects'} · Shapewall`
  }, [section])

  if (info.error?.code === 'pairing_required' || list.error?.code === 'pairing_required') return <PairingScreen />

  const error = info.error || list.error
  const showFeedback = Boolean(info.data?.agent?.ownerWrites) || section === 'feedback'
  const profile = (inRail, named) => (
    <ProfileMenu
      name={account?.user?.displayName || info.data?.user?.name || info.data?.localUser?.name || null}
      avatarUrl={account?.user?.avatarUrl || info.data?.user?.avatarUrl}
      detail={account?.user ? `@${account.user.handle}` : 'Local installation'}
      side={inRail ? 'right' : undefined}
      showName={named}
      triggerClassName={inRail ? (named ? 'w-full justify-start' : 'w-10 min-w-10 px-0') : undefined}
      items={[
        { id: 'account', label: 'Account and security', icon: UserRound, onSelect: () => leavePage('/account') },
        ...(onSignOut ? [{ id: 'sign-out', label: 'Sign out', icon: LogOut, onSelect: onSignOut }] : []),
      ]}
    />
  )
  // Desktop: the app rail, the same as on the board (components/app-rail.jsx).
  const railItems = [
    { id: 'board', label: 'Board', icon: LayoutDashboard, href: '/' },
    { id: 'workspace', label: 'Workspace', icon: Building2, href: '/console', active: true },
  ]
  const go = (id) => (event) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      navigate(id)
    }
  }
  // Agent feedback: where the board has chat, for the owner (the server checks too).
  const sections = SECTIONS.filter(([id]) => id !== 'feedback' || showFeedback)
  const railSections = sections.map(([id, label, Icon]) => ({
    id: `local-${id}`,
    label,
    icon: Icon,
    href: id === 'projects' ? '/console' : `/console?section=${id}`,
    onClick: go(id),
    active: section === id,
    'data-sw-nav': id,
  }))
  return (
    <TooltipProvider>
      <div className="flex min-h-dvh">
        {wide ? (
          <AppRail
            expanded={expanded}
            onToggle={toggle}
            home="/console"
            homeLabel="Shapewall console"
            title={name}
            logo={<Logo />}
            items={railItems}
            sections={railSections}
            sectionsLabel="Local installation"
            profile={(named) => profile(true, named)}
            className="sticky top-0 h-dvh"
          />
        ) : null}
        <div className="flex min-h-dvh min-w-0 flex-1 flex-col" data-sw-local-console>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:p-3 focus:text-fg"
          >
            Skip to content
          </a>
          <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:px-6">
              {wide ? null : (
                <>
                  <a
                    href="/console"
                    className="flex shrink-0 items-center gap-2 rounded-md px-1 py-1 outline-none focus-visible:outline-2 focus-visible:outline-accent"
                    aria-label="Shapewall console"
                  >
                    <Logo />
                    <span className="hidden text-[15px] font-semibold text-fg sm:inline">Shapewall</span>
                  </a>
                  <span className="hidden text-line sm:inline" aria-hidden="true">
                    /
                  </span>
                </>
              )}
              {/* Beside the sidebar, flush with the page heading below. */}
              <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold text-fg', !wide && 'px-1')} data-sw-local-console-title>
                {name}
              </span>
              <Badge className="hidden sm:inline-flex">Local</Badge>
              {wide ? null : profile(false, false)}
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-3 pt-5 pb-10 sm:px-6 sm:pt-8">
            <div className="mb-4 flex min-w-0 items-center gap-2 lg:hidden">
              <h1 className="truncate text-lg font-semibold text-fg">{name}</h1>
              <Badge>Local</Badge>
            </div>
            <div>
              {/* On a desktop the app sidebar lists the sections. */}
              {wide ? null : (
                <nav aria-label="Console" className="mb-5">
                  <div className="hidden px-2 pb-3 lg:block">
                    <p className="truncate text-sm font-semibold text-fg">{name}</p>
                    <Badge className="mt-1">Local installation</Badge>
                  </div>
                  <ul className="flex gap-1 lg:sticky lg:top-20 lg:flex-col">
                    {sections.map(([id, label, Icon]) => (
                      <li key={id}>
                        <Button
                          asChild
                          size="touch"
                          variant="ghost"
                          className={cn(
                            'gap-2.5 rounded-full border px-3.5 text-sm lg:h-9 lg:w-full lg:justify-start lg:rounded-md lg:border-transparent lg:px-2.5',
                            section === id
                              ? 'border-accent/40 bg-accent/10 text-fg'
                              : 'border-line bg-surface text-muted lg:bg-transparent',
                          )}
                        >
                          <a
                            href={id === 'projects' ? '/console' : `/console?section=${id}`}
                            onClick={(event) => {
                              if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                                event.preventDefault()
                                navigate(id)
                              }
                            }}
                            aria-current={section === id ? 'page' : undefined}
                            data-sw-nav={id}
                          >
                            <Icon size={16} aria-hidden="true" className={section === id ? 'text-accent' : ''} />
                            {label}
                          </a>
                        </Button>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}
              <div className="min-w-0">
                {info.loading || list.loading ? (
                  <Card>
                    <Loading label="Loading your installation" />
                  </Card>
                ) : error ? (
                  <Card className="p-4">
                    <LoadError error={error} onRetry={retry} />
                  </Card>
                ) : section === 'feedback' ? (
                  <AgentFeedbackView baseUrl="/api/agent/feedback" get={api.get} touch={!wide} />
                ) : section === 'settings' ? (
                  <>
                    <PageHeader title="Settings" description="Preferences for this browser and installation." />
                    <Card data-sw-local-console-settings>
                      <LocalSettingsContent
                        info={info.data}
                        boardCount={boards.length}
                        onSaved={info.refetch}
                        touch={!wide}
                        onOpenUpdates={() => updates.current?.open()}
                      />
                    </Card>
                  </>
                ) : (
                  <>
                    <PageHeader
                      title="Projects"
                      description="Open a board to review its pages and comments."
                      badge={
                        <Badge>
                          {boards.length} {boards.length === 1 ? 'board' : 'boards'}
                        </Badge>
                      }
                    />
                    {boards.length ? (
                      <div className="grid gap-3 md:grid-cols-2" data-sw-local-projects>
                        {boards.map((board) => (
                          <Card key={board.id} className="flex min-w-0 flex-col p-4" data-sw-local-project={board.id}>
                            <div className="flex items-start gap-3">
                              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                                <FolderKanban size={18} aria-hidden="true" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <h2 className="truncate font-semibold text-fg">{board.title}</h2>
                                <p className="mt-0.5 text-xs text-muted">
                                  1 board · {board.pageCount} {board.pageCount === 1 ? 'page' : 'pages'}
                                </p>
                              </div>
                            </div>
                            <div className="mt-4">
                              <Button asChild size="touch" variant="default" className="lg:h-9">
                                <a href={`/?board=${encodeURIComponent(board.id)}`} data-sw-local-open-board={board.id}>
                                  Open board
                                  <ArrowUpRight size={15} aria-hidden="true" />
                                </a>
                              </Button>
                            </div>
                          </Card>
                        ))}
                      </div>
                    ) : (
                      <Card>
                        <EmptyState icon={LayoutDashboard} title="No boards yet">
                          Add pages to this installation's configuration, then capture them to start reviewing.
                        </EmptyState>
                      </Card>
                    )}
                  </>
                )}
              </div>
            </div>
          </main>
          <ConsoleFooter legal={false} updatesRef={updates} transport={api} />
        </div>
      </div>
    </TooltipProvider>
  )
}
