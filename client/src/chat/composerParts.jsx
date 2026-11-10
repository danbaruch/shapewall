// Small pieces of the composer: mention and file chips, queued messages,
// follow-up chips, the help card, the usage ring, the model and effort
// pickers, and the "Allow for this chat" list in Chat settings.

import { useState } from 'react'
import { AtSign, Check, ChevronDown, Clock, Cpu, FileText, Pencil, ShieldCheck, X } from 'lucide-react'
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger, Spinner, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'
import { MENTION_ICONS } from './ComposerInput'
import { HELP_LINES, formatBytes, usageSummary } from './composerModel.js'

const chipClass = 'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-line bg-surface-2 pl-2 text-xs text-fg'

function RemoveButton({ label, onClick, touch }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-(--motion-fast) hover:bg-surface hover:text-fg',
        touch ? 'h-11 w-11 -my-3' : 'h-6 w-6',
      )}
      aria-label={label}
      onClick={onClick}
    >
      <X size={12} aria-hidden="true" />
    </button>
  )
}

// Mentions picked with "@": on the composer (removable) and on a sent message.
export function MentionChips({ items, onRemove = null, touch = false, className }) {
  if (!items?.length) return null
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Mentioned" data-sw-chat-mentions="true">
      {items.map((item) => {
        const Icon = MENTION_ICONS[item.kind] || AtSign
        return (
          <li
            key={`${item.kind}:${item.id}`}
            className={cn(chipClass, !onRemove && 'pr-2', touch && onRemove && 'py-0.5')}
            data-sw-chat-mention={`${item.kind}:${item.id}`}
          >
            <Icon size={12} className="shrink-0 text-accent" aria-hidden="true" />
            <span className="sr-only">{item.kind}: </span>
            <span className="min-w-0 truncate">{item.label}</span>
            {onRemove ? <RemoveButton label={`Remove ${item.label}`} onClick={() => onRemove(item)} touch={touch} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

// Text files attached to a message.
export function FileChips({ items, onRemove = null, touch = false, className }) {
  if (!items?.length) return null
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Text files" data-sw-chat-files="true">
      {items.map((item) => (
        <li
          key={item.id || item.name}
          className={cn(chipClass, 'rounded-md', !onRemove && 'pr-2', touch && onRemove && 'py-0.5')}
          data-sw-chat-file-chip={item.name}
        >
          <FileText size={12} className="shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium">{item.name}</span>
          <span className="shrink-0 text-faint tabular-nums">{formatBytes(item.bytes)}</span>
          {onRemove ? <RemoveButton label={`Remove ${item.name}`} onClick={() => onRemove(item)} touch={touch} /> : null}
        </li>
      ))}
    </ul>
  )
}

// Messages written while the agent answers: sent one by one when it
// finishes. Edit puts one back in the box; Remove drops it.
export function QueuedMessages({ items, onEdit, onRemove, touch }) {
  if (!items?.length) return null
  return (
    <div className="mb-2 space-y-1" data-sw-chat-queue={items.length}>
      <p className="flex items-center gap-1 px-1 text-caption text-muted">
        <Clock size={11} aria-hidden="true" /> Queued: sends when the answer finishes
      </p>
      <ol className="space-y-1">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex items-center gap-1 rounded-lg border border-dashed border-line bg-surface-2/60 py-0.5 pr-0.5 pl-2.5 text-ui text-fg"
            data-sw-chat-queued={index}
          >
            <span className="min-w-0 flex-1 truncate">
              {item.text ||
                (item.fix ? 'Fix this comment' : `${item.mentions.length + item.files.length + item.attachments.length} attached`)}
            </span>
            <IconButton
              size={touch ? 'icon' : 'icon-xs'}
              label="Edit queued message"
              onClick={() => onEdit(item)}
              data-sw-chat-queued-edit={index}
            >
              <Pencil size={12} aria-hidden="true" />
            </IconButton>
            <IconButton
              size={touch ? 'icon' : 'icon-xs'}
              label="Remove queued message"
              onClick={() => onRemove(item)}
              data-sw-chat-queued-remove={index}
            >
              <X size={12} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ol>
    </div>
  )
}

// Chips above the box: starter prompts, or follow-ups after an answer.
export function PromptChips({ items, onPick, touch, label, hook }) {
  if (!items?.length) return null
  return (
    <div
      className={cn('mb-2 flex gap-1.5', touch ? '-mx-3 overflow-x-auto px-3 pb-1 [scrollbar-width:none]' : 'flex-wrap')}
      role="group"
      aria-label={label}
    >
      {items.map((text) => (
        <Button
          key={text}
          size={touch ? 'touch' : 'xs'}
          variant="secondary"
          className="max-w-full shrink-0 animate-fade-in rounded-full font-normal text-fg"
          onClick={() => onPick(text)}
          {...{ [hook]: 'true' }}
        >
          <span className="truncate">{text}</span>
        </Button>
      ))}
    </div>
  )
}

// /help: what the box understands. Local to this panel; nothing is sent.
export function HelpCard({ onClose, touch }) {
  return (
    <div className="mb-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-xs" role="note" data-sw-chat-help="true">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="font-medium text-fg">What you can type</p>
        <IconButton size={touch ? 'icon' : 'icon-xs'} label="Close help" onClick={onClose} data-sw-chat-help-close="true">
          <X size={12} aria-hidden="true" />
        </IconButton>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        {HELP_LINES.map(([key, text]) => (
          <div key={key} className="contents">
            <dt className="font-mono font-medium text-fg">{key}</dt>
            <dd className="text-muted">{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// Context used and the last answer's tokens, when the backend reports them.
export function UsageRing({ usage, touch }) {
  const summary = usageSummary(usage)
  if (!summary) return null
  const size = 18
  const stroke = 2.5
  const radius = (size - stroke) / 2
  const length = 2 * Math.PI * radius
  const percent = summary.percent
  const tone = percent === null ? 'text-muted' : percent >= 90 ? 'text-bad' : percent >= 70 ? 'text-warn' : 'text-accent'
  const label = summary.lines.join('. ')
  return (
    <Popover>
      <Tooltip content={summary.lines.join(' · ')}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={touch ? 'touch' : 'xs'}
            className="ml-auto shrink-0 gap-1 px-1 font-normal text-muted tabular-nums"
            aria-label={label}
            data-sw-chat-usage={percent ?? 'tokens'}
          >
            {percent !== null ? (
              <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn('-rotate-90', tone)} aria-hidden="true">
                <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth={stroke} />
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${(Math.max(2, percent) / 100) * length} ${length}`}
                />
              </svg>
            ) : null}
            <span className="text-caption">{summary.label}</span>
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-64 space-y-1 p-3 text-xs" data-sw-chat-usage-details="true">
        <p className="font-medium text-fg">Usage</p>
        {summary.lines.map((line) => (
          <p key={line} className="text-muted">
            {line}
          </p>
        ))}
        <p className="text-faint">As the agent reports it. Shapewall does not bill or limit tokens.</p>
      </PopoverContent>
    </Popover>
  )
}

// The thread's model and effort, from the agent session's own choices: one
// compact button (the model, then the effort) that opens both lists. The
// list stays open while you pick (set both in one go); the arrow keys move
// through the choices, Home and End jump, Esc closes.
export function SessionOptions({ options, onChoose, disabled, touch }) {
  const [busy, setBusy] = useState(null)
  const [open, setOpen] = useState(false)
  if (!options?.length) return null
  const current = (option) => option.values.find((item) => item.value === option.currentValue)?.name || option.currentValue
  const label = options.map(current).join(' · ')
  const choose = async (option, value) => {
    // Never disable the focused choice while saving: a disabled button drops
    // the focus, and the popover would close as if you clicked away.
    if (busy !== null || value === option.currentValue) return
    setBusy(option.id)
    try {
      await onChoose(option.id, value)
    } finally {
      setBusy(null)
    }
  }
  const onKeyDown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll('[data-sw-chat-option]')]
    if (!items.length) return
    event.preventDefault()
    const at = items.indexOf(document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : items.length - 1
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : at < 0 ? 0 : (at + step) % items.length
    items[next].focus()
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Model and effort for this chat">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={touch ? 'touch' : 'sm'}
            className="max-w-full min-w-0 shrink gap-0.5 px-1 font-normal text-muted"
            disabled={disabled}
            aria-label={`Model and effort for this chat: ${label}`}
            data-sw-chat-options={options.map((option) => option.category).join(' ')}
          >
            <Cpu size={13} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate text-caption">{label}</span>
            {busy ? <Spinner size={11} /> : <ChevronDown size={12} className="shrink-0 text-faint" aria-hidden="true" />}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        className="w-64 space-y-2 p-2"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          // The current choice of the first list takes the focus, for the arrows.
          event.preventDefault()
          const content = event.currentTarget
          const first =
            content.querySelector('[data-sw-chat-option][aria-pressed="true"]') || content.querySelector('[data-sw-chat-option]')
          first?.focus()
        }}
        data-sw-chat-options-menu="true"
      >
        {options.map((option) => (
          <div key={option.id} role="group" aria-label={option.name}>
            <p className="px-2 pt-1 pb-0.5 text-caption font-medium text-faint">
              {option.category === 'model' ? 'Model' : 'Reasoning effort'}
            </p>
            {option.values.map((item) => {
              const selected = item.value === option.currentValue
              return (
                <button
                  key={item.value}
                  type="button"
                  className={cn(
                    'flex h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui transition-colors duration-(--motion-fast) outline-none focus-visible:bg-surface-2 focus-visible:text-fg lg:h-8',
                    selected ? 'text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                    busy !== null && 'opacity-60',
                  )}
                  aria-pressed={selected}
                  aria-disabled={busy !== null || undefined}
                  onClick={() => choose(option, item.value)}
                  data-sw-chat-option={`${option.category}:${item.value}`}
                >
                  <Check size={14} className={cn('shrink-0 text-accent', !selected && 'invisible')} aria-hidden="true" />
                  <span className="min-w-0 truncate">{item.name}</span>
                </button>
              )
            })}
          </div>
        ))}
        <p className="border-t border-line px-2 pt-2 text-caption text-faint">
          For this chat while its agent session runs. The agent&apos;s own defaults do not change.
        </p>
      </PopoverContent>
    </Popover>
  )
}

// Chat settings: what "Allow for this chat" answers by itself, each revocable.
export function AutoAllowSettings({ rules, onRevoke, touch }) {
  if (!rules?.length) return null
  return (
    <div className="space-y-1.5 border-t border-line pt-3 text-xs" data-sw-chat-auto-allow={rules.length}>
      <p className="flex items-center gap-1.5 font-medium text-fg">
        <ShieldCheck size={13} className="text-ok" aria-hidden="true" /> Allowed for this chat
      </p>
      <p className="text-muted">The same request is approved without asking until you remove it, clear the thread or reload.</p>
      <ul className="space-y-1">
        {rules.map((rule) => (
          <li key={rule.id} className="flex items-center gap-1 rounded-md border border-line bg-surface-2/60 py-0.5 pr-0.5 pl-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{rule.label}</span>
            <Button
              size={touch ? 'touch' : 'xs'}
              variant="ghost"
              onClick={() => onRevoke(rule)}
              aria-label={`Stop allowing ${rule.label}`}
              data-sw-chat-auto-allow-revoke={rule.kind}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
