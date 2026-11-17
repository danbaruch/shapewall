import { createContext, useCallback, useContext, useState } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'
import { AnimatePresence, m, pop, useIsPresent } from '../../lib/animate'
import { useOverlayOpen } from './use-overlay-open'

// Whether the popover around a PopoverContent is open, so the content can
// stay mounted through its exit animation (Radix's forceMount).
const OpenContext = createContext(null)

// A floating panel next to its trigger (or an Anchor). With `history`, Back
// closes it while open; leave that off for popovers that follow typing (the
// mention list), which must never touch the history.
export function Popover({ open, onOpenChange, defaultOpen, history = true, ...props }) {
  if (!history) return <PlainPopover open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen} {...props} />
  return <HistoryPopover open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen} {...props} />
}

function PlainPopover({ open, onOpenChange, defaultOpen = false, ...props }) {
  const [own, setOwn] = useState(defaultOpen)
  const controlled = open !== undefined
  const isOpen = controlled ? open : own
  const setOpen = useCallback(
    (next) => {
      if (!controlled) setOwn(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )
  return (
    <OpenContext.Provider value={isOpen}>
      <PopoverPrimitive.Root open={isOpen} onOpenChange={setOpen} {...props} />
    </OpenContext.Provider>
  )
}

function HistoryPopover({ open, onOpenChange, defaultOpen, ...props }) {
  const [isOpen, setOpen] = useOverlayOpen(open, onOpenChange, defaultOpen)
  return (
    <OpenContext.Provider value={isOpen}>
      <PopoverPrimitive.Root open={isOpen} onOpenChange={setOpen} {...props} />
    </OpenContext.Provider>
  )
}

export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export function PopoverContent({ className, align = 'start', sideOffset = 4, children, ...props }) {
  const open = useContext(OpenContext)
  return (
    // `propagate`: a popover whose owner unmounts it (the canvas's thread
    // card, Board.jsx) still plays its exit.
    <AnimatePresence propagate>
      {open ? (
        <PopoverPrimitive.Portal forceMount>
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
      ) : null}
    </AnimatePresence>
  )
}

// A Radix floating content (popover, menu) drawn by a Motion element: it pops
// in from its trigger's side and out again. On the way out it is closed
// already, so it drops its role, its data-sw-* names and its label, takes no
// pointer or focus, and leaves the accessibility tree (lib/animate.jsx).
export function FloatingPanel({ Content, origin, className, style, children, ref, ...props }) {
  const present = useIsPresent()
  const content = present
    ? props
    : Object.fromEntries(Object.entries(props).filter(([key]) => !key.startsWith('data-sw-') && key !== 'aria-label'))
  return (
    <Content forceMount asChild ref={ref} {...content}>
      <m.div
        className={className}
        style={{ transformOrigin: origin, ...style, ...(present ? null : { pointerEvents: 'none' }) }}
        {...pop}
        {...(present ? null : { role: 'presentation', 'aria-hidden': 'true', inert: true, 'data-sw-exiting': 'true' })}
      >
        {children}
      </m.div>
    </Content>
  )
}
