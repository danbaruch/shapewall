// Chat history: this person's conversations on the board (private New chats,
// the shared board thread, comment threads with their comment's badge),
// grouped Today / Yesterday / Earlier, with search, rename, archive, export
// and delete. A drawer over the chat panel on desktop, a sheet on a phone.
// The server decides who sees what (src/agent/threads.js visibleTo).

import { useEffect, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Search,
  SquarePen,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Spinner,
} from '../components/ui'
import { api } from '../lib/api'
import { cn, formatRelative, shownTime } from '../lib/utils'
import { fallbackTitle, groupThreads, markdownFileName, threadKind, threadMarkdown } from './threads'
import { previewText, readableText } from './refs'
// A chat name's limit, as the server keeps it.
import { TITLE_MAX as NAME_MAX } from '../../../src/agent/thread-history.js'

const enc = encodeURIComponent
export const threadsUrl = (boardId, query = '') => `/api/agent/boards/${enc(boardId)}/threads${query ? `?q=${enc(query)}` : ''}`
const threadUrl = (boardId, threadId) => `/api/agent/boards/${enc(boardId)}/threads/${enc(threadId)}`

export const renameThread = (boardId, threadId, title) => api.patch(threadUrl(boardId, threadId), { title })
export const archiveThread = (boardId, threadId, archived) => api.patch(threadUrl(boardId, threadId), { archived })
export const deleteThread = (boardId, threadId) => api.delete(threadUrl(boardId, threadId))
export const restoreVersion = (boardId, threadId, versionId) => api.post(`${threadUrl(boardId, threadId)}/versions/${enc(versionId)}`, {})

