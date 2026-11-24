// useResource's state as pure steps (lib/hooks.js), tested in
// test/resource-state.test.js. The state is { url, data, error, loading }:
// `url` is the address the data came from, so the render after the address
// changes shows nothing rather than the old address's answer.

export const EMPTY = Object.freeze({ url: null, data: null, error: null, loading: true })

export const startState = (url) => ({ url, data: null, error: null, loading: true })

// What a caller sees for `url`: the state only when it is about that url.
export const viewFor = (state, url) => (state.url === url ? state : { ...EMPTY, url })

// A setData update: a value, or a function of the current data.
export const applyUpdate = (data, update) => (typeof update === 'function' ? update(data) : update)
export const applyUpdates = (data, updates) => (updates || []).reduce(applyUpdate, data)

// A fetch answered. `queued`: the setData updates made while the first load
// was still out; they go on top of its answer instead of throwing it away.
// `same`: the answer is the JSON of the last one (the state object is kept).
export function landed(current, { url, data, queued = null, same = false }) {
  if (!queued && same && current.url === url && !current.error && !current.loading) return current
  return { url, data: applyUpdates(data, queued), error: null, loading: false }
}

// A fetch failed: the data stays (with the queued updates on it).
export const failed = (current, { url, error, queued = null }) => ({
  url,
  data: applyUpdates(current.url === url ? current.data : null, queued),
  error,
  loading: false,
})
