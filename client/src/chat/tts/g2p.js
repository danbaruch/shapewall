// Text to Kokoro phonemes, without espeak-ng (GPL). Kokoro was trained on
// misaki's phoneme set, so the main path is a pure JavaScript port of misaki's
// US lexicon (@titan-design/speech-g2p, MIT; misaki's dictionaries, Apache
// 2.0). Words it cannot read (names, made-up words) go to phonemize (MIT,
// rules over a CMUdict-derived lexicon), whose IPA is mapped onto misaki's
// symbols. A small dictionary of developer terms comes first.
//
// The G2P packages are passed in, so the same code runs in the worker (with a
// browser data loader) and in Node tests (with the real files).

// Words misaki reads wrong or not at all, in misaki's notation. Keys are
// matched case-sensitively first, then in lower case.
export const OVERRIDES = {
  Shapewall: 'ʃˈApwˌɔl',
  shapewall: 'ʃˈApwˌɔl',
  npm: 'ˌɛnpˌiˈɛm',
  npx: 'ˌɛnpˌiˈɛks',
  pnpm: 'pˌiˌɛnpˌiˈɛm',
  nginx: 'ˈɛnʤɪnˌɛks',
  Kubernetes: 'kˌubəɹnˈɛTiz',
  kubectl: 'kˈubkˌʌnTɹˌOl',
  SQLite: 'ˌɛskjˌuˌɛlˈIt',
  SQL: 'ˌɛskjˌuˈɛl',
  Vite: 'vˈit',
  Vitest: 'vˈitˌɛst',
  WASM: 'wˈɑzᵊm',
  wasm: 'wˈɑzᵊm',
  WebAssembly: 'wˌɛbəsˈɛmbli',
  JSON: 'ʤˈAsᵊn',
  JSONL: 'ʤˈAsᵊnˌɛl',
  YAML: 'jˈæmᵊl',
  TOML: 'tˈɑmᵊl',
  README: 'ɹˈidmˌi',
  Readme: 'ɹˈidmˌi',
  GitHub: 'ɡˈɪthˌʌb',
  GitLab: 'ɡˈɪtlˌæb',
  OAuth: 'ˈOˌɔθ',
  UI: 'jˌuˈI',
  UX: 'jˌuˈɛks',
  iOS: 'ˌIˌOˈɛs',
  macOS: 'mˌækˌOˈɛs',
  Linux: 'lˈɪnəks',
  Kokoro: 'kˈOkəɹˌO',
  Ollama: 'ˌOlˈɑmə',
  DeepSeek: 'dˈipsˌik',
  OpenAI: 'ˌOpᵊnˌAˈI',
  OpenRouter: 'ˈOpᵊnɹˌWTəɹ',
  Figma: 'fˈɪɡmə',
  Playwright: 'plˈAɹˌIt',
  Tailwind: 'tˈAlwˌɪnd',
  Radix: 'ɹˈAdɪks',
  shadcn: 'ʃˈædsˌiˌAˈɛn',
  Supabase: 'sˈupəbˌAs',
  Vercel: 'vəɹsˈɛl',
  Netlify: 'nˈɛtlᵻfˌI',
  Caddy: 'kˈædi',
  async: 'ˈAsˌɪŋk',
  regex: 'ɹˈɛʤˌɛks',
  sudo: 'sˈudˌu',
  stdout: 'stˈændəɹdˌWt',
  stderr: 'stˈændəɹdˌɛɹəɹ',
  CLI: 'sˌiˌɛlˈI',
  GIF: 'ɡˈɪf',
  PNG: 'pˈɪŋ',
  WebP: 'wˈɛbpˌi',
  SVG: 'ˌɛsvˌiʤˈi',
  Ira: 'ˈIɹə',
  e2e: 'ˌitʊˈi',
  E2E: 'ˌitʊˈi',
}

// Letter names, for acronyms the lexicon does not know (spelled out).
const LETTERS = {
  a: 'ˈA',
  b: 'bˈi',
  c: 'sˈi',
  d: 'dˈi',
  e: 'ˈi',
  f: 'ˈɛf',
  g: 'ʤˈi',
  h: 'ˈAʧ',
  i: 'ˈI',
  j: 'ʤˈA',
  k: 'kˈA',
  l: 'ˈɛl',
  m: 'ˈɛm',
  n: 'ˈɛn',
  o: 'ˈO',
  p: 'pˈi',
  q: 'kjˈu',
  r: 'ˈɑɹ',
  s: 'ˈɛs',
  t: 'tˈi',
  u: 'jˈu',
  v: 'vˈi',
  w: 'dˈʌbᵊlju',
  x: 'ˈɛks',
  y: 'wˈI',
  z: 'zˈi',
}

