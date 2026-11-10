// The action row under a finished answer: Copy, Regenerate (the latest
// answer only), thumbs up and down, Read aloud, and "< 1/2 >" between the
// versions Regenerate kept. A thumbs down opens a small form with quick
// reasons and a note; a thumbs up counts at once and may get a note too.
// Ratings are this person's own (src/agent/ratings.js on the server).
//
// On a desktop the row shows on hover and focus, and always for the latest
// answer; on touch screens it always shows.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, Pause, Play, RotateCcw, Square, ThumbsDown, ThumbsUp, Volume2 } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { Button, IconButton, Textarea } from '../components/ui'
import { threadPath } from './stream'
import { useRefs } from './RefChip'
import { readableText } from './refs'

export const REASONS = [
  ['wrong', 'Wrong'],
  ['ignored', "Didn't do what I asked"],
  ['slow', 'Too slow'],
  ['unsafe', 'Unsafe change'],
  ['other', 'Other'],
]
export const NOTE_MAX = 1000

const ratingPath = (boardId, threadId, messageId) => `${threadPath(boardId, threadId)}/messages/${encodeURIComponent(messageId)}/rating`

// This person's ratings in the thread on screen: what the thread GET said,
// then what they changed here. rate(id, value) saves; null takes it back.
export function useAnswerRatings({ boardId, threadId, thread }) {
  const [changed, setChanged] = useState({})
  useEffect(() => setChanged({}), [boardId, threadId])
  const stored = thread?.id === threadId ? thread.ratings : null
  const ratings = useMemo(() => ({ ...stored, ...changed }), [stored, changed])
  const rate = useCallback(
    async (messageId, value) => {
      const result = value
        ? await api.post(ratingPath(boardId, threadId, messageId), value)
        : await api.delete(ratingPath(boardId, threadId, messageId))
      setChanged((current) => ({ ...current, [messageId]: result?.rating || null }))
      return result?.rating || null
    },
    [boardId, threadId],
  )
  return { ratings, rate }
}

// Markdown as written, so pasting keeps lists and code blocks (reference
// tokens become words first: readableText in refs.js).
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // No clipboard permission (an http origin on a phone): the old way.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

export function VersionSwitcher({ index, count, onChange, touch }) {
  if (count < 2) return null
  const size = touch ? 'icon' : 'icon-xs'
  return (
    <span className="inline-flex items-center text-caption text-muted tabular-nums" data-sw-chat-versions={`${index + 1}/${count}`}>
      <IconButton size={size} label="Previous version" disabled={index === 0} onClick={() => onChange(index - 1)} data-sw-chat-version-prev>
        <ChevronLeft size={14} aria-hidden="true" />
      </IconButton>
      <span aria-live="polite" className="min-w-7 text-center">
        <span className="sr-only">Version </span>
        {index + 1}/{count}
      </span>
      <IconButton
        size={size}
        label="Next version"
        disabled={index === count - 1}
        onClick={() => onChange(index + 1)}
        data-sw-chat-version-next
      >
        <ChevronRight size={14} aria-hidden="true" />
      </IconButton>
    </span>
  )
}

// The form under the row: reasons (thumbs down only) and a note.
export function FeedbackForm({ rating, initial, onSubmit, onCancel, touch }) {
  const [reasons, setReasons] = useState(() => new Set(initial?.reasons || []))
  const [note, setNote] = useState(initial?.note || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const noteId = useId()
  const formRef = useRef(null)
  useEffect(() => {
    formRef.current?.querySelector(rating === 'down' ? 'button[aria-pressed]' : 'textarea')?.focus({ preventScroll: true })
    // Keep the form above the composer (a phone's sheet is short).
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    formRef.current?.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' })
  }, [rating])
  const toggle = (id) =>
    setReasons((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ rating, reasons: rating === 'down' ? [...reasons] : [], note: note.trim() })
    } catch (failure) {
      setError(failure.message || 'The feedback could not be saved. Try again.')
      setBusy(false)
    }
  }
  return (
    <form
      ref={formRef}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}
      className="animate-fade-in space-y-2 rounded-lg border border-line bg-surface-2/60 p-2.5"
      aria-label={rating === 'down' ? 'What went wrong' : 'Add a note'}
      data-sw-chat-feedback-form={rating}
    >
      {rating === 'down' ? (
        <fieldset>
          <legend className="mb-1.5 text-caption font-medium text-muted">What went wrong?</legend>
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={reasons.has(id)}
                onClick={() => toggle(id)}
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 text-xs font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  touch ? 'h-11' : 'h-7',
                  reasons.has(id) ? 'border-accent bg-accent/10 text-fg' : 'border-line bg-surface text-muted hover:text-fg',
                )}
                data-sw-chat-reason={id}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div>
        <label htmlFor={noteId} className="mb-1 block text-caption font-medium text-muted">
          Note <span className="font-normal text-faint">(optional)</span>
        </label>
        <Textarea
          id={noteId}
          size={touch ? 'touch' : 'sm'}
          rows={2}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={rating === 'down' ? 'What should the agent have done?' : 'What was good about it?'}
          data-sw-chat-feedback-note
        />
        {note.length > NOTE_MAX - 100 ? (
          <p className="mt-0.5 text-right text-caption text-faint tabular-nums">
            {note.length}/{NOTE_MAX}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size={touch ? 'touch' : 'sm'} onClick={onCancel} data-sw-chat-feedback-cancel>
          Cancel
        </Button>
        <Button variant="default" size={touch ? 'touch' : 'sm'} type="submit" disabled={busy} data-sw-chat-feedback-send>
          Send feedback
        </Button>
      </div>
    </form>
  )
}

