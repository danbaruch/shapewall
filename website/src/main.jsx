import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { loadChangelog } from './changelog.js'
import { loadDoc } from './docs-content.js'
import { routeFor } from './routes.js'
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
// Built pages arrive prerendered (scripts/prerender.mjs); the dev server sends an empty shell. The changelog and each
// docs page hydrate once their content (a chunk of its own) is here, so the first client render matches the HTML.
const start = () => (root.firstElementChild ? hydrateRoot(root, app) : createRoot(root).render(app))
const route = routeFor(window.location.pathname)
if (route?.path === '/changelog') loadChangelog().then(start, start)
else if (route?.kind === 'doc') loadDoc(route).then(start, start)
else start()

registerServiceWorker()

/* global __SHAPEWALL_ERROR_DSN__, __SHAPEWALL_ERROR_ENVIRONMENT__, __SHAPEWALL_ERROR_HOST__, __SHAPEWALL_ERROR_RELEASE__ */
// Error reports (src/errors.js): only in builds made with SHAPEWALL_ERROR_DSN, and only on shapewall.com itself (or, in a
// staging build, on that staging copy's own host: SHAPEWALL_ERROR_HOST, default shapewall.com).
if (__SHAPEWALL_ERROR_DSN__ && window.location.hostname === __SHAPEWALL_ERROR_HOST__)
  import('./errors.js')
    .then(({ start }) =>
      start({
        dsn: __SHAPEWALL_ERROR_DSN__,
        environment: __SHAPEWALL_ERROR_ENVIRONMENT__,
        release: __SHAPEWALL_ERROR_RELEASE__ || undefined,
      }),
    )
    .catch(() => {})
