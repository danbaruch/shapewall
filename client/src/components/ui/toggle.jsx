import { Toggle as TogglePrimitive } from 'radix-ui'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

// An on/off button (aria-pressed). `outline` is the bordered chip used for
// view options (Diff overlay, Changed pages only); `pill` the rounded filter;
// `flat` a borderless toolbar button with a plain fill while on (the side
// panel switch).
export const toggleVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        outline:
          'rounded-md border border-line text-muted hover:text-fg data-[state=on]:border-accent data-[state=on]:bg-accent/10 data-[state=on]:text-fg',
        flat: 'relative rounded text-muted hover:bg-fg/[0.05] hover:text-fg focus-visible:z-10 focus-visible:outline-offset-0 data-[state=on]:bg-fg/[0.07] data-[state=on]:text-fg',
        pill: 'max-w-full rounded-full border border-line text-muted hover:text-fg data-[state=on]:border-warn data-[state=on]:bg-warn/15 data-[state=on]:text-fg',
      },
      size: {
        xs: 'h-7 px-2.5 text-xs',
        sm: 'h-8 px-2.5 text-xs',
        touch: 'h-11 px-3 text-xs',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
)

export function Toggle({ variant, size, className, ...props }) {
  return <TogglePrimitive.Root className={cn(toggleVariants({ variant, size }), className)} {...props} />
}
