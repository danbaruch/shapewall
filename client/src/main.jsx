import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './lib/pwa'
import { startErrorTracking } from './lib/error-tracking'
import { installChunkRecovery } from './lib/chunk-reload'
import { ChunkBoundary } from './components/chunk-boundary'
import { AnimationRoot } from './lib/animate'
import './lib/theme'
import './lib/scrollbars'
import './styles.css'

// Opt-in, off unless the page says so (src/error-tracking.js).
startErrorTracking()
// One automatic reload when an upgrade left this tab asking for old chunk files.
installChunkRecovery()

const start = () =>
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ChunkBoundary>
        <AnimationRoot>
          <App />
        </AnimationRoot>
      </ChunkBoundary>
    </StrictMode>,
  )

// The public demo answers the API in the browser (client/src/demo); every
// other build drops this branch and the import with it.
if (__SHAPEWALL_DEMO__) {
  import('./demo/install').then(({ installDemo }) => installDemo('board')).then(start)
} else {
  if (document.querySelector('meta[name="shapewall-agent-settings"]')) {
    import('./settings/Management').then(({ default: Management }) =>
      createRoot(document.getElementById('root')).render(
        <ChunkBoundary>
          <AnimationRoot>
            <Management />
          </AnimationRoot>
        </ChunkBoundary>,
      ),
    )
  } else {
    start()
    registerServiceWorker()
  }
}
