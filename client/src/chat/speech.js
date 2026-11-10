// Voice in (Web Speech recognition) and read aloud (speechSynthesis, or the
// natural voice in tts/, which runs in this browser). Both are optional: where
// a browser lacks them, the composer explains the editable-text fallback.
// Note: Chrome's recognition sends the audio to Google's speech service.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { speakableText } from './Markdown'
import { cancelSpeech, naturalStore, synthesize } from './tts/natural.js'
import { createPlayer, speakQueue } from './tts/queue.js'
import { speakable, splitSentences } from './tts/text.js'
import { SAMPLE_RATE } from './tts/voices.js'

const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined
export const canRecognize = Boolean(Recognition)
export const canSpeak =
  typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'

const MESSAGES = {
  'not-allowed': 'Microphone access was refused. Allow it in your browser settings, or type your message.',
  'service-not-allowed': 'Speech input is unavailable in this browser. You can still type your message.',
  'no-speech': 'No speech was heard. Try again, or type your message.',
  'audio-capture': 'No microphone was found. Connect one, or type your message.',
  network: 'Speech input could not connect. Check your connection, or type your message.',
}

export function dictationUnavailable() {
  if (!window.isSecureContext) return 'Dictation needs a secure connection. You can still type your message.'
  const policy = document.permissionsPolicy || document.featurePolicy
  if (policy?.allowsFeature && !policy.allowsFeature('microphone'))
    return 'Microphone access is blocked by this site. Ask its owner to enable it, or type your message.'
  if (!canRecognize) return 'This browser does not support dictation. Use your keyboard microphone or type your message.'
  return null
}

// A session owns its callbacks. Stop lets the browser finish a transcript;
// cancel detaches first, so a late permission grant/result cannot edit a draft.
export function useDictation(onText) {
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState(null)
  const recognition = useRef(null)
  const callback = useRef(onText)
  callback.current = onText
  const finish = useCallback((session) => {
    if (recognition.current !== session) return
    recognition.current = null
    clearTimeout(session.timer)
    session.instance.onstart = session.instance.onresult = session.instance.onerror = session.instance.onend = null
    try {
      session.instance.abort()
    } catch {
      /* already ended */
    }
    setPhase('idle')
  }, [])
  const cancel = useCallback(() => {
    if (recognition.current) finish(recognition.current)
  }, [finish])
  const stop = useCallback(() => {
    const session = recognition.current
    if (!session) return
    if (!session.started) return finish(session)
    if (session.stopping) return
    session.stopping = true
    clearTimeout(session.timer)
    setPhase('stopping')
    // Some engines never emit end after stop. Keep the current editable text.
    session.timer = setTimeout(() => finish(session), 1500)
    try {
      session.instance.stop()
    } catch {
      finish(session)
    }
  }, [finish])
  const start = useCallback(() => {
    if (recognition.current) return
    const unavailable = dictationUnavailable()
    if (unavailable) return setError(unavailable)
    let instance
    try {
      instance = new Recognition()
    } catch {
      return setError('Speech input could not start. You can still type your message.')
    }
    const session = { instance, started: false, timer: null }
    recognition.current = session
    instance.lang = navigator.language || 'en-US'
    instance.interimResults = true
    instance.continuous = false
    instance.onstart = () => {
      if (recognition.current !== session) return
      session.started = true
      clearTimeout(session.timer)
      setPhase('listening')
      session.timer = setTimeout(() => {
        finish(session)
        setError('Dictation stopped after one minute. Review your message or start again.')
      }, 60000)
    }
    instance.onresult = (event) => {
      if (recognition.current !== session) return
      // Results are a cumulative snapshot, not a delta. Replace interim words.
      const text = Array.from(event.results, (result) => result[0].transcript.trim()).join(' ')
      callback.current(text)
    }
    instance.onerror = (event) => {
      if (recognition.current !== session) return
      finish(session)
      if (event.error !== 'aborted') setError(MESSAGES[event.error] || 'Speech input stopped. Review your message or try again.')
    }
    instance.onend = () => finish(session)
    setError(null)
    setPhase('starting')
    session.timer = setTimeout(() => {
      finish(session)
      setError('Microphone did not start. Check browser permissions, or type your message.')
    }, 15000)
    try {
      instance.start()
    } catch {
      finish(session)
      setError('Speech input could not start. You can still type your message.')
    }
  }, [finish])
  useEffect(() => () => cancel(), [cancel])
  useEffect(() => {
    const hide = () => {
      if (document.hidden) cancel()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', cancel)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', cancel)
    }
  }, [cancel])
  return { listening: phase !== 'idle', phase, start, stop, cancel, error }
}

// ---- Read aloud ---------------------------------------------------------------

const VOICE_KEY = 'shapewall.voice'
const voiceListeners = new Set()
let voices = []
function loadVoices() {
  voices = canSpeak ? window.speechSynthesis.getVoices() : []
  voiceListeners.forEach((listener) => listener())
}
if (canSpeak) {
  loadVoices()
  window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices)
}

