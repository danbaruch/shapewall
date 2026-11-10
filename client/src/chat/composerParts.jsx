// Small pieces of the composer: mention and file chips, queued messages,
// follow-up chips, the help card, the usage ring, the agent's option menus
// (model, thinking, more), and the "Allow for this chat" list in Chat settings.

import { useState } from 'react'
import { AtSign, ChevronDown, Clock, FileText, Pencil, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Tooltip,
} from '../components/ui'
import { cn } from '../lib/utils'
import { MENTION_ICONS } from './ComposerInput'
import { HELP_LINES, currentLabel, formatBytes, optionGroups, usageSummary, valueLabel } from './composerModel.js'

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
// `ringOnly`: a tight footer; the number stays in the tooltip and label.
export function UsageRing({ usage, touch, ringOnly = false }) {
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
            {ringOnly && percent !== null ? null : <span className="text-caption">{summary.label}</span>}
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

// ---- Agent options: model, thinking level, mode, anything else ----------------------

const optionTitle = (option) => (option.category === 'model' ? 'Model' : option.name || 'Option')
// The hook on each choice: "model:stub-deep", "thought_level:high", and for
// an option outside the known kinds its own id.
const optionHook = (option, item) => `${option.category === 'other' ? option.id : option.category}:${item.value}`

// The current choice of the menu takes the focus when it opens, by pointer
// or keyboard, so the arrows start from it. Set in the menu's own mount
// (its items are there), never a frame later.
const focusChecked = (event) => {
  event.preventDefault()
  const content = event.currentTarget
  const target = content.querySelector('[role="menuitemradio"][data-state="checked"]') || content.querySelector('[role^="menuitem"]')
  target?.focus({ preventScroll: true })
}

function OptionItems({ option, onChoose }) {
  return (
    <DropdownMenuRadioGroup value={option.currentValue} onValueChange={(value) => onChoose(option, value)} aria-label={optionTitle(option)}>
      {option.values.map((item) => (
        <DropdownMenuRadioItem
          key={item.value}
          value={item.value}
          className={cn(item.description && 'h-auto min-h-11 py-1.5 lg:h-auto lg:min-h-8')}
          data-sw-chat-option={optionHook(option, item)}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{valueLabel(option, item)}</span>
            {item.description ? <span className="truncate text-caption font-normal text-faint">{item.description}</span> : null}
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

// One footer control: a quiet text button with the current value and a
// small chevron, its own menu. `options`: what the menu lists (one option,
// or several in sections). While a turn runs it stays focusable and says
// why it cannot change (aria-disabled, the tooltip).
function OptionMenu({ hook, label, ariaLabel, tooltip, icon = null, options, onChoose, disabled, disabledReason, touch, width = 'w-64' }) {
  const [open, setOpen] = useState(false)
  // The button's tooltip, never on top of its own open menu.
  const [tip, setTip] = useState(false)
  const [busy, setBusy] = useState(false)
  const choose = async (option, value) => {
    if (busy || value === option.currentValue) return
    setBusy(true)
    try {
      await onChoose(option.id, value)
    } finally {
      setBusy(false)
    }
  }
  const sections = options.length > 1
  return (
    <DropdownMenu open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)}>
      <Tooltip content={disabled ? disabledReason : tooltip} open={tip && !open} onOpenChange={setTip}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={touch ? 'touch' : 'sm'}
            className={cn(
              'max-w-full min-w-0 shrink gap-0.5 font-normal text-muted',
              icon && !label ? (touch ? 'w-11 px-0' : 'w-8 px-0') : 'px-1.5',
              disabled && 'cursor-default opacity-60 hover:bg-transparent hover:text-muted',
            )}
            aria-label={ariaLabel}
            aria-disabled={disabled || undefined}
            data-sw-chat-options-trigger={hook}
          >
            {icon}
            {label ? <span className="min-w-0 truncate text-caption">{label}</span> : null}
            {busy ? <Spinner size={11} /> : label ? <ChevronDown size={12} className="shrink-0 text-faint" aria-hidden="true" /> : null}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        className={cn(width, 'max-w-[calc(100vw-1rem)]')}
        onOpenAutoFocus={focusChecked}
        data-sw-chat-options-menu={hook}
      >
        {options.map((option, index) => (
          <div key={option.id}>
            {sections && index ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{optionTitle(option)}</DropdownMenuLabel>
            <OptionItems option={option} onChoose={choose} />
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The footer's options, as the agent offers them (agentOptions.js): a Model
// menu and a thinking menu (the agent's own label), the rest under "More
// options"; at narrow widths (`layout` "combined", composerModel.js
// footerLayout) one control with every option in sections. While they load
// before the first message: a quiet "Loading options".
export function AgentOptions({ options, loading, layout, onChoose, disabled, touch }) {
  if (!options?.length) {
    return loading ? (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 px-1.5 text-caption text-faint"
        role="status"
        data-sw-chat-options-loading="true"
      >
        <Spinner size={11} />
        <span className="truncate">Loading options</span>
      </span>
    ) : null
  }
  const disabledReason = 'Wait for the answer to finish to change this'
  const shared = { onChoose, disabled, disabledReason, touch }
  const { model, effort, more } = optionGroups(options)
  const categories = options.map((option) => option.category).join(' ')
  if (layout === 'combined') {
    const label = [model, effort].filter(Boolean).map(currentLabel).join(' · ') || currentLabel(options[0])
    return (
      <span className="flex min-w-0 items-center" data-sw-chat-options={categories}>
        <OptionMenu
          hook="all"
          label={label}
          ariaLabel={`Options for this chat: ${label}`}
          tooltip="Model and options for this chat"
          options={options}
          {...shared}
        />
      </span>
    )
  }
  return (
    <span className="flex min-w-0 items-center gap-0.5" data-sw-chat-options={categories}>
      {[model, effort].filter(Boolean).map((option) => (
        <OptionMenu
          key={option.id}
          hook={option.category}
          label={currentLabel(option)}
          ariaLabel={`${optionTitle(option)}: ${currentLabel(option)}`}
          tooltip={optionTitle(option)}
          options={[option]}
          width={option.values.some((item) => item.description) ? 'w-72' : 'w-56'}
          {...shared}
        />
      ))}
      {more.length ? (
        <OptionMenu
          hook="more"
          ariaLabel="More options"
          tooltip={`More options: ${more.map((option) => `${optionTitle(option)} ${currentLabel(option)}`).join(', ')}`}
          icon={<SlidersHorizontal size={14} aria-hidden="true" />}
          options={more}
          {...shared}
        />
      ) : null}
    </span>
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
