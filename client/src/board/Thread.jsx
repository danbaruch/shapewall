// A comment thread, Figma style: the first message and its replies with
// avatars, times, an "edited" marker and emoji reactions, a header with the
// resolve check, previous / next thread and a menu, and an inline reply box.
// The same view is the desktop popover at the pin and the phone sheet. The
// composer for a new comment is CommentComposer.jsx.
import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Bot,
  Brush,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Crosshair,
  ExternalLink,
  History,
  Info,
  Link2,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Tooltip,
} from '../components/ui'
import { cn, formatRelative, saveAuthor, savedAuthor } from '../lib/utils'
import BeforeAfter from './BeforeAfter'
import { AttachButton, ComposerImages, DrawSheet, DrawTools, MessageImages, imageDropProps } from './CommentMedia'
import { imagesPayload, useImageDraft } from './commentImages'
import { drawing, drawingPayload, useDrawing } from './drawing'
import { COMMENT_MAX, sendsOnEnter } from './commentInput'
import { Reactions } from './Reactions'
import { viewportIcon } from './viewports'
import FixWithAgent from './FixWithAgent'
import { MentionText, MentionTextarea } from './Mentions'
import {
  AgentStatusChip,
  AuthorAvatar,
  AuthorLabel,
  FixRef,
  GithubLinks,
  ReopenedChip,
  anchorLabel,
  commentAuthor,
  exactTime,
  replyAuthor,
  safeHttpUrl,
} from './commentParts'

const withNote = (text, note) => (note ? `${text}, ${note}` : text)

// Why there is no reply box, by the viewer's role on the board.
export function replyDenial(role) {
  if (role === 'viewer') return "Viewers can't reply -- ask an admin for access."
  if (role === 'guest') return "This share link can't reply -- ask the board owner."
  return 'Replies are off on this board.'
}

function When({ at, editedAt }) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1 text-xs text-faint">
      <Tooltip content={exactTime(at)}>
        <time dateTime={at}>{formatRelative(at)}</time>
      </Tooltip>
      {editedAt ? (
        <Tooltip content={`Edited ${exactTime(editedAt)}`}>
          <span data-sw-edited="true">(edited)</span>
        </Tooltip>
      ) : null}
    </span>
  )
}

// One message: avatar, name, time, text, reactions.
function Message({ author, at, editedAt, children, reactions, canReact, me, onReact, touch, ...props }) {
  return (
    <li className="group/message flex gap-2.5 py-2" {...props}>
      <AuthorAvatar {...author} size={touch ? 'lg' : 'md'} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-ui">
          <AuthorLabel {...author} />
          <When at={at} editedAt={editedAt} />
        </p>
        {children}
        <Reactions reactions={reactions} canReact={canReact} me={me} onToggle={onReact} touch={touch} />
      </div>
    </li>
  )
}

function EditBox({ comment, busy, onSave, onCancel, touch, people }) {
  const [body, setBody] = useState(comment.body)
  const submit = async (event) => {
    event?.preventDefault()
    const text = body.trim()
    if (!text || text === comment.body) return onCancel()
    if (await onSave(comment, text)) onCancel()
  }
  return (
    <form className="mt-1 space-y-1.5" onSubmit={submit} data-sw-edit-form={comment.id}>
      <label className="block">
        <span className="sr-only">Edit comment {comment.id}</span>
        <MentionTextarea
          rows={3}
          size={touch ? 'touch' : 'sm'}
          value={body}
          maxLength={COMMENT_MAX}
          onChange={setBody}
          people={people}
          onKeyDown={(event) => {
            if (sendsOnEnter(event, touch)) {
              event.preventDefault()
              submit()
            }
          }}
          autoFocus
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button size={touch ? 'touch' : 'xs'} variant="ghost" onClick={onCancel} disabled={busy} data-sw-edit-cancel={comment.id}>
          Cancel
        </Button>
        <Button
          size={touch ? 'touch' : 'xs'}
          variant="default"
          type="submit"
          disabled={busy || !body.trim()}
          data-sw-edit-save={comment.id}
        >
          Save
        </Button>
      </div>
    </form>
  )
}

