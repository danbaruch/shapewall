// The board's journeys in the app sidebar (desktop): "None" (every page),
// each journey with its step count, the open one highlighted, a filter when
// there are more than JOURNEY_LIST_MAX, and "New journey" where journeys can
// be made. Choosing one is the same as in the Views menu and the palette:
// the journey lives in the URL (`j`). `bare`: under the sidebar's switch
// (SidebarNav.jsx), so no heading or top rule of its own.

import { useState } from 'react'
import { Eye, Plus, Route, Search } from 'lucide-react'
import { Input } from '../components/ui'
import { cn } from '../lib/utils'
import { JOURNEY_LIST_MAX, journeyMeta } from './ViewsMenu'

const row =
  'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-accent'

export function JourneysList({ journeys = [], journeyId = null, onJourney, canEditJourneys = false, onNewJourney = null, bare = false }) {
  const [query, setQuery] = useState('')
  const filtering = journeys.length > JOURNEY_LIST_MAX
  const needle = filtering ? query.trim().toLowerCase() : ''
  const shown = needle
    ? journeys.filter((item) =>
        String(item.name || item.id)
          .toLowerCase()
          .includes(needle),
      )
    : journeys
  const item = (current) => cn(row, current ? 'bg-accent/10 text-fg' : 'text-fg/90 hover:bg-surface-2')
  const icon = (current) => cn('shrink-0', current ? 'text-accent' : 'text-faint')

  return (
    <div className={cn('flex w-full flex-col', !bare && 'border-t border-line pt-2')} data-sw-journeys-sidebar="true">
      {bare ? null : (
        <p className="flex items-center px-2.5 pb-1 text-xs font-semibold text-faint">
          Journeys <span className="ml-1 font-normal tabular">{journeys.length}</span>
        </p>
      )}
      {filtering ? (
        <div className="pb-2">
          <Input
            size="sm"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, 80))}
            placeholder="Filter journeys"
            aria-label="Filter journeys"
            data-sw-journeys-filter="true"
          />
        </div>
      ) : null}
      <ul className="pb-2" aria-label="Journeys">
        {journeys.length && !needle ? (
          <li>
            <button
              type="button"
              className={item(!journeyId)}
              aria-current={journeyId ? undefined : 'true'}
              onClick={() => onJourney(null)}
              data-sw-pages-journey="none"
            >
              <Eye size={14} aria-hidden="true" className={icon(!journeyId)} />
              <span className="min-w-0 flex-1 truncate">None</span>
              <span className="shrink-0 text-xs text-faint">Show all pages</span>
            </button>
          </li>
        ) : null}
        {shown.map((entry) => {
          const current = entry.id === journeyId
          return (
            <li key={entry.id}>
              <button
                type="button"
                className={item(current)}
                aria-current={current ? 'true' : undefined}
                onClick={() => onJourney(current ? null : entry.id)}
                data-sw-pages-journey={entry.id}
              >
                <Route size={14} aria-hidden="true" className={icon(current)} />
                <span className="min-w-0 flex-1 truncate">{entry.name || entry.id}</span>
                <span className="shrink-0 text-xs text-faint tabular">{journeyMeta(entry)}</span>
              </button>
            </li>
          )
        })}
        {needle && !shown.length ? <li className="px-2.5 py-3 text-sm text-muted">No journey matches "{query.trim()}".</li> : null}
        {!journeys.length ? <li className="px-2.5 py-2 text-xs text-muted">No journeys yet.</li> : null}
        {canEditJourneys && onNewJourney ? (
          <li>
            <button
              type="button"
              className={cn(row, 'text-muted hover:bg-surface-2 hover:text-fg')}
              onClick={onNewJourney}
              data-sw-journeys-new="true"
            >
              <Plus size={14} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">New journey</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  )
}
