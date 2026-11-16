import { Mic } from 'lucide-react'
import { Button, IconButton } from '../components/ui'
import { cn } from '../lib/utils'
import { DICTATION_MESSAGES } from './dictation'

// The microphone beside a comment field (useCommentDictation.js). A toggle:
// its name stays "Dictate" and aria-pressed says whether it is listening
// (a toggle's name must not change with its state); the line under the
// field (DictationNote) says what is happening, out loud too.
// A mouse press keeps the caret in the field, so typing carries on; a
// keyboard press keeps focus here, so Enter or Space stops it again.
export function DictationButton({ dictation, touch, disabled = false }) {
  if (!dictation.supported) return null
  const on = dictation.active
  return (
    <IconButton
      size={touch ? 'icon' : 'icon-sm'}
      variant="ghost"
      className={cn(
        'relative',
        !touch && 'w-7',
        on && 'bg-bad/10 text-bad ring-1 ring-bad/40 ring-inset hover:bg-bad/15 hover:text-bad',
        dictation.state.status === 'asking' && 'bg-surface-2 text-fg',
      )}
      label="Dictate"
      tooltip={on ? 'Stop dictation (Esc)' : 'Dictate: speak to type'}
      aria-pressed={on}
      aria-describedby={dictation.describedBy}
      disabled={disabled && !on}
      onMouseDown={(event) => event.preventDefault()}
      onClick={dictation.toggle}
      data-sw-dictate={dictation.state.status}
    >
      <Mic size={16} aria-hidden="true" />
      {on ? (
        <span
          className={cn('absolute size-1.5 rounded-full bg-bad motion-safe:animate-pulse', touch ? 'top-2.5 right-2.5' : 'top-1 right-0.5')}
          aria-hidden="true"
          data-sw-dictate-dot="true"
        />
      ) : null}
    </IconButton>
  )
}

// The line under the field: the one-time privacy note (with Start and Not
// now), "Listening", or what went wrong in plain words. A polite live
// region, so a screen reader hears it; empty, it takes no room.
export function DictationNote({ dictation, touch, id, className }) {
  if (!dictation.supported) return null
  const { status, notice } = dictation.state
  const message = notice ? DICTATION_MESSAGES[notice] : null
  let body = null
  if (status === 'asking') {
    body = (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="min-w-0 flex-1 basis-48">{DICTATION_MESSAGES.privacy.text}</p>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size={touch ? 'touch' : 'xs'} variant="ghost" onClick={dictation.decline} data-sw-dictation-decline="true">
            Not now
          </Button>
          <Button size={touch ? 'touch' : 'xs'} variant="secondary" onClick={dictation.consent} data-sw-dictation-start="true">
            Start dictation
          </Button>
        </div>
      </div>
    )
  } else if (status === 'listening') {
    body = (
      <p className="flex items-center gap-1.5">
        <span className="size-1.5 shrink-0 rounded-full bg-bad motion-safe:animate-pulse" aria-hidden="true" />
        <span>Listening. {touch ? 'Tap the microphone to stop.' : 'Press the microphone or Esc to stop.'}</span>
      </p>
    )
  } else if (status === 'starting') {
    body = <p>Starting the microphone...</p>
  } else if (status === 'stopping') {
    body = <p>Finishing...</p>
  } else if (message) {
    body = <p className={cn(message.tone === 'error' && 'text-bad')}>{message.text}</p>
  }
  return (
    <div
      id={id}
      role="status"
      aria-live="polite"
      className={body ? cn('text-caption text-muted', className) : 'sr-only'}
      data-sw-dictation-note={body ? notice || status : undefined}
    >
      {body}
    </div>
  )
}
