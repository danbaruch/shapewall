// Cookieless page and event counts through Umami. The build only adds the tracker when SHAPEWALL_UMAMI_ID is
// set, and the loader in each page's <head> only runs on shapewall.com, so local builds, previews and staging copies
// send nothing. Event names are fixed strings chosen in code, never user input (the docs search sends no query).
const MAX_QUEUE = 20
let queue = []
let waiting = false

function flush() {
  waiting = false
  if (!window.umami?.track) return
  const pending = queue
  queue = []
  for (const [name, data] of pending) window.umami.track(name, data)
}

export function track(name, data) {
  if (typeof window === 'undefined' || !window.__shapewallAnalytics) return
  try {
    if (window.umami?.track) {
      window.umami.track(name, data)
      return
    }
    if (queue.length < MAX_QUEUE) queue.push([name, data])
    // The tracker is a deferred script: give it a moment to arrive.
    if (!waiting) {
      waiting = true
      setTimeout(flush, 2500)
    }
  } catch {
    // Counting must never break the page.
  }
}
