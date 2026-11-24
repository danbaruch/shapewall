// Registers the service worker that scripts/prerender.mjs writes to dist/sw.js (built site only; the dev server
// has none). Pages are network first, so a release shows up on the next visit without a reload prompt.
export function registerServiceWorker() {
  if (import.meta.env.DEV || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
