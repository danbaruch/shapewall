// The composer's text box with its two pickers: "@" mentions a page, a
// comment, a journey, a commented element or a person (picked ones become
// chips above the box), and "/" at the start runs a command. Arrow keys
// move, Enter or Tab picks, Escape closes the list (not the panel or sheet
// around it). The list is a popover anchored to the box, so a sheet never
// clips it, and the caret never leaves the box (like board/Mentions.jsx).

import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AtSign,
  FileText,
  HelpCircle,
  ListChecks,
  MessageSquare,
  MessageSquarePlus,
  Play,
  RefreshCw,
  Route,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  User,
  Wrench,
} from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent, Textarea } from '../components/ui'
import { cn } from '../lib/utils'
import { MENTION_KINDS, filterCommands, filterMentions, mentionText, typedCommand, typedMention } from './composerModel.js'

export const MENTION_ICONS = { page: FileText, comment: MessageSquare, journey: Route, element: SquareDashedMousePointer, person: User }
const COMMAND_ICONS = {
  fix: Wrench,
  review: ListChecks,
  checks: Play,
  recapture: RefreshCw,
  new: MessageSquarePlus,
  clear: Trash2,
  help: HelpCircle,
}

export const ComposerInput = forwardRef(function ComposerInput(
  { value, onChange, onKeyDown, candidates, mentions, onMention, commands, onCommand, className, ...props },
  forwardedRef,
) {
  const ref = useRef(null)
  useImperativeHandle(forwardedRef, () => ref.current)
  const caretAt = useRef(null)
  useLayoutEffect(() => {
    const element = ref.current
    const at = caretAt.current
    if (!element || at === null || element.value !== value) return
    caretAt.current = null
    element.focus()
    element.setSelectionRange(at, at)
  }, [value])
  const listId = useId()
  // { type: 'mention' | 'command', query, start? } while a list may show.
  const [typed, setTyped] = useState(null)
  const [active, setActive] = useState(0)
  const items = useMemo(() => {
    if (!typed) return []
    if (typed.type === 'command') return filterCommands(commands, typed.query).map((item) => ({ ...item, key: `cmd:${item.id}` }))
    return filterMentions(candidates, typed.query, mentions)
  }, [typed, commands, candidates, mentions])
  const open = items.length > 0

  const refresh = (element) => {
    const caret = element.selectionStart ?? element.value.length
    const command = typedCommand(element.value, caret)
    const mention = command ? null : typedMention(element.value, caret)
    setTyped(command ? { type: 'command', ...command } : mention ? { type: 'mention', ...mention } : null)
    setActive(0)
  }
  const pick = (item) => {
    const element = ref.current
    if (!element || !typed) return
    if (typed.type === 'command') {
      setTyped(null)
      onChange('')
      onCommand(item.id)
      return
    }
    const caret = element.selectionStart ?? value.length
    // The "@query" becomes the thing's short name in place ("Look at
    // Pricing page"), the text around it stays, and the pick is also a chip
    // above the box (what the server gets).
    const before = value.slice(0, typed.start)
    const after = value.slice(caret).replace(/^ +/, '')
    const name = `${mentionText(item)} `
    onChange(`${before}${name}${after}`)
    onMention(item)
    setTyped(null)
    caretAt.current = before.length + name.length
  }

  let lastKind = null
  return (
    <Popover open={open} onOpenChange={(next) => (next ? null : setTyped(null))} history={false}>
      <PopoverAnchor asChild>
        <Textarea
          ref={ref}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            refresh(event.target)
          }}
          onClick={(event) => refresh(event.currentTarget)}
          onBlur={() =>
            // Late, so a click in the list lands first; skipped if the box
            // has the focus again by then (a quick send and a new "/").
            window.setTimeout(() => {
              if (document.activeElement !== ref.current) setTyped(null)
            }, 150)
          }
          onKeyDown={(event) => {
            if (open && !event.nativeEvent.isComposing) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
                return
              }
              if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                event.preventDefault()
                pick(items[Math.min(active, items.length - 1)])
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                event.nativeEvent.stopImmediatePropagation?.()
                setTyped(null)
                return
              }
            }
            onKeyDown?.(event)
          }}
          className={className}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          {...props}
        />
      </PopoverAnchor>
      {/* Only while open: a list closed mid-animation must not linger and
          take the next Escape (the /help card's, say). */}
      {open ? (
        <PopoverContent
          id={listId}
          role="listbox"
          aria-label={typed?.type === 'command' ? 'Commands' : 'Mention something'}
          side="top"
          align="start"
          className="max-h-72 w-[var(--radix-popover-trigger-width)] overflow-y-auto"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target === ref.current) event.preventDefault()
          }}
          data-sw-chat-picker={typed?.type || 'none'}
        >
          {items.map((item, index) => {
            const command = typed?.type === 'command'
            const Icon = command ? COMMAND_ICONS[item.id] || Sparkles : MENTION_ICONS[item.kind] || AtSign
            const heading = !command && item.kind !== lastKind ? MENTION_KINDS.find((entry) => entry.kind === item.kind)?.label : null
            lastKind = item.kind
            return (
              <div key={item.key}>
                {heading ? (
                  <p className="px-2 pt-1.5 pb-0.5 text-caption font-medium text-faint" aria-hidden="true">
                    {heading}
                  </p>
                ) : null}
                <div id={`${listId}-${index}`} role="option" aria-selected={index === active}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      pick(item)
                    }}
                    className={cn(
                      'flex h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui transition-colors duration-(--motion-fast) lg:h-8',
                      index === active ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-surface-2',
                    )}
                    data-sw-chat-picker-option={command ? item.id : item.key}
                  >
                    <Icon size={14} className="shrink-0 text-faint" aria-hidden="true" />
                    {command ? (
                      <>
                        <span className="shrink-0 font-medium text-fg">/{item.id}</span>
                        <span className="min-w-0 truncate text-xs text-muted">{item.description}</span>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 truncate font-medium text-fg">{item.label}</span>
                        {item.hint ? <span className="ml-auto min-w-0 shrink truncate pl-2 text-xs text-faint">{item.hint}</span> : null}
                      </>
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </PopoverContent>
      ) : null}
    </Popover>
  )
})
