// The one agent picker, used wherever an agent is chosen: the chat header
// (which agent answers this chat) and the caret of "Fix with ..." on a
// comment thread (which agent runs this fix, once). A Radix menu: arrow keys,
// type-ahead on the names, Escape, focus back on the trigger.
//
// Each row: the agent's monogram, its name, how it is doing in plain words
// (profiles.js stateLine, from src/agent/agent-health.js), and "Default" on
// the one new chats and fixes use. The current choice is checked. Below
// them, when given: "Connect another agent..." and "Agent settings".

import { Plug, Settings2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '../components/ui'
import { cn } from '../lib/utils'
import { STATE_DOT, monogram, stateLine } from './profiles'

// The agent's tile: two letters, with its state dot at the corner.
export function AgentMark({ label, state = 'ready', size = 'md', className }) {
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 font-semibold text-fg',
        size === 'sm' ? 'h-5 w-5 text-[9px]' : 'h-7 w-7 text-[11px]',
        className,
      )}
      aria-hidden="true"
    >
      {monogram(label)}
      <span
        className={cn(
          'absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-surface',
          size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
          STATE_DOT[state] || STATE_DOT.ready,
        )}
      />
    </span>
  )
}

// A line with `code` spans for the parts in backticks (a sign-in command).
function Line({ text }) {
  return String(text)
    .split(/(`[^`]+`)/)
    .map((part, index) =>
      part.startsWith('`') && part.endsWith('`') ? (
        <code key={index} className="font-mono text-[10.5px] text-fg">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    )
}

// `options`: profiles.js pickerProfiles options. `value`: the checked one
// (null: none checked, a one-off choice). `onChoose(id)`. `disabledReason`:
// the menu does not open, and the trigger says why on hover and focus.
// `children`: the trigger (it must take a ref and spread props).
export function AgentPicker({
  options,
  value = null,
  onChoose,
  onConnect = null,
  settingsHref = null,
  disabledReason = null,
  heading = null,
  align = 'start',
  touch = false,
  children,
  ...props
}) {
  const trigger = (
    <DropdownMenuTrigger
      asChild
      aria-disabled={disabledReason ? 'true' : undefined}
      // A disabled trigger still takes focus, so its reason can be read.
      onPointerDown={disabledReason ? (event) => event.preventDefault() : undefined}
      onKeyDown={
        disabledReason ? (event) => ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key) && event.preventDefault() : undefined
      }
    >
      {children}
    </DropdownMenuTrigger>
  )
  return (
    <DropdownMenu modal={false}>
      {disabledReason ? <Tooltip content={disabledReason}>{trigger}</Tooltip> : trigger}
      <DropdownMenuContent
        align={align}
        className={cn('w-[min(20rem,calc(100vw-1.5rem))]', touch && 'p-1.5')}
        data-sw-agent-menu="true"
        {...props}
      >
        {heading ? <DropdownMenuLabel className="normal-case tracking-normal">{heading}</DropdownMenuLabel> : null}
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(picked) => onChoose?.(picked)}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              disabled={!option.configured}
              textValue={option.label}
              className="h-auto min-h-11 items-start py-2 lg:h-auto lg:min-h-11"
              aria-label={`${option.label}${option.isDefault ? ', default' : ''}, ${stateLine(option)}`}
              data-sw-agent-option={option.id}
              data-sw-agent-state={option.state}
            >
              <AgentMark label={option.label} state={option.state} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium text-fg">{option.label}</span>
                  {option.isDefault ? (
                    <span
                      className="shrink-0 rounded-full border border-line px-1.5 text-[10px] leading-4 font-medium text-muted"
                      data-sw-agent-default="true"
                    >
                      Default
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'line-clamp-2 text-[11.5px] leading-4 font-normal',
                    option.state === 'login' ? 'text-fg' : option.state === 'not-responding' ? 'text-bad' : 'text-muted',
                  )}
                >
                  <Line text={stateLine(option)} />
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onConnect || settingsHref ? <DropdownMenuSeparator /> : null}
        {onConnect ? (
          <DropdownMenuItem onSelect={onConnect} data-sw-agent-connect="true">
            <Plug size={14} aria-hidden="true" /> Connect another agent...
          </DropdownMenuItem>
        ) : null}
        {settingsHref ? (
          <DropdownMenuItem asChild>
            <a href={settingsHref} data-sw-agent-settings="true">
              <Settings2 size={14} aria-hidden="true" /> Agent settings
            </a>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
