// Link secrets in the URL fragment (/invite#<token>, /share#<token>,
// /signup#setup=<code>): browsers never send a fragment, so they stay out of
// server logs. The page keeps the secret in this tab's session storage and
// takes it out of the address bar, so a reload still works and nothing that
// copies the URL copies the secret. A pasted link that only changes the
// fragment does not reload the page: hashchange picks it up.

import { useCallback, useEffect, useState } from 'react'

function stored(key) {
  try {
    return window.sessionStorage.getItem(key) || ''
  } catch {
    return ''
  }
}
function store(key, value) {
  try {
    if (value) window.sessionStorage.setItem(key, value)
    else window.sessionStorage.removeItem(key)
  } catch {
    // Storage off: the secret lives in memory for this page only.
  }
}

// useFragmentSecret({ key, path, parse }) -> { value, forget, accept }
// - parse(fragmentWithoutHash) returns the secret or '' (validate it there)
// - valid(stored): is a kept value still usable (default: parse(v) === v)
// - path: what the address bar shows once the secret is out of it
// - forget(): drop it (used, or the server said it is no good)
// - accept(text): a link or bare secret someone pasted into the page
export function useFragmentSecret({ key, path, parse, valid, keepSearch = false }) {
  const read = useCallback(() => {
    const fresh = parse(window.location.hash.slice(1))
    if (fresh) {
      store(key, fresh)
      window.history.replaceState(null, '', `${path}${keepSearch ? window.location.search : ''}`)
      return fresh
    }
    const kept = stored(key)
    return kept && (valid ? valid(kept) : parse(kept) === kept) ? kept : ''
  }, [key, path, parse, valid, keepSearch])
  const [value, setValue] = useState(read)

  useEffect(() => {
    const onChange = () => {
      if (!window.location.hash) return
      const next = read()
      if (next) setValue(next)
    }
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
    }
  }, [read])

  const forget = useCallback(() => {
    store(key, '')
    setValue('')
  }, [key])
  const accept = useCallback(
    (text) => {
      const raw = String(text || '').trim()
      const fragment = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw
      const next = parse(fragment) || (valid && valid(fragment) ? fragment : '')
      if (!next) return false
      store(key, next)
      setValue(next)
      return true
    },
    [key, parse, valid],
  )
  return { value, forget, accept }
}
