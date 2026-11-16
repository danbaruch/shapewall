// Catches a part of the app whose code failed to load. After an upgrade an
// open tab asks for chunk files the new build no longer has: that shows a
// loading state while one automatic reload fetches the new build
// (lib/chunk-reload.js). When the reload budget is used up, or the error is
// something else, it shows a plain failure with a Reload button, and the error
// goes to the opt-in error reports once (off unless SHAPEWALL_ERROR_DSN).
import { Component } from 'react'
import { RotateCw, TriangleAlert } from 'lucide-react'
import { canRecoverFromChunkLoad, isChunkLoadError, recoverFromChunkLoad } from '../lib/chunk-reload'
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
