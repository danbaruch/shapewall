import { cn } from '../../lib/utils'
import { Disclosure } from './collapsible'

// An empty or failed screen: an icon, a title, a sentence. Optional: `action`
// (buttons under the text), `details` (technical detail behind a "Details"
// disclosure, never in the headline), `tone` ("bad" for a failure) and
// `size` ("lg" for a whole screen, centered in its container).
export function EmptyState({
  icon: Icon,
  title,
  children,
  action = null,
  details = null,
  tone = 'default',
  size = 'md',
  className,
  ...props
}) {
  const large = size === 'lg'
  return (
    <div
      className={cn(
        'flex flex-col items-center px-6 text-center',
        large ? 'm-auto w-full max-w-md animate-rise-in gap-3 py-12' : 'gap-2 py-10',
        className,
      )}
      {...props}
    >
      {Icon ? (
        large ? (
          <span
            className={cn(
              'mb-1 inline-flex h-12 w-12 items-center justify-center rounded-xl border',
              tone === 'bad' ? 'border-bad/25 bg-bad/10 text-bad' : 'border-line bg-surface text-muted shadow-card',
            )}
          >
            <Icon size={22} aria-hidden="true" />
          </span>
        ) : (
          <Icon size={22} className={tone === 'bad' ? 'text-bad' : 'text-faint'} aria-hidden="true" />
        )
      ) : null}
      <p className={cn('font-medium text-fg', large ? 'text-heading font-semibold' : 'text-sm')}>{title}</p>
      {children ? <div className={cn('text-muted', large ? 'max-w-sm text-sm' : 'max-w-xs text-xs')}>{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
      {details ? (
        <Disclosure
          title="Details"
          className="mt-2 w-full max-w-sm text-left"
          triggerClassName="mx-auto w-auto text-muted"
          data-sw-error-details
        >
          <pre className="rounded-md break-all border border-line bg-surface-2 px-3 py-2 font-mono text-caption whitespace-pre-wrap text-muted">
            {details}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  )
}
