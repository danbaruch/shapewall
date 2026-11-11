import { Lightbulb, MessageSquarePlus, X } from 'lucide-react'
import { Button, IconButton } from '../components/ui'
import { IDLE_LINKS_MAX, countLinks } from './flow'

// The notes along the top of the canvas: the comment-mode hint, the links
// hints, the first-visit tip and the viewport switch notice.
export function CanvasNotes({
  wide,
  commentMode,
  canComment,
  readyKeys,
  setCommentMode,
  composing = null,
  onCancelDraft,
  showLinks,
  activePage,
  shownSteps,
  data,
  presentPages,
  hiddenLinkTargets,
  showAllLinks,
  targetTitle,
  updateParams,
  tipOpen,
  tryOpen,
  journey,
  builder,
  viewportNotice,
  dismissTip,
  modes,
  setMode,
  comparePair,
}) {
  const modeLabel = (id) => modes.find((item) => item.id === id)?.label || id
  // The tip names only what this person can do here.
  const tipText = wide
    ? `Scroll or drag to move, Ctrl+scroll or pinch to zoom. Click a page for its actions${canComment && !comparePair ? ', or press C to comment' : ''}.`
    : `Pinch to zoom. Tap a page for its actions${canComment && !comparePair ? ', or the comment button to pin a note' : ''}.`
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex flex-col items-center gap-1.5 px-2" data-sw-canvas-notes="true">
      {composing ? (
        // A target is picked: the banner says what the comment is on, and
        // Esc (or Cancel) goes back one step, to picking.
        <div
          className="pointer-events-auto flex w-max max-w-full items-center gap-2 rounded-full border border-line bg-surface py-0.5 pr-0.5 pl-3 text-xs font-medium text-fg shadow-pop"
          role="status"
          data-sw-comment-hint="composing"
        >
          <MessageSquarePlus size={13} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 truncate" data-sw-comment-hint-target="true">
            <span className="text-muted">Commenting on</span> {composing}
          </span>
          <Button size="xs" variant="ghost" className="shrink-0 rounded-full" onClick={onCancelDraft} data-sw-comment-hint-cancel="true">
            Cancel (Esc)
          </Button>
        </div>
      ) : commentMode && canComment ? (
        <div
          className="pointer-events-auto flex w-max max-w-full items-center gap-2 rounded-full bg-accent py-0.5 pr-0.5 pl-3 text-xs font-medium text-accent-fg shadow-pop"
          role="status"
          data-sw-comment-hint={readyKeys.size ? 'element' : 'page'}
        >
          <MessageSquarePlus size={13} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {readyKeys.size
              ? wide
                ? 'Click an element on the live page to comment on it.'
                : 'Tap an element on the live page to comment on it.'
              : wide
                ? 'Click a page to comment. Zoom in until the page goes live to pin it to an element.'
                : 'Tap a page to pin a comment.'}
          </span>
          <Button
            size={wide ? 'xs' : 'touch'}
            variant="inverse"
            className="shrink-0 rounded-full"
            onClick={() => setCommentMode(false)}
            data-sw-comment-hint-done="true"
          >
            Done{wide ? ' (Esc)' : ''}
          </Button>
        </div>
      ) : null}
      {showLinks && !activePage && !shownSteps && countLinks(data?.links, presentPages, hiddenLinkTargets) > IDLE_LINKS_MAX ? (
        <p
          className="w-max max-w-full rounded-full bg-surface px-3 py-1 text-xs font-medium text-muted shadow-pop"
          data-sw-links-hint="true"
        >
          {wide ? 'Hover or select a page to see its links' : 'Tap a page to see its links'}
        </p>
      ) : null}
      {showLinks && (hiddenLinkTargets?.size || showAllLinks) ? (
        <div
          className="pointer-events-auto flex w-max max-w-full items-center gap-2 rounded-full border border-line bg-surface py-0.5 pr-0.5 pl-3 text-xs text-muted shadow-pop"
          data-sw-links-global={showAllLinks ? 'shown' : 'hidden'}
        >
          <span className="min-w-0 truncate">
            {showAllLinks
              ? 'Showing every link, the nav and footer ones too.'
              : `Hiding the nav and footer links (to ${[...hiddenLinkTargets]
                  .slice(0, 3)
                  .map((id) => targetTitle(id))
                  .join(', ')}${hiddenLinkTargets.size > 3 ? ` and ${hiddenLinkTargets.size - 3} more` : ''}).`}
          </span>
          <Button
            size={wide ? 'xs' : 'touch'}
            variant="ghost"
            className="shrink-0 rounded-full"
            onClick={() => updateParams({ la: showAllLinks ? null : '1' })}
            data-sw-links-global-toggle="true"
          >
            {showAllLinks ? 'Hide them' : 'Show them'}
          </Button>
        </div>
      ) : null}
      {tipOpen && !tryOpen && data && !commentMode && !composing && !showLinks && !journey && !builder && !viewportNotice ? (
        <div
          className="pointer-events-auto flex w-max max-w-full items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pr-0.5 pl-3 text-xs text-fg shadow-pop"
          role="note"
          data-sw-tip="true"
        >
          <Lightbulb size={13} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0">{tipText}</span>
          <IconButton
            size={wide ? 'icon-xs' : 'icon'}
            variant="ghost"
            className="shrink-0 rounded-full shadow-none"
            onClick={dismissTip}
            label="Dismiss the tip"
            data-sw-tip-dismiss="true"
          >
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
      {viewportNotice ? (
        <div
          className="pointer-events-auto flex w-max max-w-full items-center gap-2 rounded-lg border border-line bg-surface py-1 pr-1 pl-3 text-xs text-fg shadow-pop"
          role="status"
          data-sw-viewport-notice={viewportNotice.to}
        >
          <span className="min-w-0">
            Showing {modeLabel(viewportNotice.to)}: comment #{viewportNotice.id} is on the {viewportNotice.to} capture.
          </span>
          <Button
            size={wide ? 'xs' : 'touch'}
            variant="secondary"
            className="shrink-0"
            onClick={() => setMode(viewportNotice.from)}
            data-sw-viewport-notice-back="true"
          >
            Back to {modeLabel(viewportNotice.from)}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
