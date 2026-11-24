import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, RefreshCw } from 'lucide-react'
import { api, STATIC } from '../lib/api'
import { DEMO } from '../lib/demo'
import { Button, Dialog, Spinner } from './ui'
import { BUILD, VERSION } from '../lib/app-version'

const ENDPOINT = '/api/app-update'

export default function AppUpdateDialog({ open, onClose, onCloseAutoFocus, transport = api }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState(null)
  const [error, setError] = useState(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [updated, setUpdated] = useState(false)
  const alive = useRef(true)
  const staticView = DEMO || STATIC
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const readStatus = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await transport.get(ENDPOINT)
      if (alive.current) setStatus(result)
    } catch (err) {
      if (alive.current)
        setError(err.status === 404 ? 'This installation needs a manual update before in-app updates are available.' : err.message)
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [transport])
  useEffect(() => {
    if (open && !staticView) void readStatus()
  }, [open, staticView, readStatus])

  const run = async (nextAction) => {
    setAction(nextAction)
    setError(null)
    setUpdated(false)
    const target = nextAction === 'apply' ? status?.latest : null
    const atTarget = (result) =>
      target &&
      result.job?.state !== 'running' &&
      result.current?.version === target.version &&
      (!target.revision || result.current?.revision === target.revision)
    const deadline = Date.now() + (nextAction === 'apply' ? 960_000 : 90_000)
    try {
      if (nextAction === 'apply' && (!target || (!target.revision && target.version === status?.current?.version))) {
        throw new Error('This update has no distinct build identity. Ask the installer to prepare a versioned release.')
      }
      let result = await transport.post(`${ENDPOINT}/${nextAction}`)
      if (!alive.current) return
      setStatus(result)
      while (
        alive.current &&
        (result.job?.state === 'running' || (nextAction === 'apply' && result.job?.state !== 'failed' && !atTarget(result)))
      ) {
        if (Date.now() >= deadline) throw new Error('Still waiting for the update service. Reopen this panel to refresh its status.')
        await new Promise((resolve) => window.setTimeout(resolve, 1200))
        if (!alive.current) return
        try {
          result = await transport.get(ENDPOINT)
          if (!alive.current) return
          setReconnecting(false)
          setStatus(result)
          // A restarted service has a new build and no in-memory job.
          if (nextAction === 'apply' && atTarget(result)) {
            setUpdated(true)
            return
          }
        } catch (err) {
          if (nextAction !== 'apply' || (err.status && err.status < 500)) throw err
          setReconnecting(true)
        }
      }
      if (!alive.current) return
      if (result.job?.state === 'failed')
        throw new Error(result.job.error || 'The update could not finish. Try again or contact the installer.')
      if (nextAction === 'apply' && atTarget(result)) setUpdated(true)
    } catch (err) {
      if (alive.current) setError(err.message || 'Could not reach Shapewall. Check your connection and try again.')
    } finally {
      if (alive.current) {
        setAction(null)
        setReconnecting(false)
      }
    }
  }

  const running = action || status?.job?.state === 'running'
  const hasActions = updated || (status?.canUpdate && status?.supported) || error || status?.job?.state === 'running'
  const message = reconnecting
    ? 'Shapewall is restarting. Reconnecting…'
    : action === 'apply'
      ? 'Installing the update. This page may briefly disconnect.'
      : action === 'check'
        ? 'Checking for updates…'
        : updated
          ? 'Update installed. Reload to use the new version.'
          : status?.job?.state === 'running'
            ? 'An update operation is running. Refresh its status in a moment.'
            : status?.job?.state === 'failed'
              ? 'The last update operation did not finish. You can try again.'
              : status?.updateAvailable
                ? `An update is available${status.latest ? `: ${VERSION(status.latest)}` : ''}.`
                : status?.checkedAt
                  ? 'You are up to date.'
                  : 'Check when you want the latest version.'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      title="About & Updates"
      description="Shapewall"
      footer={
        staticView || !hasActions ? null : (
          <div className="flex w-full flex-wrap justify-end gap-2">
            {updated ? (
              <Button size="touch" className="lg:h-9" onClick={() => window.location.reload()} data-sw-app-reload>
                <RefreshCw size={15} aria-hidden="true" /> Reload Shapewall
              </Button>
            ) : null}
            {!updated && status?.canUpdate && status?.supported ? (
              <>
                <Button
                  variant="secondary"
                  size="touch"
                  className="lg:h-9"
                  disabled={Boolean(running || loading)}
                  onClick={() => run('check')}
                  data-sw-app-check
                >
                  <RefreshCw size={15} aria-hidden="true" /> Check for updates
                </Button>
                {status.updateAvailable ? (
                  <Button
                    size="touch"
                    className="lg:h-9"
                    disabled={Boolean(running || loading)}
                    onClick={() => run('apply')}
                    data-sw-app-update
                  >
                    <ArrowUpCircle size={15} aria-hidden="true" /> Update now
                  </Button>
                ) : null}
              </>
            ) : null}
            {!action && (error || status?.job?.state === 'running') ? (
              <Button variant="secondary" size="touch" className="lg:h-9" disabled={loading} onClick={readStatus}>
                Refresh status
              </Button>
            ) : null}
          </div>
        )
      }
    >
      <div className="space-y-4 p-5 text-sm" data-sw-app-updates>
        <div>
          <p className="font-semibold text-fg">Shapewall {VERSION(BUILD)}</p>
          <p className="mt-1 text-xs text-muted">Created by Dan Baruch</p>
        </div>
        {staticView ? (
          <p className="text-muted">
            {DEMO ? 'This is the public demo.' : 'This is a static export.'} It cannot update a Shapewall installation. Ask the installer
            for a new build.
          </p>
        ) : (
          <>
            <p className="text-muted">Updates are manual. Shapewall checks and installs only when you ask.</p>
            {status?.current && VERSION(status.current) !== VERSION(BUILD) ? (
              <p className="text-xs text-muted">Server: {VERSION(status.current)}. Reload this page to load its current interface.</p>
            ) : null}
            {loading ? (
              <p className="flex items-center gap-2 text-muted" role="status">
                <Spinner /> Reading installation details…
              </p>
            ) : status ? (
              <>
                <p className="flex items-start gap-2 text-fg" role="status" data-sw-app-update-status>
                  {action ? <Spinner /> : null}
                  <span>{message}</span>
                </p>
                {!status.supported || !status.canUpdate ? (
                  <p className="text-muted">{status.reason || 'Updates are managed by the person who installed Shapewall.'}</p>
                ) : null}
                {status.checkedAt ? (
                  <p className="text-xs text-muted">Last checked: {new Date(status.checkedAt).toLocaleString()}</p>
                ) : null}
              </>
            ) : null}
            {error ? (
              <p className="text-bad" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
