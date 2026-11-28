// B-20: the comments a migration brought in from a 1.x board wait for the
// owner's OK before agents get them (1.x never recorded who wrote a
// comment). A banner says how many; "Review and send" lists each one in full,
// and "Send to agents" sends exactly those, each with the hash of the text
// shown (one changed meanwhile stays waiting). Admins only; nobody else sees it.
// Board.jsx loads this file lazily, for admins only: the main bundle has no room to spare.
import { useCallback, useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import { api } from '../lib/api'
import { Button, Dialog } from '../components/ui'
import { confirmHostedPasskey } from './HostedApprovals'
import { sendWithStepUp } from './stepUp'

function useImportedOk({ boardId, enabled }) {
  const [comments, setComments] = useState([])
  const url = `/api/boards/${encodeURIComponent(boardId)}/waiting-ok`
  const load = useCallback(async () => {
    if (!enabled) return setComments([])
    try {
      const result = await api.get(url)
      setComments(Array.isArray(result?.comments) ? result.comments : [])
    } catch {
      setComments([])
    }
  }, [enabled, url])
  useEffect(() => {
    load()
  }, [load])
  return { comments, reload: load }
}

export const waitingOkText = (count) =>
  `${count} comment${count === 1 ? '' : 's'} from 1.x wait${count === 1 ? 's' : ''} for your OK before agents get ${count === 1 ? 'it' : 'them'}`

export default function ImportedOk({ boardId, onSent, wide = true }) {
  const { comments, reload } = useImportedOk({ boardId, enabled: true })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  if (!comments.length) return null
  const send = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const items = comments.map((comment) => ({ number: Number(comment.id), dispatchHash: comment.dispatchHash }))
      const result = await sendWithStepUp(
        () => api.post(`/api/boards/${encodeURIComponent(boardId)}/waiting-ok/send`, { comments: items }),
        confirmHostedPasskey,
      )
      onSent?.(result)
      if (result.changed?.length)
        setNotice(
          `Sent ${result.sent.length}. Not sent, changed since you opened this list: ${result.changed.map((n) => `#${n}`).join(', ')}. Read them again.`,
        )
      else setOpen(false)
      await reload()
    } catch (error) {
      setNotice(error.message || 'That did not send.')
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
        <Button size={wide ? 'xs' : 'touch'} variant="soft" onClick={() => setOpen(true)} data-sw-imported-review="true">
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
              <p className="mr-auto text-xs text-muted" role="alert">
                {notice}
              </p>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Not now
            </Button>
            <Button onClick={send} disabled={busy} data-sw-imported-send="true">
              Send {comments.length} to agents
            </Button>
          </div>
        }
      >
        <ol className="flex flex-col gap-3" data-sw-imported-list="true">
          {comments.map((comment) => (
            <li key={comment.id} className="rounded-md border border-line px-3 py-2">
              <p className="text-xs text-muted">
                #{comment.id} on {comment.pageId}
                {comment.author ? `, signed "${comment.author}"` : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">{comment.body}</p>
            </li>
          ))}
        </ol>
      </Dialog>
    </>
  )
}
