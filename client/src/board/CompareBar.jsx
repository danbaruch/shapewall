import { ArrowLeftRight, Camera, GitCompare, MessageSquareOff, X } from 'lucide-react'
import {
  Button,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Toggle,
  Tooltip,
} from '../components/ui'
import { cn } from '../lib/utils'

// Why there is no Comment tool while comparing. A comment belongs to a page
// rather than to one environment -- the pins are drawn once, on the first
// environment's frame (layout.js framePins) -- so a click on either capture
// would be the same comment, and which capture you meant is a question the
// board cannot answer for you. Reading, replying, resolving and jumping to a
// comment all work while comparing; only placing a new one waits. The tools
// show no Comment button in compare mode, and a button that is not there
// explains nothing, so the bar says it in one line.
const NO_COMMENTS = 'No new comments while comparing'
const NO_COMMENTS_WHY = 'A comment belongs to a page, not to one environment. Leave compare to add one; replies and resolving work here.'

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
  // This person may comment on this board, so the missing Comment tool is
  // worth explaining. A viewer or a guest never had one.
  canComment = false,
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
      {canComment ? (
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted" data-sw-compare-no-comments="true">
          <MessageSquareOff size={13} className="shrink-0" aria-hidden="true" />
          {touch ? (
            <span className="min-w-0">{NO_COMMENTS}</span>
          ) : (
            <Tooltip content={NO_COMMENTS_WHY}>
              <span className="min-w-0 cursor-help underline decoration-dotted underline-offset-2" tabIndex={0}>
                {NO_COMMENTS}
              </span>
            </Tooltip>
          )}
          {/* The whole reason, for a reader who cannot hover a tooltip. */}
          <span className="sr-only">{NO_COMMENTS_WHY}</span>
        </span>
      ) : null}
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
