// The natural read-aloud voice (client/src/chat/tts): sentence splitting and
// chunking, the speaking queue (order, look-ahead, stop, failure hand-off),
// saved settings, device support, and the phonemizer with its developer-term
// overrides and IPA mapping. No model is downloaded here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { misakiEnglish } from '@titan-design/speech-g2p'
import { CHUNK_MAX, FIRST_MAX, chunk, speakable, splitSentences } from '../client/src/chat/tts/text.js'
import { createPlayer, speakQueue } from '../client/src/chat/tts/queue.js'
import { DEFAULT_READ_ALOUD, READ_ALOUD_KEY, loadReadAloud, normalizeReadAloud, saveReadAloud } from '../client/src/chat/tts/settings.js'
import { naturalSupport } from '../client/src/chat/tts/support.js'
import {
  NATURAL_VOICES,
  DEFAULT_NATURAL_VOICE,
  DOWNLOAD_MB,
  MODEL_BYTES,
  MODEL_FILE,
  MODEL_SHA256,
  TOKENIZER_FILE,
  VOICE_BYTES,
  modelUrl,
  pinFor,
  voiceUrl,
} from '../client/src/chat/tts/voices.js'
import { INTEGRITY_CODE, IntegrityError, sha256, verifyBytes } from '../client/src/chat/tts/verify.js'
import { createHash } from 'node:crypto'
import { OVERRIDES, createG2p, ipaToMisaki, keepKnown, spellLetters } from '../client/src/chat/tts/g2p.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { EnglishG2P } = require('phonemize/en-g2p')

test('sentences: split at sentence ends, not at abbreviations, initials or decimals; lines always split', () => {
  assert.deepEqual(splitSentences('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!'])
  assert.deepEqual(splitSentences('Use e.g. the CLI. Version 2.1 is out.'), ['Use e.g. the CLI.', 'Version 2.1 is out.'])
  assert.deepEqual(splitSentences('Ask J. Smith about it. Then ship.'), ['Ask J. Smith about it.', 'Then ship.'])
  assert.deepEqual(splitSentences('Open items\nHome: 2 open\nPricing: 1 open'), ['Open items', 'Home: 2 open', 'Pricing: 1 open'])
  assert.deepEqual(splitSentences('He said "done." Then left.'), ['He said "done."', 'Then left.'])
  assert.deepEqual(splitSentences('  \n\n '), [])
})

test('sentences: a long first sentence is cut at its first comma so audio starts sooner', () => {
  const first = 'The pricing page has three open comments, two about the Plus card and one about the footer links.'
  assert.ok(first.length > FIRST_MAX)
  assert.deepEqual(splitSentences(`${first} Fix those next.`), [
    'The pricing page has three open comments,',
    'two about the Plus card and one about the footer links.',
    'Fix those next.',
  ])
  // Without punctuation near the start it stays whole.
  const plain = 'This sentence has no comma anywhere near the start and so it stays in one piece for the voice to read'
  assert.deepEqual(splitSentences(plain), [plain])
})

test('chunks: long sentences split under the model limit, at punctuation, never inside a word', () => {
  const long = Array.from({ length: 40 }, (_, i) => `clause number ${i}`).join(', ')
  const parts = chunk(long)
  assert.ok(parts.length > 1)
  for (const part of parts) assert.ok(part.length <= CHUNK_MAX, part)
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long)
  const word = 'x'.repeat(500)
  assert.ok(chunk(word).every((part) => part.length <= CHUNK_MAX))
})

test('speakable: file names and framework names read as words', () => {
  assert.equal(speakable('Edit ChatPanel.jsx and run Node.js.'), 'Edit ChatPanel dot J S X and run Node J S.')
  assert.equal(speakable('See src/chat/speech.js'), 'See src chat speech dot J S')
  assert.equal(speakable('Visit example.com today'), 'Visit example.com today')
  assert.equal(speakable('one\ntwo'), 'one\ntwo')
})

