// The hosted Shapewall console: accounts, workspaces, members, invites,
// access, tokens, share links and the audit log. Built by Vite as its own
// entry (vite.console.config.js) and served by `shapewall hosted` under a
// strict CSP: scripts from 'self' only, styles from 'self' plus one nonce.
//
// Everything from the server is rendered as React text, never as HTML.

// The dialog's scroll lock (react-remove-scroll, inside Radix) adds a small
// <style> element; it reads the nonce from this global, which must be set
// before any of it loads, so this import comes first.
import './nonce'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '../lib/theme'
import '../lib/scrollbars'
import './console.css'

const LocalConsole = __SHAPEWALL_DEMO__ ? null : lazy(() => import('./LocalConsole'))
const LocalAccountsApp = __SHAPEWALL_DEMO__ ? null : lazy(() => import('./LocalAccountsApp'))
const localConsole = !__SHAPEWALL_DEMO__ && Boolean(document.querySelector('meta[name="shapewall-local-console"]'))
const localAccounts =
  localConsole && (Boolean(document.querySelector('meta[name="shapewall-local-accounts"]')) || window.location.pathname === '/account')

const start = () =>
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      {localConsole ? (
        <Suspense
          fallback={
            <p role="status" className="p-6 text-sm text-muted">
              Loading console…
            </p>
          }
        >
          {localAccounts ? <LocalAccountsApp /> : <LocalConsole />}
        </Suspense>
      ) : (
        <App />
      )}
    </StrictMode>,
  )

// The public demo answers the API in the browser (client/src/demo); every
// other build drops this branch and the import with it.
if (__SHAPEWALL_DEMO__) {
  import('../demo/install').then(({ installDemo }) => installDemo('console')).then(start)
} else {
  start()
}
