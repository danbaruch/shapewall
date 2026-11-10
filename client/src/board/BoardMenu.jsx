import { Bot, Camera, Flag, GitCompare, LocateFixed, Plus, Route, Settings, Waypoints } from 'lucide-react'
import { Button, Dialog, ToggleGroup } from '../components/ui'
import { BrokenBadge } from './BrokenLinks'
import { CaptureLine } from './CaptureStatus'
import { PageFinder } from './PageFinder'

// A phone's More menu: agent, pages, viewport, journeys, links, compare,
// settings and capture.
export function BoardMenu({
  menuOpen,
  setMenuOpen,
  data,
  chatAvailable,
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
}) {
  const section = 'mb-1.5 flex items-center gap-1 text-[11px] font-medium tracking-wide text-faint uppercase'
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
            <div className="flex flex-col gap-1.5" data-sw-journey-menu="true">
              {journeys.map((item) => (
                <Button
                  key={item.id}
                  size="touch"
                  className="w-full justify-start"
                  variant={journey?.id === item.id ? 'default' : 'secondary'}
                  onClick={() => {
                    setMenuOpen(false)
                    openJourney(item.id)
                  }}
                  data-sw-journey-open={item.id}
                >
                  <Route size={15} aria-hidden="true" /> <span className="truncate">{item.name}</span>
                  <span className="ml-auto text-xs opacity-70">
                    {item.branching ? `${item.paths?.length || 2} paths` : `${item.steps.length} steps`}
                  </span>
                </Button>
              ))}
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
          <p className={section}>View</p>
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
