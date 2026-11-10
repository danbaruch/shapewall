// Read-aloud settings in Chat settings (system voice or natural voices, the
// voice, the speed) and the download strip the panel shows while the natural
// voice downloads. Where the voice runs is always on screen: natural voices
// run in this browser, on this device; nothing is sent to a server.

import { Download, Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, ToggleGroup } from '../components/ui'
import { cn } from '../lib/utils'
import { canSpeak, useNatural, useVoices } from './speech'
import { cancelNatural, removeNatural, startNatural } from './tts/natural.js'
import { naturalSupport } from './tts/support.js'
import { DOWNLOAD_MB, NATURAL_VOICES, SPEEDS, voiceLabel } from './tts/voices.js'

const DEFAULT_VOICE = '__default'
const MB = 1000 * 1000

export const WHERE_NATURAL = `Natural voices run on this device, in your browser. One-time download of about ${DOWNLOAD_MB} MB; nothing is sent to a server.`

export function downloadLabel(state) {
  if (!state.loaded) return 'Starting the download'
  const percent = Math.min(100, Math.round((state.loaded / state.total) * 100))
  return `Downloading natural voices: ${percent}% (${Math.round(state.loaded / MB)} of ${Math.round(state.total / MB)} MB)`
}

function Progress({ state, className }) {
  const percent = state.total ? Math.min(100, (state.loaded / state.total) * 100) : 0
  return (
    <div
      className={cn('h-1.5 overflow-hidden rounded-full bg-surface-2', className)}
      role="progressbar"
      aria-label="Natural voice download"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  )
}

