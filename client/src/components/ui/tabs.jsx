import { createContext, useContext } from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'

export const Tabs = TabsPrimitive.Root

// Two looks, shared with ToggleGroup:
// - segmented (default): equal-width options on a track.
// - underline: text-width tabs on a hairline, the active one underlined. The
//   row scrolls sideways when it does not fit (never truncates), and the
//   underline is drawn inside each tab so switching moves nothing.
// Use Tabs when the choice swaps a panel below, ToggleGroup when it sets a value.
export const tabListClass = {
  segmented: 'flex rounded-md border border-line bg-surface-2 p-0.5',
  underline: 'flex gap-4 overflow-x-auto border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
}

const itemBase = 'text-xs font-medium whitespace-nowrap text-muted outline-none hover:text-fg disabled:opacity-50'

export function tabItemClass(variant, large, state) {
  if (variant === 'underline') {
    return cn(
      itemBase,
      // after: the underline; transparent until active, so the box never changes.
      'relative inline-flex shrink-0 items-center justify-center rounded-sm px-0.5 transition-colors duration-(--motion-fast) ease-standard focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
      "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:content-['']",
      state === 'on'
        ? 'data-[state=on]:text-fg data-[state=on]:after:bg-accent'
        : 'data-[state=active]:text-fg data-[state=active]:after:bg-accent',
      large ? 'h-11 min-w-11' : 'h-11 lg:h-8',
    )
  }
  return cn(
    itemBase,
    'flex-1 rounded px-2.5 focus-visible:outline-2 focus-visible:outline-accent',
    state === 'on'
      ? 'data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-card'
      : 'data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-card',
    large ? 'h-11 min-w-11' : 'h-7',
  )
}

// The list's variant, so its triggers match without repeating it.
const VariantContext = createContext('segmented')

export function TabsList({ className, variant = 'segmented', ...props }) {
  return (
    <VariantContext.Provider value={variant}>
      <TabsPrimitive.List className={cn(tabListClass[variant], className)} data-sw-tabs-variant={variant} {...props} />
    </VariantContext.Provider>
  )
}

export function TabsTrigger({ className, large = false, ...props }) {
  const variant = useContext(VariantContext)
  return <TabsPrimitive.Trigger className={cn(tabItemClass(variant, large, 'active'), className)} {...props} />
}

export function TabsContent({ className, ...props }) {
  return <TabsPrimitive.Content className={cn('outline-none', className)} {...props} />
}
