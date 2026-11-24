import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { Button, Dialog, Input } from '../components/ui'

export function PairingScreen() {
  const [name, setName] = useState('')
  const [view, setView] = useState(null)
  // A failed poll says so until a poll works again; a failed request stays
  // until the next one.
  const [pollError, setPollError] = useState('')
  const [requestError, setRequestError] = useState('')
  const [busy, setBusy] = useState(false)
  const requesting = useRef(false)
  // Each poll and each request takes a ticket: an answer that left before a
  // newer one (a poll in flight when the request lands) is dropped.
  const ticket = useRef(0)
  useEffect(() => {
    let live = true
    const poll = async () => {
      if (requesting.current) return
      const mine = ++ticket.current
      try {
        const next = await api.get('/api/pairing')
        if (!live || mine !== ticket.current) return
        setPollError('')
        setView(next)
        if (next.pairing.state === 'approved' || ['host', 'device', 'identity'].includes(next.access)) window.location.reload()
      } catch (caught) {
        if (live && mine === ticket.current) setPollError(caught.message)
      }
    }
    poll()
    const timer = setInterval(poll, 2000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  const pair = async (event) => {
    event.preventDefault()
    // One request at a time: a double click must not ask the host for two codes.
    if (requesting.current) return
    requesting.current = true
    setBusy(true)
    setRequestError('')
    ticket.current += 1
    try {
      const pairing = await api.post('/api/pairing', { name })
      ticket.current += 1
      setView((current) => ({ ...current, pairing }))
    } catch (caught) {
      setRequestError(caught.message)
    } finally {
      requesting.current = false
      setBusy(false)
    }
  }
  const error = requestError || pollError
  const pairing = view?.pairing
  const code = pairing?.code
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-5 p-6" data-sw-pairing>
      <div>
        <p className="text-xs font-medium text-accent">Shapewall</p>
        <h1 className="mt-2 text-2xl font-semibold text-fg">Pair this device</h1>
      </div>
      <p className="text-sm text-muted">
        This board belongs to the person running Shapewall. Match the code and approve this device on that computer.
      </p>
      {view?.ownMachine ? (
        <p className="rounded-lg border border-line p-3 text-sm text-muted" data-sw-pairing-own-machine>
          This is the computer that runs Shapewall. Its tailnet address never lets you in by itself, because any program on this computer
          could ask the same way. Use the private owner link instead: the terminal that started Shapewall printed it, and it opens the board
          on this computer’s own address.
        </p>
      ) : null}
      {pairing?.state === 'pending' ? (
        <section className="space-y-3 rounded-lg border border-line p-4" aria-live="polite">
          <p className="text-sm text-fg">Waiting for approval: {pairing.name}</p>
          <p className="font-mono text-3xl tracking-widest text-fg" data-sw-pairing-code>
            {code.slice(0, 4)}-{code.slice(4)}
          </p>
          <p className="text-xs text-muted">
            Expires in five minutes. On the host, open Devices or run <code>shapewall devices approve {code}</code>.
          </p>
        </section>
      ) : (
        <form className="space-y-3" onSubmit={pair}>
          {['denied', 'expired'].includes(pairing?.state) ? (
            <p className="text-sm text-warn" role="status">
              {pairing.state === 'denied' ? 'The host denied this request.' : 'This request expired.'} You can request again.
            </p>
          ) : null}
          <label htmlFor="device-name" className="block text-sm text-fg">
            Device name
          </label>
          <Input
            id="device-name"
            required
            maxLength={80}
            placeholder="My phone"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={busy} data-sw-pairing-request>
            Request pairing
          </Button>
        </form>
      )}
      {error ? (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      ) : null}
      {!view?.secure ? (
        <p className="rounded-lg border border-warn/30 p-3 text-xs text-warn">
          Plain HTTP on Wi-Fi exposes your device cookie to sniffing and replay. Use Tailscale for private HTTPS, or configure a TLS
          certificate. Without HTTPS this board installs only as a bookmark.
        </p>
      ) : null}
      {ios && !standalone ? (
        <p className="text-xs text-muted">
          Installing on your iPhone? Add the board to your Home Screen first, then pair from inside that app. Its cookies are separate from
          Safari.
        </p>
      ) : null}
    </main>
  )
}

export function DevicesPanel({ info }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(null)
  const [pollError, setPollError] = useState('')
  const [actError, setActError] = useState('')
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  // As on the pairing screen: a list that left before an answer landed
  // (an approved row) is dropped rather than shown again for a tick.
  const ticket = useRef(0)
  const remote = info?.remote
  const manage = Boolean(remote?.manage)
  useEffect(() => {
    if (!manage) return
    let live = true
    const load = async () => {
      if (acting.current) return
      const mine = ++ticket.current
      try {
        const next = await api.get('/api/devices')
        if (!live || mine !== ticket.current) return
        setPollError('')
        setView(next)
      } catch (caught) {
        if (live && mine === ticket.current) setPollError(caught.message)
      }
    }
    load()
    const timer = setInterval(load, 4000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [manage])
  // One answer at a time: a double click on Approve approves once.
  const act = async (method, url) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setActError('')
    ticket.current += 1
    try {
      await api[method](url)
      if (manage) {
        const next = await api.get('/api/devices')
        ticket.current += 1
        setView(next)
        setPollError('')
      } else window.location.reload()
    } catch (caught) {
      setActError(caught.message)
    } finally {
      acting.current = false
      setBusy(false)
    }
  }
  const error = actError || pollError
  if (!remote || (!manage && !remote.device)) return null
  const pending = view?.pending || []
  return (
    <>
      <div className="fixed bottom-3 left-3 z-30 rounded-lg border border-line bg-surface p-1 shadow-lg lg:bottom-16 lg:left-[64px]">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-sw-devices-open>
          {manage ? `Devices${pending.length ? ` (${pending.length} waiting)` : ''}` : remote.device.name}
        </Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={manage ? 'Your devices' : 'This device'}>
        <div className="max-h-[70dvh] space-y-4 overflow-auto p-5" data-sw-devices>
          {error ? (
            <p role="alert" className="text-sm text-bad">
              {error}
            </p>
          ) : null}
          {manage ? (
            <>
              <p className="text-sm text-muted">
                Approve only your own devices, after matching the code shown on them. Paired devices can comment, capture and drive your
                connected agent.
              </p>
              {pending.map((item) => (
                <section key={item.id} className="space-y-2 rounded border border-line p-3">
                  <p className="text-sm font-medium text-fg">{item.name}</p>
                  <p className="break-all text-xs text-muted">
                    {item.browser} · {item.ip}
                  </p>
                  <p className="font-mono text-lg text-fg">
                    {item.code.slice(0, 4)}-{item.code.slice(4)}
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => act('post', `/api/devices/${item.code}/approve`)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => act('post', `/api/devices/${item.code}/deny`)}>
                      Deny
                    </Button>
                  </div>
                </section>
              ))}
              {(view?.devices || []).map((item) => (
                <section key={item.id} className="flex items-center justify-between gap-2 rounded border border-line p-3">
                  <p className="min-w-0 break-words text-sm text-fg">
                    {item.name}
                    <span className="block text-xs text-muted">Last seen {new Date(item.lastSeenAt).toLocaleDateString()}</span>
                  </p>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => act('delete', `/api/devices/${item.id}`)}>
                    Revoke
                  </Button>
                </section>
              ))}
              {!pending.length && !view?.devices?.length ? <p className="text-sm text-muted">No paired devices or requests yet.</p> : null}
            </>
          ) : (
            <>
              <p className="text-sm text-muted">
                Paired as {remote.device.name}. Settings and other devices are managed on the host computer.
              </p>
              <Button variant="secondary" disabled={busy} onClick={() => act('delete', `/api/devices/${remote.device.id}`)}>
                Revoke this device
              </Button>
            </>
          )}
        </div>
      </Dialog>
    </>
  )
}
