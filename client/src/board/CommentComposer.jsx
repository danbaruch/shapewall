import { useEffect, useId, useRef, useState } from 'react'
import { Brush } from 'lucide-react'
import { Button, Input, Kbd, Tooltip } from '../components/ui'
import { MentionTextarea } from './Mentions'
import { cn } from '../lib/utils'
import { COMMENT_MAX, sendsOnEnter } from './commentInput'
import { AttachButton, ComposerImages, DrawSheet, DrawTools, imageDropProps } from './CommentMedia'
import { useDrawing } from './drawing'
import { DictationButton, DictationStatus, dictationPlaceholder } from './DictationButton'
import { ComposerBox, composerFieldClass } from './ComposerBox'
import { useCommentDictation } from './hooks/useCommentDictation'

// The field grows with its text (wrapped lines too) up to eight lines, then
// scrolls (lib/useAutoGrow.js).
const GROW = { min: 2, max: 8 }
const GROW_TOUCH = { min: 3, max: 8 }

// A new comment: the text (Enter posts, Shift+Enter is a new line, Escape
// cancels), and on a local board the name it is signed with. `media` (from
// useCommentDraft): images to attach (`attach`, `images`, `attachNote` when
// they are off for this person) and the drawing tools (`draw`; `page` is
// the screenshot the phone draws on in a full sheet).
// `discard` ({ onDiscard, onKeep }): Esc was pressed on a comment that holds a
// drawing or images, so the composer asks before dropping that work.
// One composer box (ComposerBox.jsx): the text on top, growing with it; the
// image and drawing tools, the microphone (DictationButton.jsx, it writes at
// the caret; posting stops it) and Post along its bottom. On a desktop
// Cancel sits left of Post, as in the edit box, and the keys are Post's
// tooltip; under the box there is at most one quiet line (who it is signed
// as, or the length near the limit). On a phone, where the row is full,
// Cancel stays under the box.
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
  const near = body.length > COMMENT_MAX - 200
  const signed = Boolean(hosted && signedInAs)
  const describedBy = [images?.error ? 'sw-composer-image-error' : null, dictation.describedBy].filter(Boolean)
  const postButton = (
    <Button
      size={touch ? 'touch' : 'xs'}
      variant="default"
      type="submit"
      disabled={busy || reading || (!body.trim() && !shapes && !images?.images.length)}
      data-sw-save-comment="true"
    >
      {busy ? (images?.images.length ? 'Uploading...' : 'Posting...') : 'Post'}
    </Button>
  )
  const cancel = (
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
  )
  // One quiet line under the box: the length near the limit, else who it is
  // signed as. Nothing at all when there is nothing to say.
  const note = near ? (
    <span className="tabular" data-sw-composer-count="true">
      {body.length}/{COMMENT_MAX}
    </span>
  ) : signed ? (
    <span className="truncate" data-sw-composer-signed="true">
      As {signedInAs}
    </span>
  ) : null
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
      <ComposerBox
        touch={touch}
        listening={dictation.active}
        toolsProps={{ 'data-sw-composer-media': 'true' }}
        tools={
          <>
            {canDraw && !touch ? (
              <DrawTools
                owner="composer"
                touch={false}
                compact
                className="flex-1"
                leading={canAttach ? <AttachButton draft={images} touch={false} disabled={busy} /> : null}
              />
            ) : canAttach ? (
              <AttachButton draft={images} touch={touch} disabled={busy} />
            ) : null}
            {canDraw && touch && media.page ? (
              <Button size="touch" variant="ghost" className="min-w-0 px-2.5" onClick={() => setSheet(true)} data-sw-draw-open="true">
                <Brush size={16} aria-hidden="true" />
                <span className="truncate">{shapes ? `Drawing (${shapes})` : 'Draw on the page'}</span>
              </Button>
            ) : null}
          </>
        }
        actions={
          <>
            <DictationButton dictation={dictation} touch={touch} disabled={busy} bubbleSide={touch ? 'top' : 'bottom'} />
            {touch || discard ? null : cancel}
            {touch ? postButton : <Tooltip content={<PostKeys />}>{postButton}</Tooltip>}
          </>
        }
      >
        <label className="block">
          <span className="sr-only">Comment</span>
          <MentionTextarea
            size={touch ? 'touch' : 'sm'}
            grow={touch ? GROW_TOUCH : GROW}
            value={body}
            people={people}
            className={composerFieldClass(touch)}
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
            placeholder={dictationPlaceholder(dictation, 'Add a comment. @ to mention')}
            aria-describedby={describedBy.length ? describedBy.join(' ') : undefined}
            data-sw-comment-input="true"
          />
        </label>
        <DictationStatus dictation={dictation} id={dictation.noteId} />
        {canAttach ? (
          <div className="px-2.5 empty:hidden">
            <ComposerImages draft={images} touch={touch} id="sw-composer-image-error" />
          </div>
        ) : null}
      </ComposerBox>
      {media?.attachNote ? (
        <p className="text-caption text-faint" data-sw-attach-note="true">
          {media.attachNote}
        </p>
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
      ) : touch ? (
        // A phone: the line and Cancel, at a 44 px target, under the box.
        <div className="flex items-center gap-3 pl-1" data-sw-composer-footer="true">
          <p className="min-w-0 flex-1 truncate text-xs text-faint">{note}</p>
          {cancel}
        </div>
      ) : note ? (
        <p className="flex px-1 text-[11px] leading-4 text-faint" data-sw-composer-footer="true">
          {note}
        </p>
      ) : null}
    </form>
  )
}

// Post's tooltip on a desktop: the keys, once, in the order they are used.
function PostKeys() {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" data-sw-composer-keys="true">
      <span>Post</span>
      <Kbd>Enter</Kbd>
      <span className="opacity-60">·</span>
      <span>New line</span>
      <Kbd>Shift</Kbd>
      <Kbd>Enter</Kbd>
      <span className="opacity-60">·</span>
      <span>Cancel</span>
      <Kbd>Esc</Kbd>
    </span>
  )
}
