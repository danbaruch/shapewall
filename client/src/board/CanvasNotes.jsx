import { Lightbulb, MessageSquarePlus, X } from 'lucide-react'
import { Button, IconButton } from '../components/ui'
import { IDLE_LINKS_MAX, countLinks } from './flow'
import { revealNotice } from './commentReveal'
import { cn } from '../lib/utils'

// What a jump changed to show the comment, and the one way back. It is drawn
// in two places, because on a phone the jump opens the thread sheet over the
// board: a modal, so a note left on the canvas under it is visible but cannot
// be tapped, and is hidden from assistive tech with the rest of the canvas.
// Beside the canvas it stays on the canvas as it always has; on a phone it
// goes inside the sheet (BoardPanels.jsx), where it is reachable and read.
export function RevealNotice({ notice, onUndo, modeLabel, compact = false, inSheet = false }) {
  const said = revealNotice(notice, modeLabel, { compact })
  if (!said) return null
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-xs text-fg',
        inSheet
          ? 'w-full border-b border-line bg-surface-2 px-4 py-2'
          : 'pointer-events-auto w-max max-w-full rounded-lg border border-line bg-surface py-1 pr-1 pl-3 shadow-pop',
      )}
      role="status"
      data-sw-view-notice={notice.changes.join(' ')}
      // The viewport switch keeps the name it has always had, so a link or a
      // test that waits for it still does.
      data-sw-viewport-notice={notice.changes.includes('viewport') ? notice.to : undefined}
    >
      <span className="min-w-0 flex-1 text-pretty">{said.text}</span>
      <Button size={compact ? 'touch' : 'xs'} variant="secondary" className="shrink-0" onClick={onUndo} data-sw-viewport-notice-back="true">
        {said.back}
      </Button>
    </div>
  )
}

// The notes along the top of the canvas, about what the canvas shows: the
// links hints, the first-visit tip, a draft put aside and the viewport switch
// notice. The note for the tool in use (the comment hint, the drawing bar,
// "Select text") sits above the tools at the bottom (BoardTools.jsx).
export function CanvasNotes({
  wide,
  commentMode,
  canComment,
  composing = false,
  parkedDraft = null,
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
  viewNotice,
  undoViewNotice,
  // On a phone the open thread sheet owns the notice: it is a modal, so a
  // copy left here would be unreachable under it.
  noticeInSheet = false,
  dismissTip,
  modes,
  comparePair,
}) {
  const modeLabel = (id) => modes.find((item) => item.id === id)?.label || id
  const revealed = revealNotice(viewNotice, modeLabel)
  const showNotice = Boolean(revealed) && !noticeInSheet
  // The tip names only what this person can do here.
  const tipText = wide
    ? `Scroll or drag to move, Ctrl+scroll or pinch to zoom. Click a page for its actions${canComment && !comparePair ? ': Comment is first. Or press C, or use the Comment tool below' : ''}.`
    : `Pinch to zoom. Tap a page for its actions${canComment && !comparePair ? ': Comment is first. Or use the comment tool below' : ''}.`
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex flex-col items-center gap-1.5 px-2" data-sw-canvas-notes="true">
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
      {tipOpen && !tryOpen && data && !commentMode && !composing && !showLinks && !journey && !builder && !revealed ? (
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
      {parkedDraft ? (
        // A new comment with something in it was put aside when the board
        // went somewhere else: it is offered back, never dropped.
        <div
          className="pointer-events-auto flex w-max max-w-full items-center gap-1 rounded-full border border-line bg-surface py-0.5 pr-0.5 pl-3 text-xs font-medium text-fg shadow-pop"
          role="status"
          data-sw-draft-kept="true"
        >
          <MessageSquarePlus size={13} className="mr-1 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 truncate">Draft kept for {parkedDraft.title}</span>
          <Button
            size="xs"
            variant="soft"
            className="ml-1 shrink-0 rounded-full"
            onClick={parkedDraft.onReopen}
            data-sw-draft-reopen="true"
          >
            Reopen
          </Button>
          <Button size="xs" variant="ghost" className="shrink-0 rounded-full" onClick={parkedDraft.onDiscard} data-sw-draft-discard="true">
            Discard
          </Button>
        </div>
      ) : null}
      {showNotice ? <RevealNotice notice={viewNotice} onUndo={undoViewNotice} modeLabel={modeLabel} compact={!wide} /> : null}
    </div>
  )
}
