import { useEffect, useState } from 'react'
import { Button, Dialog, Input, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useResource } from '../lib/hooks'

export function ShareDialog({ open, onClose, boardId, onMoved }) {
  const [remote, setRemote] = useState('')
  const [started, setStarted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [verification, setVerification] = useState(null)
  const progress = useResource(open ? '/api/share/status' : null, { pollMs: 1000 })
  const state = progress.data?.boardId && progress.data.boardId !== boardId ? null : progress.data
  const verificationUrl = verification || state?.verificationUrl
  useEffect(() => {
    if (state?.status === 'done') onMoved()
  }, [state?.status, onMoved])
  const start = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.post('/api/share/start', { remote, board: boardId })
      setVerification(result.verificationUrl)
      setStarted(true)
      progress.refetch()
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }
  const running = state?.status === 'running'
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share with your team"
      description="Move captures and comment history to a shared project."
      size="md"
    >
      <div className="space-y-4 p-5" data-sw-share-dialog>
        <p className="text-sm text-muted">
          The shared board becomes the home for comments. Local captures keep working. Agent settings, chat, credentials, paired devices and
          local integrations stay on this machine.
        </p>
        {!started && !running ? (
          <form onSubmit={start} className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="sw-share-remote">
              Your Shapewall server
            </label>
            <Input
              id="sw-share-remote"
              size="touch"
              type="url"
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              placeholder="https://review.example.com"
              required
              data-sw-share-remote
            />
            <Button type="submit" size="touch" variant="default" disabled={busy || !remote.trim()} data-sw-share-start>
              {busy ? <Spinner /> : null} Sign in and move this board
            </Button>
          </form>
        ) : null}
        {verificationUrl && running ? (
          <p className="text-sm">
            Open{' '}
            <a className="text-accent underline" href={verificationUrl} target="_blank" rel="noopener noreferrer">
              the server's sign-in page
            </a>
            , enter the code below, pick or create a project, and check Import local comments once.
          </p>
        ) : null}
        {state?.lines?.length ? (
          <pre
            className="max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap break-words"
            aria-live="polite"
            data-sw-share-progress
          >
            {state.lines.join('\n')}
          </pre>
        ) : null}
        {running ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Moving this board. Closing the dialog keeps progress available from the profile menu.
          </p>
        ) : null}
        {error || state?.error ? (
          <p role="alert" className="text-sm text-bad">
            {error || state.error}
          </p>
        ) : null}
        {state?.status === 'failed' || state?.status === 'done' ? (
          <Button variant="ghost" size="touch" onClick={() => setStarted(false)}>
            Move again
          </Button>
        ) : null}
        {state?.status === 'done' ? (
          <div className="space-y-3" data-sw-share-done>
            <p className="text-sm">
              {state.result?.conflicts?.length
                ? "Some comments were changed on the shared board too. We kept the shared board's version of the comments listed above."
                : "Moved. These comments won't go to an agent until a teammate sends them."}
            </p>
            {state.result?.urls?.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center break-all text-sm text-accent underline"
              >
                Open on {new URL(url).host}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

export function MigrationBanner({ marker, boardId, editable, onChange }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  if (!marker) return null
  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/share/local-comments', { board: boardId, readOnly: !marker.readOnly })
      onChange()
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="flex shrink-0 flex-col items-start gap-2 border-b border-line bg-accent/10 px-4 py-2 text-xs sm:flex-row sm:items-center"
      data-sw-migration-banner
    >
      <span className="min-w-0 w-full flex-1 sm:w-auto">
        {marker.pending ? (
          'Moving comments to the shared board. Local comments are temporarily read-only.'
        ) : (
          <>
            Comments for this board now live at{' '}
            <a className="break-all text-accent underline" href={marker.url} target="_blank" rel="noopener noreferrer">
              {new URL(marker.url).origin}
            </a>
            . {marker.readOnly ? 'Local comments are read-only.' : 'This local copy is independent.'}
          </>
        )}
      </span>
      {editable && !marker.pending ? (
        <Button
          size="touch"
          variant="ghost"
          onClick={choose}
          disabled={busy}
          className="max-w-full whitespace-normal text-left"
          data-sw-local-comments
        >
          {marker.readOnly ? 'Keep commenting here' : 'Make local read-only for comments'}
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="text-bad">
          {error}
        </span>
      ) : null}
    </div>
  )
}
