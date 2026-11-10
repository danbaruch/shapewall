// The run summary after an agent turn that changed something: the files
// (+/- counts, each opening its diff), the commit or pull request, the
// comments it resolved, "Recapture to verify", and Undo where the server
// can undo it safely (src/agent/turn-changes.js). Undo is for the owner,
// asks first, and the server checks again.

import { useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileMinus,
  FilePen,
  FilePlus,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
  Undo2,
} from 'lucide-react'
import { Badge, Button, Dialog } from '../components/ui'
import { cn } from '../lib/utils'
import { DiffView } from './DiffCards'
import { RefChip, useRefs } from './RefChip'
import { resolveToken } from './refs'

const STATUS = {
  added: { icon: FilePlus, text: 'Added', tone: 'text-ok' },
  deleted: { icon: FileMinus, text: 'Deleted', tone: 'text-bad' },
  modified: { icon: FilePen, text: 'Changed', tone: 'text-muted' },
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function FileRow({ file, touch }) {
  const [open, setOpen] = useState(false)
  const status = STATUS[file.status] || STATUS.modified
  const Icon = status.icon
  const canOpen = Boolean(file.diff)
  const counts =
    file.added !== null && file.added !== undefined ? (
      <span className="shrink-0 font-mono text-caption tabular-nums">
        <span className="text-ok">+{file.added}</span> <span className="text-bad">-{file.removed}</span>
      </span>
    ) : (
      <span className="shrink-0 text-caption text-faint">{file.hidden ? 'diff hidden' : file.binary ? 'binary' : ''}</span>
    )
  const row = (
    <>
      {canOpen ? (
        <ChevronRight
          size={12}
          className={cn('shrink-0 text-faint transition-transform duration-(--motion-fast)', open && 'rotate-90')}
          aria-hidden="true"
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden="true" />
      )}
      <Icon size={12} className={cn('shrink-0', status.tone)} aria-label={status.text} />
      <span className="min-w-0 flex-1 truncate text-left font-mono text-caption text-fg">{file.path}</span>
      {counts}
    </>
  )
  return (
    <li data-sw-chat-summary-file={file.path} data-status={file.status}>
      {canOpen ? (
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-1.5 rounded px-1 text-left hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
            touch ? 'min-h-11' : 'min-h-7',
          )}
          aria-expanded={open}
          aria-label={`${status.text} ${file.path}${file.added !== null ? `, ${file.added} added, ${file.removed} removed` : ''}. ${open ? 'Hide' : 'Show'} the diff`}
          onClick={() => setOpen((value) => !value)}
          data-sw-chat-summary-toggle={file.path}
        >
          {row}
        </button>
      ) : (
        <div className={cn('flex items-center gap-1.5 px-1', touch ? 'min-h-11' : 'min-h-7')}>{row}</div>
      )}
      {open ? (
        // The row above already names the file and its counts: the diff's own header line steps aside.
        <div className="pb-1 pl-5 [&_[data-sw-chat-diff]>p:first-child]:hidden">
          <DiffView diff={file.diff} />
        </div>
      ) : null}
    </li>
  )
}

