import { useRef } from 'react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cva } from 'class-variance-authority'
import { ChevronLeft, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useOverlayEntry } from '../../lib/hooks'
import { LayoutMotion, fade, m, pop, sheet, useDragControls, useSheetLayout } from '../../lib/animate'
import { useExitGhost } from '../../lib/exit-ghost'

const panelVariants = cva(
  // A bottom sheet on phones, centered from the sm breakpoint up.
  'fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-pop outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[calc(100dvh-3rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
  {
    variants: {
      size: {
        sm: 'sm:max-w-md',
        md: 'sm:max-w-xl',
        lg: 'sm:max-w-5xl',
      },
    },
    defaultVariants: { size: 'sm' },
  },
)

// The dimmed page behind a dialog: one look for every modal surface (the
// command palette builds its own panel on it).
export function DialogOverlay({ className, ...props }) {
  return <DialogPrimitive.Overlay className={cn('fixed inset-0 z-50 animate-fade-in bg-black/40', className)} {...props} />
}

// The same scrim, faded in by Motion and out by its ghost (lib/exit-ghost.js).
export function MotionOverlay({ className, ...props }) {
  const ref = useRef(null)
  useExitGhost(ref, 'fade')
  return (
    <DialogPrimitive.Overlay asChild {...props}>
      <m.div ref={ref} className={cn('fixed inset-0 z-50 bg-black/40', className)} {...fade} />
    </DialogPrimitive.Overlay>
  )
}

// The first field or action gets focus on open, not the close button; an
// element marked data-autofocus (a sheet that is read first) wins.
function focusFirst(event) {
  event.preventDefault()
  const panel = event.currentTarget
  const target = panel.querySelector('[data-autofocus]') || panel.querySelector('textarea, input, button:not([data-dialog-close]), [href]')
  ;(target || panel).focus()
}

