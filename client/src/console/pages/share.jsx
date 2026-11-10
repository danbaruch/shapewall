// /share#<token>: a share link's landing page for guests. Previews the link
// (behind a passcode it shows nothing about the project until the passcode
// is right), asks for a name on comment links, then opens the board under
// /s/<id>/ with a guest cookie for that path only. The token stays in this
// tab's session storage until the board opens, so a reload works.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, Link2Off, Lock, MessageSquare, RefreshCw } from 'lucide-react'
import { Badge, Button, Input, Spinner } from '../../components/ui'
import { Card, Field, FormError, Loading, Notice } from '../components'
import { api } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useFragmentSecret } from '../lib/fragment'
import { TurnstileWidget } from '../lib/turnstile'
import { AuthLayout } from '../shell'
import { TOKEN_RE } from './auth'

const SHARE_KEY = 'shapewall.share'
const parseShare = (fragment) => (TOKEN_RE.test(fragment) ? fragment : '')

// "Paste the link you were sent", for a link that lost its code on the way.
export function PasteLink({ onPaste, label = 'Paste the full link you were sent', testId }) {
  const [text, setText] = useState('')
  const [bad, setBad] = useState(false)
  const submit = (event) => {
    event.preventDefault()
    setBad(!onPaste(text))
  }
  return (
    <form onSubmit={submit} className="mt-5 space-y-2 text-left">
      <Field label={label} error={bad ? 'That does not look like the whole link. It ends with a # and a long code.' : null}>
        {(props) => (
          <Input
            {...props}
            size="touch"
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setBad(false)
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://..."
            data-sw-paste-link={testId}
          />
        )}
      </Field>
      <Button type="submit" size="touch" variant="secondary" className="w-full" disabled={!text.trim()}>
        Open this link
      </Button>
    </form>
  )
}

