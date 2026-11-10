import { cn, formatRelative } from '../lib/utils'
import { Spinner, Tooltip } from '../components/ui'

// The capture state as a status dot by the board name: the time in its
// tooltip, progress while capturing, a short chip when the last one failed.
export function CaptureStatus({ data, capture }) {
  const capturedAt = data?.manifest?.capturedAt
  const failed = !capture?.running && capture?.state === 'failed' && capture.error
  const text = capture?.running
    ? `Capturing${capture.total ? ` ${capture.done || 0} of ${capture.total}` : ''}`
    : capturedAt
      ? `Captured ${formatRelative(capturedAt)}`
      : 'Not captured yet'
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted" data-sw-captured="true">
      {capture?.running ? (
        <span className="inline-flex items-center gap-1.5" role="status">
          <Spinner size={12} />
          <span className="tabular">{capture.total ? `${capture.done || 0}/${capture.total}` : 'Capturing'}</span>
          <span className="sr-only">{text}</span>
        </span>
      ) : failed ? (
        <Tooltip content={`Last capture failed: ${capture.error}`} side="bottom">
          <span
            tabIndex={0}
            className="inline-flex h-6 items-center gap-1.5 rounded-full bg-bad/10 px-2 font-medium text-bad outline-none focus-visible:outline-2 focus-visible:outline-accent"
            data-sw-capture-failed="true"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-bad" aria-hidden="true" /> Capture failed
          </span>
        </Tooltip>
      ) : (
        <Tooltip content={text} side="bottom">
          <span
            tabIndex={0}
            role="img"
            aria-label={text}
            className="inline-flex h-6 w-4 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className={cn('h-2 w-2 rounded-full', capturedAt ? 'bg-ok' : 'bg-faint')} aria-hidden="true" />
          </span>
        </Tooltip>
      )}
    </span>
  )
}

// The same as a line of text, in the phone's More menu.
export function CaptureLine({ data, capture }) {
  const capturedAt = data?.manifest?.capturedAt
  return (
    <p className="text-xs whitespace-nowrap text-muted" data-sw-captured="true">
      {capture?.running ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner size={12} /> Capturing{capture.total ? ` ${capture.done || 0}/${capture.total}` : ''}
        </span>
      ) : capturedAt ? (
        `Captured ${formatRelative(capturedAt)}`
      ) : (
        'Not captured yet'
      )}
      {!capture?.running && capture?.state === 'failed' && capture.error ? (
        <span className="ml-2 text-bad">Last capture failed: {capture.error}</span>
      ) : null}
    </p>
  )
}
