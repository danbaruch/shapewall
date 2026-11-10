// App-wide state: the signed-in account (/auth/me), toasts, and re-auth
// (the passkey check the server asks for before sensitive actions).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { Button, Dialog, Spinner } from '../components/ui'
import { api, ApiError } from './lib/api'
import { errorMessage, getPasskey } from './lib/webauthn'
import { leaveTo, navigateSoon } from './lib/router'
import { ADD_PASSKEY_EVENT } from './lib/events'
import { formatDateTime } from './lib/format'

// ---- Session ----

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  // anon: the signed-out answer (sign-up mode, a bot check, a server move).
  const [state, setState] = useState({ me: null, anon: null, loading: true, error: null })
  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/auth/me')
      setState({ me: me.user ? me : null, anon: me.user ? null : me, loading: false, error: null })
      return me.user ? me : null
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error }))
      return null
    }
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  const value = useMemo(() => ({ ...state, refresh }), [state, refresh])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export const useSession = () => useContext(SessionContext)

// ---- Toasts ----

const ToastContext = createContext(() => {})

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const counter = useRef(0)
  const toast = useCallback((message, tone = 'ok') => {
    const id = ++counter.current
    setToasts((list) => [...list.slice(-2), { id, message, tone }])
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 4500)
  }, [])
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex flex-col items-center gap-2 px-4"
        role="status"
        aria-live="polite"
        data-sw-toasts
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            className={
              item.tone === 'bad'
                ? 'pointer-events-auto max-w-md animate-pop-in rounded-lg border border-bad/40 bg-surface px-4 py-2.5 text-sm text-bad shadow-pop'
                : 'pointer-events-auto max-w-md animate-pop-in rounded-lg border border-line bg-fg px-4 py-2.5 text-sm text-surface shadow-pop'
            }
            data-sw-toast={item.tone}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// ---- Re-auth ----
// withReauth(action) runs the action; if the server answers reauth_required,
// a dialog asks for the passkey (a click, so every browser allows the
// prompt), then the action runs once more.

const ReauthContext = createContext(null)

