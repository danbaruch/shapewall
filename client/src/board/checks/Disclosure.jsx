import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

// A show/hide section for technical detail: a kit-styled button, never a
// native <details> triangle.
export default function Disclosure({ label, children, defaultOpen = false, className, ...props }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className={cn('text-xs', className)} {...props}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-1.5 rounded-md text-left font-medium text-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent lg:min-h-7"
      >
        <ChevronDown size={14} className={cn('shrink-0 transition-transform', open ? 'rotate-0' : '-rotate-90')} aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <div id={id} className="pt-1 pb-1">
          {children}
        </div>
      ) : null}
    </div>
  )
}
