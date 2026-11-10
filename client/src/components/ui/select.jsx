import { Select as SelectPrimitive } from 'radix-ui'
import { cva } from 'class-variance-authority'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useOverlayOpen } from './use-overlay-open'

// A custom select (never the OS picker). The list opens as a popover under
// the trigger on every screen; items are 44 px below the lg breakpoint.
// Radix items cannot have the value "": use `placeholder` (shown while the
// value is "") for "none", or a sentinel value.
export function Select({ open, onOpenChange, defaultOpen, ...props }) {
  const [isOpen, setOpen] = useOverlayOpen(open, onOpenChange, defaultOpen)
  return <SelectPrimitive.Root open={isOpen} onOpenChange={setOpen} {...props} />
}

export const SelectGroup = SelectPrimitive.Group

export function SelectValue(props) {
  return <SelectPrimitive.Value {...props} />
}

export const selectTriggerVariants = cva(
  'inline-flex min-w-0 items-center justify-between gap-1.5 rounded-md border bg-surface text-left font-medium text-fg shadow-card outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 data-[placeholder]:text-muted',
  {
    variants: {
      size: {
        xs: 'h-7 px-2 text-xs',
        sm: 'h-8 px-2 text-[13px]',
        touch: 'h-11 px-3 text-sm',
      },
      tone: {
        default: 'border-line',
        active: 'border-warn',
      },
    },
    defaultVariants: { size: 'sm', tone: 'default' },
  },
)

// Radix picks an item when a letter is typed on a closed trigger (type-ahead),
// so a shortcut like C on a focused "Go to page" jumped to a page. A closed
// trigger ignores letters (the open list still searches as you type); the
// key is marked, so board shortcuts still run for it.
const ignoredTypeahead = new WeakSet()
export const isIgnoredTypeahead = (event) => ignoredTypeahead.has(event?.nativeEvent || event)

export function SelectTrigger({ size, tone, className, children, onKeyDown, ...props }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ size, tone }), className)}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
        if (event.key.length === 1 && event.key !== ' ') {
          ignoredTypeahead.add(event.nativeEvent)
          event.preventDefault()
        }
      }}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={14} className="shrink-0 text-faint" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({ className, children, align = 'start', ...props }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={4}
        align={align}
        collisionPadding={8}
        className={cn(
          'z-[60] max-h-[min(var(--radix-select-content-available-height),24rem)] min-w-[max(var(--radix-select-trigger-width),10rem)] max-w-[calc(100vw-16px)] animate-pop-in overflow-hidden rounded-lg border border-line bg-surface text-fg shadow-pop',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1" nonce={globalThis.__webpack_nonce__}>
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectLabel({ className, ...props }) {
  return (
    <SelectPrimitive.Label
      className={cn('px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase', className)}
      {...props}
    />
  )
}

// `data-sw-option` carries the value, so tests and tools can pick an item.
export function SelectItem({ className, children, value, ...props }) {
  return (
    <SelectPrimitive.Item
      value={value}
      className={cn(
        'relative flex h-11 w-full cursor-default items-center gap-2 rounded-md py-0 pr-2 pl-7 text-sm text-fg outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 lg:h-8 lg:text-[13px]',
        className,
      )}
      data-sw-option={value}
      {...props}
    >
      <span className="absolute left-2 inline-flex w-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check size={14} className="text-accent" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export function SelectSeparator({ className, ...props }) {
  return <SelectPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />
}
