import { useState } from 'react'
import { Brush } from 'lucide-react'
import { Button, Input, Kbd } from '../components/ui'
import { MentionTextarea } from './Mentions'
import { COMMENT_MAX, sendsOnEnter } from './commentInput'
import { AttachButton, ComposerImages, DrawSheet, DrawTools, imageDropProps } from './CommentMedia'
import { useDrawing } from './drawing'

// A new comment: the text (Enter posts, Shift+Enter is a new line, Escape
// cancels), and on a local board the name it is signed with. `media` (from
// useCommentDraft): images to attach (`attach`, `images`, `attachNote` when
// they are off for this person) and the drawing tools (`draw`; `page` is
// the screenshot the phone draws on in a full sheet).
export function CommentComposer({ draft, onChange, onSubmit, onCancel, busy, people, touch, hosted, signedInAs, description, media }) {
  const body = draft?.body || ''
  const lines = Math.min(8, Math.max(touch ? 3 : 2, body.split('\n').length))
  const [sheet, setSheet] = useState(false)
  const shapes = useDrawing((value) => (value?.owner === 'composer' ? value.shapes.length : 0))
  const images = media?.images
  const canAttach = Boolean(media?.attach && images)
  const canDraw = Boolean(media?.draw)
  const reading = Boolean(images?.reading)
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      {...imageDropProps(images, canAttach)}
      data-sw-composer="true"
    >
      {description ? (
        <p className="truncate text-xs text-muted" data-sw-composer-target="true">
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
          onChange={(value) => onChange({ body: value.slice(0, COMMENT_MAX) })}
          onKeyDown={(event) => {
            if (sendsOnEnter(event, touch)) {
              event.preventDefault()
              onSubmit()
            }
          }}
          autoFocus
          placeholder="Add a comment. @ to mention someone or @agent"
          aria-describedby={images?.error ? 'sw-composer-image-error' : undefined}
          data-sw-comment-input="true"
        />
      </label>
      {canAttach ? <ComposerImages draft={images} touch={touch} id="sw-composer-image-error" /> : null}
      {canAttach || canDraw || media?.attachNote ? (
        <div className="flex flex-wrap items-center gap-0.5" data-sw-composer-media="true">
          {canDraw && !touch ? (
            <DrawTools
              owner="composer"
              touch={false}
              leading={canAttach ? <AttachButton draft={images} touch={false} disabled={busy} /> : null}
            />
          ) : canAttach ? (
            <AttachButton draft={images} touch={touch} disabled={busy} />
          ) : null}
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
        <label className="flex items-center gap-2 text-xs text-muted">
          <span className="shrink-0">Your name</span>
          <Input
            size={touch ? 'touch' : 'xs'}
            value={draft?.author || ''}
            onChange={(event) => onChange({ author: event.target.value.slice(0, 60) })}
            placeholder="optional"
            className="flex-1"
            data-sw-comment-author="true"
          />
        </label>
      )}
      {touch ? null : (
        <p className="flex flex-wrap items-center gap-1 text-[11px] text-faint" data-sw-composer-keys="true">
          <Kbd>Enter</Kbd> posts, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> adds a line, <Kbd>Esc</Kbd> cancels. With the @ list open,{' '}
          <Kbd>Enter</Kbd> picks.
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
        <Button size={touch ? 'touch' : 'xs'} variant="ghost" onClick={onCancel} disabled={busy} data-sw-composer-cancel="true">
          Cancel
        </Button>
        <Button
          size={touch ? 'touch' : 'xs'}
          variant="default"
          type="submit"
          disabled={busy || reading || !body.trim()}
          data-sw-save-comment="true"
        >
          {busy ? (images?.images.length ? 'Uploading...' : 'Posting...') : 'Post'}
        </Button>
      </div>
    </form>
  )
}