export function ReadAloudSettings({ settings, onChange, voiceUri, onVoice, touch }) {
  const voices = useVoices()
  const natural = useNatural()
  const support = naturalSupport()
  const size = touch ? 'touch' : 'sm'
  const supported = support.ok && natural.status !== 'unsupported'
  if (!canSpeak && !supported) return <p className="text-xs text-muted">This browser cannot read messages aloud.</p>
  const engine = settings.natural && supported ? 'natural' : 'system'
  return (
    <div className="space-y-2" data-sw-tts-settings="true">
      <p className="text-[11px] font-medium tracking-wide text-faint uppercase">Read aloud</p>
      <div data-sw-tts-engine={engine}>
        <ToggleGroup
          label="Read-aloud voice type"
          large={touch}
          value={settings.natural ? 'natural' : 'system'}
          onChange={(value) => onChange({ ...settings, natural: value === 'natural' })}
          options={[...(canSpeak ? [{ id: 'system', label: 'System voice' }] : []), { id: 'natural', label: 'Natural voices' }]}
        />
      </div>

      {settings.natural ? (
        <NaturalSection settings={settings} onChange={onChange} natural={natural} support={support} size={size} />
      ) : (
        <Select value={voiceUri || DEFAULT_VOICE} onValueChange={(value) => onVoice(value === DEFAULT_VOICE ? '' : value)}>
          <SelectTrigger size={touch ? 'touch' : 'sm'} className="w-full" aria-label="Read-aloud voice" data-sw-chat-voice="true">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_VOICE}>Browser default</SelectItem>
            {voices.map((voice) => (
              <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} · {voice.lang}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex items-center gap-2" data-sw-tts-speed={String(settings.speed)}>
        <span className="text-xs text-muted">Speed</span>
        <ToggleGroup
          label="Reading speed"
          large={touch}
          className="flex-1"
          value={String(settings.speed)}
          onChange={(value) => onChange({ ...settings, speed: Number(value) })}
          options={SPEEDS.map((speed) => ({ id: String(speed), label: `${speed}x` }))}
        />
      </div>
    </div>
  )
}

function NaturalSection({ settings, onChange, natural, support, size }) {
  if (!support.ok || natural.status === 'unsupported') {
    return (
      <p className="text-xs text-muted" data-sw-tts-unsupported="true">
        {support.reason || natural.error} Choose System voice to read with the browser&apos;s own voice.
      </p>
    )
  }
  const picker = (
    <Select value={settings.voice} onValueChange={(voice) => onChange({ ...settings, voice })}>
      <SelectTrigger size={size === 'touch' ? 'touch' : 'sm'} className="w-full" aria-label="Natural voice" data-sw-tts-voice="true">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {NATURAL_VOICES.map((voice) => (
          <SelectItem key={voice.id} value={voice.id}>
            {voiceLabel(voice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  return (
    <div className="space-y-2" data-sw-tts-state={natural.status}>
      {natural.status === 'ready' ? (
        <p className="text-xs text-muted" data-sw-tts-where="device">
          Natural voices run on this device, in your browser. Nothing is sent to a server.
        </p>
      ) : (
        <p className="text-xs text-muted" data-sw-tts-where="device">
          {natural.downloaded
            ? 'Natural voices run on this device, in your browser. Already downloaded; nothing is sent to a server.'
            : WHERE_NATURAL}
        </p>
      )}
      {picker}
      {natural.status === 'ready' && natural.pace > 1.1 ? (
        <p className="text-xs text-faint" data-sw-tts-slow="true">
          This device makes speech a little slower than it plays it, so there can be short pauses between sentences.
        </p>
      ) : null}
      {natural.status === 'idle' ? (
        <Button
          size={size}
          className="w-full justify-start"
          onClick={() => startNatural({ voice: settings.voice }).catch(() => {})}
          data-sw-tts-download="true"
        >
          <Download size={13} aria-hidden="true" />
          {natural.downloaded ? 'Turn on natural voices' : `Download voices (about ${DOWNLOAD_MB} MB)`}
        </Button>
      ) : null}
      {natural.status === 'downloading' ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs text-muted" role="status" data-sw-tts-progress="menu">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {natural.downloaded ? 'Loading the voice on this device' : downloadLabel(natural)}
          </p>
          <Progress state={natural} />
          <Button variant="ghost" size={size} className="w-full justify-start" onClick={cancelNatural} data-sw-tts-cancel="true">
            <X size={13} aria-hidden="true" /> Cancel
          </Button>
        </div>
      ) : null}
      {natural.status === 'error' ? (
        <div className="space-y-1.5">
          <p className="text-xs text-bad" role="alert" data-sw-tts-error="true">
            {natural.error}
          </p>
          <Button
            size={size}
            className="w-full justify-start"
            onClick={() => startNatural({ voice: settings.voice }).catch(() => {})}
            data-sw-tts-retry="true"
          >
            <RotateCcw size={13} aria-hidden="true" /> Try again
          </Button>
        </div>
      ) : null}
      {/* Also after a failed load, which can leave some files behind. */}
      {natural.status !== 'downloading' && (natural.downloaded || natural.status === 'error') ? (
        <Button variant="ghost" size={size} className="w-full justify-start text-muted" onClick={removeNatural} data-sw-tts-remove="true">
          <Trash2 size={13} aria-hidden="true" /> Remove the download from this browser
        </Button>
      ) : null}
      {natural.status !== 'ready' ? <p className="text-xs text-faint">Until then the system voice reads.</p> : null}
    </div>
  )
}

// The strip above the messages while the natural voice downloads, so the
// progress and Cancel stay in view with the settings closed.
export function NaturalDownloadStrip({ touch = false }) {
  const natural = useNatural()
  if (natural.status !== 'downloading') return null
  return (
    <div className="shrink-0 space-y-1 border-b border-line px-3 py-1.5" data-sw-tts-progress="panel">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted" role="status">
          {natural.downloaded ? 'Loading the natural voice on this device' : `${downloadLabel(natural)}, to this device`}
        </p>
        <Button variant="ghost" size={touch ? 'touch' : 'xs'} onClick={cancelNatural} data-sw-tts-cancel="panel">
          Cancel
        </Button>
      </div>
      <Progress state={natural} />
    </div>
  )
}
