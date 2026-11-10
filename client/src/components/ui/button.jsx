import { Slot } from 'radix-ui'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { Tooltip } from './tooltip'

// Sizes: `sm` (32 px) and `md` (40 px) for mouse layouts; `touch` and `icon`
// are 44 px, the minimum target on phones. `icon-sm` is the 32 px square.
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg shadow-card hover:bg-accent/90',
        // The primary action at rest (a mode that is off): accent text on a light accent tint, an inset hairline so the box
        // matches `default` exactly. Tint stays at or under 12% so accent text keeps 4.5:1 (test/theme.test.js).
        soft: 'bg-accent/8 text-accent ring-1 ring-accent/40 ring-inset hover:bg-accent/12',
        secondary: 'border border-line bg-surface text-fg shadow-card hover:bg-surface-2',
        ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
        danger: 'text-bad hover:bg-bad/10',
        link: 'px-0 text-accent underline-offset-2 hover:underline',
        // On a filled chip (the toast on `fg`, the comment hint on `accent`): the chip's text colour, a light hover.
        inverse: 'text-current hover:bg-white/15',
      },
      size: {
        xs: 'h-7 px-2 text-xs',
        sm: 'h-8 px-2.5 text-xs',
        md: 'h-10 px-3 text-sm',
        touch: 'h-11 min-w-11 px-3 text-sm',
        'icon-xs': 'h-7 w-7 p-0',
        'icon-sm': 'h-8 w-8 p-0',
        icon: 'h-11 w-11 p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'sm' },
  },
)

export function Button({ variant, size, asChild = false, className, type = 'button', ...props }) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

// An icon-only button: `label` is its accessible name and its tooltip (mouse
// and keyboard; touch screens get no hover, so the label must still read well
// to a screen reader). `tooltip` overrides the visible tip text.
export function IconButton({ label, tooltip, side, variant = 'ghost', size = 'icon-sm', children, ...props }) {
  return (
    <Tooltip content={tooltip ?? label} side={side}>
      <Button variant={variant} size={size} aria-label={label} {...props}>
        {children}
      </Button>
    </Tooltip>
  )
}
