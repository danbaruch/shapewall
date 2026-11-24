import { cn } from '../../lib/utils'

export function Kbd({ className, ...props }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded border border-current/25 px-1 font-sans text-[10px] font-medium opacity-80',
        className,
      )}
      {...props}
    />
  )
}
