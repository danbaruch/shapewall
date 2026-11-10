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
