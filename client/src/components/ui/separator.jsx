import { Separator as SeparatorPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'

export function Separator({ orientation = 'horizontal', decorative = true, className, ...props }) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn('shrink-0 bg-line', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
      {...props}
    />
  )
}
