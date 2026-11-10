import { Collapsible as CollapsiblePrimitive } from 'radix-ui'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

// Show and hide a section in place: the kit's replacement for a native
// <details> (no OS triangle, the same look on every screen). Compose the parts,
// or use Disclosure for the common "title, then content" case.
export const Collapsible = CollapsiblePrimitive.Root

// The row that opens and closes the section. A chevron turns with it; pass
// `chevron={false}` to draw your own. 44 px tall below lg, 32 px from lg up.
export function CollapsibleTrigger({ className, children, chevron = true, ...props }) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn(
        'group/collapsible flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-ui font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:min-h-8',
        className,
      )}
      {...props}
    >
      {chevron ? (
        <ChevronRight
          size={14}
          className="shrink-0 text-faint transition-transform duration-(--motion-fast) ease-standard group-data-[state=open]/collapsible:rotate-90"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </CollapsiblePrimitive.Trigger>
  )
}

export function CollapsibleContent({ className, ...props }) {
  return (
    <CollapsiblePrimitive.Content
      className={cn('overflow-hidden data-[state=closed]:animate-collapse-up data-[state=open]:animate-collapse-down', className)}
      {...props}
    />
  )
}

// A titled section that starts closed: `title`, an optional `meta` on the
// right of the row (a count, a status), and the content. Extra props (data-sw-*)
// go on the root.
export function Disclosure({
  title,
  meta,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
  triggerClassName,
  contentClassName,
  ...props
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange} className={className} {...props}>
      <CollapsibleTrigger className={triggerClassName}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta != null ? <span className="shrink-0 text-caption font-normal text-faint tabular-nums">{meta}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn('px-2 pt-1 pb-2', contentClassName)}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
