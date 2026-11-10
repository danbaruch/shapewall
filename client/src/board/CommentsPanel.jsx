// The comments list beside the canvas (a sheet on phones). It mirrors the
// pins: picking a thread flies to its pin and opens it there, hovering one
// lights up its pin (and a hovered pin lights up its row), and threads with
// news since you last opened them carry a dot.
import { useEffect, useRef } from 'react'
import { useBoardView, useBoardViewStore } from './boardView'
import { viewportIcon } from './viewports'
import {
  Brush,
  Check,
  CheckCheck,
  Image as ImageIcon,
  Info,
  ListChecks,
  Loader2,
  MessageSquare,
  Route,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Toggle,
  ToggleGroup,
} from '../components/ui'
import { PanelHeader } from '../components/panel-header'
import { cn, formatRelative } from '../lib/utils'
import { MentionText } from './Mentions'
import { COMMENT_STATES } from './flow'
import { AgentStatusChip, AuthorAvatar, ReopenedChip, commentAuthor } from './commentParts'
import { useCommentAgentFocus } from '../chat/agentFocus'
import { BatchProgress, SelectBox, batchRunning, batchable } from './BatchFixes'

// "No filter" in the state and mention selects (Radix items cannot be "").
const ANY = '__any'

export const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
]

function reactionSummary(comment) {
  const all = [...(comment.reactions || []), ...(comment.replies || []).flatMap((reply) => reply.reactions || [])]
  const counts = new Map()
  for (const entry of all) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + entry.count)
  return [...counts.entries()].slice(0, 3)
}

// The state chip at the right of a row's first line: the agent at work
// right now (the live chat turn), then the stored agent status, reopened,
// resolved.
function RowState({ comment }) {
  const focus = useCommentAgentFocus(comment.id)
  if (comment.status === 'resolved')
    return (
      <Badge tone="ok" data-sw-comment-state="resolved">
        <Check size={10} aria-hidden="true" /> Resolved
      </Badge>
    )
  if (focus?.state === 'working' || focus?.state === 'waiting')
    return (
      <Badge tone={focus.state === 'waiting' ? 'warn' : 'accent'} data-sw-agent-live={focus.state}>
        <Loader2 size={10} className="motion-safe:animate-spin" aria-hidden="true" />
        {focus.state === 'waiting' ? 'Needs your OK' : 'Agent working'}
      </Badge>
    )
  if (comment.agentStatus) return <AgentStatusChip status={comment.agentStatus} at={comment.agentStatusAt} />
  return <ReopenedChip comment={comment} />
}

