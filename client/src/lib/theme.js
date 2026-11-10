// Appearance: Light, Dark or System, and a theme (accent and surface
// palettes on the design tokens in styles.css). Saved in localStorage, shared
// by the board and the console, and applied to <html> as data-mode and
// data-theme. public/theme-boot.js applies the saved value before the first
// paint; this module takes over from there.

import { useSyncExternalStore } from 'react'

export const APPEARANCE_KEY = 'shapewall.appearance'
export const MODES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]
export const THEMES = [
  { id: 'default', label: 'Default' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'forest', label: 'Forest' },
  { id: 'contrast', label: 'High contrast' },
]
const DEFAULT = { mode: 'system', theme: 'default' }

export function normalizeAppearance(value) {
  const mode = MODES.some((item) => item.id === value?.mode) ? value.mode : DEFAULT.mode
  const theme = THEMES.some((item) => item.id === value?.theme) ? value.theme : DEFAULT.theme
  return { mode, theme }
}

export const resolveMode = (mode, systemDark) => (mode === 'system' ? (systemDark ? 'dark' : 'light') : mode)

const hasWindow = typeof window !== 'undefined'
const systemQuery = () => (hasWindow && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

function read() {
  try {
    return normalizeAppearance(JSON.parse(window.localStorage.getItem(APPEARANCE_KEY) || 'null'))
  } catch {
    return { ...DEFAULT }
  }
}

let current = hasWindow ? read() : { ...DEFAULT }
const listeners = new Set()

// The browser's own bar follows the page's surface.
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()
  if (!color) return
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.removeAttribute('media')
    meta.setAttribute('content', color)
  }
}

export function applyAppearance(value = current) {
  if (!hasWindow) return
  const root = document.documentElement
  root.setAttribute('data-mode', resolveMode(value.mode, Boolean(systemQuery()?.matches)))
  root.setAttribute('data-theme', value.theme)
  syncThemeColor()
}

export function getAppearance() {
  return current
}

export function setAppearance(change) {
  current = normalizeAppearance({ ...current, ...change })
  try {
    window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(current))
  } catch {
    /* not remembered; it still applies to this page */
  }
  applyAppearance()
  listeners.forEach((listener) => listener())
}

if (hasWindow) {
  applyAppearance()
  systemQuery()?.addEventListener?.('change', () => {
    if (current.mode !== 'system') return
    applyAppearance()
    listeners.forEach((listener) => listener())
  })
  // Another tab (the console next to a board) changed it.
  window.addEventListener('storage', (event) => {
    if (event.key !== APPEARANCE_KEY) return
    current = read()
    applyAppearance()
    listeners.forEach((listener) => listener())
  })
}

const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// [appearance, setAppearance] for menus.
export function useAppearance() {
  const value = useSyncExternalStore(subscribe, getAppearance, getAppearance)
  return [value, setAppearance]
}

// 'light' or 'dark': the mode in effect (System resolved), for components
// that take a mode of their own (React Flow's canvas, minimap and controls).
const resolvedMode = () => (hasWindow ? resolveMode(current.mode, Boolean(systemQuery()?.matches)) : 'light')
export function useResolvedMode() {
  return useSyncExternalStore(subscribe, resolvedMode, resolvedMode)
}