// message: the version on screen. rating: this person's ({ rating, reasons,
// note }) or null. onRate(value | null) saves it.
export function AnswerActions({
  message,
  latest = false,
  touch = false,
  rating = null,
  onRate,
  onRegenerate = null,
  regenerateDisabled = false,
  versions = null,
  speaker,
  canRead = false,
  onRead,
}) {
  const [copied, setCopied] = useState(false)
  const [form, setForm] = useState(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const refs = useRefs()
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    setForm(null)
    setError(null)
  }, [message.id])
  const speaking = speaker?.speakingId === message.id
  const size = touch ? 'icon' : 'icon-xs'
  const current = rating?.rating || null
  const flash = (set) => {
    set(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => set(false), 1800)
  }
  const copy = async () => {
    if (await copyText(readableText(message.text || '', refs?.index))) flash(setCopied)
    else setError('Copy is not allowed here. Select the text to copy it.')
  }
  const save = async (value) => {
    setError(null)
    await onRate(value)
    if (value) flash(setSaved)
  }
  const thumb = async (value) => {
    setError(null)
    if (current === value) {
      // Pressing the same thumb again takes the rating back.
      setForm(null)
      try {
        await save(null)
      } catch (failure) {
        setError(failure.message)
      }
      return
    }
    if (value === 'down') return setForm('down')
    setForm(null)
    try {
      await save({ rating: 'up', reasons: [], note: '' })
    } catch (failure) {
      setError(failure.message)
    }
  }
  // Hover-only rows stay visible while something in them is in use.
  const pinned = touch || latest || form || copied || saved || speaking || current
  return (
    <div className="space-y-1.5" data-sw-chat-answer-actions={message.id}>
      <div
        role="toolbar"
        aria-label="Answer actions"
        className={cn(
          '-ml-1.5 flex flex-wrap items-center gap-0.5 transition-opacity duration-(--motion-fast)',
          !pinned && 'opacity-0 group-hover/answer:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
        )}
        data-sw-chat-reading={speaking ? speaker.engine || 'system' : undefined}
      >
        {versions ? <VersionSwitcher {...versions} touch={touch} /> : null}
        {message.text ? (
          <IconButton size={size} label={copied ? 'Copied' : 'Copy'} onClick={copy} data-sw-chat-copy={copied ? 'done' : 'ready'}>
            {copied ? <Check size={14} aria-hidden="true" className="text-ok" /> : <Copy size={14} aria-hidden="true" />}
          </IconButton>
        ) : null}
        {onRegenerate ? (
          <IconButton size={size} label="Regenerate" onClick={onRegenerate} disabled={regenerateDisabled} data-sw-chat-regenerate>
            <RotateCcw size={14} aria-hidden="true" />
          </IconButton>
        ) : null}
        {onRate ? (
          <>
            <IconButton
              size={size}
              label={current === 'up' ? 'Good answer (rated)' : 'Good answer'}
              aria-pressed={current === 'up'}
              onClick={() => thumb('up')}
              className={current === 'up' ? 'text-accent' : undefined}
              data-sw-chat-rate="up"
            >
              <ThumbsUp size={14} aria-hidden="true" fill={current === 'up' ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton
              size={size}
              label={current === 'down' ? 'Bad answer (rated)' : 'Bad answer'}
              aria-pressed={current === 'down'}
              aria-expanded={form === 'down'}
              onClick={() => thumb('down')}
              className={current === 'down' ? 'text-accent' : undefined}
              data-sw-chat-rate="down"
            >
              <ThumbsDown size={14} aria-hidden="true" fill={current === 'down' ? 'currentColor' : 'none'} />
            </IconButton>
          </>
        ) : null}
        {canRead && message.text ? (
          <>
            <IconButton
              size={size}
              label={speaking ? 'Stop reading aloud' : 'Read aloud'}
              aria-pressed={speaking}
              onClick={() => (speaking ? speaker.stop() : onRead(message))}
              data-sw-chat-speak={message.id}
            >
              {speaking ? <Square size={12} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
            </IconButton>
            {speaking ? (
              <IconButton
                size={size}
                label={speaker.paused ? 'Resume reading' : 'Pause reading'}
                aria-pressed={speaker.paused}
                onClick={() => (speaker.paused ? speaker.resume() : speaker.pause())}
                data-sw-chat-pause={message.id}
              >
                {speaker.paused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
              </IconButton>
            ) : null}
          </>
        ) : null}
        <span role="status" className="ml-1 text-caption text-muted">
          {saved ? <span data-sw-chat-feedback-saved>Thanks for the feedback</span> : null}
        </span>
        {current === 'up' && !form && !saved ? (
          <Button variant="link" size="xs" className="ml-1 text-caption" onClick={() => setForm('up')} data-sw-chat-feedback-add-note>
            {rating?.note ? 'Edit note' : 'Add a note'}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
      {form ? (
        <FeedbackForm
          key={form}
          rating={form}
          initial={rating?.rating === form ? rating : null}
          touch={touch}
          onCancel={() => setForm(null)}
          onSubmit={async (value) => {
            await save(value)
            setForm(null)
          }}
        />
      ) : null}
    </div>
  )
}
