// The top row of a side panel (Comments, Agent, Checks): one height, inset,
// title style and close button, so switching panels never changes it.

import { X } from 'lucide-react'
import { cn } from '../lib/utils'
import { IconButton } from './ui'

// `children` sit between the title and the close button (a chip, actions);
// they get the free width, so push trailing actions right with ml-auto.
export function PanelHeader({ icon: Icon, title, onClose, closeLabel, closeProps, className, children }) {
  return (
    <div className={cn('flex h-12 shrink-0 items-center gap-1.5 px-3', className)}>
      <h2 className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-fg">
        {Icon ? <Icon size={15} className="text-muted" aria-hidden="true" /> : null}
        {title}
      </h2>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      {onClose ? (
        <IconButton label={closeLabel} onClick={onClose} {...closeProps}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  )
}
