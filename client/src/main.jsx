import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './lib/pwa'
import './lib/theme'
import './lib/scrollbars'
import './styles.css'

const start = () =>
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

// The public demo answers the API in the browser (client/src/demo); every
// other build drops this branch and the import with it.
if (__SHAPEWALL_DEMO__) {
  import('./demo/install').then(({ installDemo }) => installDemo('board')).then(start)
} else {
  if (document.querySelector('meta[name="shapewall-agent-settings"]')) {
    import('./settings/Management').then(({ default: Management }) => createRoot(document.getElementById('root')).render(<Management />))
  } else {
    start()
    registerServiceWorker()
  }
}