// `pick`: Select mode for batch fixes ({ checked, onChange, disabled }), or null.
function Row({ comment, title, selected, unread, touch, onFocus, onHover, pick = null }) {
  // Its own answer from the view store: hovering a pin re-renders one row.
  const hovered = useBoardView((state) => state.hoveredId === comment.id)
  const author = commentAuthor(comment)
  const replies = comment.replies?.length || 0
  const reactions = reactionSummary(comment)
  const thread = [comment, ...(comment.replies || [])]
  const imageCount = thread.reduce((sum, item) => sum + (item.images?.length || 0), 0)
  const drawn = thread.some((item) => item.drawing?.shapes?.length)
  const ViewportIcon = viewportIcon(comment.viewport)
  return (
    <li
      className={cn(
        'relative',
        selected ? 'bg-accent/10 shadow-[inset_3px_0_0_var(--accent)]' : hovered ? 'bg-surface-2' : '',
        comment.status === 'resolved' && !selected && 'opacity-80',
        pick && 'flex items-start',
      )}
      data-sw-batch-row={pick ? comment.id : undefined}
    >
      {pick ? (
        <span className={cn('flex shrink-0 items-center', touch ? 'pt-1.5 pl-1' : 'pt-3 pl-1.5')}>
          <SelectBox
            checked={pick.checked}
            onChange={pick.onChange}
            disabled={pick.disabled}
            touch={touch}
            label={`Select comment #${comment.id}`}
            data-sw-batch-select={comment.id}
          />
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => onFocus(comment)}
        onMouseEnter={onHover ? () => onHover(comment.id) : undefined}
        onMouseLeave={onHover ? () => onHover(null) : undefined}
        onFocus={onHover ? () => onHover(comment.id) : undefined}
        onBlur={onHover ? () => onHover(null) : undefined}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'sw-gutter-pad flex w-full gap-2.5 px-3 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          touch && 'min-h-11',
          pick && 'min-w-0 flex-1 pl-1.5',
        )}
        data-sw-comment={comment.id}
        data-sw-comment-unread={unread ? 'true' : undefined}
        data-sw-comment-selected={selected ? 'true' : undefined}
      >
        <AuthorAvatar {...author} size={touch ? 'lg' : 'md'} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-ui">
            <span className={cn('min-w-0 truncate text-fg', unread ? 'font-bold' : 'font-semibold')}>{author.name}</span>
            <span className="shrink-0 text-xs text-faint">{formatRelative(comment.createdAt)}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <RowState comment={comment} />
              {unread ? (
                <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" role="img" data-sw-unread-dot="true" />
              ) : null}
            </span>
          </span>
          <MentionText
            text={comment.body}
            plain={Boolean(comment.authorGuest)}
            className="mt-0.5 line-clamp-2 block text-ui break-words text-fg"
          />
          <span className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-muted">
            <span
              className="inline-flex h-5 min-w-0 items-center gap-1 rounded bg-surface-2 px-1.5 text-[11px] text-muted"
              data-sw-comment-page="true"
            >
              <span className="shrink-0 font-semibold text-fg/70 tabular">#{comment.id}</span>
              <span className="min-w-0 truncate">{title}</span>
              <ViewportIcon size={11} className="shrink-0 text-faint" aria-label={comment.viewport} role="img" />
            </span>
            {replies ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 tabular"
                aria-label={`${replies} ${replies === 1 ? 'reply' : 'replies'}`}
              >
                <MessageSquare size={11} aria-hidden="true" />
                <span aria-hidden="true">{replies}</span>
              </span>
            ) : null}
            {imageCount ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 tabular"
                aria-label={`${imageCount} ${imageCount === 1 ? 'image' : 'images'}`}
                data-sw-comment-images={imageCount}
              >
                <ImageIcon size={11} aria-hidden="true" />
                <span aria-hidden="true">{imageCount}</span>
              </span>
            ) : null}
            {drawn ? (
              <span className="inline-flex shrink-0 items-center" aria-label="Has a drawing" role="img" data-sw-comment-drawn="true">
                <Brush size={11} aria-hidden="true" />
              </span>
            ) : null}
            {reactions.map(([emoji, count]) => (
              <span key={emoji} className="shrink-0" aria-label={`${count} ${emoji}`}>
                {emoji}
                {count > 1 ? <span className="ml-0.5 tabular">{count}</span> : null}
              </span>
            ))}
            {comment.agentStatus && comment.reopenCount > 0 && comment.status === 'open' ? <ReopenedChip comment={comment} /> : null}
          </span>
          {comment.orphanReason ? <span className="mt-1 block text-xs text-muted">{comment.orphanReason}</span> : null}
          {comment.imported && comment.agentStatus ? <span className="mt-1 block text-xs text-faint">Imported history</span> : null}
        </span>
      </button>
    </li>
  )
}

