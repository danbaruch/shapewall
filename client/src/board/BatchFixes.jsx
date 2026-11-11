// Batch fixes (src/agent/batch-fixes.js): fix several open comments in one
// go, one after another, each an ordinary Fix with agent. Off by default
// (Agents > Fix several comments at once); when off nothing here renders.
//
// useBatchFixes: the board's setting and batch from the server (GET
// /api/agent/boards/:id/batch), followed by the "batch" event on the agent
// events stream (lib/agentEvents.js) and a slow poll while one runs; the
// selection in the comments panel's Select mode.
// BatchProgress: "Fixing 2 of 5" with each comment's state, a link to its
// thread, Cancel and the summary; the comments panel shows it as a sticky
// strip, the agent panel as a card. It survives a reload: the state is the
// server's.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, CircleSlash, Clock, Layers, Loader2, ShieldQuestion, Sparkles, X } from 'lucide-react'
import { Badge, Button, Dialog } from '../components/ui'
import { api } from '../lib/api'
import { useAgentsChanged, useBatchChanged } from '../lib/agentEvents'
import { cn } from '../lib/utils'
import { answerPermission } from '../chat/stream'
import { DiffView } from '../chat/DiffCards'

const enc = encodeURIComponent
const batchPath = (boardId) => `api/agent/boards/${enc(boardId)}/batch`
const RUNNING = new Set(['running', 'waiting'])
export const batchRunning = (batch) => Boolean(batch && RUNNING.has(batch.state))

// A comment a batch may take: open, and not with an agent already.
export const batchable = (comment) =>
  comment.status === 'open' && !['queued', 'working', 'branch-ready'].includes(comment.agentStatus) && !comment.authorGuest

export function useBatchFixes({ boardId, enabled, onProgress = null }) {
  const [data, setData] = useState(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const progress = useRef(onProgress)
  progress.current = onProgress
  const lastSeen = useRef(null)
  const load = useCallback(async () => {
    if (!enabled) return
    try {
      const next = await api.get(batchPath(boardId))
      setData(next)
      // The comments' statuses moved with the batch: the board refetches them.
      const stamp = next?.batch?.updatedAt || null
      if (stamp !== lastSeen.current) {
        lastSeen.current = stamp
        if (next?.batch) progress.current?.()
      }
    } catch {
      setData(null)
    }
  }, [boardId, enabled])
  useEffect(() => {
    load()
  }, [load])
  useBatchChanged(boardId, load, enabled)
  useAgentsChanged(load, enabled)
  const running = batchRunning(data?.batch)
  // Nothing polls otherwise: only while a batch runs, in case the events
  // stream is not there (a page opened without the owner link reconnecting).
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [running, load])
  const settings = data?.settings || null
  const offered = Boolean(enabled && settings?.enabled)
  useEffect(() => {
    if (!offered) {
      setSelecting(false)
      setSelected([])
    }
  }, [offered])
  const max = settings?.max || 5
  const toggle = (id) => setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  const start = async (ids) => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.post(batchPath(boardId), { commentIds: ids })
      setData((current) => ({ ...(current || {}), batch: next.batch }))
      setSelecting(false)
      setSelected([])
      progress.current?.()
      return true
    } catch (failure) {
      setError(failure.message || 'The batch did not start.')
      return false
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    setError(null)
    try {
      const next = await api.post(`${batchPath(boardId)}/cancel`, {})
      setData((current) => ({ ...(current || {}), batch: next.batch }))
    } catch (failure) {
      setError(failure.message || 'Not cancelled.')
      load()
    }
  }
  const dismiss = async () => {
    try {
      await api.delete(batchPath(boardId))
      setData((current) => ({ ...(current || {}), batch: null }))
    } catch {
      load()
    }
  }
  return {
    offered,
    max,
    batch: enabled ? data?.batch || null : null,
    running,
    selecting,
    setSelecting: (value) => {
      setSelecting(value)
      if (!value) setSelected([])
    },
    selected,
    setSelected,
    toggle,
    start,
    cancel,
    dismiss,
    error,
    setError,
    busy,
    refresh: load,
  }
}

// A checkbox in the kit's look (the board has no native checkboxes): a
// 44 px target on touch.
export function SelectBox({ checked, onChange, label, disabled = false, touch = false, ...props }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40',
        touch ? 'size-11' : 'size-7',
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-4.5 items-center justify-center rounded border transition-colors',
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface',
        )}
      >
        {checked ? <Check size={12} strokeWidth={3} /> : null}
      </span>
    </button>
  )
}

const firstLine = (text) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || 'No text'

