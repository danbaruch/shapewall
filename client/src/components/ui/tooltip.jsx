import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'

// One provider at the root: tooltips share the open delay and skip it when
// moving between neighbours.
export function TooltipProvider({ delayDuration = 400, ...props }) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}

export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({ className, sideOffset = 6, children, ...props }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-[70] max-w-64 animate-fade-in data-[state=closed]:animate-fade-out rounded-md bg-fg px-2 py-1 text-xs font-medium text-surface shadow-pop select-none',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

// <Tooltip content="Close"><Button ... /></Tooltip>. The child must take a
// ref and spread props (every kit control does). No content, no tooltip.
export function Tooltip({ content, side = 'top', align, children, ...props }) {
  if (!content) return children
  return (
    <TooltipRoot {...props}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {content}
      </TooltipContent>
    </TooltipRoot>
  )
}
