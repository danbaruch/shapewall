import { ArrowLeftRight, Camera, GitCompare, SlidersHorizontal, X } from 'lucide-react'
import {
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Toggle,
} from '../components/ui'
import { cn } from '../lib/utils'

// "3 of 26 pages changed", "1 page changed".
export function changedText(changedPages, totalPages = 0) {
  const total = totalPages || changedPages
  return `${changedPages}${totalPages ? ` of ${totalPages}` : ''} page${total === 1 ? '' : 's'} changed`
}

// Compare mode controls: the two environments, the diff overlay, "changed
// pages only", and a capture button for an environment with no captures yet.
//
// On a phone the bar is one row: the two environments, swap, the view
// options behind one button, and leave. It used to wrap to four rows (145 px
// at 390) and every pixel of it came off the board and off the thread sheet,
// which is measured against the canvas (sheetFit.js): the thread was squeezed
// to a few lines while comparing. One row gives the board and the sheet what
// they have outside compare mode, less this bar's 60 px.
//
// Comments work while comparing: a pin goes on the side it is placed on
// (commentSide.js), so the bar no longer has anything to say about them.
export default function CompareBar({
  environments,
  pair,
  loading,
  error,
  changedPages,
  totalPages = 0,
  changedOnly,
  showDiff,
  canCapture,
  captureBusy,
  touch,
  onPair,
  onChangedOnly,
  onShowDiff,
  onCapture,
  onClose,
}) {
  const [a, b] = pair
  // `prefix`: the visible word before the picker ("with"); the bar's own
  // "Compare" title already introduces the first one.
  const select = (value, onChange, label, testId, prefix = null) => (
    <span className={cn('flex min-w-0 items-center gap-1 text-xs text-muted', touch && 'flex-1 basis-0')}>
      {touch || !prefix ? null : <span aria-hidden="true">{prefix}</span>}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          size={touch ? 'touch' : 'sm'}
          // A phone's row is tight: a little less padding keeps a name like
          // "Production" whole at 390 px.
          className={touch ? 'w-full min-w-0 px-2.5' : 'max-w-48'}
          aria-label={label}
          data-sw-compare-env={testId}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {environments.map((env) => (
            <SelectItem key={env.id} value={env.id}>
              {env.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  )
  const missing = environments.filter((env) => pair.includes(env.id) && !env.capturedAt)
  const titleOf = (id) => environments.find((env) => env.id === id)?.title || id
  const status = (
    <span className="text-xs text-muted" aria-live="polite" data-sw-compare-status={loading ? 'loading' : error ? 'error' : 'ready'}>
      {loading ? (
        <span className="inline-flex h-6 items-center gap-1.5">
          <Spinner size={12} /> Comparing
        </span>
      ) : error ? (
        <span className="text-bad">{error}</span>
      ) : (
        <span
          className={cn(
            'tabular inline-flex h-6 items-center rounded-full px-2 font-medium',
            changedPages ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted',
          )}
          data-sw-compare-changed={changedPages}
        >
          {changedText(changedPages, totalPages)}
        </span>
      )}
    </span>
  )
  const toggles = (
    <>
      <Toggle size={touch ? 'touch' : 'sm'} pressed={showDiff} onPressedChange={onShowDiff} data-sw-diff-toggle={showDiff ? 'on' : 'off'}>
        Diff overlay
      </Toggle>
      <Toggle
        size={touch ? 'touch' : 'sm'}
        pressed={changedOnly}
        onPressedChange={onChangedOnly}
        data-sw-changed-only={changedOnly ? 'on' : 'off'}
      >
        Changed pages only
      </Toggle>
    </>
  )
  const captures = canCapture
    ? missing.map((env) => (
        <Button key={env.id} size={touch ? 'touch' : 'sm'} disabled={captureBusy} onClick={() => onCapture(env.id)}>
          <Camera size={14} aria-hidden="true" /> Capture {env.title}
        </Button>
      ))
    : null
  const swap = (
    <IconButton
      size={touch ? 'icon' : 'icon-sm'}
      // Phones: full height to tap, narrower so the two names fit.
      className={cn(touch && 'w-8 shrink-0')}
      onClick={() => onPair([b, a])}
      label={`Swap: compare ${titleOf(b)} with ${titleOf(a)}`}
      data-sw-compare-swap="true"
    >
      <ArrowLeftRight size={14} aria-hidden="true" />
    </IconButton>
  )
  const close = (
    <IconButton
      size={touch ? 'icon' : 'icon-sm'}
      className={cn(!touch && 'ml-auto')}
      onClick={onClose}
      label="Leave compare mode"
      data-sw-compare-close="true"
    >
      <X size={16} aria-hidden="true" />
    </IconButton>
  )
  const pickA = select(a, (value) => onPair(value === b ? [value, a] : [value, b]), 'Compare', 'a')
  const pickB = select(b, (value) => onPair(value === a ? [b, value] : [a, value]), 'with', 'b', 'with')

  if (touch) {
    // One row. The options behind the slider button say how many pages
    // changed on the button itself, so the count is never more than a
    // glance away.
    const optionsLabel = loading
      ? 'Compare options, comparing'
      : error
        ? 'Compare options, the comparison failed'
        : `Compare options, ${changedText(changedPages, totalPages)}`
    return (
      <div
        className="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2 py-1.5"
        role="region"
        aria-label="Compare environments"
        data-sw-compare-bar={pair.join('_')}
        data-sw-compare-layout="row"
      >
        {pickA}
        {swap}
        {pickB}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="relative shrink-0" aria-label={optionsLabel} data-sw-compare-options="true">
              {loading ? <Spinner size={14} /> : <SlidersHorizontal size={16} aria-hidden="true" />}
              {!loading && (error || changedPages) ? (
                <span
                  className={cn(
                    'tabular absolute top-1 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold',
                    error ? 'bg-bad text-white' : 'bg-accent text-accent-fg',
                  )}
                  aria-hidden="true"
                >
                  {error ? '!' : changedPages}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-3" data-sw-compare-options-panel="true">
            <p className="mb-2 text-xs font-semibold text-fg">
              {titleOf(a)} with {titleOf(b)}
            </p>
            <div className="mb-3">{status}</div>
            <div className="flex flex-col gap-2 [&>button]:w-full [&>button]:justify-start">
              {toggles}
              {captures}
            </div>
          </PopoverContent>
        </Popover>
        {close}
      </div>
    )
  }

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2"
      role="region"
      aria-label="Compare environments"
      data-sw-compare-bar={pair.join('_')}
      data-sw-compare-layout="wrap"
    >
      <span className="flex shrink-0 items-center gap-1.5 pr-1 text-[13px] font-semibold text-fg">
        <GitCompare size={15} className="shrink-0 text-accent" aria-hidden="true" />
        Compare
      </span>
      {pickA}
      {swap}
      {pickB}
      <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      {toggles}
      {status}
      {captures}
      {close}
    </div>
  )
}
