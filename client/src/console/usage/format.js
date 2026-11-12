// Numbers, times and periods as the Usage and Activity pages show them.
// "Not reported" is a value of its own here: a null number is never shown
// as 0.

export const NOT_REPORTED = 'Not reported'
export const DASH = '–'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat()

// 1,284 in full; 12.9K and 4.2M compact.
export function formatCount(value, { exact = false } = {}) {
  if (value === null || value === undefined) return DASH
  return exact || Math.abs(value) < 10_000 ? full.format(value) : compact.format(value)
}
export const formatExact = (value) => (value === null || value === undefined ? NOT_REPORTED : full.format(value))

// A duration in milliseconds: 850 ms, 12.4 s, 3 min 5 s, 2 h 14 min.
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return DASH
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min${Math.round(seconds % 60) ? ` ${Math.round(seconds % 60)} s` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${full.format(hours)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}
// For an axis: one unit, no second part.
export function formatDurationShort(ms) {
  if (ms === null || ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`
  if (ms < 3_600_000) return `${Math.round(ms / 6000) / 10} min`
  return `${Math.round(ms / 360_000) / 10} h`
}

// Round ticks for a duration axis that reaches `max` milliseconds: steps of
// 1, 2, 5, 10, 15 or 30 seconds or minutes, or whole hours; at most five.
export function durationTicks(max) {
  const steps = [100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000]
  let step = steps.find((size) => max / size <= 4)
  if (!step) step = Math.ceil(max / 4 / 3_600_000) * 3_600_000
  const ticks = []
  for (let value = 0; value < max + step; value += step) ticks.push(value)
  return ticks
}
export function formatDurationTick(ms) {
  if (!ms) return '0'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${ms / 1000} s`
  if (ms < 3_600_000) return `${Math.round(ms / 6000) / 10} min`
  return `${Math.round(ms / 360_000) / 10} h`
}

// A cost the agent reported, in millionths of a US dollar.
export function formatCost(micros) {
  if (micros === null || micros === undefined) return DASH
  const dollars = micros / 1e6
  if (dollars !== 0 && Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: dollars >= 1000 ? 0 : 2 }).format(
    dollars,
  )
}

// A metric's value for a tile, a tooltip or a cell.
export function formatMetric(metric, value, options) {
  if (value === null || value === undefined) return metric === 'calls' ? '0' : NOT_REPORTED
  if (metric === 'duration') return formatDuration(value)
  if (metric === 'cost') return formatCost(value)
  return formatCount(value, options)
}
export function formatAxis(metric, value) {
  if (metric === 'duration') return formatDurationShort(value)
  if (metric === 'cost') return value >= 1e9 ? `$${compact.format(value / 1e6)}` : formatCost(value)
  return compact.format(value)
}

// The change against the period before: "+12%", "-4%", or null when there
// is nothing honest to say (no previous value, or it was zero).
export function change(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null
  const ratio = (current - previous) / previous
  return { ratio, text: `${ratio > 0 ? '+' : ''}${Math.abs(ratio) >= 10 ? Math.round(ratio * 100) : Math.round(ratio * 1000) / 10}%` }
}
export const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : DASH)

// ---- Periods ----

export const PRESETS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['90d', 'Last 90 days'],
  ['month', 'This month'],
]
export const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
const pad = (value) => String(value).padStart(2, '0')
export const dateInput = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const parseDay = (text) => {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(text || '')
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(date.getTime()) ? date : null
}

// The instants a period covers, in the viewer's own time zone: whole local
// days, ending at the end of today. `range`: a preset id, or "custom" with
// `from` and `to` as local dates (both included).
export function periodOf({ range = '30d', from = null, to = null } = {}, now = new Date()) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const daysBack = (count) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - count + 1)
  if (range === 'custom') {
    const first = parseDay(from)
    const last = parseDay(to)
    if (first && last && first <= last)
      return {
        range,
        from: first,
        to: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
        label: `${shortDate(first)} to ${shortDate(last)}`,
      }
    range = '30d'
  }
  if (range === 'today') return { range, from: startOfDay(now), to: tomorrow, label: 'Today' }
  if (range === '7d') return { range, from: daysBack(7), to: tomorrow, label: 'Last 7 days' }
  if (range === '90d') return { range, from: daysBack(90), to: tomorrow, label: 'Last 90 days' }
  if (range === 'month') return { range, from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow, label: 'This month' }
  return { range: '30d', from: daysBack(30), to: tomorrow, label: 'Last 30 days' }
}
export const periodDays = (period) => Math.max(1, Math.round((period.to - period.from) / 86_400_000))
// The bucket that suits a period when none is chosen.
export const defaultBucket = (period) => (periodDays(period) > 120 ? 'month' : periodDays(period) > 45 ? 'week' : 'day')

export function shortDate(date) {
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  })
}
// A bucket key ("2026-11-03") as an axis tick or a tooltip title.
export function bucketLabel(key, bucket, { long = false } = {}) {
  const date = parseDay(key)
  if (!date) return key
  if (bucket === 'month') return date.toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: long ? 'numeric' : '2-digit' })
  const day = date.toLocaleDateString(
    undefined,
    long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' },
  )
  return bucket === 'week' ? `${long ? 'Week of ' : ''}${day}` : day
}
// The instants of one bucket, to narrow the page to it.
export function bucketRange(key, bucket) {
  const first = parseDay(key)
  if (!first) return null
  const last =
    bucket === 'month'
      ? new Date(first.getFullYear(), first.getMonth() + 1, 0)
      : new Date(first.getFullYear(), first.getMonth(), first.getDate() + (bucket === 'week' ? 6 : 0))
  return { from: dateInput(first), to: dateInput(last) }
}

export function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

// Rows of arrays as CSV text (cells quoted; none starts like a formula).
export function toCsv(lines) {
  const cell = (value) => {
    let text = String(value ?? '')
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }
  return `${lines.map((line) => line.map(cell).join(',')).join('\r\n')}\r\n`
}