export function SharePage() {
  const { value: token, forget, accept } = useFragmentSecret({ key: SHARE_KEY, path: '/share', parse: parseShare })
  const [ended] = useState(() => new URLSearchParams(window.location.search).has('ended'))
  const [preview, setPreview] = useState(null)
  const [state, setState] = useState(token ? 'loading' : 'missing')
  const [loadError, setLoadError] = useState(null)
  const [name, setName] = useState('')
  const [passcode, setPasscode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Comment links on a server with a bot check: one token per try.
  const [check, setCheck] = useState(null)
  const [checkRound, setCheckRound] = useState(0)

  // Each preview, and each token change, gets a new ticket: a late answer for
  // an older token must not show, or forget the link pasted since.
  const ticket = useRef(0)
  const load = useCallback(() => {
    const mine = ++ticket.current
    if (!token) {
      setState('missing')
      return
    }
    setState('loading')
    setLoadError(null)
    api
      .post('/api/shares/preview', { token })
      .then((data) => {
        if (mine !== ticket.current) return
        setPreview(data)
        setState('ready')
      })
      .catch((failure) => {
        if (mine !== ticket.current) return
        setLoadError(failure.message)
        // A dead link is dead; a network or server hiccup can be retried.
        if (failure.status === 404) {
          forget()
          setState('invalid')
        } else setState('error')
      })
  }, [token, forget])

  useEffect(() => {
    // Keep the token and ?ended out of the address bar.
    if (window.location.search) window.history.replaceState(null, '', '/share')
    // Only a token to check: forgetting a dead or used one keeps the page
    // saying why, rather than "incomplete".
    if (token) load()
    return () => {
      ticket.current += 1
    }
  }, [load, token])

  const open = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.post(`/s/${preview.id}/open`, {
        token,
        ...(passcode ? { passcode } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(check ? { turnstileToken: check } : {}),
      })
      // Used: the guest cookie carries the visit from here.
      forget()
      window.location.assign(result.url)
    } catch (failure) {
      setError(failure.message)
      setBusy(false)
      // A token works once: a new check for the next try.
      if (preview?.turnstile) {
        setCheck(null)
        setCheckRound((value) => value + 1)
      }
    }
  }

  const comment = preview?.mode === 'comment'
  const needsCheck = Boolean(comment && preview?.turnstile)
  return (
    <AuthLayout>
      <Card className="p-6 sm:p-8">
        {state === 'loading' ? <Loading label="Opening the share link" /> : null}
        {state === 'missing' ? (
          <div className="text-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-muted">
              <Link2Off size={20} aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-xl font-semibold text-fg">{ended ? 'Your visit ended' : 'This share link is incomplete'}</h1>
            <p className="mt-2 text-sm text-muted">
              {ended
                ? 'Guest visits last up to 12 hours, and end when the link is revoked or expires. Open the link you were sent again.'
                : 'Open the full link you were sent. It ends with a # and a long code.'}
            </p>
            <PasteLink onPaste={accept} testId="share" />
          </div>
        ) : null}
        {state === 'invalid' ? (
          <div className="text-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-bad/10 text-bad">
              <Link2Off size={20} aria-hidden="true" />
            </span>
            <h1 className="mt-4 text-xl font-semibold text-fg">This link does not work</h1>
            <p className="mt-2 text-sm text-muted">{loadError} Ask whoever shared it for a new one.</p>
          </div>
        ) : null}
        {state === 'error' ? (
          <div className="text-center" data-sw-share-retry>
            <h1 className="text-xl font-semibold text-fg">The link did not open</h1>
            <p className="mt-2 text-sm text-muted">{loadError}</p>
            <Button size="touch" variant="default" className="mt-5 w-full" onClick={load}>
              <RefreshCw size={15} aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : null}
        {state === 'ready' ? (
          <form onSubmit={open} className="space-y-5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={comment ? 'accent' : 'neutral'} className="px-2 py-0.5 text-[11px]">
                  {comment ? <MessageSquare size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
                  {comment ? 'View and comment' : 'View only'}
                </Badge>
                {preview.needsPasscode ? (
                  <Badge tone="warn" className="px-2 py-0.5 text-[11px]">
                    <Lock size={12} aria-hidden="true" /> Passcode
                  </Badge>
                ) : null}
              </div>
              <h1 className="mt-3 text-xl font-semibold text-fg" data-sw-share-title>
                {preview.project ? preview.project.name : 'A shared Shapewall board'}
              </h1>
              {preview.workspace ? <p className="mt-1 text-sm text-muted">Shared from {preview.workspace.name}</p> : null}
              <p className="mt-2 text-xs text-muted">This link works until {formatDateTime(preview.expiresAt)}.</p>
            </div>
            {preview.needsPasscode ? (
              <Field label="Passcode" hint="Whoever shared the link has it.">
                {(props) => (
                  <Input
                    {...props}
                    size="touch"
                    type="password"
                    value={passcode}
                    onChange={(event) => setPasscode(event.target.value)}
                    autoComplete="off"
                    data-sw-share-passcode
                  />
                )}
              </Field>
            ) : null}
            <Field
              label={comment ? 'Your name' : 'Your name (optional)'}
              hint={comment ? 'Shown with your comments, marked as a guest.' : 'So the team knows who looked.'}
            >
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  maxLength={40}
                  data-sw-share-name
                />
              )}
            </Field>
            {comment ? (
              <Notice tone="info">
                Comments you leave are visible to the team that shared this board. Do not include passwords or private data.
              </Notice>
            ) : null}
            {needsCheck ? (
              <TurnstileWidget
                key={checkRound}
                siteKey={preview.turnstile}
                onToken={setCheck}
                onError={(failure) => setError(failure.message)}
              />
            ) : null}
            <FormError error={error} />
            <Button
              type="submit"
              variant="default"
              size="touch"
              className="w-full"
              disabled={busy || (comment && !name.trim()) || (preview.needsPasscode && !passcode) || (needsCheck && !check)}
              data-sw-share-open
            >
              {busy ? <Spinner /> : null}
              Open the board
            </Button>
          </form>
        ) : null}
      </Card>
      <p className="mt-5 text-center text-xs text-muted">You are visiting as a guest. No account needed.</p>
    </AuthLayout>
  )
}
