import { Bot, Camera, Flag, MessageSquare, MessageSquarePlus, MoreHorizontal, Rows2, Settings } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { settles } from './agentActivity'
import { leavePage } from '../lib/hooks'
import { cn } from '../lib/utils'
import {
  Button,
  IconButton,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Toggle,
  ToggleGroup,
  Tooltip,
} from '../components/ui'
import { ProjectCrumb, ViewerNote } from './HostedNotes'
import { ViewsMenu } from './ViewsMenu'
import { KeyTip } from './KeyTip'
import { CaptureStatus } from './CaptureStatus'
import { BoardProfile } from './BoardProfile'
import { viewportIcon } from './viewports'
import { FIT_STEPS, TOOLBAR, collapsed, fitToolbar, toolbarItems } from './toolbarFit'

// Text widths for the toolbar fit, measured on a canvas in the page's font.
const FONTS = { name: '600 14px', ui: '500 13px', xs: '500 12px', count: '600 11px' }
let ruler
function textWidth(value, font) {
  if (typeof document === 'undefined') return value.length * 8
  ruler ||= document.createElement('canvas').getContext('2d')
  if (!ruler) return value.length * 8
  ruler.font = `${FONTS[font]} ${getComputedStyle(document.body).fontFamily}`
  return ruler.measureText(value).width
}

// The toolbar's own width, read before paint and on every resize.
function useWidth(ref, active) {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useLayoutEffect(() => {
    const node = ref.current
    if (!active || !node) return undefined
    const read = () => setWidth(Math.round(node.getBoundingClientRect().width))
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(read)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, active])
  return width
}

// One look for every control in the bar (see BoardToolbar below): a quiet
// 32 px box with a hairline. BOXED is a single button (Views, Capture, Agent
// settings); TRACK is a row of options or toggles whose chosen one is the
// raised chip (the screen sizes, the side panels), with SEGMENT its buttons.
const BOXED = 'bg-surface-2/60 text-fg ring-1 ring-line ring-inset hover:bg-surface-2'
const TRACK = 'flex shrink-0 items-center rounded-md border border-line bg-surface-2 p-0.5'
const SEGMENT = 'h-[26px] text-ui'

// A hairline between two groups of the bar.
const Divider = () => <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" data-sw-toolbar-divider="true" />

// The board's agent activity (agentActivity.js) on a toolbar control, as a
// mark on its corner, so it costs no room and reads the same at every width:
//   working  an accent dot with the same ping as a working pin (still under
//            reduced motion), the count in it when more than one runs
//   waiting  a still dot in the attention colour: an agent needs a person
//   done     a still green dot for a few seconds after the last one finished
// The words are in the control's tooltip and accessible name.
const DONE_MS = 4000
function useShownActivity(activity) {
  const [done, setDone] = useState(false)
  const previous = useRef(activity.state)
  useEffect(() => {
    const before = previous.current
    previous.current = activity.state
    if (!settles(before, activity.state)) {
      if (activity.state !== 'idle') setDone(false)
      return undefined
    }
    setDone(true)
    const timer = window.setTimeout(() => setDone(false), DONE_MS)
    return () => window.clearTimeout(timer)
  }, [activity.state])
  return activity.state === 'idle' && done ? 'done' : activity.state
}

const ACTIVITY_TONE = { working: 'bg-accent text-accent-fg', waiting: 'bg-warn text-warn-fg', done: 'bg-ok text-ok-fg' }

// With its word, the Agent button shows the activity the way Comments shows
// its count: a pill at the right end, the same size and type. One agent is a
// dot in that slot; more are counted. Working breathes slowly (styles.css
// `breathe`, the same as a working pin), inside the button and still under
// reduced motion.
function ActivityPill({ shown, count }) {
  if (shown === 'idle') return null
  const many = count > 1 && shown !== 'done'
  return (
    <span
      className={cn(
        'tabular inline-flex shrink-0 items-center justify-center rounded-full text-[11px] leading-4 font-semibold',
        many ? 'px-1.5' : 'mx-1 h-2 w-2',
        ACTIVITY_TONE[shown],
        shown === 'working' && 'motion-safe:animate-breathe',
      )}
      aria-hidden="true"
      data-sw-agent-activity-mark={shown}
      data-sw-agent-activity-pulse={shown === 'working' ? 'true' : undefined}
    >
      {many ? count : null}
    </span>
  )
}