// The reply box at the bottom of a thread. `askName`: a local board with no
// name saved in this browser asks once (the composer's saved name), so the
// reply is not signed "anonymous".
function ReplyBox({ comment, busy, onReply, touch, people, autoFocus, askName = false, onSaveName = null, media = null }) {
  const [body, setBody] = useState('')
  const [asking, setAsking] = useState(() => askName && !savedAuthor())
  const [name, setName] = useState('')
  const [sheet, setSheet] = useState(false)
  const canAttach = Boolean(media?.attach)
  const canDraw = Boolean(media?.draw)
  const images = useImageDraft({ enabled: canAttach })
  const owner = `reply-${comment.id}`
  const drawKey = `${comment.pageId}|${comment.viewport}`
  const shapes = useDrawing((value) => (value?.owner === owner ? value.shapes.length : 0))
  // The reply's drawing lives as long as its box.
  useEffect(() => {
    if (!canDraw) return undefined
    drawing.start(drawKey, owner)
    return () => drawing.end(owner)
  }, [canDraw, drawKey, owner])
  const page = canDraw && touch ? media.pageImage?.(comment.pageId, comment.viewport) : null
  const submit = async (event) => {
    event?.preventDefault()
    const text = body.trim()
    if (!text || busy || images.reading) return
    const signed = asking ? name.trim() : ''
    if (signed) {
      saveAuthor(signed)
      onSaveName?.(signed)
    }
    const session = drawing.get()
    const drawn = session?.owner === owner ? session.shapes : []
    const attached = imagesPayload(images.images)
    const extra = {
      ...(attached.length ? { images: attached } : {}),
      ...(drawn.length ? { drawing: drawingPayload(drawn) } : {}),
      onImageError: images.setError,
    }
    if (await onReply(comment, text, extra)) {
      setBody('')
      images.clear()
      drawing.set({ shapes: [], tool: null })
      if (signed) setAsking(false)
    }
  }
  const lines = Math.min(6, Math.max(1, body.split('\n').length))
  const errorId = `sw-reply-image-error-${comment.id}`
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-line px-3 py-2"
      onSubmit={submit}
      {...imageDropProps(images, canAttach)}
      data-sw-reply-form={comment.id}
    >
      {asking ? (
        <label className="flex w-full items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Your name</span>
          <Input
            size={touch ? 'touch' : 'xs'}
            value={name}
            onChange={(event) => setName(event.target.value.slice(0, 60))}
            placeholder="shown on your reply"
            className="flex-1"
            data-sw-reply-author={comment.id}
          />
        </label>
      ) : null}
      <label className="min-w-0 flex-1">
        <span className="sr-only">Reply to comment {comment.id}</span>
        <MentionTextarea
          rows={lines}
          size={touch ? 'touch' : 'sm'}
          value={body}
          maxLength={COMMENT_MAX}
          onChange={setBody}
          people={people}
          className="resize-none"
          placeholder={touch ? 'Reply' : 'Reply, @ to mention'}
          onKeyDown={(event) => {
            if (sendsOnEnter(event, touch)) {
              event.preventDefault()
              submit()
            }
          }}
          autoFocus={autoFocus}
          aria-describedby={images.error ? errorId : undefined}
          data-sw-reply-input={comment.id}
        />
      </label>
      <IconButton
        type="submit"
        variant="default"
        size={touch ? 'icon' : 'icon-sm'}
        className="rounded-full"
        disabled={busy || images.reading || !body.trim()}
        label={busy && images.images.length ? 'Uploading the reply' : 'Send reply'}
        data-sw-reply-send={comment.id}
      >
        <ArrowUp size={16} aria-hidden="true" />
      </IconButton>
      {canAttach ? (
        <div className="w-full">
          <ComposerImages draft={images} touch={touch} id={errorId} />
        </div>
      ) : null}
      {canAttach || canDraw || media?.attachNote ? (
        <div className="-mt-1 -ml-1 flex w-full flex-wrap items-center gap-0.5" data-sw-reply-media={comment.id}>
          {canDraw && !touch ? (
            <DrawTools
              owner={owner}
              touch={false}
              compact
              className="flex-1"
              leading={canAttach ? <AttachButton draft={images} touch={false} disabled={busy} /> : null}
            />
          ) : canAttach ? (
            <AttachButton draft={images} touch={touch} disabled={busy} />
          ) : null}
          {canDraw && touch && page ? (
            <Button size="touch" variant="ghost" onClick={() => setSheet(true)} data-sw-draw-open="true">
              <Brush size={16} aria-hidden="true" /> {shapes ? `Drawing (${shapes})` : 'Draw on the page'}
            </Button>
          ) : null}
          {media?.attachNote ? (
            <p className="w-full px-1 text-caption text-faint" data-sw-attach-note="true">
              {media.attachNote}
            </p>
          ) : null}
        </div>
      ) : null}
      {canDraw && touch && page ? (
        <DrawSheet open={sheet} onClose={() => setSheet(false)} owner={owner} src={page.src} native={page.native} title={media.pageTitle} />
      ) : null}
    </form>
  )
}

