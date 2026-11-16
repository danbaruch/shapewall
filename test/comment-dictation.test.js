// Dictation in a comment field: where the spoken words land and how they
// join the text around them, and the states a session moves through
// (client/src/board/dictation.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DICTATION_IDLE,
  DICTATION_MESSAGES,
  dictationLang,
  isActive,
  nextDictation,
  normalizeSpeech,
  spliceSpeech,
  spokenText,
  startsSentence,
  transcriptParts,
} from '../client/src/board/dictation.js'

// A recognizer result list, like Chrome's: [text, isFinal] pairs.
const results = (...items) => items.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript }, length: 1 }))

test('speech is one line of single spaces', () => {
  assert.equal(normalizeSpeech('  hello   there \n friend '), 'hello there friend')
  assert.equal(normalizeSpeech(undefined), '')
})

test('settled and still-heard words are kept apart, from a starting result', () => {
  const list = results([' the logo', true], [' is too small', true], [' on pho', false])
  assert.deepEqual(transcriptParts(list), { final: 'the logo is too small', interim: 'on pho' })
  assert.deepEqual(transcriptParts(list, 2), { final: '', interim: 'on pho' })
  assert.deepEqual(transcriptParts(list, 9), { final: '', interim: '' })
  assert.equal(spokenText(transcriptParts(list)), 'the logo is too small on pho')
  assert.deepEqual(transcriptParts(null), { final: '', interim: '' })
})

test('a sentence starts in an empty field, after a new line and after . ! ?', () => {
  assert.equal(startsSentence(''), true)
  assert.equal(startsSentence('   '), true)
  assert.equal(startsSentence('First line\n'), true)
  assert.equal(startsSentence('Looks good. '), true)
  assert.equal(startsSentence('Looks good.'), true)
  assert.equal(startsSentence('Really?" '), true)
  assert.equal(startsSentence('The logo '), false)
  assert.equal(startsSentence('Pricing, '), false)
})

test('into an empty field: capitalised, the caret after the words', () => {
  assert.deepEqual(spliceSpeech('', { start: 0 }, 'the logo is small'), { value: 'The logo is small', caret: 17 })
})

test('at the end of a sentence: a space, then a capital', () => {
  const { value, caret } = spliceSpeech('Looks good.', { start: 11 }, 'make it bigger')
  assert.equal(value, 'Looks good. Make it bigger')
  assert.equal(caret, value.length)
  assert.equal(spliceSpeech('Looks good. ', { start: 12 }, 'make it bigger').value, 'Looks good. Make it bigger')
})

test('mid-sentence: one space each side, case left as spoken', () => {
  const text = 'Make the  bigger'
  const { value, caret } = spliceSpeech(text, { start: 9 }, 'logo')
  assert.equal(value, 'Make the logo bigger')
  assert.equal(value.slice(0, caret), 'Make the logo')
  assert.equal(spliceSpeech('Make thebigger', { start: 8 }, 'logo').value, 'Make the logo bigger')
  // Names stay capitalised: never lowercased.
  assert.equal(spliceSpeech('Ask ', { start: 4 }, 'Robin about it').value, 'Ask Robin about it')
})

test('replaces the selection', () => {
  const text = 'The button is blue on hover'
  const start = text.indexOf('blue')
  const { value } = spliceSpeech(text, { start, end: start + 4 }, 'dark green')
  assert.equal(value, 'The button is dark green on hover')
})

test('no space before closing punctuation, none after an opening bracket or @', () => {
  assert.equal(spliceSpeech('Hello', { start: 5 }, ', world').value, 'Hello, world')
  assert.equal(spliceSpeech('Hello world', { start: 5 }, 'big').value, 'Hello big world')
  assert.equal(spliceSpeech('The logo.', { start: 8 }, 'please').value, 'The logo please.')
  assert.equal(spliceSpeech('See (', { start: 5 }, 'below').value, 'See (below')
  assert.equal(spliceSpeech('Ping @', { start: 6 }, 'robin').value, 'Ping @robin')
})

test('nothing heard leaves the text and the selection alone', () => {
  assert.deepEqual(spliceSpeech('Keep me', { start: 0, end: 4 }, '   '), { value: 'Keep me', caret: 4 })
})

test('never past the length limit', () => {
  const { value, caret } = spliceSpeech('abcd', { start: 4 }, 'efgh ijkl', 8)
  assert.equal(value.length, 8)
  assert.equal(value, 'abcd efg')
  assert.equal(caret, 8)
  assert.equal(spliceSpeech('abcdefgh', { start: 8 }, 'more', 8).value, 'abcdefgh')
})

test('a caret out of range is clamped', () => {
  assert.equal(spliceSpeech('Hi', { start: 99 }, 'there').value, 'Hi there')
  assert.equal(spliceSpeech('Hi', { start: -3 }, 'oh').value, 'Oh Hi')
})

const run = (events, state = DICTATION_IDLE) => events.reduce(nextDictation, state)

