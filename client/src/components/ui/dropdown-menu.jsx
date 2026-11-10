import { DropdownMenu as MenuPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'
import { useOverlayOpen } from './use-overlay-open'

// A menu of actions. Back closes it while it is open (see useOverlayOpen).
export function DropdownMenu({ open, onOpenChange, defaultOpen, ...props }) {
  const [isOpen, setOpen] = useOverlayOpen(open, onOpenChange, defaultOpen)
  return <MenuPrimitive.Root open={isOpen} onOpenChange={setOpen} {...props} />
}

export const DropdownMenuTrigger = MenuPrimitive.Trigger
export const DropdownMenuGroup = MenuPrimitive.Group

export function DropdownMenuContent({ className, sideOffset = 4, align = 'end', ...props }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          'z-[60] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 overflow-y-auto data-[state=open]:animate-pop-in rounded-lg border border-line bg-surface p-1 text-fg shadow-pop',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  )
}

const itemClass =
  'relative flex h-11 w-full cursor-default items-center gap-2 rounded-md px-2 text-sm text-fg outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 lg:h-8 lg:text-[13px] [&_svg]:shrink-0 [&_svg]:text-muted'

export function DropdownMenuItem({ className, tone, ...props }) {
  return <MenuPrimitive.Item className={cn(itemClass, tone === 'danger' && 'text-bad [&_svg]:text-bad', className)} {...props} />
}

export function DropdownMenuLabel({ className, ...props }) {
  return (
    <MenuPrimitive.Label
      className={cn('px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({ className, ...props }) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />
}

// One choice out of a few inside a menu (Appearance, View as). Checked items
// show a check; `aria-checked` comes from Radix.
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup

// `indicator={false}` for items laid out as tiles, which show the choice
// with their own checked style.
export function DropdownMenuRadioItem({ className, children, indicator = true, ...props }) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClass, indicator && 'pr-8', 'data-[state=checked]:font-medium', className)} {...props}>
      {children}
      {indicator ? (
        <MenuPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center text-accent">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="!text-accent">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </MenuPrimitive.ItemIndicator>
      ) : null}
    </MenuPrimitive.RadioItem>
  )
}
