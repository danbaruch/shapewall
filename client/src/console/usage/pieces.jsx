// Small pieces the Usage and Activity pages share: stat tiles, a drawer,
// cells for values an agent may not have reported, and the outcome chip.

import { Dialog as DialogPrimitive } from 'radix-ui'
import { ArrowDownRight, ArrowUpRight, FlaskConical, Minus, X } from 'lucide-react'
import { DialogOverlay, Skeleton, Tooltip } from '../../components/ui'
import { DEMO } from '../../lib/demo'
import { cn } from '../../lib/utils'
import { OUTCOME_GROUP_LABEL, OUTCOME_LABEL, outcomeGroup } from '../../../../src/hosted/usage-shape.js'
import { Card } from '../components'
import { OUTCOME_ICON, Sparkline } from './charts'
import { NOT_REPORTED, change } from './format'
import { STATUS, useChartTheme } from './theme'

// The public demo says once, under a page's title, that what it shows is
// made up (client/src/demo/usage). Nothing outside the demo build.
export function DemoNote({ children, testId }) {
  if (!DEMO) return null
  return (
    <p
      className="mb-4 flex items-start gap-2 rounded-md border border-line bg-surface-2/60 px-3 py-2.5 text-xs text-muted print:hidden"
      role="note"
      data-sw-demo-numbers={testId}
    >
      <FlaskConical size={14} className="mt-px shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

// A number an agent did not report: a dash that says so, never a zero.
export function Unreported({ what = null }) {
  return (
    <Tooltip content={what ? `${what}: not reported by the agent` : NOT_REPORTED}>
      <span className="text-faint" aria-label={NOT_REPORTED} data-sw-unreported>
        {'–'}
      </span>
    </Tooltip>
  )
}
export const orUnreported = (value, format, what) => (value === null || value === undefined ? <Unreported what={what} /> : format(value))

// How a turn ended: an icon and a label (colour is never the only sign).
export function OutcomeChip({ outcome, className }) {
  const group = outcomeGroup(outcome)
  const Icon = OUTCOME_ICON[group]
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-sw-outcome={group}>
      <Icon size={13} style={{ color: STATUS[group] }} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{outcome ? OUTCOME_LABEL[outcome] || outcome : OUTCOME_GROUP_LABEL.running}</span>
    </span>
  )
}

// One headline number with its change against the period before and, when
// there is one, a small trend line. `better`: which direction is good news
// ('up', 'down', or null when a change is just a change).
// On the dashboard a tile is a widget: `fill` makes it as tall as its place
// on the grid (and sizes its number to its width), `menu` is its options
// button, `spark` and `showCompare` are what its options turned on or off.
export function StatTile({
  label,
  value,
  current,
  previous,
  better = null,
  hint = null,
  trend = null,
  loading = false,
  note = null,
  compare = 'the period before',
  testId,
  fill = false,
  menu = null,
  spark = true,
  showCompare = true,
  showLabel = true,
}) {
  const theme = useChartTheme()
  const delta = change(current, previous)
  const up = delta && delta.ratio > 0
  const flat = delta && Math.abs(delta.ratio) < 0.0005
  const good = delta && better && !flat ? (better === 'up') === up : null
  const Arrow = flat ? Minus : up ? ArrowUpRight : ArrowDownRight
  return (
    <Card
      // (Without its label, while the layout is edited, a tile is shorter by its bar: less padding keeps every line in view.)
      className={cn(
        'min-w-0 px-4',
        showLabel ? 'py-3' : 'py-1.5',
        fill && '@container/tile flex h-full flex-col justify-center overflow-hidden',
      )}
      data-sw-tile={testId}
    >
      {showLabel || menu ? (
        <div className="flex items-center justify-between gap-1" data-sw-tile-head>
          <p className="truncate text-xs font-medium text-muted">{showLabel ? label : ''}</p>
          {menu}
        </div>
      ) : null}
      {loading ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <div className="mt-0.5 flex items-end justify-between gap-2">
          <p
            className={cn(
              'min-w-0 leading-8 font-semibold text-fg',
              fill ? 'truncate text-[19px] @min-[13rem]/tile:text-[26px]' : 'text-[21px] sm:truncate sm:text-[26px]',
            )}
            title={fill && typeof value === 'string' ? value : undefined}
            data-sw-tile-value
          >
            {value}
          </p>
          {trend && spark ? (
            <span className={fill ? 'hidden @min-[15rem]/tile:block' : 'hidden sm:block'} data-sw-tile-spark>
              <Sparkline values={trend} color={theme.series[0]} />
            </span>
          ) : null}
        </div>
      )}
      <p
        className={cn(
          'mt-0.5 flex min-h-4 items-center gap-x-1.5 text-caption text-muted',
          fill ? 'min-w-0' : 'flex-wrap',
          !showCompare && 'hidden',
        )}
        data-sw-tile-compare
      >
        {loading ? null : delta ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              good === true ? 'text-ok' : good === false ? 'text-bad' : 'text-fg',
            )}
            data-sw-tile-delta
          >
            <Arrow size={12} aria-hidden="true" />
            {delta.text}
          </span>
        ) : null}
        {loading ? null : <span className="truncate">{delta ? `against ${compare}` : (note ?? 'Nothing to compare with yet')}</span>}
      </p>
      {hint && !loading ? (
        <p className={cn('mt-0.5 text-caption text-muted', fill ? 'truncate' : 'text-pretty')} title={fill ? hint : undefined}>
          {hint}
        </p>
      ) : null}
    </Card>
  )
}

// A panel from the right edge (a sheet from the bottom on a phone). Escape,
// a press outside and its close button close it.
export function Drawer({ open, onClose, title, description, children, testId }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogPrimitive.Portal>
        <DialogOverlay className="bg-black/30" />
        <DialogPrimitive.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] w-full animate-sheet-in flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-fg shadow-pop outline-none sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-[440px] sm:animate-fade-in sm:rounded-none sm:border-y-0 sm:border-r-0"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          {...(description ? {} : { 'aria-describedby': undefined })}
          data-sw-drawer={testId}
        >
          <div className="flex items-center gap-3 border-b border-line px-5 py-3">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-[15px] font-semibold text-fg">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 truncate text-xs text-muted">{description}</DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="Close"
              data-sw-drawer-close
            >
              <X size={18} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

// A titled group of label and value pairs inside a drawer or a profile.
export function Facts({ title, children, className }) {
  return (
    <section className={cn('border-b border-line px-5 py-3.5 last:border-0', className)}>
      {title ? <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3> : null}
      <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">{children}</dl>
    </section>
  )
}
export function Fact({ label, children }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </>
  )
}
