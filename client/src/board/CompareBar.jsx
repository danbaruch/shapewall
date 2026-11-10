import { ArrowLeftRight, Camera, GitCompare, X } from 'lucide-react'
import { Button, IconButton, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, Toggle } from '../components/ui'
import { cn } from '../lib/utils'

// Compare mode controls: the two environments, the diff overlay, "changed
// pages only", and a capture button for an environment with no captures yet.
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
    <span className={cn('flex min-w-0 items-center gap-1 text-xs text-muted', touch && 'min-w-28 flex-1')}>
      {touch || !prefix ? null : <span aria-hidden="true">{prefix}</span>}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          size={touch ? 'touch' : 'sm'}
          className={touch ? 'flex-1' : 'max-w-48'}
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
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2"
      role="region"
      aria-label="Compare environments"
      data-sw-compare-bar={pair.join('_')}
    >
      <span className="flex shrink-0 items-center gap-1.5 pr-1 text-[13px] font-semibold text-fg">
        <GitCompare size={15} className="shrink-0 text-accent" aria-hidden="true" />
        {touch ? null : 'Compare'}
      </span>
      {select(a, (value) => onPair(value === b ? [value, a] : [value, b]), 'Compare', 'a')}
      <IconButton size={touch ? 'icon' : 'icon-sm'} onClick={() => onPair([b, a])} label="Swap the environments">
        <ArrowLeftRight size={14} aria-hidden="true" />
      </IconButton>
      {select(b, (value) => onPair(value === a ? [b, value] : [a, value]), 'with', 'b', 'with')}
      <IconButton
        size={touch ? 'icon' : 'icon-sm'}
        className={cn('ml-auto', !touch && 'order-last')}
        onClick={onClose}
        label="Leave compare mode"
        data-sw-compare-close="true"
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
      <Toggle size={touch ? 'touch' : 'sm'} pressed={showDiff} onPressedChange={onShowDiff}>
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
      <span className="text-xs text-muted" aria-live="polite" data-sw-compare-status={loading ? 'loading' : 'ready'}>
        {loading ? (
          <span className="inline-flex items-center gap-1.5">
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
          >
            {changedPages}
            {totalPages ? ` of ${totalPages}` : ''} page{(totalPages || changedPages) === 1 ? '' : 's'} changed
          </span>
        )}
      </span>
      {canCapture
        ? missing.map((env) => (
            <Button key={env.id} size={touch ? 'touch' : 'sm'} disabled={captureBusy} onClick={() => onCapture(env.id)}>
              <Camera size={14} aria-hidden="true" /> Capture {env.title}
            </Button>
          ))
        : null}
    </div>
  )
}
