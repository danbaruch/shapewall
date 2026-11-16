import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef } from 'react'
import {
  DICTATION_IDLE,
  DICTATION_SEEN_KEY,
  dictationLang,
  isActive,
  nextDictation,
  spliceSpeech,
  spokenText,
  transcriptParts,
} from '../dictation'

// Dictation for one comment field (the composer, a reply, an edit): the
// browser's speech recognition writes at the caret, the words still being
// heard shown live and replaced as they settle (rules in ../dictation.js).
// It only starts from a press, and it stops on a second press, on Esc, when
// the field goes away (posting, closing the thread or sheet, another
// comment), when the tab is hidden and after QUIET_MS without a word.

const Recognition = () => (typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null)

// Only where it can work: a recognizer, a secure page (https or localhost)
// and a site policy that lets this page use the microphone. Elsewhere
// (Firefox, a plain-http address) there is no button at all.
let supported = null
export function dictationSupported() {
  if (supported !== null) return supported
  if (typeof window === 'undefined' || !Recognition() || !window.isSecureContext) return (supported = false)
  const policy = document.permissionsPolicy || document.featurePolicy
  try {
    supported = !(policy?.allowsFeature && !policy.allowsFeature('microphone'))
  } catch {
    supported = true
  }
  return supported
}

// The privacy line is shown once per browser. Storage blocked (a private
// window): once per page load instead.
let seenHere = false
export function dictationSeen() {
  if (seenHere) return true
  try {
    return window.localStorage.getItem(DICTATION_SEEN_KEY) === '1'
  } catch {
    return false
  }
}
function markSeen() {
  seenHere = true
  try {
    window.localStorage.setItem(DICTATION_SEEN_KEY, '1')
  } catch {
    /* storage blocked: remembered for this page load */
  }
}

const START_MS = 15000
const STOP_MS = 1500
export const QUIET_MS = 30000

// One microphone at a time across the board: starting in one field stops
// any other.
let stopOther = null

// Off for good: no more events, timers cleared, the microphone released.
function detach(current) {
  clearTimeout(current.timer)
  clearTimeout(current.quiet)
  const { rec } = current
  rec.onstart = rec.onresult = rec.onerror = rec.onend = null
  try {
    rec.abort()
  } catch {
    /* already ended */
  }
  if (stopOther === current.cancel) stopOther = null
}

