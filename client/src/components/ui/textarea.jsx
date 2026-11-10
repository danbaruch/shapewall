import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

export const textareaVariants = cva(
  'block w-full min-w-0 resize-y rounded-md border border-line bg-surface text-fg outline-none placeholder:text-faint focus:border-accent disabled:opacity-50',
  {
    variants: {
      size: {
        sm: 'px-2 py-1.5 text-[13px]',
        md: 'px-3 py-2 text-[13px]',
        touch: 'min-h-11 px-2.5 py-2 text-base',
      },
    },
    defaultVariants: { size: 'sm' },
  },
)

export function Textarea({ size, className, ...props }) {
  return <textarea className={cn(textareaVariants({ size }), className)} {...props} />
}