function UndoDialog({ open, summary, busy, error, onCancel, onConfirm, touch }) {
  const branch = summary.undo?.kind === 'branch'
  const files = summary.files || []
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={branch ? 'Delete the agent’s branch?' : 'Undo the agent’s change?'}
      description={
        branch
          ? `This deletes the branch ${summary.undo.branch} and the agent's commit on it. Your own checkout is not touched.`
          : files.length === 1
            ? 'This puts 1 file back the way it was before this answer. Nothing is undone if it changed since.'
            : `This puts ${plural(files.length, 'file')} back the way they were before this answer. Nothing is undone if any of them changed since.`
      }
      wrapDescription
      footer={
        <>
          <Button size={touch ? 'touch' : 'md'} variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size={touch ? 'touch' : 'md'} variant="danger" onClick={onConfirm} disabled={busy} data-sw-chat-undo-confirm="true">
            <Undo2 size={14} aria-hidden="true" /> {busy ? 'Undoing…' : branch ? 'Delete branch' : 'Undo change'}
          </Button>
        </>
      }
    >
      <div className="space-y-2 px-4 pb-1">
        {!branch && files.length ? (
          <ul className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-caption text-muted">
            {files.map((file) => (
              <li key={file.path} className="truncate">
                {file.status === 'added' ? 'remove ' : file.status === 'deleted' ? 'restore ' : 'revert '}
                {file.path}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-ui text-bad" data-sw-chat-undo-error="true">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

export default function RunSummary({ message, owner = false, touch = false, onUndo = null, onRecapture = null }) {
  const summary = message.summary
  const refs = useRefs()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [recaptured, setRecaptured] = useState(false)
  if (!summary) return null
  const files = summary.files || []
  const undone = summary.undone
  const canUndo = Boolean(owner && onUndo && summary.undo?.available && !undone)
  const resolved = (summary.resolved || []).map((id) => resolveToken(refs?.index, 'comment', id) || { id, plain: true })
  const commit = summary.commit
  const short = commit?.sha ? commit.sha.slice(0, 7) : null
  const head =
    files.length || summary.more
      ? `Changed ${plural(files.length + (summary.more || 0), 'file')}`
      : commit
        ? 'Made a commit'
        : resolved.length
          ? `Resolved ${plural(resolved.length, 'comment')}`
          : 'Done'
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onUndo(message.id)
      setConfirming(false)
    } catch (failure) {
      setError(failure.message || 'The change was not undone.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className={cn('overflow-hidden rounded-lg border bg-surface text-ui', undone ? 'border-line opacity-90' : 'border-line shadow-card')}
      aria-label="What this answer changed"
      data-sw-chat-summary={summary.kind || 'files'}
      data-undone={undone ? 'true' : undefined}
    >
      <header className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-2.5 py-1.5">
        <CheckCircle2 size={13} className={cn('shrink-0', undone ? 'text-faint' : 'text-ok')} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{head}</span>
        {summary.added || summary.removed ? (
          <span
            className="shrink-0 font-mono text-caption tabular-nums"
            aria-label={`${summary.added} lines added, ${summary.removed} removed`}
          >
            <span className="text-ok">+{summary.added}</span> <span className="text-bad">-{summary.removed}</span>
          </span>
        ) : null}
        {undone ? (
          <Badge tone="neutral" data-sw-chat-summary-undone="true">
            Undone
          </Badge>
        ) : null}
      </header>
      {files.length ? (
        <ul className="px-1.5 py-1" aria-label="Changed files">
          {files.map((file) => (
            <FileRow key={file.path} file={file} touch={touch} />
          ))}
          {summary.more ? <li className="px-1 py-1 text-caption text-muted">and {plural(summary.more, 'more file')}</li> : null}
        </ul>
      ) : null}
      {commit || summary.pr || resolved.length ? (
        <div className="space-y-1 border-t border-line px-2.5 py-1.5 text-caption text-muted">
          {commit ? (
            <p className="flex min-w-0 items-center gap-1.5" data-sw-chat-summary-commit={short}>
              {commit.branch ? (
                <GitBranch size={12} className="shrink-0" aria-hidden="true" />
              ) : (
                <GitCommitHorizontal size={12} className="shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 truncate">
                {commit.branch ? (
                  <>
                    Branch <span className="font-mono text-fg">{commit.branch}</span>,{' '}
                  </>
                ) : null}
                commit <span className="font-mono text-fg">{short}</span>
                {commit.commits?.[0]?.subject ? <> · {commit.commits[0].subject}</> : null}
              </span>
            </p>
          ) : null}
          {summary.pr?.url ? (
            <p className="flex items-center gap-1.5">
              <GitPullRequest size={12} className="shrink-0" aria-hidden="true" />
              <a
                href={summary.pr.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-w-0 items-center gap-1 text-accent underline underline-offset-2"
                data-sw-chat-summary-pr="true"
              >
                <span className="truncate">Pull request {summary.pr.url.split('/').pop()}</span>
                <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
              </a>
            </p>
          ) : null}
          {resolved.length ? (
            <p className="flex flex-wrap items-center gap-1" data-sw-chat-summary-resolved={resolved.length}>
              <span>Resolved</span>
              {resolved.map((ref) => (ref.plain ? <span key={ref.id}>#{ref.id}</span> : <RefChip key={ref.id} item={ref} />))}
            </p>
          ) : null}
        </div>
      ) : null}
      {(onRecapture && files.length && !undone) || canUndo || (owner && summary.undo && !summary.undo.available && !undone) || undone ? (
        <footer className="space-y-1 border-t border-line px-2.5 py-1.5">
          {(onRecapture && files.length && !undone) || canUndo ? (
            <div className={cn('gap-1.5', touch ? 'grid grid-cols-2' : 'flex flex-wrap')}>
              {onRecapture && files.length && !undone ? (
                <Button
                  size={touch ? 'touch' : 'sm'}
                  variant="secondary"
                  className={cn(touch && !canUndo && 'col-span-2')}
                  onClick={() => {
                    onRecapture(summary.recapture?.length ? summary.recapture : null)
                    setRecaptured(true)
                  }}
                  data-sw-chat-summary-recapture={summary.recapture?.join(',') || 'board'}
                >
                  <RefreshCw size={13} aria-hidden="true" /> {recaptured ? 'Recapture again' : 'Recapture to verify'}
                </Button>
              ) : null}
              {canUndo ? (
                <Button
                  size={touch ? 'touch' : 'sm'}
                  variant="ghost"
                  className={cn('text-muted', touch && !(onRecapture && files.length) && 'col-span-2')}
                  onClick={() => {
                    setError(null)
                    setConfirming(true)
                  }}
                  data-sw-chat-undo={message.id}
                >
                  <Undo2 size={13} aria-hidden="true" /> Undo
                </Button>
              ) : null}
            </div>
          ) : null}
          {owner && summary.undo && !summary.undo.available && !undone && summary.undo.reason ? (
            <p className="text-caption text-muted" data-sw-chat-undo-unavailable="true">
              No Undo here: {summary.undo.reason}.
            </p>
          ) : null}
          {undone ? (
            <p className="text-caption text-muted">
              {undone.kind === 'branch'
                ? `Deleted the branch ${undone.branch}.`
                : `Put ${plural(undone.files || files.length, 'file')} back.`}
            </p>
          ) : null}
        </footer>
      ) : null}
      {canUndo || confirming ? (
        <UndoDialog
          open={confirming}
          summary={summary}
          busy={busy}
          error={error}
          touch={touch}
          onCancel={() => setConfirming(false)}
          onConfirm={confirm}
        />
      ) : null}
    </section>
  )
}