// Starting a batch: the comments it takes, and the cap when more were chosen.
export function BatchConfirm({ open, onClose, ids, comments, max, agentName, targetTitle, onStart, busy, error, touch }) {
  const byId = useMemo(() => new Map(comments.map((comment) => [comment.id, comment])), [comments])
  const taken = ids.slice(0, max)
  const over = ids.length - taken.length
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Fix ${taken.length} ${taken.length === 1 ? 'comment' : 'comments'} with ${agentName}`}
      description="One at a time, in this order. Each is a normal fix you can review and undo."
      wrapDescription
      size="md"
      footer={
        <>
          <Button variant="secondary" size={touch ? 'touch' : 'sm'} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size={touch ? 'touch' : 'sm'}
            disabled={busy || !taken.length}
            onClick={() => onStart(ids)}
            data-sw-batch-start="true"
          >
            {busy ? (
              <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles size={14} aria-hidden="true" />
            )}{' '}
            Start
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-sw-batch-confirm={taken.length}>
        {over > 0 ? (
          <p
            className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
            role="note"
            data-sw-batch-over={over}
          >
            <AlertTriangle size={14} className="mt-px shrink-0 text-warn" aria-hidden="true" />
            <span>
              You chose {ids.length}. Only the first {max} will run; the batch limit is set in Agents.
            </span>
          </p>
        ) : null}
        <ol className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {taken.map((id, index) => {
            const comment = byId.get(id)
            return (
              <li key={id} className="flex min-w-0 items-start gap-2.5 px-3 py-2 text-ui" data-sw-batch-confirm-item={id}>
                <span className="w-5 shrink-0 text-right text-xs text-faint tabular-nums">{index + 1}.</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg" data-sw-batch-confirm-title={id}>
                    <span className="text-muted tabular-nums">#{id}</span> {firstLine(comment?.body)}
                  </span>
                  <span className="block truncate text-xs text-muted">{comment ? targetTitle(comment.pageId) : 'comment'}</span>
                </span>
              </li>
            )
          })}
        </ol>
        {error ? (
          <p className="text-xs text-bad" role="alert" data-sw-batch-error="true">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

const ITEM_STATES = {
  waiting: { label: 'Waiting', tone: 'neutral', icon: Clock },
  running: { label: 'Running', tone: 'accent', icon: Loader2 },
  fixed: { label: 'Fixed', tone: 'ok', icon: Check },
  failed: { label: 'Failed', tone: 'bad', icon: AlertTriangle },
  skipped: { label: 'Skipped', tone: 'neutral', icon: CircleSlash },
}

// One line for where the batch is.
export function batchHeadline(batch) {
  const total = batch.items.length
  const done = batch.items.filter((item) => !['waiting', 'running'].includes(item.state)).length
  if (batch.state === 'waiting') return `Waiting for your OK on #${batch.waiting?.commentId}`
  if (batch.state === 'running') return `Fixing ${Math.min(done + 1, total)} of ${total}`
  const { fixed = 0, failed = 0, skipped = 0 } = batch.counts || {}
  const parts = [`${fixed} fixed`, failed ? `${failed} failed` : null, skipped ? `${skipped} skipped` : null].filter(Boolean).join(', ')
  if (batch.state === 'cancelled') return `Cancelled: ${parts}`
  if (batch.state === 'stopped')
    return batch.stopReason === 'failures' ? `Stopped after 2 failures in a row: ${parts}` : `Stopped: ${parts}`
  return `Done: ${parts}`
}

