// Cloudflare Turnstile, shown only when the server asks for it (open sign-up,
// comment share links). The script loads from Cloudflare only then; the
// server adds it to this page's CSP only when a site key is configured.

import { useEffect, useRef } from 'react'

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading = null

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT
      script.async = true
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')))
      script.onerror = () => {
        loading = null
        reject(new Error('The bot check could not load. Check your connection and reload the page.'))
      }
      document.head.append(script)
    })
  }
  return loading
}

// onToken(token | null): a token after the check passes, null when it
// expires or fails (the form stays disabled until there is one).
export function TurnstileWidget({ siteKey, onToken, onError }) {
  const box = useRef(null)
  const latest = useRef({ onToken, onError })
  latest.current = { onToken, onError }
  useEffect(() => {
    let id = null
    let gone = false
    loadTurnstile()
      .then((turnstile) => {
        if (gone || !box.current) return
        id = turnstile.render(box.current, {
          sitekey: siteKey,
          callback: (token) => latest.current.onToken(token),
          'expired-callback': () => latest.current.onToken(null),
          'error-callback': () => latest.current.onToken(null),
        })
      })
      .catch((error) => latest.current.onError?.(error))
    return () => {
      gone = true
      if (id !== null) window.turnstile?.remove(id)
    }
  }, [siteKey])
  return <div ref={box} className="min-h-[65px]" data-sw-turnstile />
}
