// The app rail on the board (desktop): the pages sidebar and search, then the
// places this kind of board can take you (the workspace console for hosted
// and demo boards, the local console for a local install), sharing, and you.
// See components/app-rail.jsx.

import { useEffect } from 'react'
import { Building2, Files, LayoutDashboard, Share2 } from 'lucide-react'
import { AppRail, rememberLastBoard } from '../components/app-rail'
import { BoardProfile } from './BoardProfile'
import { PagesTree } from './PagesTree'

// The rail holds where you are in the app (the board, its workspace); the
// workspace's own sections (members, settings, ...) are its console's sidebar.
export function boardRailItems({ info, localSettingsAvailable, setShareOpen }) {
  const items = [{ id: 'board', label: 'Board', icon: LayoutDashboard, href: './', active: true }]
  const consoleUrl = info?.consoleUrl && !info?.guest ? info.consoleUrl : null
  if (consoleUrl) items.push({ id: 'workspace', label: 'Workspace', icon: Building2, href: consoleUrl })
  else if (localSettingsAvailable) items.push({ id: 'workspace', label: 'Workspace', icon: Building2, href: '/console' })
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
  // Collapsed, the page tree is one icon: hover it (or click, tap or press
  // Enter) for the same tree in a flyout beside the rail. A choice there
  // closes the flyout; only the panel button and Ctrl+B expand the sidebar.
  const sections =
    !expanded && pages
      ? [
          {
            id: 'pages',
            label: 'Pages and journeys',
            icon: Files,
            flyout: ({ close }) => (
              <PagesTree
                {...pages}
                onPage={(id) => {
                  close()
                  pages.onPage(id)
                }}
                onJourney={(id) => {
                  close()
                  pages.onJourney(id)
                }}
              />
            ),
          },
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
      {pages ? <PagesTree {...pages} /> : null}
    </AppRail>
  )
}
