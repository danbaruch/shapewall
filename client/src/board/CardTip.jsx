// The tooltip of a card's title and badges. A board draws hundreds of cards
// with five or six of these each, so unlike the kit's Tooltip (a Radix
// tooltip per control, mounted with it) this one mounts nothing until the
// pointer rests on its control or the keyboard focuses it. It looks and reads
// the same: the kit tooltip's bubble, role="tooltip", the provider's delay,
// gone on leave, blur, press or Escape. Mouse and keyboard only.
//
// The child must be one DOM element (it gets the handlers and the ref).
import { cloneElement, useEffect, useRef, useState } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '../components/ui'

const OPEN_DELAY_MS = 400

export function CardTip({ content, side = 'top', align = 'center', children }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!content) return children
  const show = (delay) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }
  const own = children.props
  const setRef = (node) => {
    anchor.current = node
    if (typeof own.ref === 'function') own.ref(node)
    else if (own.ref) own.ref.current = node
  }
  const trigger = cloneElement(children, {
    ref: setRef,
    onPointerEnter: (event) => {
      own.onPointerEnter?.(event)
      if (event.pointerType !== 'touch') show(OPEN_DELAY_MS)
    },
    onPointerLeave: (event) => {
      own.onPointerLeave?.(event)
      hide()
    },
    onPointerDown: (event) => {
      own.onPointerDown?.(event)
      hide()
    },
    onFocus: (event) => {
      own.onFocus?.(event)
      if (event.target.matches?.(':focus-visible')) show(0)
    },
    onBlur: (event) => {
      own.onBlur?.(event)
      hide()
    },
  })
  return (
    <>
      {trigger}
      {open ? (
        <Popover open onOpenChange={(next) => (next ? null : hide())} history={false}>
          <PopoverAnchor virtualRef={anchor} />
          <PopoverContent
            role="tooltip"
            side={side}
            align={align}
            sideOffset={6}
            // Never takes the focus or the pointer: it only describes.
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            className="pointer-events-none z-[70] max-w-64 animate-fade-in rounded-md border-0 bg-fg px-2 py-1 text-xs font-medium text-surface select-none"
            data-sw-card-tip="true"
          >
            {content}
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  )
}
