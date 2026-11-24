// Chart colours. One palette for every chart on the Usage pages, picked for
// each mode and checked for colour-blind readers (adjacent pairs keep their
// distance under protan, deutan and tritan simulation; the same seven hues
// in both modes, stepped for the surface they sit on).
//
// Colour is never the only channel: every chart with two or more series has a
// legend, a table view, and labels on its marks where they fit; "not
// reported" is a hatch, not a colour.
//
// Colour follows the thing, not its rank: an agent keeps its colour while
// filters come and go (colorFor remembers what it gave out for the session).

import { useMemo } from 'react'
import { useResolvedMode } from '../../lib/theme'

export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
}
// How a turn ended. Reserved: never used for "series 4". Shown with a label.
export const STATUS = {
  completed: '#0ca30c',
  needs_person: '#fab219',
  failed: '#d03b3b',
  stopped: '#ec835a',
  other: '#898781',
  running: '#3987e5',
}
// Approvals: allowed by a person, allowed without asking, denied.
export const APPROVAL = { person: 0, auto: 3, denied: 'failed' }

const INK = {
  light: { surface: '#ffffff', text: '#18181b', muted: '#55555f', grid: '#e7e7ea', axis: '#b4b4bd', other: '#a1a1aa', track: '#f1f1f3' },
  dark: { surface: '#17171b', text: '#f4f4f5', muted: '#a1a1aa', grid: '#2a2a31', axis: '#4a4a55', other: '#6b6b76', track: '#222228' },
}

// Which palette slot each thing holds, per dimension, for this session.
const assigned = new Map()
export function slotFor(dimension, key) {
  if (!assigned.has(dimension)) assigned.set(dimension, new Map())
  const slots = assigned.get(dimension)
  if (!slots.has(key)) {
    // The lowest slot that is least used so far.
    const counts = Array(SERIES.light.length).fill(0)
    for (const slot of slots.values()) counts[slot] += 1
    slots.set(key, counts.indexOf(Math.min(...counts)))
  }
  return slots.get(key)
}

export function useChartTheme() {
  const mode = useResolvedMode() === 'dark' ? 'dark' : 'light'
  return useMemo(() => {
    const ink = INK[mode]
    return {
      mode,
      ...ink,
      series: SERIES[mode],
      // The colour of one group of a dimension. "Other" is neutral.
      colorFor(dimension, key) {
        if (key === '__other') return ink.other
        if (dimension === 'outcome') return STATUS[key] || ink.other
        return SERIES[mode][slotFor(dimension, key)]
      },
      status: STATUS,
    }
  }, [mode])
}