export default function CommentsPanel({
  comments,
  filter,
  counts,
  onFilter,
  selectedId = null,
  onFocus,
  onHover = null,
  unread = new Set(),
  onMarkAllRead = null,
  canAct,
  targetTitle,
  touch,
  journeyFilter = null,
  heading = true,
  onClose = null,
  onResetBrowserComments = null,
  people = [],
  narrow = null,
  // Batch fixes (BatchFixes.jsx useBatchFixes, plus agentName, onConfirm,
  // onOpenThread), or null: nothing of it renders when they are off.
  batch = null,
}) {
  // A thread picked from a pin or a link scrolls into view in the list.
  const listRef = useRef(null)
  useEffect(() => {
    if (selectedId === null) return
    const item = listRef.current?.querySelector(`[data-sw-comment="${selectedId}"]`)
    item?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId, comments.length])
  // A hovered pin's row scrolls into view too (desktop list only).
  const view = useBoardViewStore()
  useEffect(() => {
    if (touch) return undefined
    let last = view.get().hoveredId
    return view.subscribe(() => {
      const { hoveredId } = view.get()
      if (hoveredId === last) return
      last = hoveredId
      if (hoveredId !== null) listRef.current?.querySelector(`[data-sw-comment="${hoveredId}"]`)?.scrollIntoView?.({ block: 'nearest' })
    })
  }, [touch, view])
  const narrowing = Boolean(narrow && (narrow.query || narrow.state || narrow.mention))
  const unreadShown = comments.filter((comment) => unread.has(comment.id)).length
  const batchOn = Boolean(batch?.offered)
  const selecting = batchOn && batch.selecting
  const candidates = selecting ? comments.filter(batchable) : []
  const chosen = selecting ? batch.selected.filter((id) => candidates.some((comment) => comment.id === id)) : []
  const size = touch ? 'touch' : 'xs'
  return (
    <>
      <div className="shrink-0 border-b border-line">
        {heading ? (
          <PanelHeader
            icon={MessageSquare}
            title="Comments"
            onClose={onClose}
            closeLabel="Close comments"
            closeProps={{ 'data-sw-comments-close': 'true' }}
          />
        ) : null}
        <div className={cn('px-3 pb-2.5', heading ? '' : 'pt-2.5')}>
          <ToggleGroup
            label="Show comments"
            value={filter}
            onChange={onFilter}
            large={touch}
            className="w-full"
            options={FILTERS.map((item) => ({ ...item, count: item.id === 'all' ? counts.open + counts.resolved : counts[item.id] }))}
          />
        </div>
      </div>
      {narrow ? (
        <div className="space-y-1.5 border-b border-line px-3 py-2" data-sw-comment-narrow="true">
          <Input
            type="search"
            icon={Search}
            size={touch ? 'touch' : 'xs'}
            value={narrow.query}
            onChange={(event) => narrow.onQuery(event.target.value.slice(0, 120))}
            placeholder="Search text, people, pages, #id"
            aria-label="Search comments"
            data-sw-comment-search="true"
          />
          <div className="flex items-center gap-1.5">
            <Select value={narrow.state || ANY} onValueChange={(value) => narrow.onState(value === ANY ? null : value)}>
              <SelectTrigger size={touch ? 'touch' : 'xs'} className="flex-1" aria-label="Comment state" data-sw-comment-state="true">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any state</SelectItem>
                <SelectSeparator />
                {COMMENT_STATES.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={narrow.mention || ANY} onValueChange={(value) => narrow.onMention(value === ANY ? null : value)}>
              <SelectTrigger size={touch ? 'touch' : 'xs'} className="flex-1" aria-label="Mentioning" data-sw-comment-mention="true">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Anyone mentioned</SelectItem>
                {people.length ? <SelectSeparator /> : null}
                {people.map((person) => (
                  <SelectItem key={person.handle} value={person.handle}>
                    @{person.handle}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {narrowing ? (
              <IconButton
                size={touch ? 'icon' : 'icon-xs'}
                onClick={narrow.onClear}
                label="Clear search and filters"
                data-sw-comment-narrow-clear="true"
              >
                <X size={14} aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        </div>
      ) : null}
      {onResetBrowserComments ? (
        <div
          className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-2 text-xs text-muted"
          data-sw-browser-comments="true"
        >
          <Info size={13} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">Demo: comments you add stay in this browser.</span>
          <Button
            variant="ghost"
            size={touch ? 'touch' : 'xs'}
            className="text-fg"
            onClick={onResetBrowserComments}
            data-sw-browser-comments-reset="true"
          >
            Reset
          </Button>
        </div>
      ) : null}
      {journeyFilter ? (
        <div className="border-b border-line px-3 py-2">
          <Toggle
            variant="pill"
            size={touch ? 'touch' : 'xs'}
            pressed={journeyFilter.on}
            onPressedChange={journeyFilter.onToggle}
            data-sw-journey-filter={journeyFilter.on ? 'on' : 'off'}
          >
            <Route size={12} className="shrink-0 text-warn" aria-hidden="true" />
            <span className="truncate">Only {journeyFilter.name}</span>
          </Toggle>
        </div>
      ) : null}
      {batchOn && filter !== 'resolved' ? (
        <div
          className={cn(
            'flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs text-muted',
            selecting && 'bg-accent/5',
          )}
          data-sw-batch-bar={selecting ? 'selecting' : 'off'}
        >
          {selecting ? (
            <>
              <span className="min-w-0 flex-1 tabular-nums" role="status" data-sw-batch-count={chosen.length}>
                {chosen.length} selected{chosen.length > batch.max ? `, the first ${batch.max} will run` : ''}
              </span>
              <Button
                variant="ghost"
                size={size}
                className="text-fg"
                disabled={!candidates.length}
                onClick={() => batch.setSelected(candidates.slice(0, batch.max).map((comment) => comment.id))}
                data-sw-batch-select-all="true"
              >
                Select all{candidates.length > batch.max ? ` (first ${batch.max})` : ''}
              </Button>
              <Button
                variant="ghost"
                size={size}
                className="text-fg"
                onClick={() => batch.setSelecting(false)}
                data-sw-batch-select-done="true"
              >
                Cancel
              </Button>
              <Button
                size={size}
                className="w-full sm:w-auto"
                disabled={!chosen.length || batchRunning(batch.batch)}
                onClick={() => batch.onConfirm(chosen)}
                data-sw-batch-fix={chosen.length}
              >
                <Sparkles size={13} aria-hidden="true" /> Fix {chosen.length || ''} with {batch.agentName}
              </Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">Fix several open comments in one go.</span>
              <Button
                variant="ghost"
                size={size}
                className="text-fg"
                disabled={batchRunning(batch.batch)}
                onClick={() => batch.setSelecting(true)}
                data-sw-batch-select-mode="true"
              >
                <ListChecks size={13} aria-hidden="true" /> Select
              </Button>
            </>
          )}
        </div>
      ) : null}
      {batchOn && batch.batch ? (
        <div className="sticky top-0 z-10 border-b border-line bg-surface px-3 py-2" data-sw-batch-strip="true">
          <BatchProgress
            batch={batch.batch}
            boardId={batch.boardId}
            compact
            touch={touch}
            onOpenThread={batch.onOpenThread}
            onCancel={batch.cancel}
            onDismiss={batch.dismiss}
          />
        </div>
      ) : null}
      {unreadShown && onMarkAllRead ? (
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-muted" data-sw-unread-bar="true">
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1">{unreadShown} with new activity</span>
          <Button variant="ghost" size={touch ? 'touch' : 'xs'} className="text-fg" onClick={onMarkAllRead} data-sw-mark-all-read="true">
            <CheckCheck size={13} aria-hidden="true" /> Mark all read
          </Button>
        </div>
      ) : null}
      <ul ref={listRef} className="min-h-0 flex-1 divide-y divide-line overflow-y-auto" data-sw-comment-list="true">
        {comments.length ? (
          comments.map((comment) => (
            <Row
              key={comment.id}
              comment={comment}
              title={targetTitle(comment.pageId)}
              selected={selectedId === comment.id}
              unread={unread.has(comment.id)}
              touch={touch}
              onFocus={onFocus}
              onHover={onHover}
              pick={
                selecting && comment.status === 'open'
                  ? {
                      checked: chosen.includes(comment.id),
                      disabled: !batchable(comment),
                      onChange: () => batch.toggle(comment.id),
                    }
                  : null
              }
            />
          ))
        ) : (
          <li>
            {narrowing ? (
              <EmptyState icon={Search} title="No comments match">
                <Button variant="link" size={touch ? 'touch' : 'xs'} className="shadow-none" onClick={narrow.onClear}>
                  Clear the search and filters
                </Button>
              </EmptyState>
            ) : (
              <EmptyState
                icon={MessageSquare}
                title={filter === 'resolved' ? 'Nothing resolved yet' : filter === 'open' ? 'No open comments' : 'No comments yet'}
              >
                {!canAct
                  ? 'This board is read-only.'
                  : touch
                    ? 'Tap Comment, then tap a page to pin a note.'
                    : 'Press C or turn on Comment, then click a page to pin a note.'}
              </EmptyState>
            )}
          </li>
        )}
      </ul>
    </>
  )
}
