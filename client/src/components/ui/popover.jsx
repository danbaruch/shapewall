import { Popover as PopoverPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'
import { useOverlayOpen } from './use-overlay-open'

// A floating panel next to its trigger (or an Anchor). With `history`, Back
// closes it while open; leave that off for popovers that follow typing (the
// mention list), which must never touch the history.
export function Popover({ open, onOpenChange, defaultOpen, history = true, ...props }) {
  if (!history) return <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen} {...props} />
  return <HistoryPopover open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen} {...props} />
}

function HistoryPopover({ open, onOpenChange, defaultOpen, ...props }) {
  const [isOpen, setOpen] = useOverlayOpen(open, onOpenChange, defaultOpen)
  return <PopoverPrimitive.Root open={isOpen} onOpenChange={setOpen} {...props} />
}

export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({ className, align = 'start', sideOffset = 4, ...props }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-[60] max-w-[calc(100vw-16px)] animate-pop-in rounded-lg border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}
