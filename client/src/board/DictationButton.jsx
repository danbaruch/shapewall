import { Mic, X } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'
import { DICTATION_MESSAGES, DICTATION_STOP_TIP, DICTATION_TIP, dictationAnnouncement } from './dictation'

// Dictation lives inside the comment field, like the microphone in a chat
// composer: a quiet icon in the field's bottom-right corner that fills with
// the accent while it listens, the field's border in the same accent, and
// "Listening..." as the placeholder. Nothing is ever added around the field:
// starting, listening, stopping and failing never move anything (an error is
// a bubble at the microphone, not a row). The logic is
// hooks/useCommentDictation.js; the rules are dictation.js.

// What the field needs while dictation is possible: room on the right so
// text never runs under the microphone, and the live accent while it listens.
export function dictationFieldClass(dictation, touch) {
  if (!dictation.supported) return null
  return cn(
    touch ? 'pr-11' : 'pr-9',
    'transition-[border-color,box-shadow] duration-(--motion-base) ease-out',
    dictation.active && 'border-accent ring-3 ring-accent/15',
  )
}

// The placeholder: "Listening..." while it listens into an empty field.
export const dictationPlaceholder = (dictation, placeholder) => (dictation.active ? 'Listening...' : placeholder)

// The microphone, placed in the field's bottom-right corner (its wrapper is
// `relative`). A toggle: its name stays "Dictate" and aria-pressed says
// whether it listens; the tooltip says what it does and who hears the audio,
// then how to stop. A mouse press keeps the caret in the field, so typing
// carries on; a keyboard press keeps focus here, so Enter or Space stops it.
// On a phone the target is 44 px with a 32 px circle drawn inside it, so the
// field stays light.
export function DictationButton({ dictation, touch, disabled = false }) {
  if (!dictation.supported) return null
  const { status } = dictation.state
  const on = dictation.active
  const message = dictation.bubble ? DICTATION_MESSAGES[dictation.bubble] : null
  const button = (
    <button
      type="button"
      aria-label="Dictate"
      aria-pressed={on}
      aria-describedby={dictation.describedBy}
      disabled={disabled && !on}
      onMouseDown={(event) => event.preventDefault()}
      onClick={dictation.toggle}
      className={cn(
        'group/mic flex items-center justify-center rounded-full outline-none disabled:pointer-events-none disabled:opacity-50',
        touch ? 'size-11' : 'size-7 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
      )}
      data-sw-dictate={status}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-full transition-[background-color,color,box-shadow,opacity] duration-(--motion-base) ease-out',
          touch ? 'size-8' : 'size-7',
          touch && 'group-focus-visible/mic:outline-2 group-focus-visible/mic:outline-offset-1 group-focus-visible/mic:outline-accent',
          on
            ? cn('bg-accent text-accent-fg', status === 'listening' && 'motion-safe:animate-dictate', status === 'starting' && 'opacity-70')
            : cn('text-muted', touch ? 'group-active/mic:bg-surface-2' : 'group-hover/mic:bg-surface-2 group-hover/mic:text-fg'),
        )}
        data-sw-dictate-face="true"
      >
        <Mic size={touch ? 18 : 15} aria-hidden="true" />
      </span>
    </button>
  )
  return (
    <Popover open={Boolean(message)} onOpenChange={(open) => (open ? null : dictation.dismiss())} history={false}>
      <PopoverAnchor asChild>
        <span className={cn('absolute', touch ? 'right-0 bottom-0' : 'right-[3px] bottom-[3px]')} data-sw-dictate-anchor="true">
          {touch ? button : <Tooltip content={on ? DICTATION_STOP_TIP : DICTATION_TIP}>{button}</Tooltip>}
        </span>
      </PopoverAnchor>
      {message ? (
        <PopoverContent
          // Below the microphone, over the tools row, so it never covers the
          // words; it flips above when there is no room.
          side="bottom"
          align="end"
          sideOffset={6}
          // A note, not a dialog: the caret stays where it was.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="flex w-max max-w-64 items-start gap-1 py-1.5 pr-1 pl-2.5 text-xs leading-snug"
          data-sw-dictation-bubble={dictation.bubble}
        >
          <p className={cn('min-w-0 flex-1 py-0.5', message.tone === 'error' ? 'text-fg' : 'text-muted')}>{message.text}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dictation.dismiss}
            className={cn(
              'flex shrink-0 items-center justify-center rounded text-faint outline-none hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent',
              touch ? 'size-8' : 'size-5',
            )}
            data-sw-dictation-dismiss="true"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

// What a screen reader hears: "Listening", or the bubble's words. Visually
// hidden, so it never takes room.
export function DictationStatus({ dictation, id }) {
  if (!dictation.supported) return null
  return (
    <span
      id={id}
      role="status"
      aria-live="polite"
      className="sr-only"
      data-sw-dictation-status={dictation.state.notice || dictation.state.status}
    >
      {dictationAnnouncement(dictation.state)}
    </span>
  )
}