export function ReauthProvider({ children }) {
  const { me, refresh } = useSession()
  // A recovery-code session has no passkey to confirm with (often none at
  // all): it is told to add one first.
  const recovery = Boolean(me?.viaRecovery)
  const [tryExisting, setTryExisting] = useState(false)
  const [pending, setPending] = useState(null) // { resolve, reject, message }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const ask = useCallback(
    (message) =>
      new Promise((resolve, reject) => {
        setError(null)
        setTryExisting(false)
        setPending({ resolve, reject, message })
      }),
    [],
  )

  const withReauth = useCallback(
    async (action) => {
      try {
        return await action()
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.code !== 'reauth_required') throw failure
        await ask(failure.message)
        return action()
      }
    },
    [ask],
  )

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const { options } = await api.post('/auth/reauth/options', {})
      const response = await getPasskey(options)
      await api.post('/auth/reauth/verify', { response })
      // A recovery session confirmed by a passkey is a passkey session now.
      if (recovery) await refresh()
      const done = pending
      setPending(null)
      done.resolve()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => {
    if (busy) return
    const done = pending
    setPending(null)
    done?.reject(Object.assign(new Error('Cancelled.'), { cancelled: true }))
  }
  const addPasskey = () => {
    cancel()
    // Closing the dialog goes Back first; the account page opens its
    // add-passkey dialog from the #add-passkey it lands on.
    navigateSoon('/account#add-passkey')
    window.setTimeout(() => window.dispatchEvent(new Event(ADD_PASSKEY_EVENT)), 450)
  }
  const askAdd = recovery && !tryExisting
  const onHold =
    me?.passkeys
      ?.map((key) => key.onHoldUntil)
      .filter(Boolean)
      .sort()[0] || null

  return (
    <ReauthContext.Provider value={withReauth}>
      {children}
      <Dialog
        open={Boolean(pending)}
        onClose={cancel}
        title={askAdd ? 'Add a passkey first' : "Confirm it's you"}
        footer={
          askAdd ? (
            <>
              <Button size="touch" variant="ghost" onClick={cancel} className="lg:h-10">
                Cancel
              </Button>
              <Button size="touch" variant="default" onClick={addPasskey} data-sw-reauth-add-passkey className="lg:h-10">
                <KeyRound size={16} aria-hidden="true" />
                Add a passkey
              </Button>
            </>
          ) : (
            <>
              <Button size="touch" variant="ghost" onClick={cancel} disabled={busy} className="lg:h-10">
                Cancel
              </Button>
              <Button size="touch" variant="default" onClick={confirm} disabled={busy} data-sw-reauth className="lg:h-10">
                {busy ? <Spinner /> : <ShieldCheck size={16} aria-hidden="true" />}
                Use passkey
              </Button>
            </>
          )
        }
      >
        <div className="space-y-2 px-5 py-4 text-sm text-muted">
          {askAdd ? (
            <>
              <p data-sw-reauth-recovery>
                You signed in with a recovery code, so there is no passkey to confirm this change with. Add a passkey first: for your
                safety, a passkey added this way can confirm changes like this one 24 hours after it is added.
              </p>
              {onHold ? <p>Your new passkey can confirm changes from {formatDateTime(onHold)}.</p> : null}
              <button
                type="button"
                className="text-[13px] font-medium text-accent underline-offset-2 hover:underline"
                onClick={() => setTryExisting(true)}
              >
                I still have a passkey: use it
              </button>
            </>
          ) : (
            <p>This is a sensitive change, so Shapewall checks your passkey first (once every 10 minutes).</p>
          )}
          {error ? (
            <p className="text-bad" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </ReauthContext.Provider>
  )
}

export const useReauth = () => useContext(ReauthContext)

// Runs an action with re-auth, a busy flag and an error message; a cancelled
// re-auth is not an error. A second run while one is busy is dropped (a
// double click, Enter held down). Outside the signed-in console there is no
// re-auth dialog: the action just runs.
export function useAction() {
  const withReauth = useReauth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const running = useRef(false)
  const run = useCallback(
    async (action) => {
      if (running.current) return undefined
      running.current = true
      setBusy(true)
      setError(null)
      try {
        return await (withReauth ? withReauth(action) : action())
      } catch (failure) {
        if (!failure?.cancelled) setError(errorMessage(failure))
        return undefined
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [withReauth],
  )
  return { run, busy, error, setError }
}

// Signs out, then loads `to` afresh. If the server could not be told, the
// session is still live: say so and stay, rather than look signed out.
export function useSignOut(to = '/signin') {
  const toast = useToast()
  return useCallback(async () => {
    try {
      await api.post('/auth/logout', {})
    } catch (failure) {
      toast(`You are still signed in: ${errorMessage(failure)}`, 'bad')
      return
    }
    leaveTo(to)
  }, [toast, to])
}

// GET a URL into state, with refetch.
export function useLoad(url) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(url) })
  const ticket = useRef(0)
  const load = useCallback(async () => {
    if (!url) return null
    const mine = ++ticket.current
    try {
      const data = await api.get(url)
      if (mine === ticket.current) setState({ data, error: null, loading: false })
      return data
    } catch (error) {
      if (mine === ticket.current) setState((current) => ({ data: current.data, error, loading: false }))
      return null
    }
  }, [url])
  useEffect(() => {
    setState({ data: null, error: null, loading: Boolean(url) })
    load()
  }, [load, url])
  return { ...state, reload: load, setData: (data) => setState((current) => ({ ...current, data })) }
}

// A newest-first list read a page at a time. `urlFor(before)` builds the URL
// (no argument: the first page); a new `urlFor` (the filters changed) starts
// over, and a page asked for under the old one is dropped when it lands.
// `key` names the list in the answer; `next` is what to pass as `before`.
export function usePagedLoad(urlFor, key) {
  const [state, setState] = useState({ items: [], next: null, loading: true, more: false, error: null })
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++generation.current
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const data = await api.get(urlFor())
      if (mine === generation.current) setState({ items: data[key], next: data.next, loading: false, more: false, error: null })
    } catch (error) {
      if (mine === generation.current) setState({ items: [], next: null, loading: false, more: false, error })
    }
  }, [urlFor, key])
  useEffect(() => {
    reload()
    return () => {
      generation.current += 1
    }
  }, [reload])
  const next = state.next
  const loadMore = useCallback(async () => {
    if (!next) return
    const mine = generation.current
    setState((current) => ({ ...current, more: true, error: null }))
    try {
      const data = await api.get(urlFor(next))
      if (mine !== generation.current) return
      setState((current) => ({ ...current, items: [...current.items, ...data[key]], next: data.next, more: false }))
    } catch (error) {
      if (mine === generation.current) setState((current) => ({ ...current, error, more: false }))
    }
  }, [urlFor, key, next])
  return { ...state, reload, loadMore }
}
