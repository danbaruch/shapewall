import { Bot, Camera, Flag, MessageSquare, MessageSquarePlus, MoreHorizontal, Rows2, Settings } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { PALETTE_KEY, PaletteTrigger } from './PageFinder'
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

// Comments, Agent and Checks share the side panel: flat buttons side by side,
// the open panel's one pressed with the kit's selected treatment (Toggle
// `flat`), none pressed while the panel is closed. Each also opens its own
// entry point (unchanged hooks).
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
}) {
  const commentsOn = !panelHidden && !chatThread && !checksOpen
  // Each button keeps one name; aria-pressed says whether its panel is open.
  const segment = 'h-8 text-ui'
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Side panel">
      <Tooltip content={`${commentsOn ? 'Hide' : 'Show'} comments (${allOpen} open)`} side="bottom">
        <Toggle
          variant="flat"
          className={segment}
          pressed={commentsOn}
          onPressedChange={() =>
            updateParams({ panel: panelHidden || chatThread || checksOpen ? null : 'off', chat: null, checks: null, cv: null })
          }
          aria-label={`Comments, ${allOpen} open`}
          data-sw-panel-toggle="true"
        >
          <MessageSquare size={14} aria-hidden="true" />
          {labels ? 'Comments' : null}
          <span className="tabular rounded-full bg-fg/[0.07] px-1.5 text-[11px] leading-4 font-semibold text-fg" aria-hidden="true">
            {allOpen}
          </span>
        </Toggle>
      </Tooltip>
      {chatAvailable ? (
        <Tooltip content={chatThread ? 'Close the agent chat' : 'Chat with your agent about this board'} side="bottom">
          <Toggle
            variant="flat"
            className={segment}
            pressed={Boolean(chatThread)}
            aria-label="Agent"
            onPressedChange={() => (chatThread ? updateParams({ chat: null }) : reopenChat())}
            data-sw-chat-toggle="true"
          >
            <Bot size={14} aria-hidden="true" />
            {labels ? 'Agent' : null}
          </Toggle>
        </Tooltip>
      ) : null}
      {canChecks ? (
        <Tooltip content={checksOpen ? 'Close the checks' : 'Page checks: performance, accessibility, SEO'} side="bottom" align="end">
          <Toggle
            variant="flat"
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

// The board toolbar. Desktop (lg and up): three zones, the canvas-tool way:
//   left    where you are and how you look at it: the project and board
//           switcher, the screen-size toggle, Views (journeys and what the
//           canvas shows), and on a local
//           board Capture with its status (otherwise the status dot sits by
//           the name)
//   centre  find: "Go to page or journey" (Ctrl/Cmd+K), centred on the toolbar
//   right   act and open panels: the viewer note, Comment (the one primary
//           action: a soft accent button while comment mode is off, filled
//           and aria-pressed while it is on), the side panel switch
//           (Comments | Agent | Checks), and Agent settings last
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
  openPalette,
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
}) {
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
          className="shrink-0 text-fg"
          onClick={() => setMenuOpen(true)}
          label={chatAvailable ? 'More: agent, pages, views, screen size' : 'More: pages, views, screen size'}
          data-sw-menu="true"
        >
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
        off.tight ? 'gap-x-3' : 'gap-x-5',
        // Centred: two equal side columns. Too narrow for that: the left zone
        // takes its own width (the name held to its minimum) and the search
        // icon follows it.
        fit.centred ? 'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]' : 'grid-cols-[auto_auto_minmax(0,1fr)]',
      )}
      data-sw-toolbar="full"
      data-sw-toolbar-fit={FIT_STEPS[fit.step]}
      data-sw-toolbar-centred={fit.centred ? 'true' : 'false'}
    >
      <h1 className="sr-only">Shapewall: {boardTitle}</h1>
      <div className={cn('flex min-w-0 items-center', innerGap)} data-sw-toolbar-zone="left">
        <div className="flex min-w-0 flex-col justify-center" style={fit.centred ? undefined : { maxWidth: TOOLBAR.name[fit.step] }}>
          {project && !sidebarTitled ? <ProjectCrumb project={project} /> : null}
          {picker}
        </div>
        {canCapture ? null : status}
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
              itemClassName={off.viewport ? 'px-2' : undefined}
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
          labelMax={fit.journey || TOOLBAR.journey[Math.min(fit.step, TOOLBAR.journey.length - 1)]}
        />
        {canCapture ? (
          <>
            <IconButton
              variant="ghost"
              className="shrink-0 text-fg"
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

      <div className="flex shrink-0 items-center justify-center" data-sw-toolbar-zone="center">
        <Tooltip content={<KeyTip label="Go to a page, journey or comment" keys={[PALETTE_KEY]} />} side="bottom">
          <PaletteTrigger onOpen={openPalette} compact={off.search} style={off.search ? undefined : { width: fit.search }} />
        </Tooltip>
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
        />
        {settingsAvailable ? (
          <IconButton
            variant="ghost"
            className="shrink-0 text-fg"
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
