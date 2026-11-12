import { cn } from '../lib/utils'
import { useState } from 'react'
import { Bot, Camera, Eye, Flag, GitCompare, LocateFixed, Plus, Route, Search, Settings, Waypoints } from 'lucide-react'
import { Button, Dialog, Input, ToggleGroup } from '../components/ui'
import { BrokenBadge } from './BrokenLinks'
import { CaptureLine } from './CaptureStatus'
import { PageFinder } from './PageFinder'
import { JOURNEY_LIST_MAX, journeyMeta } from './ViewsMenu'

// A phone's More menu: agent, pages, viewport, journeys (the same group as
// the desktop Views menu), what to show, settings and capture.
export function BoardMenu({
  menuOpen,
  setMenuOpen,
  data,
  chatAvailable,
  activity,
  chatThread,
  reopenChat,
  groupedPages,
  jumpToPage,
  modes,
  mode,
  setMode,
  journeys,
  journey,
  canEditJourneys,
  openJourney,
  closeJourney,
  startBuilder,
  canChecks,
  openChecks,
  showLinks,
  toggleLinks,
  brokenLinks,
  canCompare,
  comparePair,
  toggleCompare,
  settingsAvailable,
  openSettings,
  capture,
  canCapture,
  busy,
  setCaptureConfirm,
  // Hosted boards: { open, list } for the Agents sheet (null: no such panel here).
  hostedAgents = null,
}) {
  const section = 'mb-1.5 flex items-center gap-1 text-[11px] font-medium tracking-wide text-faint uppercase'
  const [query, setQuery] = useState('')
  const filtering = journeys.length > JOURNEY_LIST_MAX
  const needle = filtering ? query.trim().toLowerCase() : ''
  const shownJourneys = needle ? journeys.filter((item) => item.name.toLowerCase().includes(needle)) : journeys
  const pickJourney = (id) => {
    setMenuOpen(false)
    if (id) openJourney(id)
    else closeJourney()
  }
  return (
    <Dialog open={menuOpen} onClose={() => setMenuOpen(false)} title={data?.board?.title || 'Board'}>
      <div className="space-y-5 p-5">
        {modes.length > 1 ? (
          <div>
            <p className={section}>Screen size</p>
            <ToggleGroup
              label="Screen size"
              options={modes}
              value={mode}
              onChange={(value) => {
                setMode(value)
                setMenuOpen(false)
              }}
              large
            />
          </div>
        ) : null}
        {chatAvailable ? (
          <Button
            size="touch"
            className="w-full justify-start"
            variant={chatThread ? 'default' : 'secondary'}
            onClick={() => {
              setMenuOpen(false)
              reopenChat()
            }}
            data-sw-chat-toggle="true"
          >
            <Bot size={16} aria-hidden="true" /> Chat with your agent
          </Button>
        ) : null}
        {hostedAgents ? (
          <Button
            size="touch"
            className="w-full justify-start"
            variant="secondary"
            onClick={() => {
              setMenuOpen(false)
              hostedAgents.open()
            }}
            data-sw-hosted-agent-open="true"
          >
            <Bot size={16} aria-hidden="true" /> Agents
            {hostedAgents.list?.agents?.length ? (
              <span className="ml-auto text-xs font-normal text-muted">
                {hostedAgents.list.agents.filter((agent) => agent.state !== 'offline').length} of {hostedAgents.list.agents.length} online
              </span>
            ) : null}
          </Button>
        ) : null}
        {activity?.text ? (
          // What the agents are doing, in words (the More button shows the mark).
          <p
            className={cn('-mt-1 flex items-start gap-2 text-xs', activity.state === 'waiting' ? 'text-fg' : 'text-muted')}
            role="status"
            data-sw-agent-activity-line={activity.state}
          >
            <span
              className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', activity.state === 'waiting' ? 'bg-warn' : 'bg-accent')}
              aria-hidden="true"
            />
            {activity.text}
          </p>
        ) : null}
        <div>
          <p className={section}>
            <LocateFixed size={12} aria-hidden="true" /> Go to a page
          </p>
          <PageFinder
            groups={groupedPages}
            onPick={(pageId) => {
              setMenuOpen(false)
              jumpToPage(pageId)
            }}
          />
        </div>
        {journeys.length || canEditJourneys ? (
          <div>
            <p className={section}>Journeys</p>
            {filtering ? (
              <Input
                size="touch"
                icon={Search}
                wrapperClassName="mb-1.5"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter journeys"
                aria-label="Filter journeys"
                data-sw-views-filter="true"
              />
            ) : null}
            <div
              className={filtering ? 'flex max-h-80 flex-col gap-1.5 overflow-y-auto' : 'flex flex-col gap-1.5'}
              role="radiogroup"
              aria-label="Journeys"
              data-sw-journey-menu="true"
            >
              {journeys.length && !needle ? (
                <Button
                  size="touch"
                  className="w-full justify-start"
                  role="radio"
                  aria-checked={!journey}
                  variant={journey ? 'secondary' : 'default'}
                  onClick={() => pickJourney(null)}
                  data-sw-journey-open="none"
                >
                  <Eye size={15} aria-hidden="true" /> None
                  <span className="ml-auto text-xs opacity-70">All pages</span>
                </Button>
              ) : null}
              {shownJourneys.map((item) => (
                <Button
                  key={item.id}
                  size="touch"
                  className="w-full justify-start"
                  role="radio"
                  aria-checked={journey?.id === item.id}
                  variant={journey?.id === item.id ? 'default' : 'secondary'}
                  onClick={() => pickJourney(item.id)}
                  data-sw-journey-open={item.id}
                >
                  <Route size={15} aria-hidden="true" /> <span className="truncate">{item.name}</span>
                  <span className="ml-auto text-xs tabular-nums opacity-70">{journeyMeta(item)}</span>
                </Button>
              ))}
              {needle && !shownJourneys.length ? <p className="px-1 text-sm text-muted">No journey matches.</p> : null}
              {canEditJourneys ? (
                <Button
                  size="touch"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    setMenuOpen(false)
                    startBuilder()
                  }}
                >
                  <Plus size={15} aria-hidden="true" /> New journey
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <p className={section}>Show</p>
          {canChecks ? (
            <Button
              size="touch"
              className="w-full justify-start"
              variant="secondary"
              onClick={() => {
                setMenuOpen(false)
                openChecks()
              }}
              data-sw-checks-toggle="true"
            >
              <Flag size={16} aria-hidden="true" />
              Checks
            </Button>
          ) : null}
          <Button
            size="touch"
            className="w-full justify-start"
            aria-pressed={showLinks}
            variant={showLinks ? 'default' : 'secondary'}
            onClick={() => {
              setMenuOpen(false)
              toggleLinks()
            }}
            data-sw-links-toggle="true"
          >
            <Waypoints size={15} aria-hidden="true" /> {showLinks ? 'Hide links between pages' : 'Show links between pages'}
            <BrokenBadge count={brokenLinks.length} />
          </Button>
          {canCompare ? (
            <Button
              size="touch"
              className="w-full justify-start"
              aria-pressed={Boolean(comparePair)}
              variant={comparePair ? 'default' : 'secondary'}
              onClick={() => {
                setMenuOpen(false)
                toggleCompare()
              }}
              data-sw-compare-toggle="true"
            >
              <GitCompare size={15} aria-hidden="true" /> {comparePair ? 'Leave compare mode' : 'Compare environments'}
            </Button>
          ) : null}
          {settingsAvailable ? (
            <Button
              size="touch"
              className="w-full justify-start"
              variant="secondary"
              onClick={() => {
                setMenuOpen(false)
                openSettings()
              }}
              data-sw-settings-open="true"
            >
              <Settings size={15} aria-hidden="true" /> Agent settings
            </Button>
          ) : null}
        </div>
        <div className="space-y-2 border-t border-line pt-4">
          <CaptureLine data={data} capture={capture} />
          {canCapture ? (
            <Button
              size="touch"
              className="w-full"
              disabled={capture?.running || busy}
              onClick={() => {
                setMenuOpen(false)
                setCaptureConfirm(true)
              }}
              data-sw-capture="true"
            >
              <Camera size={15} aria-hidden="true" /> Capture now
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
