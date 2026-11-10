import { useState } from 'react'
import { Smile } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'
import { REACTION_LABELS, REACTIONS } from '../../../src/reactions.js'

// Whether `me` ({ name, handle }) is one of the people who reacted.
function reactedByMe(entry, me) {
  if (!me) return false
  return entry.by.some((person) =>
    me.handle && person.handle
      ? person.handle === me.handle
      : String(person.name).toLowerCase() === String(me.name || 'anonymous').toLowerCase(),
  )
}

function whoReacted(entry, me) {
  const label = REACTION_LABELS[entry.emoji] || entry.emoji
  if (!entry.by.length) return `${entry.count} ${entry.count === 1 ? 'person' : 'people'} reacted with ${label}`
  const names = entry.by.map((person) => (reactedByMe({ by: [person] }, me) ? 'You' : person.name))
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  return `${list} reacted with ${label}`
}

// Emoji reactions under a message: chips with counts (yours highlighted, who
// reacted on hover) and, for people who may react, a picker.
export function Reactions({ reactions = [], canReact, me, onToggle, touch }) {
  const [picking, setPicking] = useState(false)
  if (!reactions.length && !canReact) return null
  const chip = cn(
    'inline-flex items-center gap-1 rounded-full border px-1.5 text-xs leading-none tabular',
    touch ? 'h-11 min-w-11 justify-center' : 'h-6',
  )
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-sw-reactions="true">
      {reactions.map((entry) => {
        const mine = reactedByMe(entry, me)
        const tip = whoReacted(entry, me)
        return (
          <Tooltip key={entry.emoji} content={tip}>
            {canReact ? (
              <button
                type="button"
                className={cn(
                  chip,
                  'transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                  mine
                    ? 'border-accent/35 bg-accent/5 text-fg hover:border-accent/60'
                    : 'border-line bg-surface-2 text-fg hover:border-faint',
                )}
                aria-pressed={mine}
                aria-label={`${tip}. ${mine ? 'Remove your reaction' : 'Add yours'}`}
                onClick={() => onToggle(entry.emoji)}
                data-sw-reaction={entry.emoji}
                data-sw-reaction-mine={mine ? 'true' : 'false'}
              >
                <span aria-hidden="true">{entry.emoji}</span>
                <span aria-hidden="true" className="font-medium">
                  {entry.count}
                </span>
              </button>
            ) : (
              <span className={cn(chip, 'border-line bg-surface-2 text-fg')} aria-label={tip} role="img" data-sw-reaction={entry.emoji}>
                <span aria-hidden="true">{entry.emoji}</span>
                <span aria-hidden="true" className="font-medium">
                  {entry.count}
                </span>
              </span>
            )}
          </Tooltip>
        )
      })}
      {canReact ? (
        <Popover open={picking} onOpenChange={setPicking}>
          <Tooltip content="Add a reaction">
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  chip,
                  // Square, so the face sits dead centre.
                  touch ? 'px-0' : 'w-6 justify-center px-0',
                  'border-transparent text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent',
                  // Quiet until the message is hovered or focused (always there on touch).
                  !touch && !reactions.length && 'opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100',
                  picking && 'opacity-100',
                )}
                aria-label="Add a reaction"
                data-sw-reaction-add="true"
              >
                <Smile size={15} aria-hidden="true" />
              </button>
            </PopoverTrigger>
          </Tooltip>
          {/* Beside the button, so the message stays readable while picking.
              A phone has no room beside it: below, under the button. */}
          <PopoverContent
            side={touch ? 'bottom' : 'right'}
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="flex gap-0.5 p-1"
            aria-label="Reactions"
            data-sw-reaction-picker="true"
          >
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={cn(
                  'inline-flex items-center justify-center rounded-md text-lg hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent',
                  touch ? 'h-11 w-11' : 'h-8 w-8',
                )}
                aria-label={`React with ${REACTION_LABELS[emoji]}`}
                onClick={() => {
                  setPicking(false)
                  onToggle(emoji)
                }}
                data-sw-reaction-pick={emoji}
              >
                {emoji}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
