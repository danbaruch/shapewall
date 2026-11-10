// Scrollbars that show only while you scroll. styles.css draws a thin rounded
// thumb on a clear track and keeps it invisible until the scroller carries
// data-scrolling, which this sets on whatever is scrolling (the page: <html>)
// and clears a moment after it stops.
//
// Only where the platform draws classic scrollbars that take space (Windows,
// Linux, macOS with "always show"): there <html> gets sw-scrollbars. Overlay
// scrollbars (phones, tablets, macOS by default) measure 0 wide, already
// behave like this and stay native.

const IDLE_MS = 900

function classicScrollbars() {
  try {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;top:-999px;width:100px;height:100px;overflow:scroll;visibility:hidden'
    document.documentElement.appendChild(probe)
    const classic = probe.offsetWidth - probe.clientWidth > 0
    probe.remove()
    return classic
  } catch {
    return false
  }
}

function watch() {
  const timers = new WeakMap()
  const onScroll = (event) => {
    const target = event.target === document ? document.documentElement : event.target
    if (!(target instanceof Element)) return
    if (!target.hasAttribute('data-scrolling')) target.setAttribute('data-scrolling', '')
    clearTimeout(timers.get(target))
    timers.set(
      target,
      setTimeout(() => target.removeAttribute('data-scrolling'), IDLE_MS),
    )
  }
  // Scroll events do not bubble; capture sees every scroller's.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}

if (typeof document !== 'undefined' && classicScrollbars()) {
  document.documentElement.classList.add('sw-scrollbars')
  watch()
}