// Without its word (a narrow toolbar, the phone's More button) the mark sits
// inside the icon's corner, small, with the same calm motion.
function ActivityMark({ shown, count, touch = false }) {
  if (shown === 'idle') return null
  const many = count > 1 && shown !== 'done'
  return (
    <span
      className={cn(
        'tabular pointer-events-none absolute flex items-center justify-center rounded-full font-semibold ring-2 ring-surface',
        touch ? 'top-2 right-2' : '-top-1 -right-1',
        many ? 'h-3.5 min-w-3.5 px-0.5 text-[9px] leading-none' : 'h-2 w-2',
        ACTIVITY_TONE[shown],
        shown === 'working' && 'motion-safe:animate-breathe',
      )}
      aria-hidden="true"
      data-sw-agent-activity-mark={shown}
      data-sw-agent-activity-pulse={shown === 'working' ? 'true' : undefined}
    >
      {many ? count : null}
    </span>
  )
}

// In words: what runs and what waits, and on a hosted board whether an agent
// is listening at all (said also when nothing is going on).
const activityWords = (shown, activity) => (shown === 'done' ? ['Agent done', activity.text].filter(Boolean).join('. ') : activity.text)

// Comments, Agent and Checks share the side panel: three siblings on one
// track, the open panel's one raised (Toggle `segment`, the same chip as the
// chosen screen size), none raised while the panel is closed. Each also
// opens its own entry point (unchanged hooks).
function PanelSwitch({
  labels,
  allOpen,
  panelHidden,
  chatAvailable,
  chatThread,
  reopenChat,
  checksOpen,
  canChecks,
  openChecks,
  closeChecks,
  updateParams,
  activity,
  shown,
  openAgentThread,
}) {
  const commentsOn = !panelHidden && !chatThread && !checksOpen
  const words = activityWords(shown, activity)
  // Without an agent chat on this board the Comments button carries the mark.
  const onComments = !chatAvailable && Boolean(words)
  const activityHooks = { 'data-sw-agent-activity': shown, 'data-sw-agent-activity-count': activity.count || undefined }
  // Each button keeps one name; aria-pressed says whether its panel is open.
  const segment = cn(SEGMENT, !labels && 'px-2')
  return (
    <div className={TRACK} role="group" aria-label="Side panel" data-sw-panel-switch="true">
      <Tooltip content={`${commentsOn ? 'Hide' : 'Show'} comments (${allOpen} open)${onComments ? `. ${words}` : ''}`} side="bottom">
        <Toggle
          variant="segment"
          className={segment}
          pressed={commentsOn}
          onPressedChange={() =>
            updateParams({ panel: panelHidden || chatThread || checksOpen ? null : 'off', chat: null, checks: null, cv: null })
          }
          aria-label={`Comments, ${allOpen} open${onComments ? `. ${words}` : ''}`}
          data-sw-panel-toggle="true"
          {...(chatAvailable ? {} : activityHooks)}
        >
          <span className="relative inline-flex">
            <MessageSquare size={14} aria-hidden="true" />
            {onComments ? <ActivityMark shown={shown} count={activity.count} /> : null}
          </span>
          {labels ? 'Comments' : null}
          <span className="tabular rounded-full bg-fg/[0.07] px-1.5 text-[11px] leading-4 font-semibold text-fg" aria-hidden="true">
            {allOpen}
          </span>
        </Toggle>
      </Tooltip>
      {chatAvailable ? (
        <Tooltip content={words || (chatThread ? 'Close the agent chat' : 'Chat with your agent about this board')} side="bottom">
          <Toggle
            variant="segment"
            className={segment}
            pressed={Boolean(chatThread)}
            aria-label={words ? `Agent. ${words}` : 'Agent'}
            // Exactly one thing needs the person: the panel opens on it.
            onPressedChange={() =>
              chatThread ? updateParams({ chat: null }) : activity.target ? openAgentThread(activity.target) : reopenChat()
            }
            data-sw-chat-toggle="true"
            {...activityHooks}
          >
            <span className="relative inline-flex">
              <Bot size={14} aria-hidden="true" />
              {labels ? null : <ActivityMark shown={shown} count={activity.count} />}
            </span>
            {labels ? 'Agent' : null}
            {labels ? <ActivityPill shown={shown} count={activity.count} /> : null}
          </Toggle>
        </Tooltip>
      ) : null}
      {canChecks ? (
        <Tooltip content={checksOpen ? 'Close the checks' : 'Page checks: performance, accessibility, SEO'} side="bottom" align="end">
          <Toggle
            variant="segment"
            className={segment}
            pressed={Boolean(checksOpen)}
            aria-label="Checks"
            onPressedChange={() => (checksOpen ? closeChecks() : openChecks())}
            data-sw-checks-toggle="true"
          >
            <Flag size={14} aria-hidden="true" />
            {labels ? 'Checks' : null}
          </Toggle>
        </Tooltip>
      ) : null}
    </div>
  )
}

