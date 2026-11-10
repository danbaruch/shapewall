import { useCallback, useState } from 'react'
import { useOverlayEntry } from '../../lib/hooks'

// Open state for a Radix overlay (select, menu, popover), controlled or not,
// that owns a history entry while open: Android Back closes the list instead
// of leaving the board, like the native picker it replaces.
export function useOverlayOpen(openProp, onOpenChange, defaultOpen = false) {
  const [own, setOwn] = useState(defaultOpen)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : own
  const setOpen = useCallback(
    (next) => {
      if (!controlled) setOwn(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )
  useOverlayEntry(open, () => setOpen(false))
  return [open, setOpen]
}
