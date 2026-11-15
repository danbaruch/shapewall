import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { registerServiceWorker } from './pwa.js'
import './styles.css'

const root = document.getElementById('root')
const app = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
// Built pages arrive prerendered (scripts/prerender.mjs); the dev server sends an empty shell.
if (root.firstElementChild) hydrateRoot(root, app)
else createRoot(root).render(app)

registerServiceWorker()

/* global __SHAPEWALL_ERROR_DSN__, __SHAPEWALL_ERROR_ENVIRONMENT__, __SHAPEWALL_ERROR_RELEASE__ */
// Error reports (src/errors.js): only in builds made with SHAPEWALL_ERROR_DSN, and only on shapewall.com itself.
if (__SHAPEWALL_ERROR_DSN__ && window.location.hostname === 'shapewall.com')
  import('./errors.js')
    .then(({ start }) =>
      start({
        dsn: __SHAPEWALL_ERROR_DSN__,
        environment: __SHAPEWALL_ERROR_ENVIRONMENT__,
        release: __SHAPEWALL_ERROR_RELEASE__ || undefined,
      }),
    )
    .catch(() => {})