// `compact`: the comments panel's strip (the list folds away behind a button).
// `comments`: the board's comments, for each row's first line.
export function BatchProgress({
  batch,
  boardId,
  comments = [],
  onOpenThread,
  onCancel,
  onDismiss,
  touch = false,
  compact = false,
  className,
}) {
  const [open, setOpen] = useState(!compact)
  const bodies = useMemo(() => new Map((comments || []).map((comment) => [comment.id, comment.body])), [comments])
  const [answering, setAnswering] = useState(null)
  const [failed, setFailed] = useState(null)
  if (!batch) return null
  const running = batchRunning(batch)
  const size = touch ? 'touch' : 'xs'
  const total = batch.items.length
  const finished = batch.items.filter((item) => !['waiting', 'running'].includes(item.state)).length
  const answer = async (optionId) => {
    if (!batch.waiting) return
    setAnswering(optionId ?? 'deny')
    setFailed(null)
    try {
      await answerPermission(boardId, batch.waiting.threadId, batch.waiting.card.id, optionId)
    } catch (error) {
      setFailed(error.message)
    } finally {
      setAnswering(null)
    }
  }
  const options = (batch.waiting?.card?.options || []).filter((option) => option && option.optionId)
  return (
    <section
      className={cn('space-y-2', className)}
      aria-label="Batch of fixes"
      data-sw-batch={batch.state}
      data-sw-batch-compact={compact ? 'true' : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        {running ? (
          batch.state === 'waiting' ? (
            <ShieldQuestion size={15} className="shrink-0 text-warn" aria-hidden="true" />
          ) : (
            <Loader2 size={15} className="shrink-0 text-accent motion-safe:animate-spin" aria-hidden="true" />
          )
        ) : (
          <Layers size={15} className="shrink-0 text-muted" aria-hidden="true" />
        )}
        <p className="min-w-0 flex-1 truncate text-ui font-semibold text-fg" role="status" data-sw-batch-headline="true">
          {batchHeadline(batch)}
        </p>
        {compact ? (
          <Button
            variant="ghost"
            size={size}
            className="text-fg"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            data-sw-batch-toggle="true"
          >
            {open ? 'Hide' : 'Show'}
          </Button>
        ) : null}
        {running ? (
          <Button variant="secondary" size={size} onClick={onCancel} disabled={batch.cancelling} data-sw-batch-cancel="true">
            Cancel
          </Button>
        ) : onDismiss ? (
          <Button
            variant="ghost"
            size={touch ? 'icon' : 'icon-xs'}
            onClick={onDismiss}
            aria-label="Close the summary"
            data-sw-batch-dismiss="true"
          >
            <X size={14} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label="Fixes finished"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={finished}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-(--motion-base)"
          style={{ width: `${(finished / Math.max(1, total)) * 100}%` }}
        />
      </div>
      {batch.state === 'waiting' && batch.waiting ? (
        <div
          className="space-y-1.5 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2"
          data-sw-batch-waiting={batch.waiting.commentId}
        >
          <p className="text-xs text-fg">
            The agent asks before it goes on: <span className="font-medium">{batch.waiting.card.label || 'an action'}</span>. The batch
            waits for your answer.
          </p>
          {batch.waiting.card.detail ? (
            <pre
              className="max-h-32 overflow-auto rounded bg-surface px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-fg"
              data-sw-batch-waiting-detail="true"
            >
              {batch.waiting.card.detail}
            </pre>
          ) : null}
          {batch.waiting.card.diff ? <DiffView diff={batch.waiting.card.diff} /> : null}
          <div className="flex flex-wrap gap-1.5">
            {options.map((option) => (
              <Button
                key={option.optionId}
                size={size}
                variant={/reject|deny/i.test(option.kind || '') ? 'secondary' : 'default'}
                disabled={Boolean(answering)}
                onClick={() => answer(option.optionId)}
                data-sw-batch-answer={option.optionId}
              >
                {option.name || option.optionId}
              </Button>
            ))}
            {!options.length ? (
              <Button size={size} variant="secondary" onClick={() => onOpenThread?.(batch.waiting.commentId)}>
                Review in the chat
              </Button>
            ) : null}
          </div>
          {failed ? (
            <p className="text-xs text-bad" role="alert">
              {failed}
            </p>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <ol className="divide-y divide-line rounded-md border border-line bg-surface" data-sw-batch-items={total}>
          {batch.items.map((item) => {
            const info = ITEM_STATES[item.state] || ITEM_STATES.waiting
            const Icon = info.icon
            return (
              <li
                key={item.commentId}
                className="flex min-w-0 items-center gap-2 px-2 py-1"
                data-sw-batch-item={item.commentId}
                data-sw-batch-item-state={item.state}
              >
                <Button
                  variant="link"
                  size={size}
                  className="shrink-0 px-1 shadow-none tabular-nums"
                  onClick={() => onOpenThread?.(item.commentId)}
                  aria-label={`Open comment #${item.commentId}`}
                  data-sw-batch-open={item.commentId}
                >
                  #{item.commentId}
                </Button>
                <span className="min-w-0 flex-1 truncate text-xs" data-sw-batch-item-title={item.commentId}>
                  {bodies.has(item.commentId) ? <span className="text-fg">{firstLine(bodies.get(item.commentId))}</span> : null}
                  {item.message ? (
                    <span className="text-muted">
                      {bodies.has(item.commentId) ? ' · ' : ''}
                      {item.message}
                    </span>
                  ) : null}
                </span>
                <Badge tone={info.tone} className="shrink-0">
                  <Icon size={10} className={item.state === 'running' ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />{' '}
                  {info.label}
                </Badge>
              </li>
            )
          })}
        </ol>
      ) : null}
      {!running && batch.requested > total ? (
        <p className="text-xs text-muted">
          {batch.requested - total} more {batch.requested - total === 1 ? 'was' : 'were'} chosen but not run (the limit is {batch.max}).
        </p>
      ) : null}
    </section>
  )
}