test('first press asks once (the privacy line); Start begins, Not now goes back', () => {
  const asking = run([{ type: 'press', seen: false }])
  assert.deepEqual(asking, { status: 'asking', notice: 'privacy' })
  assert.equal(isActive(asking), false, 'nothing listens while asking')
  assert.deepEqual(run(['consent'], asking), { status: 'starting', notice: null })
  assert.deepEqual(run(['decline'], asking), DICTATION_IDLE)
  assert.deepEqual(run([{ type: 'press' }], asking), DICTATION_IDLE, 'a second press on the mic also closes it')
})

test('seen before: a press starts, started listens, a press stops, the end is idle and quiet', () => {
  const states = []
  let state = DICTATION_IDLE
  for (const event of [{ type: 'press', seen: true }, 'started', 'result', { type: 'press' }, 'ended']) {
    state = nextDictation(state, event)
    states.push(state.status)
  }
  assert.deepEqual(states, ['starting', 'listening', 'listening', 'stopping', 'idle'])
  assert.equal(state.notice, null)
})

test('errors land on idle with a plain message; our own abort says nothing', () => {
  const listening = run([{ type: 'press', seen: true }, 'started'])
  for (const code of ['not-allowed', 'audio-capture', 'no-speech', 'network', 'service-not-allowed', 'language-not-supported']) {
    const state = nextDictation(listening, { type: 'error', code })
    assert.deepEqual(state, { status: 'idle', notice: code })
    assert.ok(DICTATION_MESSAGES[code].text.length > 10)
    assert.equal(DICTATION_MESSAGES[code].tone, 'error')
    assert.doesNotMatch(DICTATION_MESSAGES[code].text, /—/, 'no em dashes')
  }
  assert.deepEqual(nextDictation(listening, { type: 'error', code: 'aborted' }), DICTATION_IDLE)
  assert.deepEqual(nextDictation(listening, { type: 'error', code: 'something-new' }), { status: 'idle', notice: 'failed' })
  // A start that never came.
  assert.deepEqual(
    run([
      { type: 'press', seen: true },
      { type: 'error', code: 'start' },
    ]),
    { status: 'idle', notice: 'start' },
  )
  // After a stop, a late error is just the end.
  assert.deepEqual(run([{ type: 'press' }, { type: 'error', code: 'no-speech' }], listening), DICTATION_IDLE)
})

test('ending by itself says so; a long quiet stops with the same note', () => {
  const listening = run([{ type: 'press', seen: true }, 'started'])
  assert.deepEqual(nextDictation(listening, 'ended'), { status: 'idle', notice: 'ended' })
  assert.deepEqual(run(['quiet', 'ended'], listening), { status: 'idle', notice: 'ended' })
  assert.equal(DICTATION_MESSAGES.ended.tone, 'info')
})

test('cancel always lands on idle with nothing said; dismiss clears a note', () => {
  const listening = run([{ type: 'press', seen: true }, 'started'])
  assert.deepEqual(nextDictation(listening, 'cancel'), DICTATION_IDLE)
  assert.deepEqual(nextDictation({ status: 'asking', notice: 'privacy' }, 'cancel'), DICTATION_IDLE)
  const failed = nextDictation(listening, { type: 'error', code: 'network' })
  assert.deepEqual(nextDictation(failed, 'dismiss'), DICTATION_IDLE)
  assert.deepEqual(nextDictation(listening, 'dismiss'), listening, 'dismiss never stops a session')
  assert.equal(nextDictation(DICTATION_IDLE, 'cancel'), DICTATION_IDLE)
})

test('stray events do not start anything', () => {
  for (const event of ['started', 'ended', 'quiet', 'consent', 'decline', { type: 'error', code: 'network' }]) {
    assert.deepEqual(nextDictation(DICTATION_IDLE, event), DICTATION_IDLE, JSON.stringify(event))
  }
  const stopping = run([{ type: 'press', seen: true }, 'started', { type: 'press' }])
  assert.equal(nextDictation(stopping, { type: 'press' }), stopping, 'pressing while stopping waits for the end')
})

test('the language: the browser first, then the page, then US English', () => {
  assert.equal(dictationLang({ languages: ['de-DE', 'en-US'], language: 'de-DE', pageLang: 'en' }), 'de-DE')
  assert.equal(dictationLang({ languages: [], language: 'fr-CA', pageLang: 'en' }), 'fr-CA')
  assert.equal(dictationLang({ pageLang: 'en' }), 'en')
  assert.equal(dictationLang({ languages: ['not a tag'] }), 'en-US')
  assert.equal(dictationLang(), 'en-US')
})

test('the privacy line says who transcribes and that Shapewall keeps nothing', () => {
  assert.match(DICTATION_MESSAGES.privacy.text, /browser's speech service/)
  assert.match(DICTATION_MESSAGES.privacy.text, /Shapewall never receives or stores the audio/)
})
