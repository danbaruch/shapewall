// After an upgrade (a new Shapewall version, or a new deploy of the demo), an
// open tab still names the previous build's chunk files, which are gone. The
// fix is one reload, which picks up the new build.
//
// Bounded: at most one automatic reload per page path per release within
// CHUNK_RELOAD_WINDOW_MS, remembered in sessionStorage under a key that
// includes the release, so a newer release starts fresh. Without working
// storage there is no automatic reload at all (it could loop). Once the reload
// is used up, the boundary shows its fallback with a manual reload.
//
// Nothing here reports anything. Reports go through lib/error-tracking.js,
// which is off unless the server set SHAPEWALL_ERROR_DSN.
import { BUILD } from './app-version.js'

const KEY_PREFIX = 'shapewall:chunk-reload:'
export const CHUNK_RELOAD_WINDOW_MS = 10 * 60 * 1000

let pending = false

const sessionStore = () => {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

const defaults = () => ({
  storage: sessionStore(),
  release: BUILD.revision || BUILD.version,
  path: typeof window !== 'undefined' ? window.location.pathname : '/',
  now: Date.now(),
  reload: () => window.location.reload(),
})
const resolve = (deps) => ({ ...defaults(), ...deps })
const reloadKey = ({ release, path }) => KEY_PREFIX + String(release).slice(0, 12) + ':' + path

const read = (storage, key) => {
  try {
    return storage ? storage.getItem(key) : null
  } catch {
    return null
  }
}
const write = (storage, key, value) => {
  try {
    storage?.setItem(key, value)
  } catch {
    /* storage full or blocked: treated as no storage */
  }
}
const withinWindow = (d, key) => {
  const at = Number(read(d.storage, key))
  return Number.isFinite(at) && at > 0 && d.now - at < CHUNK_RELOAD_WINDOW_MS
}

// The messages browsers give for a dynamic import whose file is gone (or that
// came back as HTML), plus Vite's own preload error.
export const isChunkLoadError = (error) => {
  const text = String(error?.message || error || '').toLowerCase()
  return (
    text.includes('failed to fetch dynamically imported module') ||
    text.includes('error loading dynamically imported module') ||
    text.includes('importing a module script failed') ||
    text.includes('unable to preload css') ||
    text.includes('failed to load module script') ||
    text.includes('chunkloaderror') ||
    text.includes('loading chunk')
  )
}

/** True once a recovery reload has started; errors raised meanwhile are noise. */
export const isChunkRecoveryPending = () => pending

/** Pure check: would recoverFromChunkLoad(error) reload, or is one already under way? */
export const canRecoverFromChunkLoad = (error, deps) => {
  if (!isChunkLoadError(error)) return false
  if (pending) return true
  const d = resolve(deps)
  if (!d.storage) return false
  return !withinWindow(d, reloadKey(d))
}

/** Reloads when error is a stale-chunk failure and the budget allows. Returns true while a reload is under way. */
export const recoverFromChunkLoad = (error, deps) => {
  if (!isChunkLoadError(error)) return false
  if (pending) return true
  const d = resolve(deps)
  const key = reloadKey(d)
  if (withinWindow(d, key)) return false
  const stamp = String(d.now)
  write(d.storage, key, stamp)
  // The budget must survive the reload, or this could loop.
  if (read(d.storage, key) !== stamp) return false
  pending = true
  d.reload()
  return true
}

/**
 * Whether an error recovery could not fix should be reported (when reports are
 * on at all). Nothing while a reload is pending; a chunk failure once per page
 * path per release window, so manual reloads do not repeat it.
 */
export const claimErrorReport = (error, deps) => {
  if (pending) return false
  if (!isChunkLoadError(error)) return true
  const d = resolve(deps)
  const key = reloadKey(d) + ':reported'
  if (withinWindow(d, key)) return false
  write(d.storage, key, String(d.now))
  return true
}

// Vite fires vite:preloadError when a lazy import or its preload fails. Start
// the reload at once, but never preventDefault: that makes the import resolve
// to undefined and React.lazy then fails reading .default. Letting it reject
// sends the failure to the nearest ChunkBoundary, which shows a loading state
// until the reload lands. A dynamic import outside React (a plain import() in
// an entry) reaches the window listeners instead.
export function installChunkRecovery(target = typeof window !== 'undefined' ? window : null) {
  if (!target) return
  target.addEventListener('vite:preloadError', (event) => {
    recoverFromChunkLoad(event?.payload)
  })
  target.addEventListener('unhandledrejection', (event) => {
    recoverFromChunkLoad(event?.reason)
  })
  target.addEventListener('error', (event) => {
    recoverFromChunkLoad(event?.error || event?.message)
  })
}

// Tests only.
export const resetChunkRecoveryForTests = () => {
  pending = false
}
