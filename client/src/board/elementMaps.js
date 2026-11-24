// Element maps on the board: fetched once per live page (a small cache, so a
// frame that goes live again does not refetch), checked with the same rules
// as a push (cleanElementMap), then used for hit-testing, hover outlines and
// pin placement instead of the live frame's DOM. A page drawn small (its
// screenshot, not live) loads its map too while it is being commented on, so
// a click at any zoom pins to the element under it (Frame.jsx).

import { useEffect, useState } from 'react'
import { cleanElementMap } from '../../../src/capture/element-map.js'

const CACHE_MAX = 12
const cache = new Map() // url -> Promise<map | null>

// The map at `url` (cached), or null when there is none or it does not load.
export function loadElementMap(url) {
  return load(url)
}

function load(url) {
  if (cache.has(url)) {
    const hit = cache.get(url)
    cache.delete(url)
    cache.set(url, hit)
    return hit
  }
  const promise = fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((raw) => (raw ? cleanElementMap(raw) : null))
    .catch(() => null)
  // A failed load is not remembered: the next time the frame goes live tries again.
  promise.then((map) => {
    if (!map) cache.delete(url)
  })
  cache.set(url, promise)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return promise
}

// { map, state }: state is 'off' (no url), 'loading', 'ready' or 'failed'.
export function useElementMap(url) {
  const [result, setResult] = useState({ url: null, map: null, state: 'off' })
  useEffect(() => {
    if (!url) return undefined
    let alive = true
    load(url).then((map) => {
      if (alive) setResult({ url, map, state: map ? 'ready' : 'failed' })
    })
    return () => {
      alive = false
    }
  }, [url])
  if (!url) return { map: null, state: 'off' }
  if (result.url !== url) return { map: null, state: 'loading' }
  return result
}
