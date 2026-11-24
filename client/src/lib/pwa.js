// Installable board: registers the service worker (sw.js, built by
// vite.config.js) in production builds, on secure origins (https or
// localhost). It caches the app shell only, never board data or live HTML.
export function registerServiceWorker() {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      /* the board works without it */
    })
  })
}