// Spell a word letter by letter, misaki style: secondary stress on every
// letter but the last ("API" is ˌApˌiˈI).
export function spellLetters(word) {
  const letters = [...String(word).toLowerCase()].filter((ch) => LETTERS[ch])
  return letters.map((ch, i) => (i === letters.length - 1 ? LETTERS[ch] : LETTERS[ch].replace('ˈ', 'ˌ'))).join('')
}

// Every symbol Kokoro's tokenizer knows (its vocabulary); anything else is
// dropped before the model sees it.
const VOCAB = new Set(
  [...' !"$(),.:;?AIOQSTWYabcdefhijklmnopqrstuvwxyzæçðøŋœɐɑɒɔɕɖəɚɛɜɟɡɣɤɥɨɪɯɰɲɳɴɸɹɻɽɾʁʂʃʈʊʋʌʎʒʔʝʣʤʥʦʧʨʰʲˈˌː̃βθχᵊᵝᵻ—“”…→↓↗↘ꭧ'].filter(Boolean),
)
export const keepKnown = (phonemes) => [...phonemes].filter((ch) => VOCAB.has(ch)).join('')

const VOWELS = new Set([...'AIOWYaeiouæɑɒɔəɛɜɪʊʌᵊᵻɝɚ'])
const IPA_PAIRS = [
  ['t͡ʃ', 'ʧ'],
  ['d͡ʒ', 'ʤ'],
  ['tʃ', 'ʧ'],
  ['dʒ', 'ʤ'],
  ['eɪ', 'A'],
  ['aɪ', 'I'],
  ['aʊ', 'W'],
  ['ɔɪ', 'Y'],
  ['oʊ', 'O'],
  ['əʊ', 'O'],
  ['ɫ', 'l'],
  ['r', 'ɹ'],
  ['g', 'ɡ'],
  ['ɾ', 'T'],
  ['ʔ', 't'],
  ['ɐ', 'ə'],
  ['ɒ', 'ɑ'],
  ['ː', ''],
  ['ɚ', 'əɹ'],
]

// phonemize's IPA (stress before the syllable) to misaki's notation (stress
// right before the vowel, single letters for diphthongs, ɜɹ / əɹ for r-coloured
// vowels).
export function ipaToMisaki(ipa) {
  let text = String(ipa || '')
  for (const [from, to] of IPA_PAIRS) text = text.split(from).join(to)
  const out = []
  let pending = ''
  for (const ch of text) {
    if (ch === 'ˈ' || ch === 'ˌ') {
      pending = ch
      continue
    }
    if (VOWELS.has(ch)) {
      const stress = pending
      pending = ''
      if (ch === 'ɝ') {
        out.push(stress ? `${stress}ɜɹ` : 'əɹ')
      } else {
        out.push(stress + ch)
      }
      continue
    }
    if (ch === ' ') pending = ''
    out.push(ch)
  }
  return out.join('')
}

const ACRONYM = /^[A-Z]{2,5}s?$/
const NO_VOWEL = /^[bcdfghjklmnpqrstvwxz]{2,5}$/i

// createG2p({ misakiEnglish, toIPA(word) -> IPA }) -> { phonemize(text) -> string }
export function createG2p({ misakiEnglish, toIPA }) {
  const lookup = (word) => OVERRIDES[word] ?? OVERRIDES[word.toLowerCase()] ?? null
  const fallback = (token) => {
    const word = token.text
    const known = lookup(word)
    if (known) return known
    if (ACRONYM.test(word) || NO_VOWEL.test(word)) {
      const plural = /s$/.test(word) && /^[A-Z]+s$/.test(word)
      return spellLetters(plural ? word.slice(0, -1) : word) + (plural ? 'z' : '')
    }
    if (!toIPA || !/\p{L}/u.test(word)) return null
    try {
      const phonemes = keepKnown(ipaToMisaki(toIPA(word)))
      // phonemize leaves one-syllable words unstressed; misaki stresses them.
      return /[ˈˌ]/.test(phonemes) ? phonemes : phonemes.replace(/[AIOWYaeiouæɑɔəɛɜɪʊʌ]/, 'ˈ$&')
    } catch {
      return null
    }
  }
  const g2p = misakiEnglish({ fallback })
  return {
    phonemize(text) {
      // Overrides go in as misaki's own [word](/phonemes/) markup, so the
      // tokenizer still sees the punctuation around them.
      const clean = String(text || '').replace(/[[\]]/g, ' ')
      const marked = clean.replace(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu, (word) => {
        const known = lookup(word)
        if (known) return `[${word}](/${known}/)`
        // camelCase and PascalCase identifiers read as their parts.
        return /\p{Ll}\p{Lu}/u.test(word) ? word.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2') : word
      })
      return keepKnown(g2p.phonemize(marked).phonemes).replace(/\s+/g, ' ').trim()
    },
  }
}
