// The app rail on the board (desktop): the pages and journeys, then the
// places this kind of board can take you (the workspace console for hosted
// and demo boards, the local console for a local install), sharing, and you.
// See components/app-rail.jsx.

import { useEffect } from 'react'
import { Building2, Files, LayoutDashboard, Route, Share2, UserRound } from 'lucide-react'
import { AppRail, rememberLastBoard } from '../components/app-rail'
import { BoardProfile } from './BoardProfile'
import { accountUrlFor } from './railLinks'
import { JourneysList } from './JourneysList'
import { PagesTree } from './PagesTree'
import { SidebarNav } from './SidebarNav'

// The rail holds where you are in the app (the board, its workspace); the
// workspace's own sections (members, settings, ...) are its console's sidebar.
export function boardRailItems({ info, localSettingsAvailable, setShareOpen }) {
  const items = [{ id: 'board', label: 'Board', icon: LayoutDashboard, href: './', active: true }]
  const consoleUrl = info?.consoleUrl && !info?.guest ? info.consoleUrl : null
  // The same three places as the console's sidebar, so the menu does not
  // change shape as you move between the board and its workspace.
  if (consoleUrl) {
    items.push({ id: 'workspace', label: 'Workspace', icon: Building2, href: consoleUrl })
    items.push({ id: 'account', label: 'Account and security', icon: UserRound, href: accountUrlFor(consoleUrl) })
  } else if (localSettingsAvailable) {
    items.push({ id: 'workspace', label: 'Workspace', icon: Building2, href: '/console' })
    items.push({ id: 'account', label: 'Account and security', icon: UserRound, href: '/account' })
  }
  if (info?.shareEnabled) items.push({ id: 'share', label: 'Share with your team', icon: Share2, onSelect: () => setShareOpen(true) })
  return items
}

export function BoardRail({
  info,
  localName,
  onOpenBuzz,
  demo,
  localSettingsAvailable,
  settingsAvailable,
  openSettings,
  setShareOpen,
  expanded,
  onToggle,
  pages,
  // Drawing mode: the collapsed rail's flyouts stay shut (AppRail).
  quiet = false,
}) {
  // So the console's rail can bring you back here: only your own boards
  // (not a share link, a guest's or a public one), and only the board in the
  // address, never anything else in it.
  const own = Boolean(info) && !info.guest && !info.public && !info.share
  const boardParam = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('board')
  useEffect(() => {
    if (!own) return
    rememberLastBoard(window.location.pathname + (boardParam ? '?board=' + encodeURIComponent(boardParam) : ''))
  }, [own, boardParam])
  const items = boardRailItems({ info, localSettingsAvailable, setShareOpen })
  // Collapsed, the pages and the journeys are an icon each: hover one (or
  // click, tap or press Enter) for its list in a flyout beside the rail. A
  // choice there closes the flyout; only the panel button and Ctrl+B expand
  // the sidebar. The Journeys icon has a dot while a journey is open.
  const journeysShown = Boolean(pages) && (pages.journeys?.length > 0 || pages.canEditJourneys)
  const pick = (close, fn) => (id) => {
    close()
    fn?.(id)
  }
  const sections =
    !expanded && pages
      ? [
          {
            id: 'pages',
            label: 'Pages',
            icon: Files,
            flyout: ({ close }) => (
              <PagesTree groups={pages.groups} comments={pages.comments} activePage={pages.activePage} onPage={pick(close, pages.onPage)} />
            ),
          },
          ...(journeysShown
            ? [
                {
                  id: 'journeys',
                  label: 'Journeys',
                  icon: Route,
                  dot: Boolean(pages.journeyId),
                  'data-sw-rail-journeys': pages.journeyId || 'none',
                  flyout: ({ close }) => (
                    <JourneysList
                      journeys={pages.journeys}
                      journeyId={pages.journeyId}
                      onJourney={pick(close, pages.onJourney)}
                      canEditJourneys={pages.canEditJourneys}
                      onNewJourney={pages.onNewJourney ? () => pick(close, pages.onNewJourney)() : null}
                    />
                  ),
                },
              ]
            : []),
        ]
      : []
  return (
    <AppRail
      expanded={expanded}
      onToggle={onToggle}
      home="./"
      homeLabel="Shapewall"
      title={info?.project?.name || info?.title}
      logo={<img src="./favicon.svg" alt="" className="h-7 w-7" />}
      items={items}
      sections={sections}
      flyoutsDisabled={quiet}
      profile={(wide) => (
        <BoardProfile
          info={info}
          localName={localName}
          onOpenBuzz={onOpenBuzz}
          demo={demo}
          localSettingsAvailable={localSettingsAvailable}
          settingsAvailable={settingsAvailable}
          openSettings={openSettings}
          setShareOpen={setShareOpen}
          side="right"
          align="end"
          showName={wide}
          triggerClassName={wide ? 'w-full justify-start' : 'w-10 min-w-10 px-0'}
        />
      )}
    >
      {pages ? <SidebarNav {...pages} /> : null}
    </AppRail>
  )
}
