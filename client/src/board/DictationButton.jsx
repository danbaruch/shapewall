import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Mic, X } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'
import { DICTATION_MESSAGES, DICTATION_STOP_TIP, DICTATION_TIP, dictationAnnouncement } from './dictation'

// Dictation lives in the composer box (ComposerBox.jsx), like the microphone
// in a chat app: a quiet icon in the box's action row, left of the send
// button, that fills with the accent while it listens; the box's border takes
// the same accent and an empty field reads "Listening...". Nothing is ever
// added around the box: starting, listening, stopping and failing never move
// anything (an error is a bubble at the microphone, or on a phone a notice
// over the sheet's header, never a row). The logic is
// hooks/useCommentDictation.js; the rules are dictation.js.

// The placeholder: "Listening..." while it listens into an empty field.
export const dictationPlaceholder = (dictation, placeholder) => (dictation.active ? 'Listening...' : placeholder)

// The microphone, in the box's action row. A toggle: its name stays "Dictate" and aria-pressed says
// whether it listens; the tooltip says what it does and who hears the audio,
// then how to stop. A mouse press keeps the caret in the field, so typing
// carries on; a keyboard press keeps focus here, so Enter or Space stops it.
// On a phone the target is 44 px with a 32 px circle drawn inside it, so the
// row stays light.
//
// A message (an error, or "stopped by itself") never sits on Post or Cancel:
// on a phone sheet it is a slim notice over the sheet's header (title and
// subtitle), clear of its close button; on a desktop it is a bubble by the
// microphone, below the box by default, or above it (`bubbleSide="top"`)
// where Cancel sits under the box, as in the new-comment composer.
export function DictationButton({ dictation, touch, disabled = false, bubbleSide = 'bottom' }) {
  const anchor = useRef(null)
  const sheet = useSheetHeader(anchor, touch && Boolean(dictation.bubble))
  if (!dictation.supported) return null
  const { status } = dictation.state
  const on = dictation.active
  const message = dictation.bubble ? DICTATION_MESSAGES[dictation.bubble] : null
  const inSheet = Boolean(message && sheet)
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
    <Popover open={Boolean(message) && !inSheet} onOpenChange={(open) => (open ? null : dictation.dismiss())} history={false}>
      <PopoverAnchor asChild>
        <span ref={anchor} className="inline-flex shrink-0" data-sw-dictate-anchor="true">
          {touch ? button : <Tooltip content={on ? DICTATION_STOP_TIP : DICTATION_TIP}>{button}</Tooltip>}
        </span>
      </PopoverAnchor>
      {inSheet ? <SheetNotice sheet={sheet} message={message} code={dictation.bubble} onDismiss={dictation.dismiss} /> : null}
      {message && !inSheet ? (
        <PopoverContent
          side={bubbleSide}
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

// The phone sheet the microphone is in, and its header row, while a message
// is up. Null outside a sheet (the bubble is used there).
function useSheetHeader(anchor, wanted) {
  const [sheet, setSheet] = useState(null)
  useLayoutEffect(() => {
    if (!wanted) return setSheet(null)
    const panel = anchor.current?.closest('[role="dialog"]')
    const header = panel?.querySelector('[data-sw-dialog-header]')
    if (!panel || !header) return setSheet(null)
    const measure = () => setSheet({ panel, top: header.offsetTop, height: header.offsetHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [anchor, wanted])
  return sheet
}

// The phone notice: laid over the sheet's header (the sheet's own box, so
// nothing moves), full width but clear of the close button on the right,
// centred on the header and growing down only when the words need more room.
function SheetNotice({ sheet, message, code, onDismiss }) {
  return createPortal(
    <div
      className="pointer-events-none absolute right-[60px] left-3 z-10 flex items-center py-2"
      style={{ top: sheet.top, minHeight: sheet.height }}
    >
      <div
        className="pointer-events-auto flex w-full animate-fade-in items-start gap-1 rounded-lg border border-line bg-surface py-1.5 pr-1 pl-3 text-[13px] leading-[18px] shadow-pop"
        data-sw-dictation-bubble={code}
      >
        <p className={cn('min-w-0 flex-1 py-[7px]', message.tone === 'error' ? 'text-fg' : 'text-muted')}>{message.text}</p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-8 shrink-0 items-center justify-center rounded text-faint outline-none hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          data-sw-dictation-dismiss="true"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>,
    sheet.panel,
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