// A modal dialog. Back (its own history entry) and Escape close it, as does a
// press outside. `onClose` may refuse (a save in flight) by doing nothing.
// `description` is one line; `wrapDescription` lets a full sentence wrap.
// Escape in a field marked data-sw-own-escape="true" is that field's, not the dialog's.
//
// Motion: centred, it pops in; on a phone it is a sheet that springs up from
// the bottom and can be pulled down by its header to close. Closing is
// immediate for the app (focus, Escape, the rest of the page); a picture of
// the panel plays the exit (lib/exit-ghost.js).
export function Dialog({
  open,
  onClose,
  title,
  description,
  wrapDescription = false,
  children,
  footer,
  size = 'sm',
  className,
  onCloseAutoFocus,
  // A dialog showing something that cannot be shown again (a new token, a
  // share link) closes only from its own buttons, never a stray click or Escape.
  sticky = false,
  // A sheet that came from a list: the name of what it goes back to
  // ("Comments"). Closing it already returns there, but an X does not say so,
  // so the way out leads the title row as a named back control instead.
  back = null,
  // A ceiling in screen pixels for the whole panel, over its own max-height.
  // The phone thread sheet sets one so it always leaves a strip of board
  // above itself (sheetFit.js).
  maxHeight = null,
}) {
  useOverlayEntry(open, onClose)
  // What had focus when the dialog opened (the button that opened it), read
  // during the render that opens it, before the dialog moves focus. Without a
  // Radix trigger nothing else knows it, and Escape left focus on the page body.
  const opener = useRef(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement
  wasOpen.current = open
  const restoreFocus = (event) => {
    const target = opener.current
    opener.current = null
    if (target && target !== document.body && target.isConnected) {
      event.preventDefault()
      target.focus({ preventScroll: true })
    }
  }
  const phone = useSheetLayout()
  const panel = (
    <DialogPanel
      phone={phone}
      size={size}
      className={className}
      maxHeight={maxHeight}
      sticky={sticky}
      back={back}
      title={title}
      description={description}
      wrapDescription={wrapDescription}
      footer={footer}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus || restoreFocus}
    >
      {children}
    </DialogPanel>
  )
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogPrimitive.Portal>
        <MotionOverlay />
        {/* A phone sheet can be pulled down to close: drag is in the larger
            animation chunk (lib/animate.jsx). */}
        {phone && !sticky ? <LayoutMotion>{panel}</LayoutMotion> : panel}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// A sheet pulled down this far, or flicked down this fast, closes.
const DISMISS_DISTANCE = 96
const DISMISS_VELOCITY = 600
const NOT_A_HANDLE = 'button, a, input, textarea, select, [role="button"], [role="menuitem"]'

function DialogPanel({
  phone,
  size,
  className,
  maxHeight,
  sticky,
  back,
  title,
  description,
  wrapDescription,
  footer,
  onClose,
  onCloseAutoFocus,
  children,
}) {
  const ref = useRef(null)
  useExitGhost(ref, phone ? 'sheet' : 'pop')
  const drag = useDragControls()
  const draggable = phone && !sticky
  return (
    <DialogPrimitive.Content
      asChild
      onOpenAutoFocus={focusFirst}
      onCloseAutoFocus={onCloseAutoFocus}
      // A field that uses Escape itself (editing a message: Escape cancels
      // the edit) marks itself data-sw-own-escape: the dialog stays open.
      onEscapeKeyDown={(event) => {
        if (sticky || event.target?.closest?.('[data-sw-own-escape="true"]')) event.preventDefault()
      }}
      onInteractOutside={(event) => {
        if (sticky) event.preventDefault()
      }}
      {...(description ? {} : { 'aria-describedby': undefined })}
    >
      <m.div
        ref={ref}
        className={cn(panelVariants({ size }), className)}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)', ...(maxHeight ? { maxHeight } : null) }}
        {...(phone ? sheet : pop)}
        {...(draggable
          ? {
              drag: 'y',
              dragListener: false,
              dragControls: drag,
              dragConstraints: { top: 0, bottom: 0 },
              dragElastic: { top: 0, bottom: 1 },
              dragMomentum: false,
              onDragEnd: (event, info) => {
                if (info.offset.y > DISMISS_DISTANCE || info.velocity.y > DISMISS_VELOCITY) onClose()
              },
            }
          : null)}
        data-sw-sheet={phone ? 'true' : undefined}
      >
        {/* The title (and its one-line description) centered on the 44px
            close; a description that wraps keeps the title at the top. On a
            phone the header is also the sheet's handle: pull it down to close. */}
        <div
          className={cn(
            'relative flex gap-3 border-b border-line py-3.5 pr-5',
            back ? 'pl-2' : 'pl-5',
            wrapDescription ? 'items-start' : 'items-center',
            draggable && 'touch-none',
          )}
          data-sw-dialog-header="true"
          onPointerDown={
            draggable
              ? (event) => {
                  if (event.button !== 0 || event.target.closest?.(NOT_A_HANDLE)) return
                  drag.start(event)
                }
              : undefined
          }
        >
          {draggable ? (
            <span
              aria-hidden="true"
              className="absolute top-1.5 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-line"
              data-sw-sheet-handle="true"
            />
          ) : null}
          {back ? (
            <DialogPrimitive.Close
              data-dialog-close
              data-sw-dialog-back="true"
              className="-my-1.5 inline-flex h-11 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={`Back to ${back}`}
            >
              <ChevronLeft size={18} aria-hidden="true" />
              {back}
            </DialogPrimitive.Close>
          ) : null}
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-[15px] font-semibold text-fg">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className={cn('mt-0.5 text-xs text-muted', wrapDescription ? 'text-pretty' : 'truncate')}>
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          {/* The way out is named once: a sheet that came from a list says
              where it goes back to, and nothing else needs an X beside it. */}
          {back ? null : (
            <DialogPrimitive.Close
              data-dialog-close
              className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="Close"
            >
              <X size={18} aria-hidden="true" />
            </DialogPrimitive.Close>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
      </m.div>
    </DialogPrimitive.Content>
  )
}
