import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

// Text fields. The `touch` size is 44 px with 16 px text, so iOS does not zoom
// into the field on focus.
export const fieldVariants = cva(
  'block w-full min-w-0 rounded-md border border-line bg-surface text-fg outline-none placeholder:text-faint focus:border-accent disabled:opacity-50',
  {
    variants: {
      size: {
        xs: 'h-7 px-2 text-xs',
        sm: 'h-8 px-2 text-[13px]',
        touch: 'h-11 px-2.5 text-base',
      },
    },
    defaultVariants: { size: 'sm' },
  },
)

// `icon`: a lucide icon drawn inside the field on the left.
export function Input({ size, icon: Icon, className, wrapperClassName, ...props }) {
  if (!Icon) return <input className={cn(fieldVariants({ size }), className)} {...props} />
  return (
    <span className={cn('relative block', wrapperClassName)}>
      <Icon size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" aria-hidden="true" />
      <input className={cn(fieldVariants({ size }), 'pl-7', className)} {...props} />
    </span>
  )
}
