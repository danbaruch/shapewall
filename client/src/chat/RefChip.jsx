// A reference to the board in an agent's answer (refs.js): a chip that jumps
// the canvas there and opens the thing (a comment's thread, a page, a
// journey, a page's checks), with a preview on hover or keyboard focus and,
// on touch, on a long press (a tap jumps).

import { createContext, useContext, useMemo, useRef, useState } from 'react'
import { FileText, Flag, MessageSquare, Route } from 'lucide-react'
import { Badge, HoverCard, HoverCardContent, HoverCardTrigger, Popover, PopoverAnchor, PopoverContent } from '../components/ui'
import { cn } from '../lib/utils'
import { refLabel, usedRefs } from './refs'
import { excerpt } from './text'
import { commentText } from '../../../src/comment-fields.js'

// { index, onNavigate(ref), thumbFor(pageId), touch }, or null: plain text.
export const RefsContext = createContext(null)
export const useRefs = () => useContext(RefsContext)

const ICONS = { comment: MessageSquare, page: FileText, journey: Route, check: Flag }
const LONG_PRESS_MS = 450

const COMMENT_STATUS = {
  resolved: { tone: 'ok', text: 'Resolved' },
  'needs-human': { tone: 'warn', text: 'Needs a person' },
  done: { tone: 'accent', text: 'Agent done' },
  'branch-ready': { tone: 'warn', text: 'Fix ready on branch' },
}

function Preview({ item, refs }) {
  if (item.kind === 'comment') {
    const comment = item.target
    const status = comment.status === 'resolved' ? COMMENT_STATUS.resolved : COMMENT_STATUS[comment.agentStatus] || null
    const page = refs.index.pages.get(comment.pageId)
    return (
      <div className="space-y-1.5" data-sw-ref-preview="comment">
        <p className="flex items-center gap-1.5 text-caption text-muted">
          <span className="font-semibold text-fg">#{comment.id}</span>
          <span className="min-w-0 truncate">{comment.author || 'Comment'}</span>
          {status ? (
            <Badge tone={status.tone} className="ml-auto">
              {status.text}
            </Badge>
          ) : null}
        </p>
        <p className="line-clamp-4 text-ui break-words text-fg">{excerpt(commentText(comment), 200)}</p>
        {page ? (
          <p className="truncate text-caption text-muted">
            {page.title} · {comment.viewport}
          </p>
        ) : null}
      </div>
    )
  }
  if (item.kind === 'journey') {
    return (
      <div className="space-y-1" data-sw-ref-preview="journey">
        <p className="text-ui font-semibold text-fg">{item.target.name}</p>
        <p className="text-caption text-muted">Journey{item.target.steps?.length ? ` · ${item.target.steps.length} steps` : ''}</p>
      </div>
    )
  }
  const page = item.target
  const thumb = refs.thumbFor?.(page.id)
  return (
    <div className="space-y-1.5" data-sw-ref-preview={item.kind}>
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="h-28 w-full rounded-md bg-sunken object-cover object-top shadow-thumb"
          loading="lazy"
          data-sw-ref-thumb="true"
        />
      ) : null}
      <p className="flex items-baseline gap-1.5">
        <span className="min-w-0 truncate text-ui font-semibold text-fg">{page.title}</span>
        {page.path ? <span className="min-w-0 truncate font-mono text-caption text-muted">{page.path}</span> : null}
      </p>
      {item.kind === 'check' ? (
        <p className="text-caption text-muted">
          {item.count ? `${item.count} check${item.count === 1 ? '' : 's'} to look at` : 'No open checks on this page'}
        </p>
      ) : null}
    </div>
  )
}

const ACTION = { comment: 'Open comment', page: 'Go to page', journey: 'Open journey', check: 'Open checks for' }

export function RefChip({ item, children, className }) {
  const refs = useRefs()
  const [open, setOpen] = useState(false)
  const press = useRef({ timer: 0, long: false })
  if (!refs?.onNavigate) return <span className={className}>{children ?? refLabel(item)}</span>
  const Icon = ICONS[item.kind]
  const label = children ?? refLabel(item)
  const go = (event) => {
    if (press.current.long) {
      press.current.long = false
      event.preventDefault()
      return
    }
    setOpen(false)
    refs.onNavigate(item)
  }
  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse') return
    press.current.long = false
    window.clearTimeout(press.current.timer)
    press.current.timer = window.setTimeout(() => {
      press.current.long = true
      setOpen(true)
    }, LONG_PRESS_MS)
  }
  const cancelPress = () => window.clearTimeout(press.current.timer)
  const chip = (
    <button
      type="button"
      className={cn(
        'mx-px inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 align-baseline text-[0.92em] leading-[1.45] font-medium text-fg',
        'transition-colors duration-(--motion-fast) ease-standard hover:border-accent/60 hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        // A finger needs a bigger target than the text line: the hit area grows, not the chip.
        // At least 44 px each way, centred on the chip, without changing the line height.
        refs.touch &&
          'relative after:absolute after:-inset-y-3.5 after:left-1/2 after:w-[max(calc(100%+0.5rem),2.75rem)] after:-translate-x-1/2 after:content-[""]',
        className,
      )}
      aria-label={`${ACTION[item.kind]} ${item.kind === 'comment' ? `#${item.target.id}` : refLabel(item).replace(/^Checks: /, '')}`}
      onClick={go}
      onPointerDown={onPointerDown}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(event) => refs.touch && event.preventDefault()}
      data-sw-ref={item.kind}
      data-sw-ref-id={String(item.id)}
    >
      <Icon size={11} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
  // Touch: a hover card's trigger blocks touchstart, so the preview is a
  // popover anchored on the chip, opened only by the long press (Back closes it).
  if (refs.touch) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>{chip}</PopoverAnchor>
        <PopoverContent className="w-64 p-2.5" side="top" onOpenAutoFocus={(event) => event.preventDefault()}>
          <Preview item={item} refs={refs} />
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{chip}</HoverCardTrigger>
      <HoverCardContent className="w-64 p-2.5" side="top">
        <Preview item={item} refs={refs} />
      </HoverCardContent>
    </HoverCard>
  )
}

// What the turn used, as a quiet row of chips under the answer: attached
// board images and what its tools read. Not the thread's own comment (the
// thread shows it at the top), and not what the answer's text already links.
export function UsedRefs({ reply, request, commentId, text }) {
  const refs = useRefs()
  const list = useMemo(() => {
    if (!refs?.index) return []
    const inline = String(text || '')
    return usedRefs(refs.index, { reply, request }).filter(
      (ref) =>
        !(ref.kind === 'comment'
          ? ref.id === commentId || new RegExp(`#${ref.id}\\b|\\[\\[comment:${ref.id}\\]\\]`).test(inline)
          : inline.includes(`[[page:${ref.id}]]`)),
    )
  }, [refs?.index, reply, request, commentId, text])
  if (!list.length || !refs?.onNavigate) return null
  return (
    <div className="flex flex-wrap items-center gap-1 text-caption text-muted" data-sw-chat-used-refs={list.length}>
      <span className="mr-0.5">Used</span>
      {list.map((ref) => (
        <RefChip key={`${ref.kind}:${ref.id}`} item={ref} />
      ))}
    </div>
  )
}
