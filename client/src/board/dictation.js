// Dictation in a comment, a reply or an edit: the browser's own speech
// recognition (SpeechRecognition / webkitSpeechRecognition) writes into the
// field at the caret. Kept pure, so the rules can be read and tested without
// a browser (test/comment-dictation.test.js); the hook that drives the
// recognizer is useCommentDictation.js and the button is DictationButton.jsx.
//
// Privacy: Shapewall never sees the audio. The browser's speech service does
// the transcription (in Chrome that is Google's), so dictation only ever
// starts from an explicit press, and the first press says so once.

// Remembered once someone has read the privacy line and started dictation.
export const DICTATION_SEEN_KEY = 'shapewall.dictation.seen'

// Speech engines pad and double their spaces; one line of plain words.
export function normalizeSpeech(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A recognizer's results (a SpeechRecognitionResultList, or any list of
// { isFinal, 0: { transcript } }) from index `from`: the settled words and the
// words still being heard, each as one normalized string.
export function transcriptParts(results, from = 0) {
  const finals = []
  const interims = []
  const list = results ? Array.from(results) : []
  for (let index = Math.max(0, from); index < list.length; index += 1) {
    const result = list[index]
    const text = normalizeSpeech(result?.[0]?.transcript)
    if (!text) continue
    ;(result.isFinal ? finals : interims).push(text)
  }
  return { final: finals.join(' '), interim: interims.join(' ') }
}

// The spoken words to show: what is settled, then what is still being heard.
export const spokenText = ({ final, interim }) => normalizeSpeech(`${final} ${interim}`)

// Whether text typed right after `before` starts a sentence: an empty field,
// a new line, or the end of a sentence (". ", "?", "!", even inside a quote).
export function startsSentence(before) {
  if (!before.trim()) return true
  if (/\n[ \t]*$/.test(before)) return true
  return /[.!?…]["'”’)\]]*\s+$/.test(before) || /[.!?…]["'”’)\]]*$/.test(before)
}

const capitalize = (text) => text.replace(/^(\P{L}*)(\p{Ll})/u, (all, lead, letter) => lead + letter.toLocaleUpperCase())

// Characters after which the next word follows with no space: a space or a
// new line already there, an opening bracket or quote, a mention's @ or a #.
const OPENS = /[\s([{"'“‘@#/-]$/
// Characters a spoken word joins with no space before: closing punctuation.
const CLOSES = /^[,.!?;:…%)\]}"'”’]/

// The field's text with `spoken` written over the range `start`..`end` (the
// caret, or the selection it replaces): a space where words meet, a capital
// at the start of a sentence (never a lowercase one: engines capitalize
// names), and no more than `max` characters in all. Returns the new text and
// the caret, just after the spoken words.
export function spliceSpeech(value, { start, end = start }, spoken, max = Infinity) {
  const text = String(value ?? '')
  const from = Math.max(0, Math.min(start ?? text.length, text.length))
  const to = Math.max(from, Math.min(end ?? from, text.length))
  const before = text.slice(0, from)
  const after = text.slice(to)
  let words = normalizeSpeech(spoken)
  if (!words) return { value: text, caret: to }
  if (startsSentence(before)) words = capitalize(words)
  const lead = before && !OPENS.test(before) && !CLOSES.test(words) ? ' ' : ''
  const trail = after && !/^\s/.test(after) && !CLOSES.test(after) ? ' ' : ''
  const room = Math.max(0, max - before.length - after.length)
  let insert = `${lead}${words}${trail}`
  if (insert.length > room) insert = insert.slice(0, room)
  return { value: before + insert + after, caret: before.length + Math.min(insert.length, lead.length + words.length) }
}

// The dictation states. `status`: idle, asking (the first press shows the
// privacy line, with Start and Not now), starting (waiting for the
// microphone), listening, stopping (the last words are being settled).
// `notice`: what the line under the field says, or null.
export const DICTATION_IDLE = { status: 'idle', notice: null }

export const isActive = (state) => state.status === 'starting' || state.status === 'listening' || state.status === 'stopping'

// One step. Events: { type: 'press', seen }, 'consent', 'decline', 'started',
// 'result', { type: 'error', code }, 'ended', 'quiet', 'cancel', 'dismiss'.
// Every way out of a session lands on idle, so the microphone is never left
// on by a missed event.
export function nextDictation(state, event) {
  const type = typeof event === 'string' ? event : event?.type
  switch (type) {
    case 'press':
      if (isActive(state)) return state.status === 'stopping' ? state : { status: 'stopping', notice: null }
      if (state.status === 'asking') return DICTATION_IDLE
      return event.seen ? { status: 'starting', notice: null } : { status: 'asking', notice: 'privacy' }
    case 'consent':
      return state.status === 'asking' ? { status: 'starting', notice: null } : state
    case 'decline':
      return state.status === 'asking' ? DICTATION_IDLE : state
    case 'started':
      return state.status === 'starting' ? { status: 'listening', notice: null } : state
    case 'error': {
      if (!isActive(state)) return state
      // Our own abort, or a stop that the engine reports as one.
      if (event.code === 'aborted' || state.status === 'stopping') return { status: 'idle', notice: state.notice }
      return { status: 'idle', notice: DICTATION_MESSAGES[event.code] ? event.code : 'failed' }
    }
    case 'ended':
      // Ended by itself (a long pause, the engine's own limit): say so, calmly.
      if (state.status === 'stopping') return { status: 'idle', notice: state.notice }
      return isActive(state) ? { status: 'idle', notice: 'ended' } : state
    case 'quiet':
      return state.status === 'listening' ? { status: 'stopping', notice: 'ended' } : state
    case 'cancel':
      return state.status === 'idle' && !state.notice ? state : DICTATION_IDLE
    case 'dismiss':
      return state.notice && !isActive(state) && state.status !== 'asking' ? { ...state, notice: null } : state
    default:
      return state
  }
}

// The line under the field, by notice. `tone`: info (muted) or error.
export const DICTATION_MESSAGES = {
  privacy: {
    tone: 'info',
    text: "Your browser's speech service (Google's, in Chrome) turns your voice into text. Shapewall never receives or stores the audio.",
  },
  ended: { tone: 'info', text: 'Dictation stopped. Press the microphone to keep going.' },
  'not-allowed': { tone: 'error', text: 'Microphone access is blocked. Allow it for this site in your browser, then try again.' },
  'service-not-allowed': { tone: 'error', text: "This browser's speech service is not available here. You can still type." },
  'audio-capture': { tone: 'error', text: 'No microphone was found. Connect one and try again.' },
  'no-speech': { tone: 'error', text: 'No speech was heard. Press the microphone and try again.' },
  network: { tone: 'error', text: "The browser's speech service could not be reached. Check your connection and try again." },
  'language-not-supported': { tone: 'error', text: "Dictation isn't available in your browser's language." },
  start: { tone: 'error', text: 'The microphone did not start. Check its permission for this site and try again.' },
  failed: { tone: 'error', text: 'Dictation stopped unexpectedly. Try again, or type.' },
}

// The language to listen for: the browser's own first language (the one the
// person speaks; Shapewall's interface is English whatever they write in),
// then the page's, then US English.
export function dictationLang({ languages = [], language = '', pageLang = '' } = {}) {
  const valid = (tag) => typeof tag === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag)
  return [...(languages || []), language, pageLang].find(valid) || 'en-US'
}
