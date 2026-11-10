import { Dialog as DialogPrimitive } from 'radix-ui'
import { cva } from 'class-variance-authority'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useOverlayEntry } from '../../lib/hooks'

const panelVariants = cva(
  // A bottom sheet on phones, centered from the sm breakpoint up.
  'fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] w-full animate-sheet-in flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-pop outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[calc(100dvh-3rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:animate-pop-in sm:rounded-xl',
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
}) {
  useOverlayEntry(open, onClose)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(panelVariants({ size }), className)}
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
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
          {/* The title (and its one-line description) centered on the 44px
              close; a description that wraps keeps the title at the top. */}
          <div className={cn('flex gap-3 border-b border-line px-5 py-3.5', wrapDescription ? 'items-start' : 'items-center')}>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-[15px] font-semibold text-fg">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className={cn('mt-0.5 text-xs text-muted', wrapDescription ? 'text-pretty' : 'truncate')}>
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              data-dialog-close
              className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="Close"
            >
              <X size={18} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
