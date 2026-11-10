import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot } from 'lucide-react'
import { cn } from '../lib/utils'
import { Avatar, Popover, PopoverAnchor, PopoverContent, Textarea } from '../components/ui'
import { personColorKey } from './commentParts'
import { isAgentHandle, isKnownMention, splitMentions } from '../../../src/mentions.js'

// Everyone on the board (boardPeople in src/mentions.js): which mentions are
// shown as mentions. Board provides it once.
export const BoardPeople = createContext([])

// Comment text with each @mention as a chip: people in the accent colour,
// agents with a robot. A handle nobody on the board goes by ("@ag", a typo)
// stays plain text, and so does everything a share link guest wrote: a guest
// cannot reach anyone, so "@agent" from one is just text.
export function MentionText({ text, className, plain = false }) {
  const people = useContext(BoardPeople)
  const parts = useMemo(() => (plain ? [{ text: String(text ?? '') }] : splitMentions(text)), [text, plain])
  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.handle && isKnownMention(part.handle, people) ? (
          <span
            key={index}
            className={cn(
              'inline-flex items-baseline gap-0.5 rounded px-1 font-medium',
              isAgentHandle(part.handle) ? 'bg-warn/15 text-fg' : 'bg-accent/10 text-accent',
            )}
            data-sw-mention={part.handle}
          >
            {isAgentHandle(part.handle) ? <Bot size={11} className="self-center" aria-hidden="true" /> : null}
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  )
}

// The "@nam" being typed just before the caret, or null.
function typedMention(value, caret) {
  const match = /(^|[^\w@.])@([\w.-]{0,40})$/.exec(value.slice(0, caret))
  return match ? { query: match[2].toLowerCase(), start: caret - match[2].length - 1 } : null
}

// A textarea that suggests people and agents after "@". Arrow keys move,
// Enter or Tab picks (Enter on a handle typed out in full is the field's own
// Enter, so it posts), Escape closes the list (not the dialog around it). The
// list is a popover anchored to the field, so a sheet or a scrolling panel
// never clips it, and the caret never leaves the field.
export function MentionTextarea({ value, onChange, people, className, onKeyDown, size, ...props }) {
  const ref = useRef(null)
  // The caret after a picked mention, placed as soon as the new text is in
  // the box (before the next key, so fast typing lands after the mention).
  const caretAfterPick = useRef(null)
  useLayoutEffect(() => {
    const element = ref.current
    const at = caretAfterPick.current
    if (!element || at === null || element.value !== value) return
    caretAfterPick.current = null
    element.focus()
    element.setSelectionRange(at, at)
  }, [value])
  const listId = useId()
  const [typed, setTyped] = useState(null)
  const [active, setActive] = useState(0)
  // One row per person (boardPeople folds a name-made alias like
  // "@robin-ash" into "@robin"), and typing the alias still finds them.
  const matches = useMemo(() => {
    if (!typed) return []
    const { query } = typed
    const handles = (person) => [person.handle, ...(person.aliases || [])]
    const found = people
      .filter((person) => person.known !== false)
      .filter((person) => handles(person).some((handle) => handle.startsWith(query)) || person.name.toLowerCase().includes(query))
      .map((person) => ({ ...person, exact: Boolean(query) && handles(person).includes(query) }))
    // The exact handle first, so Enter on a finished "@robin" posts.
    return [...found.filter((person) => person.exact), ...found.filter((person) => !person.exact)].slice(0, 6)
  }, [people, typed])
  const open = matches.length > 0

  const refresh = (element) => {
    const next = typedMention(element.value, element.selectionStart ?? element.value.length)
    setTyped(next)
    setActive(0)
  }
  const pick = (person) => {
    const element = ref.current
    if (!element || !typed) return
    const caret = element.selectionStart ?? value.length
    const insert = `@${person.handle} `
    const next = `${value.slice(0, typed.start)}${insert}${value.slice(caret)}`
    onChange(next)
    setTyped(null)
    caretAfterPick.current = typed.start + insert.length
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? null : setTyped(null))} history={false}>
      <PopoverAnchor asChild>
        <Textarea
          ref={ref}
          size={size}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            refresh(event.target)
          }}
          onClick={(event) => refresh(event.currentTarget)}
          onBlur={() => window.setTimeout(() => setTyped(null), 150)}
          onKeyDown={(event) => {
            // An IME's Enter picks a word, not a mention.
            if (open && !event.nativeEvent.isComposing) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
                return
              }
              // The mention is already typed out in full: Enter posts (or
              // whatever the field does) instead of picking it again.
              const finished = event.key === 'Enter' && active === 0 && matches[0].exact
              if (finished) setTyped(null)
              else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                pick(matches[active])
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
      <PopoverContent
        id={listId}
        role="listbox"
        aria-label="Mention someone"
        side="bottom"
        className="max-h-56 w-[var(--radix-popover-trigger-width)] overflow-y-auto"
        // The caret stays in the field: the list never takes focus.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // A press in the field itself re-reads the caret (onClick) instead.
        onInteractOutside={(event) => {
          if (event.target === ref.current) event.preventDefault()
        }}
        data-sw-mention-list="true"
      >
        {matches.map((person, index) => (
          <div key={person.handle} id={`${listId}-${index}`} role="option" aria-selected={index === active}>
            <button
              type="button"
              tabIndex={-1}
              // mousedown, so the textarea does not lose the caret first.
              onMouseDown={(event) => {
                event.preventDefault()
                pick(person)
              }}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px]',
                'h-11 lg:h-8',
                index === active ? 'bg-accent/10 text-fg' : 'text-muted hover:bg-surface-2',
                'transition-colors',
              )}
              data-sw-mention-option={person.handle}
            >
              <Avatar
                person
                agent={Boolean(person.agent)}
                name={person.name}
                colorKey={personColorKey(person)}
                size="sm"
                className="shrink-0"
              />
              <span className="min-w-0 truncate font-medium text-fg">{person.agent ? '@' + person.handle : person.name}</span>
              <span className="min-w-0 shrink truncate text-xs text-faint">
                {person.agent ? (person.name !== person.handle ? person.name : 'agent') : '@' + person.handle}
              </span>
            </button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
