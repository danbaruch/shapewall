import { useRef } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'
import { m, pop } from '../../lib/animate'
import { useExitGhost } from '../../lib/exit-ghost'
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

export function PopoverContent({ className, align = 'start', sideOffset = 4, children, ...props }) {
  return (
    <PopoverPrimitive.Portal>
      <FloatingPanel
        Content={PopoverPrimitive.Content}
        origin="var(--radix-popover-content-transform-origin)"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-[60] max-w-[calc(100vw-16px)] rounded-lg border border-line bg-surface p-1 text-fg shadow-pop outline-none',
          className,
        )}
        {...props}
      >
        {children}
      </FloatingPanel>
    </PopoverPrimitive.Portal>
  )
}

// A Radix floating content (popover, menu) drawn by a Motion element: it pops
// in from its trigger's side. Closing is immediate for the app; a picture of
// it pops out (lib/exit-ghost.js).
export function FloatingPanel({ Content, origin, className, style, children, ...props }) {
  const ref = useRef(null)
  useExitGhost(ref, 'pop')
  return (
    <Content asChild {...props}>
      <m.div ref={ref} className={className} style={{ transformOrigin: origin, ...style }} {...pop}>
        {children}
      </m.div>
    </Content>
  )
}
