import { useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { IconButton, Popover, PopoverContent, PopoverTrigger } from '../components/ui'
import { captureWarningText } from '../../../src/capture/network-summary.js'
import { viewportIcon } from './viewports'

// A page card's network chip: requests that failed while its screenshots
// were taken (the capture still succeeded). Opens the details per device.
export function CaptureWarnings({ pageId, title, entries, viewports }) {
  const [open, setOpen] = useState(false)
  const rows = viewports
    .map((name) => ({ name, text: entries?.[name]?.status === 'ok' ? captureWarningText(entries[name].networkSummary) : '' }))
    .filter((row) => row.text)
  if (!rows.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="nodrag nopan relative inline-flex h-5 items-center gap-1 rounded-full bg-warn/15 px-1.5 text-[10px] font-medium text-fg transition-colors hover:bg-warn/25 focus-visible:outline-2 focus-visible:outline-accent [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3 [@media(pointer:coarse)]:before:content-['']"
          aria-label={`Capture network warnings for ${title}`}
          data-sw-capture-warning={pageId}
          onClick={(event) => event.stopPropagation()}
        >
          <TriangleAlert size={10} className="shrink-0 text-warn" aria-hidden="true" />
          Network
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-w-[calc(100vw-1.5rem)] p-0 text-xs"
        aria-label="Capture network warnings"
        data-sw-capture-warning-details
      >
        <div className="flex items-start gap-2 border-b border-line py-2 pr-1.5 pl-3">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warn/15 text-warn">
            <TriangleAlert size={13} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-semibold text-fg">Capture network warnings</h3>
            <p className="mt-0.5 truncate text-muted">{title}</p>
          </div>
          <IconButton
            size="icon-sm"
            className="[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
            label="Close"
            tooltip=""
            onClick={() => setOpen(false)}
          >
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
        <div className="space-y-2.5 px-3 py-2.5">
          <p className="text-muted">Screenshots were saved. These requests had problems during capture.</p>
          <ul className="divide-y divide-line rounded-md border border-line">
            {rows.map((row) => {
              const Icon = viewportIcon(row.name)
              return (
                <li key={row.name} className="flex items-start gap-2 px-2.5 py-2">
                  <Icon size={13} className="mt-0.5 shrink-0 text-faint" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block font-medium text-fg capitalize">{row.name}</span>
                    <span className="block break-words text-muted">{row.text}</span>
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="text-faint">
            Counts only requests that failed before the screenshot. Normal page redirects aren’t counted; failed API calls are.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
