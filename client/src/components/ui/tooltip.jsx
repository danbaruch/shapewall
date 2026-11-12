import { useRef } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'

// One provider at the root: tooltips share the open delay and skip it when
// moving between neighbours.
export function TooltipProvider({ delayDuration = 400, ...props }) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}

export const TooltipRoot = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

// A tooltip never swallows Esc. Radix hands Esc to the topmost layer only,
// and an open tooltip is a layer: with the keyboard on a button inside a
// thread or a dialog (its tooltip showing), the first Esc closed just the
// tooltip and a second one was needed for the thing itself. Here the tooltip
// still closes, at once (no fade, so its layer is gone by the next frame),
// and the same key is then given to whatever is under it.
function passEscapeOn(tooltip) {
  const from = document.activeElement
  if (tooltip) tooltip.style.animation = 'none'
  let tries = 0
  const pass = () => {
    tries += 1
    if (tooltip?.isConnected && tries < 20) {
      window.requestAnimationFrame(pass)
      return
    }
    const target = from?.isConnected ? from : document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  }
  window.requestAnimationFrame(pass)
}

export function TooltipContent({ className, sideOffset = 6, children, onEscapeKeyDown, ...props }) {
  const node = useRef(null)
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={node}
        sideOffset={sideOffset}
        collisionPadding={8}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event)
          if (!event.defaultPrevented) passEscapeOn(node.current)
        }}
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
