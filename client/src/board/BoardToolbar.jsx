import {
  Bot,
  Camera,
  Check,
  Eye,
  Flag,
  GitCompare,
  Map as MapIcon,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Rows2,
  Settings,
  Waypoints,
} from 'lucide-react'
import { leavePage, useMediaQuery } from '../lib/hooks'
import { cn } from '../lib/utils'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
import { BrokenBadge } from './BrokenLinks'
import { PALETTE_KEY, PaletteTrigger } from './PageFinder'
import { KeyTip } from './KeyTip'
import { CaptureStatus } from './CaptureStatus'
import { BoardProfile } from './BoardProfile'
import { viewportIcon } from './viewports'

// The board's view options: links between pages, compare, the minimap.
function ViewMenu({
  showLinks,
  toggleLinks,
  linksTip,
  brokenLinks,
  canCompare,
  comparePair,
  toggleCompare,
  minimapOn,
  toggleMinimap,
  compact,
}) {
  const on = [showLinks, Boolean(comparePair)].filter(Boolean).length
  const item = 'pr-2'
  const check = (value) => (
    <span className={cn('ml-auto inline-flex h-4 w-4 items-center justify-center', value ? '!text-accent' : 'opacity-0')}>
      <Check size={14} className="!text-accent" aria-hidden="true" />
    </span>
  )
  return (
    <DropdownMenu>
      <Tooltip content="View options: links between pages, compare, minimap" side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className={cn('relative h-8 shrink-0 text-[13px] text-fg', compact ? 'w-8 px-0' : 'px-2.5', on && 'text-accent')}
            aria-label={on ? `View options, ${on} on` : 'View options'}
            data-sw-view-menu="true"
          >
            <Eye size={15} aria-hidden="true" />
            {compact ? null : 'View'}
            {on ? (
              <span
                className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-surface"
                aria-hidden="true"
                data-sw-view-on={on}
              />
            ) : null}
            <BrokenBadge count={brokenLinks.length} corner />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="center"
        className="w-72"
        onCloseAutoFocus={(event) => {
          // Back to the canvas, so the next shortcut reaches the board.
          event.preventDefault()
          document.querySelector('[data-sw-canvas]')?.focus({ preventScroll: true })
        }}
      >
        <DropdownMenuLabel>View</DropdownMenuLabel>
        <DropdownMenuItem
          className={item}
          role="menuitemcheckbox"
          aria-checked={showLinks}
          onSelect={toggleLinks}
          data-sw-links-toggle="true"
        >
          <Waypoints size={15} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block">Links between pages</span>
            {brokenLinks.length ? (
              <span className="block text-xs text-bad">
                {brokenLinks.length} {brokenLinks.length === 1 ? 'link leads' : 'links lead'} to an error
              </span>
            ) : null}
          </span>
          {check(showLinks)}
        </DropdownMenuItem>
        {canCompare ? (
          <DropdownMenuItem
            className={item}
            role="menuitemcheckbox"
            aria-checked={Boolean(comparePair)}
            onSelect={toggleCompare}
            data-sw-compare-toggle="true"
          >
            <GitCompare size={15} aria-hidden="true" /> Compare environments
            {check(Boolean(comparePair))}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className={item} role="menuitemcheckbox" aria-checked={minimapOn} onSelect={toggleMinimap}>
          <MapIcon size={15} aria-hidden="true" /> Minimap
          {check(minimapOn)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-muted">{linksTip}.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Comments, Agent and Checks share the side panel: flat buttons side by side,
// the open panel pressed (a plain fill, no box or accent underline). Each also opens its own entry point (unchanged hooks).
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

// The board toolbar. Desktop (lg and up): three zones with fixed breakpoints
// (no self-measuring, so labels never change with the session's history):
//   left    logo, the project and board switcher, the capture status dot
//   center  viewport, "Go to page or journey" (Ctrl/Cmd+K), View options
//   right   capture and settings, Comment (the one primary action), the side
//           panel switch (Comments | Agent | Checks), the profile
// Below xl (1280 px) the viewport and panel switch drop their words (their
// accessible names and tooltips stay). Phone: a compact bar whose More button
// opens BoardMenu.
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
  const xl = useMediaQuery('(min-width: 1280px)')
  const boardTitle = boards.find((item) => item.id === boardId)?.title || data?.board?.title || boardId
  const project = info?.hosted && info?.project?.url && info.role !== 'guest' ? info.project : null
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
  const viewer = !canComment && info?.hosted && info?.role === 'viewer'

  if (!wide) {
    return (
      <header className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2 py-1.5" data-sw-toolbar="compact">
        <h1 className="sr-only">Shapewall</h1>
        {picker}
        {canComment && !comparePair ? (
          <IconButton
            size="icon"
            variant={commentMode ? 'default' : 'ghost'}
            className={cn('shrink-0', !commentMode && 'text-fg')}
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
          label={chatAvailable ? 'More: agent, pages, journeys, screen size' : 'More: pages, journeys, screen size'}
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
      label: (
        <span className="inline-flex items-center gap-1.5">
          <Icon size={14} aria-hidden="true" className={xl ? 'hidden 2xl:block' : undefined} />
          <span className={xl ? undefined : 'sr-only'}>{item.label}</span>
        </span>
      ),
    }
  })
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 xl:px-4" data-sw-toolbar="full">
      <h1 className="sr-only">Shapewall: {boardTitle}</h1>
      <div className="flex min-w-0 flex-1 items-center gap-1.5" data-sw-toolbar-zone="left">
        <div className="flex min-w-0 flex-col justify-center">
          {project && !sidebarTitled ? <ProjectCrumb project={project} /> : null}
          {picker}
        </div>
        <CaptureStatus data={data} capture={capture} />
      </div>

      <div className="flex shrink-0 items-center gap-2" data-sw-toolbar-zone="center">
        {modes.length > 1 ? (
          <span
            key={viewportNotice?.at || 'still'}
            className={cn('shrink-0 rounded-md', viewportNotice && 'animate-flash')}
            data-sw-viewport-flash={viewportNotice ? viewportNotice.to : undefined}
          >
            <ToggleGroup label="Screen size" options={viewportOptions} value={mode} onChange={setMode} />
          </span>
        ) : null}
        <Tooltip content={<KeyTip label="Go to a page, journey or comment" keys={[PALETTE_KEY]} />} side="bottom">
          <PaletteTrigger onOpen={openPalette} compact={!xl} />
        </Tooltip>
        <ViewMenu
          showLinks={showLinks}
          toggleLinks={toggleLinks}
          linksTip={linksTip}
          brokenLinks={brokenLinks}
          canCompare={canCompare}
          comparePair={comparePair}
          toggleCompare={toggleCompare}
          minimapOn={minimapOn}
          toggleMinimap={toggleMinimap}
          compact={!xl}
        />
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2" data-sw-toolbar-zone="right">
        {canCapture ? (
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
        ) : null}
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
        {viewer ? <ViewerNote /> : null}
        {canComment && !comparePair ? (
          <Tooltip
            content={
              <KeyTip label={commentMode ? 'Stop commenting' : 'Click a page to pin a comment'} keys={commentMode ? ['C', 'Esc'] : ['C']} />
            }
            side="bottom"
          >
            <Button
              variant="default"
              className={cn(
                'h-8 shrink-0 px-3 text-[13px]',
                commentMode && 'bg-accent/90 shadow-[inset_0_1px_3px_rgb(0_0_0/0.25)] ring-2 ring-accent/30',
              )}
              aria-pressed={commentMode}
              onClick={() => setCommentMode((value) => !value)}
              data-sw-comment-mode="true"
            >
              <MessageSquarePlus size={15} aria-hidden="true" /> Comment
            </Button>
          </Tooltip>
        ) : null}
        <PanelSwitch
          labels={xl}
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
      </div>
    </header>
  )
}
