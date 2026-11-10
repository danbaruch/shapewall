// The public demo build (`npm run build:demo`, vite.demo.config.js) sets
// __SHAPEWALL_DEMO__; every other build has it false, so `if (DEMO)` code and
// the demo's in-browser backend (client/src/demo, loaded with a dynamic
// import behind that flag) are dropped from them.

import { useSyncExternalStore } from 'react'

export const DEMO = typeof __SHAPEWALL_DEMO__ !== 'undefined' && Boolean(__SHAPEWALL_DEMO__)

// What the demo backend shares with the UI (View as, Reset), set by
// client/src/demo/install.js. Null outside the demo.
let bridge = null
const listeners = new Set()
export function setDemoBridge(value) {
  bridge = value
  listeners.forEach((listener) => listener())
}
export function notifyDemo() {
  listeners.forEach((listener) => listener())
}
const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => (bridge ? bridge.version : 0)

// The demo controls ({ role, roles, setRole, reset, ... }) or null.
export function useDemo() {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return bridge
}

// Attached chat images live in this browser in the demo: their object URLs.
export const demoFiles = new Map()

// Demo boards that show another board's captures (a second project made
// from the same export): board id -> the folder under data/boards/.
export const demoBoardFolders = new Map()
