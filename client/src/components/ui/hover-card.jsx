import { HoverCard as HoverCardPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'

// A preview that opens while the mouse rests on its trigger (a comment pin).
// Mouse only: touch and keyboard users open the real thing instead, so it
// never owns a history entry.
export function HoverCard({ openDelay = 250, closeDelay = 80, ...props }) {
  return <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />
}

export const HoverCardTrigger = HoverCardPrimitive.Trigger

export function HoverCardContent({ className, sideOffset = 6, align = 'start', ...props }) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          'pointer-events-none z-[65] w-72 max-w-[calc(100vw-16px)] animate-fade-in data-[state=closed]:animate-fade-out rounded-lg border border-line bg-surface p-3 text-fg shadow-pop outline-none',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}
