// The site's appearance: System (the default), Light or Dark. The choice is kept in localStorage; the boot script
// in index.html applies it to <html data-theme> before the first paint, and this module owns it after that
// (changes from the theme control, other tabs, and the OS switching while on System).
import { useSyncExternalStore } from 'react'

export const THEME_KEY = 'shapewall.site.theme'
export const THEME_CHOICES = ['system', 'light', 'dark']
// The page background per theme (--color-paper in styles.css), for the browser chrome.
const CHROME = { light: '#fafaf9', dark: '#17171b' }

const listeners = new Set()
let watching = false
// The choice made on this page when storage refuses to keep it.
let unsaved = null

function osDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function getChoice() {
  if (unsaved) return unsaved
  try {
    const saved = window.localStorage.getItem(THEME_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

function apply() {
  const choice = getChoice()
  const theme = choice === 'system' ? (osDark() ? 'dark' : 'light') : choice
  document.documentElement.setAttribute('data-theme', theme)
  // On System each meta keeps its own colour and the browser picks by media query; a fixed choice sets both.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const own = (meta.getAttribute('media') || '').includes('dark') ? 'dark' : 'light'
    meta.setAttribute('content', CHROME[choice === 'system' ? own : theme])
  }
}

function changed() {
  apply()
  for (const listener of listeners) listener()
}

export function setChoice(choice) {
  unsaved = null
  try {
    if (choice === 'light' || choice === 'dark') window.localStorage.setItem(THEME_KEY, choice)
    else window.localStorage.removeItem(THEME_KEY)
  } catch {
    // Storage blocked: the choice still applies to this page.
    unsaved = THEME_CHOICES.includes(choice) ? choice : 'system'
  }
  changed()
}

function subscribe(listener) {
  listeners.add(listener)
  if (!watching) {
    watching = true
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', changed)
    window.addEventListener('storage', (event) => {
      if (event.key === THEME_KEY || event.key === null) changed()
    })
  }
  return () => listeners.delete(listener)
}

// The current choice. Prerendered HTML and the first client render say "system"; the saved choice follows at once.
export function useThemeChoice() {
  return useSyncExternalStore(subscribe, getChoice, () => 'system')
}