// The board toolbar. Desktop (lg and up): three zones holding four groups,
// the canvas-tool way:
//   left    identity: the project and board switcher with the capture
//           status dot (when the board was captured, in its tooltip);
//           then, after a hairline, the view controls: the screen-size
//           switch, Views (journeys and what the canvas shows), and on a
//           local board Capture with its status
//   centre  find: "Go to page or journey" (Ctrl/Cmd+K), centred on the toolbar
//   right   act and open panels: the viewer note, Comment (the one primary
//           action and the one accent control: soft while comment mode is
//           off, filled and aria-pressed while it is on); then, after a
//           hairline, the side panel switch (Comments | Agent | Checks) and
//           Agent settings last
// Every control but the name and Comment is the same quiet box: 32 px tall,
// the same radius, a hairline, the same tint (BOXED, TRACK). A chosen option
// or an open panel is the raised chip on its track.
// toolbarFit.js decides which labels drop when the zones do not fit, from the
// toolbar's width and what it shows (accessible names and tooltips stay).
// Phone: a compact bar whose More button opens BoardMenu.
export function BoardToolbar({
  wide,
  info,
  boardId,
  boards,
  data,
  localProjects,
  projectsError,
  localName,
  onPickBoard,
  onOpenBuzz,
  demo,
  localSettingsAvailable,
  settingsAvailable,
  openSettings,
  setShareOpen,
  modes,
  mode,
  setMode,
  viewportNotice,
  canComment,
  comparePair,
  commentMode,
  setCommentMode,
  setMenuOpen,
  showLinks,
  toggleLinks,
  linksTip,
  brokenLinks,
  canCompare,
  toggleCompare,
  minimapOn,
  toggleMinimap,
  journeys = [],
  journey,
  openJourney,
  closeJourney,
  canEditJourneys,
  startBuilder,
  openBrokenLinks,
  capture,
  busy,
  canCapture,
  setCaptureConfirm,
  chatAvailable,
  chatThread,
  reopenChat,
  updateParams,
  panelHidden,
  checksOpen,
  allOpen,
  canChecks,
  openChecks,
  closeChecks,
  setSheetOpen,
  // The expanded app sidebar already names the project.
  sidebarTitled,
  // What the board's agents are doing (agentActivity.js), and opening the
  // one thread that needs the person.
  activity = { state: 'idle', count: 0, text: '', target: null },
  openAgentThread = () => {},
}) {
  const shown = useShownActivity(activity)
  const boardTitle = boards.find((item) => item.id === boardId)?.title || data?.board?.title || boardId
  const project = info?.hosted && info?.project?.url && info.role !== 'guest' ? info.project : null
  const viewer = !canComment && info?.hosted && info?.role === 'viewer'
  const commenting = canComment && !comparePair
  const headerRef = useRef(null)
  const toolbarWidth = useWidth(headerRef, wide)
  const statusKind = capture?.running ? 'running' : capture?.state === 'failed' && capture.error ? 'failed' : 'dot'
  const progress = capture?.running && capture.total ? `${capture.done || 0}/${capture.total}` : 'Capturing'
  const viewportLabels = modes.map((item) => item.label).join('\n')
  const fit = useMemo(
    () =>
      fitToolbar({
        width: toolbarWidth,
        ...toolbarItems({
          text: textWidth,
          title: boardTitle,
          viewports: viewportLabels ? viewportLabels.split('\n') : [],
          capture: Boolean(canCapture),
          status: { kind: statusKind, progress },
          viewer,
          comment: commenting,
          panels: { comments: allOpen, agent: Boolean(chatAvailable), checks: Boolean(canChecks) },
          settings: Boolean(settingsAvailable),
          journey: journey?.name || null,
        }),
      }),
    [
      toolbarWidth,
      boardTitle,
      viewportLabels,
      canCapture,
      statusKind,
      progress,
      viewer,
      commenting,
      allOpen,
      chatAvailable,
      canChecks,
      settingsAvailable,
      journey?.name,
    ],
  )
  const off = collapsed(fit.step)
  const profile = (
    <BoardProfile
      info={info}
      localName={localName}
      onOpenBuzz={onOpenBuzz}
      demo={demo}
      localSettingsAvailable={localSettingsAvailable}
      settingsAvailable={settingsAvailable}
      openSettings={openSettings}
      setShareOpen={setShareOpen}
    />
  )
  const picker = (
    <Select
      value={boardId}
      onValueChange={(value) => {
        if (!value.startsWith('project/')) return onPickBoard(value)
        const local = localProjects.find((item) => `project/${item.id}` === value)
        if (local?.url && local.running) leavePage(local.url)
      }}
    >
      <SelectTrigger
        size={wide ? 'sm' : 'touch'}
        className={
          wide
            ? cn(
                'max-w-72 min-w-0 border-transparent bg-transparent px-2.5 text-sm font-semibold shadow-none hover:bg-surface-2 data-[state=open]:bg-surface-2',
                project && 'h-6',
              )
            : 'min-w-0 flex-1 border-transparent bg-transparent px-2 text-[15px] font-semibold shadow-none'
        }
        aria-label={`Board: ${boardTitle}`}
        data-sw-picker="true"
      >
        <SelectValue>
          <span className="block truncate">{boardTitle}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {localProjects.length > 1 || project ? <SelectLabel>{project ? project.name : 'This project'}</SelectLabel> : null}
          {boards.map((board) => (
            <SelectItem key={board.id} value={board.id}>
              {wide ? `${board.title} · ${board.pageCount} pages` : board.title}
            </SelectItem>
          ))}
        </SelectGroup>
        {localProjects.length > 1 ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Local projects</SelectLabel>
              {localProjects.map((local) => (
                <SelectItem
                  key={local.id}
                  value={`project/${local.id}`}
                  disabled={local.current || !local.running}
                  data-sw-local-project={local.id}
                >
                  {local.title}
                  {local.current ? ' (current)' : local.running ? '' : ' (not running)'}
                </SelectItem>
              ))}
            </SelectGroup>
            {localProjects.some((local) => !local.running && !local.current) ? (
              <p className="max-w-72 px-2 py-1.5 text-xs text-muted">Start a stopped project with shapewall serve in its folder.</p>
            ) : null}
          </>
        ) : null}
        {projectsError ? (
          <p className="max-w-72 px-2 py-1.5 text-xs text-bad">Could not load local projects. Check the terminal for your project index.</p>
        ) : null}
      </SelectContent>
    </Select>
  )

  if (!wide) {
    return (
      <header className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2 py-1.5" data-sw-toolbar="compact">
        <h1 className="sr-only">Shapewall</h1>
        {picker}
        {canComment && !comparePair ? (
          <IconButton
            size="icon"
            variant={commentMode ? 'default' : 'soft'}
            className="shrink-0"
            aria-pressed={commentMode}
            onClick={() => setCommentMode((value) => !value)}
            label={commentMode ? 'Stop commenting' : 'Comment: tap a page to pin'}
            data-sw-comment-mode="true"
          >
            <MessageSquarePlus size={19} aria-hidden="true" />
          </IconButton>
        ) : null}
        {viewer ? <ViewerNote compact /> : null}
        <Button
          size="touch"
          variant="ghost"
          className="shrink-0 gap-1.5 px-2.5 text-fg"
          onClick={() => {
            closeChecks()
            setSheetOpen(true)
          }}
          aria-label={`Comments, ${allOpen} open`}
          data-sw-panel-toggle="true"
        >
          <MessageSquare size={18} aria-hidden="true" />
          <span className="tabular text-[13px] font-semibold">{allOpen}</span>
        </Button>
        <IconButton
          size="icon"
          variant="ghost"
          className="relative shrink-0 text-fg"
          onClick={() => setMenuOpen(true)}
          label={`${chatAvailable ? 'More: agent, pages, views, screen size' : 'More: pages, views, screen size'}${shown !== 'idle' ? `. ${activityWords(shown, activity)}` : ''}`}
          data-sw-menu="true"
          data-sw-agent-activity={shown}
          data-sw-agent-activity-count={activity.count || undefined}
        >
          <ActivityMark shown={shown} count={activity.count} touch />
          <MoreHorizontal size={19} aria-hidden="true" />
        </IconButton>
        {profile}
      </header>
    )
  }

  const viewportOptions = modes.map((item) => {
    const Icon = item.id === 'all' ? Rows2 : viewportIcon(item.id)
    return {
      id: item.id,
      tooltip: off.viewport ? item.label : null,
      label: off.viewport ? (
        <span className="inline-flex items-center">
          <Icon size={14} aria-hidden="true" />
          <span className="sr-only">{item.label}</span>
        </span>
      ) : (
        item.label
      ),
    }
  })
  const status = <CaptureStatus data={data} capture={capture} />
  const innerGap = off.tight ? 'gap-1' : 'gap-1.5'
  return (
    <header
      ref={headerRef}
      className={cn(
        'grid h-14 shrink-0 items-center border-b border-line bg-surface px-3',
        // Two zones and the room between them; no search here any more (it is
        // the sidebar's field), so the bar keeps its shape whatever is open.
        off.tight ? 'gap-x-3' : 'gap-x-5',
        // Centred: two equal side columns. Too narrow for that: the left zone
        // takes its own width (the name held to its minimum) and the search
        // icon follows it.
        'grid-cols-[auto_minmax(0,1fr)]',
      )}
      data-sw-toolbar="full"
      data-sw-toolbar-fit={FIT_STEPS[fit.step]}
    >
      <h1 className="sr-only">Shapewall: {boardTitle}</h1>
      <div className={cn('flex min-w-0 items-center', innerGap)} data-sw-toolbar-zone="left">
        <div className="flex min-w-0 flex-col justify-center" style={{ maxWidth: TOOLBAR.name[fit.step] }}>
          {project && !sidebarTitled ? <ProjectCrumb project={project} /> : null}
          {picker}
        </div>
        {canCapture ? null : status}
        {off.viewport ? null : <Divider />}
        {modes.length > 1 ? (
          <span
            key={viewportNotice?.at || 'still'}
            className={cn('shrink-0 rounded-md', viewportNotice && 'animate-flash')}
            data-sw-viewport-flash={viewportNotice ? viewportNotice.to : undefined}
          >
            <ToggleGroup
              label="Screen size"
              options={viewportOptions}
              value={mode}
              onChange={setMode}
              itemClassName={cn('h-[26px]', off.viewport && 'px-2')}
            />
          </span>
        ) : null}
        <ViewsMenu
          journeys={journeys}
          journey={journey}
          openJourney={openJourney}
          closeJourney={closeJourney}
          canEditJourneys={canEditJourneys}
          startBuilder={startBuilder}
          showLinks={showLinks}
          toggleLinks={toggleLinks}
          linksTip={linksTip}
          brokenLinks={brokenLinks}
          openBrokenLinks={openBrokenLinks}
          canCompare={canCompare}
          comparePair={comparePair}
          toggleCompare={toggleCompare}
          minimapOn={minimapOn}
          toggleMinimap={toggleMinimap}
          compact={off.view}
          boxed={BOXED}
          labelMax={fit.journey || TOOLBAR.journey[Math.min(fit.step, TOOLBAR.journey.length - 1)]}
        />
        {canCapture ? (
          <>
            <IconButton
              variant="ghost"
              className={cn('shrink-0', BOXED)}
              disabled={capture?.running || busy}
              onClick={() => setCaptureConfirm(true)}
              label="Capture now"
              tooltip="Recapture every page"
              side="bottom"
              data-sw-capture="true"
            >
              <Camera size={16} aria-hidden="true" />
            </IconButton>
            {status}
          </>
        ) : null}
      </div>

      <div className={cn('flex min-w-0 items-center justify-end', innerGap)} data-sw-toolbar-zone="right">
        {viewer ? <ViewerNote /> : null}
        {commenting ? (
          <Tooltip
            content={
              <KeyTip label={commentMode ? 'Stop commenting' : 'Click a page to pin a comment'} keys={commentMode ? ['C', 'Esc'] : ['C']} />
            }
            side="bottom"
          >
            <Button
              variant={commentMode ? 'default' : 'soft'}
              className={cn('h-8 shrink-0 text-[13px]', off.comment ? 'w-8 px-0' : 'px-3', commentMode && 'ring-2 ring-accent/30')}
              aria-pressed={commentMode}
              onClick={() => setCommentMode((value) => !value)}
              data-sw-comment-mode="true"
            >
              <MessageSquarePlus size={15} aria-hidden="true" />
              {off.comment ? <span className="sr-only">Comment</span> : 'Comment'}
            </Button>
          </Tooltip>
        ) : null}
        {commenting && !off.viewport ? <Divider /> : null}
        <PanelSwitch
          labels={!off.panels}
          allOpen={allOpen}
          panelHidden={panelHidden}
          chatAvailable={chatAvailable}
          chatThread={chatThread}
          reopenChat={reopenChat}
          checksOpen={checksOpen}
          canChecks={canChecks}
          openChecks={openChecks}
          closeChecks={closeChecks}
          updateParams={updateParams}
          activity={activity}
          shown={shown}
          openAgentThread={openAgentThread}
        />
        {settingsAvailable ? (
          <IconButton
            variant="ghost"
            className={cn('shrink-0', BOXED)}
            onClick={openSettings}
            label="Agent settings"
            tooltip="Agent settings: which agent the chat uses"
            side="bottom"
            data-sw-settings-open="true"
          >
            <Settings size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
    </header>
  )
}
