// The natural voice: Kokoro-82M (Apache 2.0) as ONNX, run in the browser by
// ONNX Runtime Web. One model file for every voice; each voice is a small
// style file. US English voices only: the phonemes come from a US lexicon.

export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
// Pinned, so a change upstream never changes what is downloaded.
export const MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'
// 8-bit weights: 92 MB, the smallest file that sounds like the full model.
// On WebAssembly it runs as fast as the 326 MB full-precision file; WebGPU
// is only faster with the 163 MB fp16 file, so the board uses WebAssembly.
export const MODEL_FILE = 'onnx/model_quantized.onnx'
export const MODEL_BYTES = 92361116
export const DOWNLOAD_MB = 90
export const SAMPLE_RATE = 24000
export const STYLE_DIM = 256
export const HF_HOST = 'https://huggingface.co'
// The model, tokenizer and voices, kept in this browser after the first time.
export const CACHE_NAME = 'shapewall-tts'
export const modelUrl = (file) => `${HF_HOST}/${MODEL_ID}/resolve/${MODEL_REVISION}/${file}`
export const voiceUrl = (id) => modelUrl(`voices/${id}.bin`)

// Published sizes and SHA-256s at MODEL_REVISION (Hugging Face's LFS
// metadata for the model and voices; tokenizer.json is a plain git file whose
// blob id was checked against the download). Every file is verified before
// it is cached or used; anything else is thrown away.
export const MODEL_SHA256 = 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'
export const TOKENIZER_FILE = 'tokenizer.json'
export const TOKENIZER_BYTES = 3497
export const TOKENIZER_SHA256 = '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34'
export const VOICE_BYTES = 522240

// Graded B- or better on Kokoro's own voice card, plus a few for variety.
export const NATURAL_VOICES = [
  {
    id: 'af_heart',
    name: 'Heart',
    accent: 'US',
    gender: 'female',
    sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  },
  {
    id: 'af_bella',
    name: 'Bella',
    accent: 'US',
    gender: 'female',
    sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  },
  {
    id: 'af_nicole',
    name: 'Nicole',
    accent: 'US',
    gender: 'female',
    note: 'soft',
    sha256: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  },
  {
    id: 'af_aoede',
    name: 'Aoede',
    accent: 'US',
    gender: 'female',
    sha256: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361',
  },
  {
    id: 'af_kore',
    name: 'Kore',
    accent: 'US',
    gender: 'female',
    sha256: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e',
  },
  {
    id: 'af_sarah',
    name: 'Sarah',
    accent: 'US',
    gender: 'female',
    sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  },
  {
    id: 'af_nova',
    name: 'Nova',
    accent: 'US',
    gender: 'female',
    sha256: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f',
  },
  { id: 'af_sky', name: 'Sky', accent: 'US', gender: 'female', sha256: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9' },
  {
    id: 'am_michael',
    name: 'Michael',
    accent: 'US',
    gender: 'male',
    sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  },
  {
    id: 'am_fenrir',
    name: 'Fenrir',
    accent: 'US',
    gender: 'male',
    sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  },
  { id: 'am_puck', name: 'Puck', accent: 'US', gender: 'male', sha256: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0' },
  { id: 'am_echo', name: 'Echo', accent: 'US', gender: 'male', sha256: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3' },
]
export const DEFAULT_NATURAL_VOICE = 'af_heart'
export const isNaturalVoice = (id) => NATURAL_VOICES.some((voice) => voice.id === id)
export const voiceLabel = (voice) => `${voice.name} · ${voice.accent} ${voice.gender}${voice.note ? `, ${voice.note}` : ''}`

export const SPEEDS = [0.8, 1, 1.2, 1.5]

// The pinned size and hash for a file URL, or null (never downloaded).
export function pinFor(url) {
  if (url === modelUrl(MODEL_FILE)) return { bytes: MODEL_BYTES, sha256: MODEL_SHA256 }
  if (url === modelUrl(TOKENIZER_FILE)) return { bytes: TOKENIZER_BYTES, sha256: TOKENIZER_SHA256 }
  const voice = NATURAL_VOICES.find((item) => voiceUrl(item.id) === url)
  return voice ? { bytes: VOICE_BYTES, sha256: voice.sha256 } : null
}
