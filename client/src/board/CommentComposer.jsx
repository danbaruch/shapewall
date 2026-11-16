import { useEffect, useId, useRef, useState } from 'react'
import { Brush } from 'lucide-react'
import { Button, Input, Kbd } from '../components/ui'
import { MentionTextarea } from './Mentions'
import { cn } from '../lib/utils'
import { COMMENT_MAX, sendsOnEnter } from './commentInput'
import { AttachButton, ComposerImages, DrawSheet, DrawTools, imageDropProps } from './CommentMedia'
import { useDrawing } from './drawing'
import { DictationButton, DictationNote } from './DictationButton'
import { useCommentDictation } from './hooks/useCommentDictation'

// A new comment: the text (Enter posts, Shift+Enter is a new line, Escape
// cancels), and on a local board the name it is signed with. `media` (from
// useCommentDraft): images to attach (`attach`, `images`, `attachNote` when
// they are off for this person) and the drawing tools (`draw`; `page` is
// the screenshot the phone draws on in a full sheet).
// `discard` ({ onDiscard, onKeep }): Esc was pressed on a comment that holds a
// drawing or images, so the composer asks before dropping that work.
// The microphone (DictationButton.jsx) writes at the caret; posting stops it.
export function CommentComposer({
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy,
  people,
  touch,
  hosted,
  signedInAs,
  description,
  media,
  discard = null,
  // Phones: open straight on the drawing sheet (the board's Draw tool).
  startDraw = false,
}) {
  const body = draft?.body || ''
  const lines = Math.min(8, Math.max(touch ? 3 : 2, body.split('\n').length))
  const [sheet, setSheet] = useState(false)
  const drawable = Boolean(touch && media?.draw && media?.page)
  useEffect(() => {
    if (startDraw && drawable) setSheet(true)
  }, [startDraw, drawable])
  const shapes = useDrawing((value) => (value?.owner === 'composer' ? value.shapes.length : 0))
  const images = media?.images
  const canAttach = Boolean(media?.attach && images)
  const canDraw = Boolean(media?.draw)
  const reading = Boolean(images?.reading)
  const input = useRef(null)
  const nameId = useId()
  const dictation = useCommentDictation({ value: body, setValue: (value) => onChange({ body: value }), inputRef: input, max: COMMENT_MAX })
  const post = () => {
    dictation.cancel()
    onSubmit()
  }
  const mic = <DictationButton dictation={dictation} touch={touch} disabled={busy} />
  const describedBy = [images?.error ? 'sw-composer-image-error' : null, dictation.describedBy].filter(Boolean)
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        post()
      }}
      {...imageDropProps(images, canAttach)}
      data-sw-composer="true"
    >
      {description ? (
        // On desktop also the card's handle (ThreadPopover.jsx): drag it to
        // see what is under the composer. It reaches the card's top edge.
        <p
          className={cn('truncate text-xs text-muted', !touch && '-mx-3 -mt-3 cursor-grab touch-none px-3 pt-3 select-none')}
          title={touch ? undefined : 'Drag to move'}
          data-sw-composer-target="true"
          data-sw-card-drag-handle={touch ? undefined : 'true'}
        >
          {description}
        </p>
      ) : null}
      <label className="block">
        <span className="sr-only">Comment</span>
        <MentionTextarea
          size={touch ? 'touch' : 'sm'}
          rows={lines}
          value={body}
          people={people}
          className="resize-none"
          onChange={(value) => {
            const text = value.slice(0, COMMENT_MAX)
            dictation.onInput(text)
            onChange({ body: text })
          }}
          onKeyDown={(event) => {
            if (sendsOnEnter(event, touch)) {
              event.preventDefault()
              post()
            }
          }}
          inputRef={input}
          {...dictation.fieldProps}
          autoFocus
          placeholder="Add a comment. @ to mention someone or @agent"
          aria-describedby={describedBy.length ? describedBy.join(' ') : undefined}
          data-sw-comment-input="true"
        />
      </label>
      <DictationNote dictation={dictation} touch={touch} id={dictation.noteId} />
      {canAttach ? <ComposerImages draft={images} touch={touch} id="sw-composer-image-error" /> : null}
      {canAttach || canDraw || media?.attachNote || dictation.supported ? (
        <div className="flex flex-wrap items-center gap-0.5" data-sw-composer-media="true">
          {canDraw && !touch ? (
            <DrawTools
              owner="composer"
              touch={false}
              compact
              className="flex-1"
              leading={
                canAttach || dictation.supported ? (
                  <>
                    {canAttach ? <AttachButton draft={images} touch={false} disabled={busy} /> : null}
                    {mic}
                  </>
                ) : null
              }
            />
          ) : (
            <>
              {canAttach ? <AttachButton draft={images} touch={touch} disabled={busy} /> : null}
              {mic}
            </>
          )}
          {canDraw && touch && media.page ? (
            <Button size="touch" variant="ghost" onClick={() => setSheet(true)} data-sw-draw-open="true">
              <Brush size={16} aria-hidden="true" /> {shapes ? `Drawing (${shapes})` : 'Draw on the page'}
            </Button>
          ) : null}
          {media?.attachNote ? (
            <p className="w-full text-caption text-faint" data-sw-attach-note="true">
              {media.attachNote}
            </p>
          ) : null}
        </div>
      ) : null}
      {touch && canDraw && media.page ? (
        <DrawSheet
          open={sheet}
          onClose={() => setSheet(false)}
          owner="composer"
          src={media.page.src}
          native={media.page.native}
          title={media.pageTitle}
        />
      ) : null}
      {hosted ? null : (
        <div className="flex items-center gap-2 text-xs text-muted">
          <label className="shrink-0" htmlFor={nameId}>
            Your name
          </label>
          <Input
            id={nameId}
            size={touch ? 'touch' : 'xs'}
            value={draft?.author || ''}
            onChange={(event) => onChange({ author: event.target.value.slice(0, 60) })}
            placeholder="optional"
            className="flex-1"
            data-sw-comment-author="true"
          />
        </div>
      )}
      {discard ? (
        <div
          className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 py-1 pr-1 pl-2.5 text-xs text-fg"
          role="alertdialog"
          aria-label="Discard this comment?"
          data-sw-composer-discard="true"
        >
          <p className="min-w-0 flex-1 font-medium">Discard this comment?</p>
          <Button size="xs" variant="danger" onClick={discard.onDiscard} autoFocus data-sw-composer-discard-yes="true">
            Discard
          </Button>
          <Button size="xs" variant="secondary" onClick={discard.onKeep} data-sw-composer-discard-keep="true">
            Keep
          </Button>
        </div>
      ) : touch ? null : (
        <p className="flex items-center gap-1 overflow-hidden text-[11px] whitespace-nowrap text-faint" data-sw-composer-keys="true">
          <Kbd>Enter</Kbd> posts, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line, <Kbd>Esc</Kbd> cancels
        </p>
      )}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-faint">
          {body.length > COMMENT_MAX - 200 ? (
            <span className="tabular">
              {body.length}/{COMMENT_MAX}
            </span>
          ) : hosted && signedInAs ? (
            `As ${signedInAs}`
          ) : null}
        </p>
        <Button
          size={touch ? 'touch' : 'xs'}
          variant="ghost"
          onClick={() => {
            dictation.cancel()
            onCancel()
          }}
          disabled={busy}
          data-sw-composer-cancel="true"
        >
          Cancel
        </Button>
        <Button
          size={touch ? 'touch' : 'xs'}
          variant="default"
          type="submit"
          disabled={busy || reading || (!body.trim() && !shapes && !images?.images.length)}
          data-sw-save-comment="true"
        >
          {busy ? (images?.images.length ? 'Uploading...' : 'Posting...') : 'Post'}
        </Button>
      </div>
    </form>
  )
}