export function useVoices() {
  return useSyncExternalStore(
    (listener) => {
      voiceListeners.add(listener)
      return () => voiceListeners.delete(listener)
    },
    () => voices,
    () => voices,
  )
}

export function savedVoice() {
  try {
    return window.localStorage.getItem(VOICE_KEY) || ''
  } catch {
    return ''
  }
}
export function saveVoice(uri) {
  try {
    if (uri) window.localStorage.setItem(VOICE_KEY, uri)
    else window.localStorage.removeItem(VOICE_KEY)
  } catch {
    /* private mode */
  }
}

// One message reads at a time, with the natural voice when it is on and
// loaded (tts/), else the system voice. Returns { speakingId, paused,
// engine, speak(id, markdown, { voiceUri, readAloud }), pause, resume, stop }.
export function useSpeaker() {
  const [speakingId, setSpeakingId] = useState(null)
  const [paused, setPaused] = useState(false)
  const [engine, setEngine] = useState(null)
  const [error, setError] = useState(null)
  const run = useRef(null)
  const player = useRef(null)

  const finish = useCallback((session) => {
    if (run.current !== session) return
    run.current = null
    setSpeakingId(null)
    setPaused(false)
    setEngine(null)
  }, [])

  const stop = useCallback(() => {
    run.current?.controller.abort()
    run.current = null
    cancelSpeech()
    player.current?.stop()
    if (canSpeak) window.speechSynthesis.cancel()
    setSpeakingId(null)
    setPaused(false)
    setEngine(null)
  }, [])

  const speakSystem = useCallback(
    (session, text, voiceUri, rate) => {
      if (run.current !== session) return
      const id = session.id
      if (!canSpeak || !text) return finish(session)
      window.speechSynthesis.cancel()
      const utterance = new window.SpeechSynthesisUtterance(text)
      const voice = window.speechSynthesis.getVoices().find((item) => item.voiceURI === voiceUri)
      if (voice) utterance.voice = voice
      utterance.lang = voice?.lang || navigator.language || 'en-US'
      utterance.rate = rate || 1
      utterance.onend = () => finish(session)
      utterance.onerror = (event) => {
        if (run.current !== session) return
        if (!['canceled', 'interrupted'].includes(event.error))
          setError({ id, text: 'This voice could not play. Choose another voice in Chat settings and try again.' })
        finish(session)
      }
      setEngine('system')
      try {
        window.speechSynthesis.speak(utterance)
      } catch {
        setError({ id, text: 'This voice could not start. Choose another voice in Chat settings and try again.' })
        finish(session)
      }
    },
    [finish],
  )

  const speak = useCallback(
    (id, markdown, { voiceUri = '', readAloud = {} } = {}) => {
      stop()
      setError(null)
      const controller = new AbortController()
      const session = { id, controller }
      run.current = session
      setSpeakingId(id)
      const natural = readAloud.natural && naturalStore.get().status === 'ready'
      if (!natural) return speakSystem(session, speakableText(markdown), voiceUri, readAloud.speed)
      // Inside the click: browsers only start audio from a user gesture.
      try {
        player.current ??= createPlayer(SAMPLE_RATE)
        player.current.unlock()
      } catch {
        return speakSystem(session, speakableText(markdown), voiceUri, readAloud.speed)
      }
      setEngine('natural')
      const sentences = splitSentences(speakable(speakableText(markdown, { lines: true })))
      speakQueue({
        sentences,
        synthesize: (sentence) => synthesize(sentence, { voice: readAloud.voice, speed: readAloud.speed }),
        play: (samples) => player.current.play(samples),
        signal: controller.signal,
      })
        .then(() => finish(session))
        .catch((error) => {
          if (controller.signal.aborted) return
          // The rest of the message in the system voice; the worker drops
          // the sentences still queued for the natural one.
          cancelSpeech()
          speakSystem(session, sentences.slice(error.index ?? 0).join(' '), voiceUri, readAloud.speed)
        })
    },
    [finish, speakSystem, stop],
  )

  const pause = useCallback(() => {
    if (!run.current) return
    if (engine === 'natural') player.current?.pause()
    else if (canSpeak) window.speechSynthesis.pause()
    setPaused(true)
  }, [engine])

  const resume = useCallback(() => {
    if (!run.current) return
    if (engine === 'natural') player.current?.resume()
    else if (canSpeak) window.speechSynthesis.resume()
    setPaused(false)
  }, [engine])

  useEffect(
    () => () => {
      stop()
      player.current?.close()
      player.current = null
    },
    [stop],
  )
  useEffect(() => {
    const hide = () => {
      if (document.hidden) stop()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', stop)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', stop)
    }
  }, [stop])
  return useMemo(
    () => ({ speakingId, paused, engine, error, speak, pause, resume, stop }),
    [speakingId, paused, engine, error, speak, pause, resume, stop],
  )
}

export function useNatural() {
  return useSyncExternalStore(naturalStore.subscribe, naturalStore.get, naturalStore.get)
}