export function useCommentDictation({ value, setValue, inputRef, max = Infinity }) {
  const [state, dispatch] = useReducer(nextDictation, DICTATION_IDLE)
  const session = useRef(null)
  const latest = useRef({ value, setValue, max })
  latest.current = { value, setValue, max }
  const caret = useRef(null)
  const active = isActive(state)
  const noteId = `sw-dictation-${useId().replace(/:/g, '')}`

  const end = useCallback((current, event) => {
    if (session.current !== current) return
    session.current = null
    detach(current)
    dispatch(event)
  }, [])
  const stop = (current) => {
    if (current.stopping) return
    current.stopping = true
    clearTimeout(current.timer)
    clearTimeout(current.quiet)
    // The last words settle before the end; some engines never say so.
    current.timer = setTimeout(() => end(current, 'ended'), STOP_MS)
    try {
      current.rec.stop()
    } catch {
      end(current, 'ended')
    }
  }
  const listenQuietly = (current) => {
    clearTimeout(current.quiet)
    current.quiet = setTimeout(() => {
      if (session.current !== current) return
      dispatch('quiet')
      stop(current)
    }, QUIET_MS)
  }

  const begin = () => {
    stopOther?.()
    const Ctor = Recognition()
    let rec
    try {
      rec = new Ctor()
    } catch {
      return dispatch({ type: 'error', code: 'start' })
    }
    const element = inputRef.current
    const text = latest.current.value
    // At the caret, or over the selection; the end if the field never had focus.
    const ours = element && element.value === text
    const start = ours ? (element.selectionStart ?? text.length) : text.length
    const current = {
      rec,
      base: { value: text, start, end: ours ? (element.selectionEnd ?? start) : start },
      skip: 0,
      seen: 0,
      shown: text,
      caret: null,
      timer: null,
      quiet: null,
      stopping: false,
    }
    current.cancel = () => end(current, 'cancel')
    session.current = current
    stopOther = current.cancel
    rec.lang = dictationLang({ languages: navigator.languages, language: navigator.language, pageLang: document.documentElement.lang })
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onstart = () => {
      if (session.current !== current) return
      clearTimeout(current.timer)
      dispatch('started')
      listenQuietly(current)
    }
    rec.onresult = (event) => {
      if (session.current !== current) return
      current.seen = event.results.length
      if (!current.stopping) listenQuietly(current)
      const spoken = spokenText(transcriptParts(event.results, current.skip))
      if (!spoken) return
      const next = spliceSpeech(current.base.value, current.base, spoken, latest.current.max)
      current.shown = next.value
      current.caret = next.caret
      caret.current = next
      latest.current.setValue(next.value)
    }
    rec.onerror = (event) => end(current, { type: 'error', code: event.error })
    rec.onend = () => end(current, 'ended')
    current.timer = setTimeout(() => end(current, { type: 'error', code: 'start' }), START_MS)
    try {
      rec.start()
    } catch {
      end(current, { type: 'error', code: 'start' })
    }
  }

  // Stop now, keeping every word already in the field. For posting, Esc,
  // Cancel and anything that closes the field.
  const cancel = () => {
    if (session.current) end(session.current, 'cancel')
    else dispatch('cancel')
  }
  const toggle = () => {
    if (session.current) {
      dispatch({ type: 'press' })
      return stop(session.current)
    }
    if (state.status === 'asking') return dispatch({ type: 'press' })
    const seen = dictationSeen()
    dispatch({ type: 'press', seen })
    if (seen) begin()
  }
  // Start and Not now leave with the note: the caret goes back to the field.
  const consent = () => {
    markSeen()
    dispatch('consent')
    begin()
    inputRef.current?.focus({ preventScroll: true })
  }
  const decline = () => {
    dispatch('decline')
    inputRef.current?.focus({ preventScroll: true })
  }

  // The person typed while listening: their text stands, and the next words
  // go where their caret is now. What was still being heard stays as shown.
  const rebase = (text) => {
    const current = session.current
    const element = inputRef.current
    if (!current) return
    const ours = element && element.value === text
    const at = ours ? (element.selectionStart ?? text.length) : text.length
    current.base = { value: text, start: at, end: ours ? (element.selectionEnd ?? at) : at }
    current.skip = current.seen
    current.shown = text
    current.caret = null
    caret.current = null
  }
  const onInput = (text) => {
    if (session.current) rebase(text)
    else if (state.notice && state.status === 'idle') dispatch('dismiss')
  }
  // The caret moved by a click or a key (no edit): follow it.
  const follow = () => {
    const current = session.current
    const element = inputRef.current
    if (!current || !element || element.value !== current.shown) return
    const { selectionStart: from, selectionEnd: to } = element
    const at = current.caret ?? current.base.start
    const until = current.caret ?? current.base.end
    if (from === at && to === until) return
    rebase(element.value)
  }

  // The caret goes after the words just written, once they are in the box.
  useLayoutEffect(() => {
    const next = caret.current
    const element = inputRef.current
    if (!next || !element || element.value !== next.value) return
    caret.current = null
    element.setSelectionRange(next.caret, next.caret)
    if (next.caret >= next.value.length - 1) element.scrollTop = element.scrollHeight
  }, [value, inputRef])

  // Esc stops dictation first (or answers "Not now"); a second Esc does what
  // it always did. Read in the capture phase, before the popover or sheet.
  const asking = state.status === 'asking'
  useEffect(() => {
    if (!active && !asking) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (session.current) end(session.current, 'cancel')
      else dispatch('decline')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, asking, end])

  // A hidden tab or a page being left never keeps the microphone.
  useEffect(() => {
    if (!active) return undefined
    const hide = () => {
      if (document.hidden && session.current) end(session.current, 'cancel')
    }
    const leave = () => session.current && end(session.current, 'cancel')
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
    }
  }, [active, end])

  // The field is gone (posted, closed, another comment): off, silently.
  useEffect(
    () => () => {
      const current = session.current
      if (!current) return
      session.current = null
      detach(current)
    },
    [],
  )

  return {
    supported: dictationSupported(),
    noteId,
    state,
    active,
    toggle,
    consent,
    decline,
    cancel,
    onInput,
    fieldProps: { onMouseUp: follow, onKeyUp: follow },
  }
}
