import { clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The kit's own type scale and shadows (styles.css), so cn() treats
// text-caption as a font size (not a colour) and shadow-lift as a shadow.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['caption', 'ui', 'title', 'heading', 'display'],
      shadow: ['card', 'pop', 'lift', 'thumb'],
    },
  },
})

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

// A demo export is made at a fixed time (`fixturesAt` in its info.json), so
// every build of it has the same files. Times up to that moment are shown as
// if it were now, so the demo never reads as weeks old; later times (comments
// a visitor adds in their browser) are shown as they are.
let fixturesAt = null
let fixtureShift = 0
export function setFixtureClock(value, now = Date.now()) {
  const time = Date.parse(value || '')
  const next = Number.isFinite(time) ? time : null
  if (next === fixturesAt) return
  fixturesAt = next
  fixtureShift = next === null ? 0 : Math.max(0, now - next)
}

// The time to show for a stored time (ms), after the fixture clock.
export function shownTime(value) {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return NaN
  return fixturesAt !== null && time <= fixturesAt ? time + fixtureShift : time
}

export function formatRelative(value, now = Date.now()) {
  const time = shownTime(value)
  if (!Number.isFinite(time)) return ''
  const seconds = Math.round((time - now) / 1000)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

const AUTHOR_KEY = 'shapewall.author'
export function savedAuthor() {
  try {
    return window.localStorage.getItem(AUTHOR_KEY) || ''
  } catch {
    return ''
  }
}
export function saveAuthor(value) {
  try {
    window.localStorage.setItem(AUTHOR_KEY, value)
  } catch {
    /* private mode */
  }
}
