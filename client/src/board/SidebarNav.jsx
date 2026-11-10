// The expanded board sidebar's navigation: a two-option switch, "Pages 26 |
// Journeys 6", over the page tree (PagesTree.jsx) or the journeys list
// (JourneysList.jsx). The chosen tab is remembered in this browser. Opening
// a journey from elsewhere (the Views menu, the palette, J) never switches
// it; the Journeys tab shows a dot while one is open. Collapsed, the rail
// has one icon for each instead (BoardRail.jsx).

import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui'
import { JourneysList } from './JourneysList'
import { PagesTree } from './PagesTree'

const TAB_KEY = 'shapewall.sidebar.nav'
export const SIDEBAR_TABS = ['pages', 'journeys']

function savedTab() {
  try {
    const value = window.localStorage.getItem(TAB_KEY)
    return SIDEBAR_TABS.includes(value) ? value : 'pages'
  } catch {
    return 'pages'
  }
}

// A dot beside the Journeys count while a journey is open.
export function JourneyDot({ className = '' }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent ${className}`}
      aria-hidden="true"
      data-sw-journey-dot="true"
    />
  )
}

export function SidebarNav({ groups, journeys = [], comments, activePage, journeyId, onPage, onJourney, canEditJourneys, onNewJourney }) {
  const [tab, setTab] = useState(savedTab)
  const total = groups.reduce((sum, item) => sum + item.pages.length, 0)
  // No journeys and none can be made here: the page tree alone, as before.
  if (!journeys.length && !canEditJourneys) return <PagesTree groups={groups} comments={comments} activePage={activePage} onPage={onPage} />
  const choose = (value) => {
    setTab(value)
    try {
      window.localStorage.setItem(TAB_KEY, value)
    } catch {
      /* not remembered */
    }
  }
  const trigger = 'gap-1'
  return (
    <Tabs value={tab} onValueChange={choose} className="flex w-full flex-col border-t border-line pt-2" data-sw-sidebar-nav={tab}>
      <TabsList aria-label="Pages and journeys" className="mb-2">
        <TabsTrigger value="pages" className={trigger} data-sw-sidebar-tab="pages">
          Pages <span className="font-normal text-faint tabular">{total}</span>
        </TabsTrigger>
        <TabsTrigger value="journeys" className={trigger} data-sw-sidebar-tab="journeys">
          Journeys <span className="font-normal text-faint tabular">{journeys.length}</span>
          {journeyId ? <JourneyDot className="ml-0.5" /> : null}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pages" tabIndex={-1}>
        <PagesTree bare groups={groups} comments={comments} activePage={activePage} onPage={onPage} />
      </TabsContent>
      <TabsContent value="journeys" tabIndex={-1}>
        <JourneysList
          bare
          journeys={journeys}
          journeyId={journeyId}
          onJourney={onJourney}
          canEditJourneys={canEditJourneys}
          onNewJourney={onNewJourney}
        />
      </TabsContent>
    </Tabs>
  )
}
