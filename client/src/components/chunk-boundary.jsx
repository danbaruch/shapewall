// Catches a part of the app whose code failed to load. After an upgrade an
// open tab asks for chunk files the new build no longer has: that shows a
// loading state while one automatic reload fetches the new build
// (lib/chunk-reload.js). When the reload budget is used up, or the error is
// something else, it shows a plain failure with a Reload button, and the error
// goes to the opt-in error reports once (off unless SHAPEWALL_ERROR_DSN).
import { Component, lazy } from 'react'
import { RotateCw, TriangleAlert } from 'lucide-react'
import { canRecoverFromChunkLoad, isChunkLoadError, isChunkRecoveryPending, recoverFromChunkLoad } from '../lib/chunk-reload'
import { reportBoundaryError } from '../lib/error-tracking'
import { Button, EmptyState, Spinner } from './ui'

export function ChunkRecovering() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 bg-sunken p-6 text-sm text-muted" data-sw-chunk-recovering>
      <Spinner />
      <span role="status">Updating to the latest version…</span>
    </div>
  )
}

export function ChunkFailed({ error }) {
  const stale = isChunkLoadError(error)
  return (
    <div className="flex h-full overflow-y-auto bg-sunken" role="alert" data-sw-chunk-failed>
      <EmptyState
        size="lg"
        tone="bad"
        icon={TriangleAlert}
        title="This part of Shapewall did not load"
        details={error?.message ? String(error.message) : null}
        action={
          <Button size="touch" variant="default" className="lg:h-10" onClick={() => window.location.reload()} data-sw-chunk-reload>
            <RotateCw size={15} aria-hidden="true" /> Reload
          </Button>
        }
      >
        {stale
          ? 'Shapewall may have been upgraded while this tab was open, or the connection dropped. Reload to get the current version.'
          : 'Something went wrong while showing this. Reload to try again.'}
      </EmptyState>
    </div>
  )
}

export class ChunkBoundary extends Component {
  state = { error: null, recovering: false }

  static getDerivedStateFromError(error) {
    return { error, recovering: canRecoverFromChunkLoad(error) }
  }

  componentDidCatch(error) {
    if (recoverFromChunkLoad(error)) return
    if (this.state.recovering) this.setState({ recovering: false })
    reportBoundaryError(error)
  }

  render() {
    if (!this.state.error) return this.props.children
    if (this.state.recovering) return <ChunkRecovering />
    return this.props.fallback ?? <ChunkFailed error={this.state.error} />
  }
}

// ---- One panel at a time ----
// A lazily loaded panel (Checks, the agent chat, a settings dialog, the usage
// pages) whose code fails to load shows a small retry state in its own place;
// the board or the console around it keeps working. The root boundary above
// stays for everything else.

// React.lazy keeps a failed import for good, so a retry needs a new one.
// `lazyPanel(load)` is a component like lazy(load) with `.retry()`.
export function lazyPanel(load) {
  let Current = lazy(load)
  function Panel(props) {
    return <Current {...props} />
  }
  Panel.retry = () => {
    Current = lazy(load)
  }
  return Panel
}

export function PanelFailed({ error, onRetry, compact = false }) {
  const stale = isChunkLoadError(error)
  return (
    <div className={compact ? 'p-2' : 'flex h-full min-h-40 items-center justify-center p-4'} role="alert" data-sw-panel-failed>
      <EmptyState
        icon={TriangleAlert}
        tone="bad"
        title={stale ? 'This panel did not load' : 'Something went wrong here'}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="touch" variant="secondary" className="lg:h-8" onClick={onRetry} data-sw-panel-retry>
              <RotateCw size={14} aria-hidden="true" /> Try again
            </Button>
            {stale ? (
              <Button size="touch" variant="ghost" className="lg:h-8" onClick={() => window.location.reload()} data-sw-panel-reload>
                Reload Shapewall
              </Button>
            ) : null}
          </div>
        }
      >
        {stale ? 'The connection may have dropped, or Shapewall was updated. The rest of the page still works.' : null}
      </EmptyState>
    </div>
  )
}

// `retry`: the lazyPanel(s) inside, made fresh before trying again.
// `fallback(state)`: a custom failure view (a dialog that failed to load
// still shows as a dialog).
export class PanelBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    // A stale chunk after an upgrade: the page reloads once on its own
    // (lib/chunk-reload.js); this panel says so meanwhile.
    if (recoverFromChunkLoad(error)) return
    reportBoundaryError(error)
  }

  retry = () => {
    for (const panel of [this.props.retry].flat()) panel?.retry?.()
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (isChunkRecoveryPending()) return <ChunkRecovering />
    if (this.props.fallback) return this.props.fallback({ error, retry: this.retry })
    return <PanelFailed error={error} onRetry={this.retry} compact={this.props.compact} />
  }
}
