// B-20: the comments a migration brought in from a 1.x board wait for the
// owner's OK before agents get them (1.x never recorded who wrote a
// comment). A banner says how many; "Review and send" lists each one in full,
// and "Send to agents" sends exactly those, each with the hash of the text
// shown (one changed meanwhile stays waiting). Admins only; nobody else sees it.
// Board.jsx loads this file lazily, for admins only: the main bundle has no room to spare.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Inbox } from 'lucide-react'
import { api } from '../lib/api'
import { Button, Dialog, Spinner } from '../components/ui'
import { errorMessage } from '../console/lib/webauthn'
import { confirmHostedPasskey, plain } from './HostedApprovals'
import { sendWithStepUp } from './stepUp'

const BATCH_SIZE = 500

function useImportedOk({ boardId, enabled, refreshKey = 0 }) {
  const [comments, setComments] = useState([])
  const ticketRef = useRef(0)
  const mountedRef = useRef(true)
  const hasCommentsRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      ticketRef.current += 1
    }
  }, [])
  useEffect(() => {
    hasCommentsRef.current = comments.length > 0
  }, [comments.length])
  const url = `/api/boards/${encodeURIComponent(boardId)}/waiting-ok`
  const load = useCallback(async () => {
    const mine = ++ticketRef.current
    if (!enabled) {
      if (mountedRef.current) setComments([])
      return { ok: true, comments: [] }
    }
    try {
      const result = await api.get(url)
      const next = Array.isArray(result?.comments) ? result.comments : []
      if (!mountedRef.current || mine !== ticketRef.current) return { ok: true, stale: true, comments: next }
      setComments(next)
      return { ok: true, comments: next }
    } catch (error) {
      if (!mountedRef.current || mine !== ticketRef.current) return { ok: false, stale: true, error }
      // Keep prior comments if we already had any so an open modal and partial-send warnings are never wiped.
      if (!hasCommentsRef.current) setComments([])
      return { ok: false, error }
    }
  }, [enabled, url])
  useEffect(() => {
    load()
  }, [load, refreshKey])
  return { comments, reload: load }
}

export const waitingOkText = (count) =>
  `${count} comment${count === 1 ? '' : 's'} from 1.x wait${count === 1 ? 's' : ''} for your OK before agents get ${count === 1 ? 'it' : 'them'}`

export default function ImportedOk({ boardId, onSent, wide = true, titleOf = null, refreshKey = 0, onVisibleChange = null }) {
  const { comments, reload } = useImportedOk({ boardId, enabled: true, refreshKey })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null) // { tone: 'bad' | 'warn', text: string, retry?: boolean }
  const [unchecked, setUnchecked] = useState(() => new Set())
  useEffect(() => {
    onVisibleChange?.(comments.length > 0)
    return () => onVisibleChange?.(false)
  }, [comments.length, onVisibleChange])
  if (!comments.length) return null
  const selected = comments.filter((comment) => !unchecked.has(comment.id))
  const toggle = (id) => {
    setUnchecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const openDialog = () => {
    setNotice(null)
    setUnchecked(new Set())
    setOpen(true)
    reload().then((res) => {
      if (res && !res.ok && !res.stale) {
        setNotice({ tone: 'bad', text: `Could not refresh the list: ${errorMessage(res.error)}`, retry: true })
      }
    })
  }
  const retryReload = async () => {
    setBusy(true)
    try {
      const res = await reload()
      if (res?.ok) setNotice(null)
      else if (res && !res.stale) setNotice({ tone: 'bad', text: `Could not refresh the list: ${errorMessage(res.error)}`, retry: true })
    } finally {
      setBusy(false)
    }
  }
  const send = async () => {
    if (!selected.length) return
    setBusy(true)
    setNotice(null)
    const sent = []
    const changed = []
    const skipped = []
    try {
      const items = selected.map((comment) => ({ number: Number(comment.id), dispatchHash: comment.dispatchHash }))
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE)
        const result = await sendWithStepUp(
          () => api.post(`/api/boards/${encodeURIComponent(boardId)}/waiting-ok/send`, { comments: chunk }),
          confirmHostedPasskey,
        )
        if (Array.isArray(result?.sent)) sent.push(...result.sent)
        if (Array.isArray(result?.changed)) changed.push(...result.changed)
        if (Array.isArray(result?.skipped)) skipped.push(...result.skipped)
      }
      onSent?.({ sent, changed, skipped })
      const refreshed = await reload()
      if (changed.length) {
        const suffix = refreshed && !refreshed.ok && !refreshed.stale ? ` Could not refresh the list: ${errorMessage(refreshed.error)}` : ''
        setNotice({
          tone: 'warn',
          text: `Sent ${sent.length}. Not sent, changed since you opened this list: ${changed.map((n) => `#${n}`).join(', ')}. Read them again.${suffix}`,
          retry: Boolean(refreshed && !refreshed.ok && !refreshed.stale),
        })
      } else if (refreshed && !refreshed.ok && !refreshed.stale) {
        setNotice({
          tone: 'bad',
          text: `Sent ${sent.length}, but could not refresh the list: ${errorMessage(refreshed.error)}`,
          retry: true,
        })
      } else {
        setOpen(false)
      }
    } catch (error) {
      if (sent.length) {
        onSent?.({ sent, changed, skipped })
        await reload()
      }
      const message = errorMessage(error)
      setNotice({
        tone: 'bad',
        text: sent.length ? `Sent ${sent.length}, then failed: ${message}` : message || 'That did not send.',
        retry: Boolean(sent.length),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div
        className="pointer-events-auto flex w-max max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg shadow-pop"
        role="status"
        data-sw-imported-ok={comments.length}
      >
        <Inbox size={14} aria-hidden="true" className="shrink-0 text-muted" />
        <span>{waitingOkText(comments.length)}.</span>
        <Button size={wide ? 'xs' : 'touch'} variant="soft" onClick={openDialog} data-sw-imported-review="true">
          Review and send
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => (busy ? null : setOpen(false))}
        title="Comments from 1.x"
        description="1.x did not record who wrote these. Read each one; agents get them as if you wrote them."
        wrapDescription
        size="md"
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {notice ? (
              <div className="mr-auto flex items-center gap-2 text-xs" role="alert" data-sw-imported-notice={notice.tone}>
                <p className={notice.tone === 'bad' ? 'text-bad' : 'text-warn'}>{notice.text}</p>
                {notice.retry ? (
                  <Button size="xs" variant="ghost" onClick={retryReload} disabled={busy} data-sw-imported-retry="true">
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Not now
            </Button>
            <Button onClick={send} disabled={busy || !selected.length} data-sw-imported-send="true">
              {busy ? <Spinner /> : null}
              {busy ? 'Sending...' : `Send ${selected.length} to agents`}
            </Button>
          </div>
        }
      >
        <ol className="flex flex-col gap-3 px-5 py-4" data-sw-imported-list="true">
          {comments.map((comment) => {
            const checked = !unchecked.has(comment.id)
            const screen = titleOf ? titleOf(comment.pageId) : comment.pageId
            return (
              <li key={comment.id} className="rounded-md border border-line px-3 py-2" data-sw-imported-item={comment.id}>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(comment.id)}
                    disabled={busy}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                    data-sw-imported-check={comment.id}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted">
                      #{comment.id} on {plain(screen)}
                      {comment.author ? `, signed "${plain(comment.author)}"` : ''}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">{plain(comment.body)}</p>
                  </div>
                </label>
              </li>
            )
          })}
        </ol>
      </Dialog>
    </>
  )
}
