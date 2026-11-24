// A folded section with a kit-style trigger (a rotating chevron, a 44 px row
// on touch), in place of a native <details> triangle. Built on Radix
// Collapsible. Local to the chat and comment pieces for now; a candidate for
// components/ui (workstream D owns the kit).
import { useState } from 'react'
import { Collapsible } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'

export default function Disclosure({
  title,
  icon: Icon = null,
  children,
  defaultOpen = false,
  className,
  triggerClassName,
  contentClassName,
  touch = false,
  ...props
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={cn('text-xs', className)}
      data-state={open ? 'open' : 'closed'}
      {...props}
    >
      <Collapsible.Trigger
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1.5 text-left font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg',
          'focus-visible:outline-2 focus-visible:outline-accent',
          touch ? 'min-h-11' : 'min-h-7',
          triggerClassName,
        )}
      >
        <ChevronRight
          size={13}
          className="shrink-0 transition-transform duration-(--motion-fast) group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        {Icon ? <Icon size={13} className="shrink-0" aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </Collapsible.Trigger>
      <Collapsible.Content className={cn('px-1.5 pt-1 pb-1', contentClassName)}>{children}</Collapsible.Content>
    </Collapsible.Root>
  )
}