function fakeAudio() {
  const log = []
  let synthCalls = 0
  return {
    log,
    get synthCalls() {
      return synthCalls
    },
    synthesize: async (text) => {
      synthCalls += 1
      log.push(`make ${text}`)
      await new Promise((resolve) => setTimeout(resolve, 2))
      return new Float32Array(text.length)
    },
    play: async (samples) => {
      log.push(`play ${samples.length}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
}

test('queue: speaks in order and makes the next sentence while one plays', async () => {
  const audio = fakeAudio()
  const result = await speakQueue({ sentences: ['a', 'bb', 'ccc'], synthesize: audio.synthesize, play: audio.play, lookahead: 2 })
  assert.equal(result, 'done')
  assert.deepEqual(
    audio.log.filter((line) => line.startsWith('play')),
    ['play 1', 'play 2', 'play 3'],
  )
  // Sentence 2 was requested before sentence 1 finished playing.
  assert.ok(audio.log.indexOf('make bb') < audio.log.indexOf('play 1') + 2)
  assert.ok(audio.log.indexOf('make bb') < audio.log.indexOf('play 2'))
})

test('queue: stop ends it between sentences and makes nothing more', async () => {
  const audio = fakeAudio()
  const controller = new AbortController()
  const result = await speakQueue({
    sentences: ['one', 'two', 'three', 'four', 'five'],
    synthesize: audio.synthesize,
    play: async (samples) => {
      await audio.play(samples)
      controller.abort()
    },
    signal: controller.signal,
    lookahead: 1,
  })
  assert.equal(result, 'stopped')
  assert.equal(audio.log.filter((line) => line.startsWith('play')).length, 1)
  assert.ok(audio.synthCalls <= 2)
})

test('queue: a failed sentence rejects with its index, so the rest can be read another way', async () => {
  const played = []
  await assert.rejects(
    speakQueue({
      sentences: ['ok', 'broken', 'later'],
      synthesize: async (text) => {
        if (text === 'broken') throw new Error('model gone')
        return new Float32Array(4)
      },
      play: async () => played.push(1),
    }),
    (error) => error.message === 'model gone' && error.index === 1,
  )
  assert.equal(played.length, 1)
})

test('player: close frees the audio context, and a later play opens a new one', async () => {
  const contexts = []
  class FakeContext {
    state = 'running'
    closed = 0
    constructor() {
      contexts.push(this)
    }
    close() {
      this.closed += 1
      this.state = 'closed'
      return Promise.resolve()
    }
  }
  const player = createPlayer(24000, FakeContext)
  await player.close() // nothing opened yet: nothing to close
  assert.equal(contexts.length, 0)
  player.unlock()
  assert.equal(contexts.length, 1)
  await player.close()
  assert.equal(contexts[0].closed, 1)
  assert.equal(player.context, null)
  player.unlock()
  assert.equal(contexts.length, 2)
  // A context that refuses to close does not throw into the unmount.
  contexts[1].close = () => {
    throw new Error('already closed')
  }
  await player.close()
})

function memoryStorage() {
  const data = new Map()
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), data }
}

test('settings: defaults, saved choice, and bad values falling back', () => {
  const storage = memoryStorage()
  assert.deepEqual(loadReadAloud(storage), DEFAULT_READ_ALOUD)
  assert.equal(DEFAULT_READ_ALOUD.natural, false, 'natural voices are off until chosen')
  const saved = saveReadAloud({ natural: true, voice: 'am_michael', speed: 1.2 }, storage)
  assert.deepEqual(saved, { natural: true, voice: 'am_michael', speed: 1.2 })
  assert.deepEqual(JSON.parse(storage.data.get(READ_ALOUD_KEY)), saved)
  assert.deepEqual(loadReadAloud(storage), saved)
  assert.deepEqual(normalizeReadAloud({ natural: 'yes', voice: 'bf_emma', speed: 9 }), {
    natural: false,
    voice: DEFAULT_NATURAL_VOICE,
    speed: 1,
  })
  storage.setItem(READ_ALOUD_KEY, '{not json')
  assert.deepEqual(loadReadAloud(storage), DEFAULT_READ_ALOUD)
  assert.deepEqual(loadReadAloud(null), DEFAULT_READ_ALOUD)
})

test('voices: US English only, unique ids, the default among them; the download note matches the model size', () => {
  const ids = NATURAL_VOICES.map((voice) => voice.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes(DEFAULT_NATURAL_VOICE))
  assert.ok(ids.every((id) => /^a[fm]_/.test(id)))
  assert.ok(Math.abs(MODEL_BYTES / 1e6 - DOWNLOAD_MB) < 5, 'the "about N MB" note stays honest')
})

test('integrity: every downloaded file is pinned to its published size and SHA-256', () => {
  const model = pinFor(modelUrl(MODEL_FILE))
  assert.deepEqual(model, { bytes: 92361116, sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478' })
  assert.equal(MODEL_SHA256, model.sha256)
  assert.match(pinFor(modelUrl(TOKENIZER_FILE)).sha256, /^[0-9a-f]{64}$/)
  for (const voice of NATURAL_VOICES) {
    const pin = pinFor(voiceUrl(voice.id))
    assert.equal(pin.bytes, VOICE_BYTES, voice.id)
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, voice.id)
  }
  assert.equal(new Set(NATURAL_VOICES.map((voice) => voice.sha256)).size, NATURAL_VOICES.length)
  assert.equal(pinFor(voiceUrl('zz_unknown')), null)
  assert.equal(pinFor(modelUrl('onnx/model.onnx')), null)
})

test('integrity: a wrong size or hash is refused, the published bytes pass', async () => {
  const bytes = new TextEncoder().encode('kokoro').buffer
  const pin = { bytes: bytes.byteLength, sha256: await sha256(bytes) }
  assert.equal(pin.sha256, createHash('sha256').update('kokoro').digest('hex'))
  assert.equal(await verifyBytes(bytes, pin, 'voice.bin'), bytes)
  const tampered = new TextEncoder().encode('kokorO').buffer
  await assert.rejects(verifyBytes(tampered, pin, 'voice.bin'), (error) => {
    assert.ok(error instanceof IntegrityError)
    assert.equal(error.code, INTEGRITY_CODE)
    assert.match(error.message, /voice\.bin did not match the published file \(SHA-256 differs\)/)
    return true
  })
  await assert.rejects(verifyBytes(new ArrayBuffer(3), pin, 'voice.bin'), /3 bytes, expected 6/)
  await assert.rejects(verifyBytes(bytes, null, 'other.bin'), /no pinned hash/)
})

test('integrity: the worker verifies before caching and deletes the entry on a mismatch', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'client/src/chat/tts/tts.worker.js'), 'utf8')
  const verify = worker.indexOf('await verifyBytes(buffer, pin, name)')
  assert.ok(verify > 0 && verify < worker.indexOf('await cache?.put('), 'verified before cache.put')
  assert.match(worker, /const discard = async \(error\) => \{\s+await cache\?\.delete\(url\)/)
})

test('support: explains why natural voices cannot run here', () => {
  const scope = { WebAssembly: {}, Worker: function () {}, AudioContext: function () {} }
  assert.deepEqual(naturalSupport({ deviceMemory: 8 }, scope), { ok: true, reason: null })
  assert.deepEqual(naturalSupport({}, scope), { ok: true, reason: null })
  const low = naturalSupport({ deviceMemory: 2 }, scope)
  assert.equal(low.ok, false)
  assert.match(low.reason, /2 GB of memory/)
  assert.match(naturalSupport({}, { ...scope, WebAssembly: undefined }).reason, /WebAssembly/)
  assert.match(naturalSupport({}, { ...scope, Worker: undefined }).reason, /workers/)
  assert.match(naturalSupport({}, { ...scope, AudioContext: undefined }).reason, /audio/)
})

test('phonemes: IPA maps onto Kokoro symbols with stress before the vowel', () => {
  assert.equal(ipaToMisaki('həˈɫoʊ'), 'həlˈO')
  assert.equal(ipaToMisaki('ˈdʒeɪs'), 'ʤˈAs')
  assert.equal(ipaToMisaki('kəˈbɝnɪtəz'), 'kəbˈɜɹnɪtəz')
  assert.equal(ipaToMisaki('ˈbɝdɚ'), 'bˈɜɹdəɹ')
  assert.equal(spellLetters('API'), 'ˌApˌiˈI')
  assert.equal(keepKnown('a😀b'), 'ab')
})

test('phonemes: misaki lexicon first, developer overrides, letter spelling and a fallback for unknown words', () => {
  const english = new EnglishG2P()
  const g2p = createG2p({ misakiEnglish, toIPA: (word) => english.predict(word) || '' })
  assert.equal(g2p.phonemize('Open the settings menu.'), 'ˈOpᵊn ðə sˈɛTɪŋz mˈɛnju.')
  const dev = g2p.phonemize('The npm scripts read the README and the JSON.')
  assert.ok(dev.includes(OVERRIDES.npm), dev)
  assert.ok(dev.includes(OVERRIDES.README), dev)
  assert.ok(dev.includes(OVERRIDES.JSON), dev)
  // An acronym nobody knows is spelled; a made-up word still gets read.
  assert.ok(g2p.phonemize('Check the QZX flag.').includes('kjˌuzˌiˈɛks'))
  const unknown = g2p.phonemize('The frobnicator glorped.')
  assert.match(unknown, /fɹ.*ɡl/)
  // camelCase identifiers read as their parts.
  assert.match(g2p.phonemize('useEffect'), /əfˈɛkt/)
  // Only symbols the model knows, and markup in the text cannot inject phonemes.
  for (const text of ['Hello [world](/xyz/) 😀', 'Version 2.1 fixed 404 errors.', 'Ira and Jayce']) {
    const out = g2p.phonemize(text)
    assert.equal(keepKnown(out), out)
    assert.ok(!out.includes('xyz'), out)
  }
})

test('build: the natural voice is lazy (its own tts- files, not in the app shell or the main bundle)', () => {
  const config = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8')
  assert.match(config, /!name\.startsWith\(TTS_PREFIX\)/)
  assert.match(fs.readFileSync(path.join(ROOT, 'vite.demo.config.js'), 'utf8'), /worker: ttsWorker\(\)/)
  const natural = fs.readFileSync(path.join(ROOT, 'client', 'src', 'chat', 'tts', 'natural.js'), 'utf8')
  assert.match(natural, /new Worker\(new URL\('\.\/tts\.worker\.js', import\.meta\.url\)/)
  for (const file of ['natural.js', 'queue.js', 'text.js', 'settings.js', 'support.js', 'voices.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'client', 'src', 'chat', 'tts', file), 'utf8')
    assert.doesNotMatch(source, /onnxruntime-web|speech-g2p|phonemize/, `${file} must not pull the model code into the main bundle`)
  }
})

test('csp: the worker policy is the same for shapewall serve, the hosted server and shapewall.com/demo', async () => {
  const { TTS_WORKER_CSP, isTtsAsset } = await import('../src/server/app.js')
  const caddy = fs.readFileSync(path.join(ROOT, 'website', 'deploy', 'shapewall.Caddyfile'), 'utf8')
  assert.ok(caddy.includes(`header @demoTts Content-Security-Policy "${TTS_WORKER_CSP}"`))
  assert.match(caddy, /@demoTts path_regexp \^\/demo\/assets\/tts-\[\^\/\]\*\\\.m\?js\$/)
  // The board page itself never gets Hugging Face or WebAssembly.
  const shell = /header @demoShell Content-Security-Policy "([^"]+)"/.exec(caddy)[1]
  assert.doesNotMatch(shell, /huggingface|wasm-unsafe-eval/)
  const hosted = fs.readFileSync(path.join(ROOT, 'src', 'hosted', 'pages.js'), 'utf8')
  // Member, public-project and share-link boards.
  assert.equal(hosted.match(/setHeaders: assetHeaders/g)?.length, 3)
  assert.ok(isTtsAsset('/srv/dist/client/assets/tts-tts.worker-a1.js'))
  assert.ok(isTtsAsset('assets/tts-ort-wasm-simd-threaded.jsep-b2.mjs'))
  assert.ok(!isTtsAsset('assets/index-c3.js'))
  assert.ok(!isTtsAsset('assets/tts-us_gold-d4.json'))
})