// Copy as Markdown / Download .md for one thread (the stored messages), with
// reference tokens as words (refs.js readableText; `refIndex`: the board's).
export async function exportThread({ boardId, threadId, title, comment, how, messages = null, refIndex = null }) {
  const stored = messages || (await api.get(threadUrl(boardId, threadId)))?.messages || []
  const list = stored.map((message) => (message.text ? { ...message, text: readableText(message.text, refIndex) } : message))
  const text = threadMarkdown({ title, threadId, messages: list, comment })
  if (how === 'copy') {
    await navigator.clipboard.writeText(text)
    return 'Copied as Markdown.'
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = markdownFileName(title || fallbackTitle(threadId, comment))
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'Downloaded.'
}

function useSearch(boardId, query) {
  const [state, setState] = useState({ query: '', threads: null, loading: false, error: null })
  useEffect(() => {
    const value = query.trim()
    if (!value) {
      setState({ query: '', threads: null, loading: false, error: null })
      return undefined
    }
    let live = true
    setState((current) => ({ ...current, loading: true }))
    const timer = setTimeout(async () => {
      try {
        const data = await api.get(threadsUrl(boardId, value))
        if (live) setState({ query: value, threads: data?.threads || [], loading: false, error: null })
      } catch (error) {
        if (live) setState({ query: value, threads: [], loading: false, error })
      }
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [boardId, query])
  return state
}

function ThreadRow({ thread, current, comment, touch, busy, onSelect, onRename, onArchive, onExport, onDelete }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const title = thread.title || fallbackTitle(thread.id, comment)
  const kind = threadKind(thread.id)
  const save = async () => {
    if (await onRename(thread, name)) setRenaming(false)
  }
  if (renaming) {
    return (
      <li className="flex items-center gap-1.5 px-2 py-1.5" data-sw-chat-history-item={thread.id} data-sw-renaming="true">
        <Input
          size={touch ? 'touch' : 'sm'}
          value={name}
          maxLength={NAME_MAX}
          autoFocus
          aria-label="Chat name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              save()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setRenaming(false)
            }
          }}
          data-sw-chat-rename-input="true"
        />
        {/* The limit shows as it nears, so a long name is not cut off unseen. */}
        {name.length >= NAME_MAX - 20 ? (
          <span
            className={cn('shrink-0 text-caption tabular-nums', name.length >= NAME_MAX ? 'text-warn' : 'text-faint')}
            aria-live="polite"
            data-sw-chat-rename-count={name.length}
          >
            {name.length}/{NAME_MAX}
          </span>
        ) : null}
        <Button size={touch ? 'touch' : 'sm'} onClick={save} disabled={busy} data-sw-chat-rename-save="true">
          Save
        </Button>
        <IconButton size={touch ? 'icon' : 'icon-sm'} label="Cancel rename" onClick={() => setRenaming(false)}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </li>
    )
  }
  return (
    <li
      className={cn('group relative flex items-center rounded-md', current ? 'bg-accent/10' : 'hover:bg-surface-2')}
      data-sw-chat-history-item={thread.id}
      data-sw-chat-history-kind={kind}
      data-current={current ? 'true' : undefined}
    >
      <button
        type="button"
        className={cn(
          'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent',
          touch ? 'min-h-14 py-2' : 'min-h-11 py-1.5',
        )}
        aria-current={current ? 'true' : undefined}
        onClick={() => onSelect(thread.id)}
        data-sw-chat-history-open-thread={thread.id}
      >
        <span className={cn('w-full truncate text-ui', current ? 'font-semibold text-fg' : 'font-medium text-fg')}>{title}</span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-caption text-muted">
          {kind === 'comment' ? (
            <Badge tone="accent" className="shrink-0 tabular-nums" data-sw-chat-history-comment={thread.commentId}>
              #{thread.commentId}
            </Badge>
          ) : null}
          {kind === 'board' ? (
            <span className="inline-flex shrink-0 items-center gap-1" data-sw-chat-history-shared="true">
              <Users size={11} aria-hidden="true" /> Shared ·
            </span>
          ) : null}
          <span className="truncate tabular-nums">
            {formatRelative(thread.updatedAt)} · {thread.count} {thread.count === 1 ? 'message' : 'messages'}
          </span>
        </span>
        {thread.match ? (
          <span className="line-clamp-2 w-full text-caption text-faint" data-sw-chat-history-match="true">
            {previewText(thread.match.text)}
          </span>
        ) : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size={touch ? 'icon' : 'icon-sm'}
            className={cn(
              'mr-1 shrink-0',
              !touch && !current && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            )}
            aria-label={`Actions for ${title}`}
            data-sw-chat-history-menu={thread.id}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setName(thread.title || '')
              setRenaming(true)
            }}
            data-sw-chat-history-action="rename"
          >
            <Pencil size={14} aria-hidden="true" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onArchive(thread, !thread.archived)} data-sw-chat-history-action="archive">
            {thread.archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
            {thread.archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onExport(thread, 'copy')} data-sw-chat-history-action="copy">
            <Copy size={14} aria-hidden="true" /> Copy as Markdown
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onExport(thread, 'download')} data-sw-chat-history-action="download">
            <Download size={14} aria-hidden="true" /> Download .md
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger" onSelect={() => onDelete(thread)} data-sw-chat-history-action="delete">
            <Trash2 size={14} aria-hidden="true" /> {kind === 'chat' ? 'Delete' : 'Clear chat'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

function HistoryBody({
  boardId,
  threads,
  loading,
  currentId,
  comments,
  refIndex = null,
  touch,
  onSelect,
  onNew,
  onChanged,
  onRemoved,
  autoFocus,
}) {
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const search = useSearch(boardId, query)
  const commentOf = (thread) => (thread.commentId ? comments.find((item) => item.id === thread.commentId) || null : null)
  const searching = Boolean(query.trim())
  const list = searching ? search.threads || [] : threads || []
  const active = list.filter((thread) => !thread.archived)
  const archived = list.filter((thread) => thread.archived)
  const groups = groupThreads(active, { timeOf: shownTime })

  const act = async (work, done) => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await work()
      await onChanged()
      if (done) setNotice({ tone: 'ok', text: done })
      return result ?? true
    } catch (error) {
      setNotice({ tone: 'bad', text: error.message })
      return false
    } finally {
      setBusy(false)
    }
  }
  const rowProps = {
    touch,
    busy,
    onSelect,
    onRename: (thread, title) => act(() => renameThread(boardId, thread.id, title)),
    onArchive: (thread, value) => act(() => archiveThread(boardId, thread.id, value), value ? 'Archived.' : 'Moved back to your chats.'),
    onExport: async (thread, how) => {
      setNotice(null)
      try {
        const text = await exportThread({ boardId, threadId: thread.id, title: thread.title, comment: commentOf(thread), how, refIndex })
        setNotice({ tone: 'ok', text })
      } catch (error) {
        setNotice({ tone: 'bad', text: error.message || 'Could not export this chat.' })
      }
    },
    onDelete: (thread) => setConfirm(thread),
  }
  const row = (thread) => (
    <ThreadRow key={thread.id} thread={thread} current={thread.id === currentId} comment={commentOf(thread)} {...rowProps} />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-sw-chat-history="true">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <Input
          icon={Search}
          size={touch ? 'touch' : 'sm'}
          wrapperClassName="min-w-0 flex-1"
          type="search"
          placeholder="Search your chats"
          aria-label="Search your chats"
          value={query}
          maxLength={200}
          autoFocus={autoFocus}
          onChange={(event) => setQuery(event.target.value)}
          data-sw-chat-history-search="true"
        />
        <Button size={touch ? 'touch' : 'sm'} variant="secondary" onClick={onNew} data-sw-chat-new="history">
          <SquarePen size={14} aria-hidden="true" /> New chat
        </Button>
      </div>
      {notice ? (
        <p
          className={cn('mx-3 mb-1 rounded-md px-2 py-1 text-caption', notice.tone === 'bad' ? 'bg-bad/10 text-bad' : 'bg-ok/10 text-fg')}
          role={notice.tone === 'bad' ? 'alert' : 'status'}
          data-sw-chat-history-notice={notice.tone}
        >
          {notice.text}
        </p>
      ) : null}
      {/* On a phone the sheet focuses the list, not the search field, so the keyboard stays down. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 outline-none" tabIndex={-1} {...(touch ? { 'data-autofocus': true } : {})}>
        {(loading && !threads) || (searching && search.loading && !search.threads) ? (
          <p className="flex items-center gap-2 px-2 py-3 text-ui text-muted" role="status">
            <Spinner size={12} /> {searching ? 'Searching' : 'Loading your chats'}
          </p>
        ) : null}
        {!loading && !active.length && !archived.length && !(searching && search.loading) ? (
          <div
            className="flex flex-col items-center gap-2 px-4 py-8 text-center"
            data-sw-chat-history-empty={searching ? 'search' : 'none'}
          >
            <MessageSquare size={20} className="text-faint" aria-hidden="true" />
            <p className="text-ui text-muted">
              {searching ? `No chats match "${query.trim()}".` : 'No chats yet. Ask the agent something to start one.'}
            </p>
          </div>
        ) : null}
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={`sw-history-${group.id}`} data-sw-chat-history-group={group.id}>
            <h3 id={`sw-history-${group.id}`} className="px-2.5 pt-3 pb-1 text-caption font-medium text-faint">
              {group.label}
            </h3>
            <ul className="space-y-0.5">{group.items.map(row)}</ul>
          </section>
        ))}
        {archived.length ? (
          <section className="mt-2 border-t border-line pt-1" data-sw-chat-history-group="archived">
            <Button
              variant="ghost"
              size={touch ? 'touch' : 'sm'}
              className="w-full justify-start text-muted"
              aria-expanded={showArchived || searching}
              onClick={() => setShowArchived((value) => !value)}
              data-sw-chat-history-archived-toggle="true"
            >
              <Archive size={13} aria-hidden="true" /> Archived ({archived.length})
            </Button>
            {showArchived || searching ? <ul className="space-y-0.5">{archived.map(row)}</ul> : null}
          </section>
        ) : null}
      </div>
      <Dialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={confirm && threadKind(confirm.id) === 'chat' ? 'Delete this chat?' : 'Clear this chat?'}
        footer={
          <>
            <Button variant="secondary" size={touch ? 'touch' : 'sm'} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size={touch ? 'touch' : 'sm'}
              disabled={busy}
              data-sw-chat-history-confirm-delete="true"
              onClick={async () => {
                const thread = confirm
                const ok = await act(
                  () => deleteThread(boardId, thread.id),
                  threadKind(thread.id) === 'chat' ? 'Chat deleted.' : 'Thread cleared.',
                )
                if (ok) {
                  setConfirm(null)
                  onRemoved(thread.id)
                }
              }}
            >
              {confirm && threadKind(confirm.id) === 'chat' ? 'Delete' : 'Clear'}
            </Button>
          </>
        }
      >
        <p className="px-5 py-4 text-sm text-muted">
          {confirm && threadKind(confirm.id) === 'chat'
            ? `"${confirm.title || 'This chat'}" and its earlier versions are removed for good. Download it first to keep a copy.`
            : 'Everyone who can chat on this board shares this chat. Clearing removes its messages for all of them, and the agent forgets it.'}
        </p>
      </Dialog>
    </div>
  )
}

// `open`, `onClose`; the rest goes to the list. Escape closes the drawer.
export function ChatHistory({ open, onClose, touch, ...props }) {
  const drawerOpen = open && !touch
  // Escape closes the drawer wherever the focus is (a row it held may have
  // moved), unless a menu or another dialog above it takes the key.
  useEffect(() => {
    if (!drawerOpen) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const above = [...document.querySelectorAll('[role="dialog"]')].some((node) => !node.hasAttribute('data-sw-chat-history-drawer'))
      if (above || document.querySelector('[role="menu"]') || event.target.closest?.('[data-sw-renaming]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen, onClose])
  if (touch) {
    return (
      <Dialog open={open} onClose={onClose} title="Your chats" size="md">
        <div className="flex h-[70dvh] min-h-0 flex-col">{open ? <HistoryBody touch {...props} /> : null}</div>
      </Dialog>
    )
  }
  if (!open) return null
  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-in flex-col bg-surface"
      role="dialog"
      aria-modal="false"
      aria-label="Your chats"
      data-sw-chat-history-drawer="true"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="flex-1 text-title font-semibold text-fg">Your chats</h2>
        <IconButton label="Close chat history" onClick={onClose} data-sw-chat-history-close="true">
          <X size={15} aria-hidden="true" />
        </IconButton>
      </div>
      <HistoryBody touch={false} autoFocus {...props} />
    </div>
  )
}
