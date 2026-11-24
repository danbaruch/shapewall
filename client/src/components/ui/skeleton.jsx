import { cn } from '../../lib/utils'

// A loading placeholder in the shape of what is coming. Size it with classes
// (h-4 w-32, rounded-full for an avatar). Hidden from screen readers: pair
// a screen with one role="status" label, not one per block.
export function Skeleton({ className, ...props }) {
  return <div aria-hidden="true" className={cn('sw-skeleton animate-shimmer rounded-md', className)} {...props} />
}
