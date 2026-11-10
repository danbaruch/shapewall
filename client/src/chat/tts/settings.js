// Read-aloud settings, saved in this browser. The system voice's pick stays
// under its own older key (shapewall.voice).

import { DEFAULT_NATURAL_VOICE, SPEEDS, isNaturalVoice } from './voices.js'

export const READ_ALOUD_KEY = 'shapewall.readAloud'
export const DEFAULT_READ_ALOUD = Object.freeze({ natural: false, voice: DEFAULT_NATURAL_VOICE, speed: 1 })

export function normalizeReadAloud(value) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    natural: input.natural === true,
    voice: isNaturalVoice(input.voice) ? input.voice : DEFAULT_NATURAL_VOICE,
    speed: SPEEDS.includes(input.speed) ? input.speed : 1,
  }
}

export function loadReadAloud(storage = globalThis.localStorage) {
  try {
    return normalizeReadAloud(JSON.parse(storage?.getItem(READ_ALOUD_KEY) || 'null'))
  } catch {
    return { ...DEFAULT_READ_ALOUD }
  }
}

export function saveReadAloud(value, storage = globalThis.localStorage) {
  const next = normalizeReadAloud(value)
  try {
    storage?.setItem(READ_ALOUD_KEY, JSON.stringify(next))
  } catch {
    /* private mode */
  }
  return next
}
