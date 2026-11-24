import { useEffect, useState } from 'react'
import { Button, Dialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, Textarea } from '../components/ui'
import { buzzRequest } from './api'
import { editableRejection, REQUEST_MAX_BYTES, requestBytes } from './request'

export default function BuzzDialog({ open, onClose, boardId }) {
  const [view, setView] = useState(null)
  const [targetId, setTargetId] = useState('codex')
  const [text, setText] = useState('')
  const [feed, setFeed] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const target = view?.agents.find((a) => a.id === targetId)
  const textBytes = requestBytes(text)
  const tooLong = textBytes > REQUEST_MAX_BYTES

  useEffect(() => {
    if (!open) return
    let active = true
    buzzRequest(boardId, 'view')
      .then((data) => {
        if (active) {
          setView(data)
          setError(null)
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [open, boardId])

  async function refresh() {
    setBusy(true)
    setError(null)
    try {
      const data = await buzzRequest(boardId, 'feed')
      setFeed(data.events)
      setView((old) => ({ ...old, receipts: data.receipts }))
      if (pending) setReceipt(data.receipts.find((r) => r.requestId === pending.requestId) || receipt)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    if (!text.trim() && !pending) return
    if (!pending && tooLong) {
      setError('This request is too long. Shorten it before sending.')
      return
    }
    // Retain exactly the same UUID/body after a browser/network failure. A
    // repeated click can fetch its receipt but cannot publish it twice.
    const retrying = Boolean(pending)
    const request = pending || { requestId: crypto.randomUUID(), target: targetId, text }
    setPending(request)
    setBusy(true)
    setError(null)
    try {
      const data = await buzzRequest(boardId, 'dispatch', request)
      setReceipt(data.receipt)
      setView((old) => ({ ...old, receipts: [...(old?.receipts || []).filter((r) => r.requestId !== request.requestId), data.receipt] }))
    } catch (e) {
      if (editableRejection(e, retrying)) {
        setPending(null)
        setError(`${e.message} Nothing was sent. Edit the request and try again.`)
      } else
        setError(`${e.message} It may have been sent. Check Recent requests below before sending again. (request ${request.requestId})`)
    } finally {
      setBusy(false)
    }
  }

  const nameFor = (pubkey) => view?.agents.find((a) => a.pubkey === pubkey)?.name || 'Owner'
  return (
    <Dialog open={open} onClose={busy ? () => {} : onClose} title="Existing Buzz conversation" size="md">
      <div className="space-y-4 p-5 text-sm" data-sw-buzz-dialog>
        <p className="text-muted">
          This posts to your shared Buzz channel {view ? `#${view.channel.name} ` : ''}with your existing agents and sessions, so it can
          steer work already in progress. Replies are not tied to a Shapewall comment and don’t prove a fix is done.
        </p>
        <p className="text-muted">
          After an agent changes source, recapture the board and check the result yourself. There is no Stop control here, and your Buzz
          permissions still apply.
        </p>
        {error ? (
          <p role="alert" className="break-words text-bad">
            {error}
          </p>
        ) : null}
        {!view && !error ? (
          <p>
            <Spinner /> Loading private connection...
          </p>
        ) : null}
        {view ? (
          <>
            <div className="space-y-1">
              <label htmlFor="sw-buzz-agent" className="block font-medium">
                Existing agent
              </label>
              <Select value={targetId} onValueChange={setTargetId} disabled={busy || Boolean(pending)}>
                <SelectTrigger id="sw-buzz-agent" size="touch" className="w-full" data-sw-buzz-agent>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {view.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {target ? (
              <div className="space-y-1 text-xs text-muted">
                <p>Sends as {target.name}.</p>
                <details>
                  <summary className="cursor-pointer">Technical details</summary>
                  <div className="mt-2 space-y-1 break-words">
                    <p>
                      Target: {target.name} (<code>{target.pubkey}</code>). Transport signer: {target.signer.name} (
                      <code>{target.signer.pubkey}</code>), using its existing owner-attested Buzz identity. The signed envelope identifies
                      this as owner-supplied Shapewall text; the signer did not compose it.
                    </p>
                    <p>
                      Source folder for this board: <code>{view.sourceRoot}</code>. It does not change or sandbox the agent’s working
                      directory. Emails, code and mentions are sent as JSON escapes in the envelope.
                    </p>
                  </div>
                </details>
              </div>
            ) : null}
            <label className="block space-y-1 font-medium">
              Request for the shared channel
              <Textarea
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy || Boolean(pending)}
                maxLength={12000}
                aria-invalid={tooLong || undefined}
                placeholder="Describe the source change you want this existing agent to make."
              />
            </label>
            {tooLong ? (
              <p role="alert" className="text-bad">
                This request uses {textBytes.toLocaleString()} bytes; the limit is {REQUEST_MAX_BYTES.toLocaleString()}. Shorten it before
                sending.
              </p>
            ) : null}
            <p className="text-xs text-muted">
              Only {target?.name || 'the selected agent'} is notified. Your text and this board’s source folder are sent to your private
              Buzz server.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="touch" variant="default" onClick={send} disabled={busy || (!pending && (!text.trim() || tooLong))}>
                {busy ? 'Working...' : pending ? 'Check this request receipt' : 'Send to Buzz'}
              </Button>
              <Button size="touch" onClick={refresh} disabled={busy}>
                Refresh shared conversation
              </Button>
              {receipt ? (
                <Button
                  size="touch"
                  onClick={() => {
                    setPending(null)
                    setReceipt(null)
                    setText('')
                  }}
                  disabled={busy}
                >
                  New request
                </Button>
              ) : null}
            </div>
            <section aria-label="Recent requests" className="space-y-2">
              {view.receipts?.length ? <h3 className="text-xs font-medium text-muted">Recent requests</h3> : null}
              {(view.receipts || [])
                .slice(-5)
                .reverse()
                .map((r) => (
                  <article className="space-y-1 rounded border border-line p-3" key={r.requestId} data-sw-buzz-receipt={r.status}>
                    <p className="font-medium">
                      {r.status === 'sent' ? 'Sent to Buzz' : r.status === 'not_sent' ? 'Not sent' : 'Delivery unknown'}
                    </p>
                    <p className="text-xs text-muted">{r.message}</p>
                    <p className="break-all text-xs">
                      Request: {r.requestId}
                      {r.eventId ? ` · Signed event: ${r.eventId}` : ''}
                    </p>
                    <details>
                      <summary className="cursor-pointer text-xs">Exact transmitted envelope</summary>
                      <pre className="mt-2 whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">{r.envelope}</pre>
                    </details>
                  </article>
                ))}
            </section>
            <section aria-label="Verified shared Buzz messages" className="space-y-3">
              <p className="text-xs text-muted">
                Manual refresh shows a bounded recent view of signed owner and mapped-agent messages. It is not complete history or a
                per-request response stream.
              </p>
              {feed.map((event) => (
                <article key={event.id} className="rounded border border-line p-3" data-sw-buzz-event>
                  <p className="text-xs font-medium">
                    {nameFor(event.pubkey)} · signature verified · {new Date(event.createdAt * 1000).toLocaleString()}
                  </p>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">{event.content}</pre>
                  <p className="mt-2 break-all text-xs text-faint">Event: {event.id}</p>
                </article>
              ))}
            </section>
          </>
        ) : null}
      </div>
    </Dialog>
  )
}