// A note under a message that has a drawing: where it shows.
function DrawingNote({ item, currentVersion, onShow }) {
  if (!item?.drawing?.shapes?.length) return null
  const previous = Boolean(item.drawing.captureVersion && currentVersion && item.drawing.captureVersion !== currentVersion)
  const count = item.drawing.shapes.length
  return (
    <p className="mt-1.5 text-xs text-muted" data-sw-message-drawing={previous ? 'previous' : 'current'}>
      <Brush size={11} className="mr-1 inline-block align-[-1px]" aria-hidden="true" />
      {previous ? (
        <>
          <span>Drawn on the previous capture ({count === 1 ? 'one shape' : `${count} shapes`}).</span>{' '}
          {onShow ? (
            <button
              type="button"
              className="rounded text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              onClick={onShow}
              data-sw-show-drawing="true"
            >
              View it on Before
            </button>
          ) : null}
        </>
      ) : (
        <span>Drawn on the page ({count === 1 ? 'one shape' : `${count} shapes`}), shown over the frame.</span>
      )}
    </p>
  )
}

// The whole thread. `can` says what this person may do with this comment
// ({ reply, resolve, react, edit, delete }); `nav` steps through the threads
// in the list (`prevNote` / `nextNote`, e.g. "switches to Phone", say when a
// step changes the viewport); `onClose` is null in the phone sheet (it has
// its own close). When replying is off, `denial` (or one made from `role`)
// says why. `hosted: false` marks a local board, where the reply box asks
// for a name once; `onSaveName` hears it.
export function ThreadView({
  comment,
  page,
  title,
  people,
  touch,
  me,
  can,
  busy,
  actions,
  nav,
  beforeAfter,
  onClose = null,
  editingRef = null,
  denial = null,
  role = null,
  hosted = null,
  onSaveName = null,
  media = null,
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const scroller = useRef(null)
  useEffect(() => {
    setEditing(false)
    setConfirming(false)
  }, [comment.id])
  // Escape inside the edit box cancels the edit, not the thread.
  if (editingRef) editingRef.current = editing ? () => setEditing(false) : null
  // New replies scroll into view.
  const replyCount = comment.replies?.length || 0
  useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [comment.id, replyCount])
  const resolved = comment.status === 'resolved'
  // A resolved thread has no agent at work: only "Agent done" still shows.
  const agentStatus = resolved && comment.agentStatus !== 'done' ? null : comment.agentStatus
  const size = touch ? 'icon' : 'icon-sm'
  const ViewportIcon = viewportIcon(comment.viewport, null)
  const fixable = Boolean(actions.onFixAgent) && comment.status === 'open'
  const chips = (comment.reopenCount > 0 && !resolved) || Boolean(agentStatus)
  const issueUrl = comment.github?.issue ? safeHttpUrl(comment.github.issue.url) : null
  const currentVersion = media?.currentVersion?.(comment) || null
  const showBefore = () => {
    const element = scroller.current?.querySelector('[data-sw-before-after]')
    element?.scrollIntoView?.({ block: 'nearest' })
    element?.querySelector('[data-sw-compare-handle], [role="tab"]')?.focus?.()
  }
  const menu = [
    actions.onCopyLink
      ? { id: 'link', label: 'Copy link', icon: Link2, run: () => actions.onCopyLink(comment), hook: 'data-sw-copy-link' }
      : null,
    can.edit ? { id: 'edit', label: 'Edit', icon: Pencil, run: () => setEditing(true), hook: 'data-sw-edit' } : null,
    actions.onAskAgent
      ? { id: 'agent', label: 'Ask agent', icon: Bot, run: () => actions.onAskAgent(comment), hook: 'data-sw-ask-agent' }
      : null,
    issueUrl
      ? {
          id: 'issue',
          label: `Open issue #${comment.github.issue.number} on GitHub`,
          icon: CircleDot,
          href: issueUrl,
          hook: 'data-sw-github-open',
        }
      : actions.onGithubIssue && can.resolve
        ? {
            id: 'issue',
            label: 'Create a GitHub issue',
            icon: CircleDot,
            run: () => actions.onGithubIssue(comment),
            hook: 'data-sw-github-issue',
          }
        : null,
    actions.onHistory && page
      ? { id: 'history', label: 'Page history', icon: History, run: () => actions.onHistory(comment), hook: 'data-sw-comment-history' }
      : null,
    page?.url ? { id: 'page', label: 'Open the page', icon: ExternalLink, href: page.url, hook: 'data-sw-open-page' } : null,
  ].filter(Boolean)

  return (
    <div className="flex max-h-[inherit] min-h-0 flex-col" data-sw-selected-comment={comment.id} data-sw-thread={comment.id}>
      <div className={cn('flex shrink-0 items-center gap-0.5 border-b border-line', touch ? 'px-2 py-1' : 'py-1 pr-1 pl-3')}>
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted" data-sw-thread-title="true">
          {onClose ? (
            <>
              <span className="shrink-0 font-semibold text-fg tabular">#{comment.id}</span>
              <span className="min-w-0 truncate text-fg/80">{title}</span>
              {ViewportIcon ? (
                <Tooltip content={`${comment.viewport[0].toUpperCase()}${comment.viewport.slice(1)} capture`}>
                  <span className="inline-flex shrink-0 text-faint" aria-label={`${comment.viewport} capture`} role="img">
                    <ViewportIcon size={12} aria-hidden="true" />
                  </span>
                </Tooltip>
              ) : (
                <span className="shrink-0 text-faint">· {comment.viewport}</span>
              )}
            </>
          ) : nav?.total > 1 ? (
            <span className="tabular">
              {nav.index + 1} of {nav.total}
            </span>
          ) : null}
        </p>
        {nav?.total > 1 ? (
          <>
            <IconButton
              size={size}
              onClick={nav.onPrev}
              label={withNote('Previous thread', nav.prevNote)}
              tooltip={withNote('Previous thread (Left arrow)', nav.prevNote)}
              data-sw-thread-prev="true"
              data-sw-thread-note={nav.prevNote || undefined}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </IconButton>
            <IconButton
              size={size}
              onClick={nav.onNext}
              label={withNote('Next thread', nav.nextNote)}
              tooltip={withNote('Next thread (Right arrow)', nav.nextNote)}
              data-sw-thread-next="true"
              data-sw-thread-note={nav.nextNote || undefined}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </IconButton>
          </>
        ) : null}
        {can.resolve ? (
          <IconButton
            size={size}
            variant={resolved ? 'default' : 'ghost'}
            className={cn('rounded-full', resolved && 'bg-ok text-ok-fg hover:bg-ok/90')}
            disabled={busy}
            aria-pressed={resolved}
            onClick={() => actions.onStatus(comment, resolved ? 'reopen' : 'resolve')}
            label={resolved ? 'Reopen the thread' : 'Resolve the thread'}
            tooltip={resolved ? 'Resolved: reopen' : 'Resolve'}
            {...(resolved ? { 'data-sw-reopen': comment.id } : { 'data-sw-resolve': comment.id })}
          >
            <Check size={16} strokeWidth={2.5} aria-hidden="true" />
          </IconButton>
        ) : resolved ? (
          <span className="mx-1 inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 text-xs leading-6 font-medium text-fg">
            <Check size={12} aria-hidden="true" /> Resolved
          </span>
        ) : null}
        {menu.length || can.delete ? (
          <DropdownMenu>
            <Tooltip content="More">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size={size} aria-label={`More for comment ${comment.id}`} data-sw-thread-menu={comment.id}>
                  <MoreHorizontal size={16} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end">
              {menu.map((item) =>
                item.href ? (
                  <DropdownMenuItem key={item.id} asChild {...{ [item.hook]: comment.id }}>
                    <a href={item.href} target="_blank" rel="noreferrer noopener">
                      <item.icon size={14} aria-hidden="true" /> {item.label}
                    </a>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem key={item.id} onSelect={item.run} {...{ [item.hook]: comment.id }}>
                    <item.icon size={14} aria-hidden="true" /> {item.label}
                  </DropdownMenuItem>
                ),
              )}
              {can.delete ? (
                <>
                  {menu.length ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem tone="danger" onSelect={() => setConfirming(true)} data-sw-delete={comment.id}>
                    <Trash2 size={14} aria-hidden="true" /> Delete thread
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {onClose ? (
          <IconButton size={size} onClick={onClose} label="Close the thread" tooltip="Close (Esc)" data-sw-thread-close="true">
            <X size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>

      {fixable || chips ? (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5" data-sw-thread-agent="true">
          <ReopenedChip comment={comment} />
          {/* While the agent works, Fix with agent says so itself. */}
          {fixable && ['queued', 'working'].includes(agentStatus) ? null : (
            <AgentStatusChip status={agentStatus} at={comment.agentStatusAt} />
          )}
          <span className="min-w-0 flex-1" />
          {fixable ? (
            <FixWithAgent comment={comment} onFix={actions.onFixAgent} onOpenChat={actions.onAskAgent} busy={busy} touch={touch} />
          ) : null}
        </div>
      ) : null}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3">
        {comment.orphanReason ? <p className="pt-2 text-xs text-muted">{comment.orphanReason}</p> : null}
        {comment.imported && comment.agentStatus ? <p className="pt-2 text-xs text-muted">Imported agent status (history)</p> : null}
        {actions.onSendToAgent && comment.status === 'open' ? (
          <div className="py-2">
            <Button
              size={touch ? 'touch' : 'sm'}
              disabled={busy || comment.dispatchable || (comment.needsRunApproval && !['admin', 'owner'].includes(role))}
              onClick={() => actions.onSendToAgent(comment)}
            >
              {comment.dispatchable
                ? 'Sent to agent'
                : comment.needsRunApproval
                  ? ['admin', 'owner'].includes(role)
                    ? 'Approve agent run'
                    : 'Awaiting run approval'
                  : 'Send to agent'}
            </Button>
          </div>
        ) : null}
        <ol className="divide-y divide-line/60" aria-label={`Comment ${comment.id} and replies`}>
          <Message
            author={commentAuthor(comment)}
            at={comment.createdAt}
            editedAt={comment.editedAt}
            reactions={comment.reactions}
            canReact={can.react}
            me={me}
            onReact={(emoji) => actions.onReact(comment, emoji, null)}
            touch={touch}
            data-sw-message="comment"
          >
            {editing ? (
              <EditBox
                comment={comment}
                busy={busy}
                onSave={actions.onEdit}
                onCancel={() => setEditing(false)}
                touch={touch}
                people={people}
              />
            ) : (
              <MentionText
                text={comment.body}
                plain={Boolean(comment.authorGuest)}
                className="block text-ui break-words whitespace-pre-wrap text-fg"
              />
            )}
            <MessageImages boardId={media?.boardId} images={comment.images} touch={touch} label={`Comment ${comment.id}`} />
            <DrawingNote item={comment} currentVersion={currentVersion} onShow={showBefore} />
            {comment.anchor ? (
              <Tooltip content={<span className="font-mono text-[11px] break-all">{comment.anchor.selector}</span>}>
                <p
                  className="mt-1.5 inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
                  data-sw-thread-anchor="true"
                  tabIndex={0}
                >
                  <Crosshair size={11} className="shrink-0" aria-hidden="true" />
                  <span className="shrink-0">Pinned to</span>
                  <span className="truncate text-fg">{anchorLabel(comment.anchor)}</span>
                </p>
              </Tooltip>
            ) : null}
            {page?.note ? (
              <p className="mt-1 flex items-start gap-1 text-xs text-faint" data-sw-page-note="true">
                <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" /> {page.note}
              </p>
            ) : null}
            {comment.resolution ? <p className="mt-1.5 rounded bg-ok/10 px-2 py-1 text-xs text-fg">Fix: {comment.resolution}</p> : null}
            <FixRef value={comment.fixRef} touch={touch} />
            <GithubLinks github={comment.github} touch={touch} />
            {beforeAfter ? (
              <BeforeAfter
                comment={comment}
                pair={beforeAfter.pairFor(comment)}
                native={beforeAfter.nativeFor(comment)}
                urlFor={beforeAfter.urlFor}
                onImageError={beforeAfter.onImageError}
                touch={touch}
              />
            ) : null}
          </Message>
          {(comment.replies || []).length ? (
            <li data-sw-replies="true">
              <ol className="divide-y divide-line/60" aria-label="Replies">
                {comment.replies.map((reply) => (
                  <Message
                    key={reply.id}
                    author={replyAuthor(reply)}
                    at={reply.createdAt}
                    reactions={reply.reactions}
                    canReact={can.react}
                    me={me}
                    onReact={(emoji) => actions.onReact(comment, emoji, reply.id)}
                    touch={touch}
                    data-sw-reply={reply.id}
                  >
                    <MentionText
                      text={reply.body}
                      plain={Boolean(reply.guest)}
                      className="block text-ui break-words whitespace-pre-wrap text-fg"
                    />
                    <MessageImages boardId={media?.boardId} images={reply.images} touch={touch} label={`Reply ${reply.id}`} />
                    <DrawingNote item={reply} currentVersion={currentVersion} onShow={showBefore} />
                  </Message>
                ))}
              </ol>
            </li>
          ) : null}
        </ol>
      </div>

      {confirming ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-bad/10 px-3 py-2 text-xs text-fg" role="alert">
          <span className="min-w-0 flex-1">Delete this thread and its replies for good?</span>
          <Button size={touch ? 'touch' : 'xs'} variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size={touch ? 'touch' : 'xs'}
            variant="secondary"
            className="text-bad"
            onClick={() => actions.onDelete(comment)}
            disabled={busy}
            data-sw-delete-confirm={comment.id}
          >
            <Trash2 size={13} aria-hidden="true" /> Delete
          </Button>
        </div>
      ) : null}
      {can.reply ? (
        <ReplyBox
          key={comment.id}
          comment={comment}
          busy={busy}
          onReply={actions.onReply}
          touch={touch}
          people={people}
          askName={hosted === false}
          onSaveName={onSaveName}
          media={media}
        />
      ) : (
        <p className="shrink-0 border-t border-line px-3 py-2 text-xs text-muted" data-sw-reply-denied={role || 'true'}>
          {denial || replyDenial(role)}
        </p>
      )}
    </div>
  )
}
