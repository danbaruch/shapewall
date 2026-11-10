// The cards an agent reply carries while it works: tool calls, its plan,
// permission requests (edit a file, run a command) and its reasoning.

import { useState } from 'react'
import {
  Brain,
  CheckCircle2,
  Circle,
  CircleDot,
  Clock,
  ListChecks,
  Loader2,
  ShieldCheck,
  ShieldQuestion,
  Wrench,
  XCircle,
} from 'lucide-react'
import { Badge, Button, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'
import { DiffView, NoteCard } from './DiffCards'
import { useAllowForChat } from './allowForChat'
import { allowForChatLabel } from './composerModel.js'

// The run summary after a turn that changed something (RunSummary.jsx).
export { default as RunSummary } from './RunSummary'

export function ToolCard({ card }) {
  const Icon = card.state === 'running' ? Loader2 : card.state === 'error' ? XCircle : CheckCircle2
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-line bg-surface-2/60 px-2 py-1.5 text-xs"
      data-sw-chat-card={card.name}
      data-state={card.state}
    >
      <Wrench size={12} className="shrink-0 text-faint" aria-hidden="true" />
      {/* The label wraps rather than truncates; the detail gives way first. */}
      <span className="min-w-0 flex-1 font-medium break-words text-fg">{card.label || card.name}</span>
      {card.detail ? (
        <Tooltip content={card.detail}>
          <span className="max-w-[45%] shrink-0 truncate text-muted">{card.detail}</span>
        </Tooltip>
      ) : null}
      <Icon
        size={13}
        className={cn(
          'shrink-0',
          card.state === 'running' && 'animate-spin text-muted',
          card.state === 'done' && 'text-ok',
          card.state === 'error' && 'text-bad',
        )}
        aria-label={card.state}
      />
    </div>
  )
}

// The agent's plan (ACP agents): its steps and where it is.
export function PlanCard({ card }) {
  return (
    <div className="rounded-md border border-line bg-surface-2/60 px-2 py-1.5 text-xs" data-sw-chat-card="plan">
      <p className="mb-1 flex items-center gap-1.5 font-medium text-fg">
        <ListChecks size={12} className="text-faint" aria-hidden="true" /> Plan
      </p>
      <ol className="space-y-0.5">
        {(card.entries || []).map((entry, index) => {
          const Icon = entry.status === 'completed' ? CheckCircle2 : entry.status === 'in_progress' ? CircleDot : Circle
          return (
            <li key={index} className="flex items-start gap-1.5" data-status={entry.status}>
              <Icon
                size={12}
                className={cn(
                  'mt-0.5 shrink-0',
                  entry.status === 'completed' ? 'text-ok' : entry.status === 'in_progress' ? 'text-accent' : 'text-faint',
                )}
                aria-label={entry.status.replace('_', ' ')}
              />
              <span className={cn('min-w-0 break-words', entry.status === 'completed' ? 'text-muted line-through' : 'text-fg')}>
                {entry.content}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const PERMISSION_STATES = {
  approved: { tone: 'ok', text: 'Allowed' },
  denied: { tone: 'bad', text: 'Denied' },
  expired: { tone: 'warn', text: 'No answer, denied' },
  cancelled: { tone: 'neutral', text: 'Cancelled' },
}

// "Edit src/pages/signup.html" -> the verb and the path, so the path can be
// a chip. Anything else stays one sentence.
const PATH_LABEL = /^(Edit|Write|Create|Read|Delete|Move|Run)\s+(\S+[./]\S*)$/
function splitLabel(label) {
  const match = PATH_LABEL.exec(String(label || '').trim())
  return match ? { verb: match[1], path: match[2] } : null
}

// Whether a detail is code (a command, JSON, several lines) rather than prose.
const looksLikeCode = (text) => /\n|^\s*[{[$]|\b(?:npm|npx|git|node|rm|mv|cp|cat)\s/.test(String(text || ''))

// The agent asks before it acts (edit a file, run a command): the person
// picks one of its options. Only while the answer is being written.
export function PermissionCard({ card, onAnswer, live, touch }) {
  const allowForChat = useAllowForChat()
  const [busy, setBusy] = useState(false)
  // The answer given here, shown at once (the stream confirms it a moment later).
  const [answered, setAnswered] = useState(null)
  const state = card.state === 'pending' && answered ? answered : card.state
  // A starter agent's command card is answered from the stored thread (no stream).
  const pending = state === 'pending' && (live || card.answerable === true)
  const done = PERMISSION_STATES[state]
  const answer = async (optionId) => {
    setBusy(true)
    try {
      await onAnswer(card.id, optionId)
      const kind = (card.options || []).find((option) => option.optionId === optionId)?.kind || 'reject'
      setAnswered(kind.startsWith('allow') ? 'approved' : 'denied')
    } finally {
      setBusy(false)
    }
  }
  const split = splitLabel(card.label)
  const options = card.options || []
  // "Allow for this chat" (composerModel.js canAutoAllow): allow this one,
  // and the same request again in this chat without asking. Only where the
  // agent offers no "always" option of its own.
  const allowOnce = options.find((option) => option.kind === 'allow_once')
  const chatRule = pending && allowOnce && allowForChat.can(card)
  const buttons = [
    ...options.map((option) => ({
      key: option.optionId,
      label: option.name,
      primary: option.kind === 'allow_once',
      run: () => answer(option.optionId),
      hook: { 'data-sw-chat-permission-option': option.optionId, 'data-kind': option.kind },
    })),
    ...(chatRule
      ? [
          {
            key: 'allow-chat',
            label: allowForChatLabel(card),
            primary: false,
            run: async () => {
              await answer(allowOnce.optionId)
              allowForChat.add(card)
            },
            hook: { 'data-sw-chat-permission-allow-chat': 'true' },
          },
        ]
      : []),
    ...(!options.some((option) => option.kind.startsWith('reject'))
      ? [{ key: 'deny', label: 'Deny', primary: false, run: () => answer(null), hook: { 'data-sw-chat-permission-deny': 'true' } }]
      : []),
  ]
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border text-[13px]',
        pending ? 'border-warn/60 bg-surface shadow-card' : 'border-line bg-surface-2/60',
      )}
      data-sw-chat-card="permission"
      data-sw-chat-permission={card.id}
      data-state={state}
      role={pending ? 'group' : undefined}
      aria-label={pending ? `The agent asks: ${card.label}` : undefined}
    >
      {pending ? (
        <p className="flex items-center gap-1.5 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-xs font-medium text-fg">
          <ShieldQuestion size={13} className="shrink-0 text-warn" aria-hidden="true" /> The agent asks before it acts
        </p>
      ) : null}
      <div className="space-y-1.5 px-3 py-2">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5">
          {!pending ? <ShieldQuestion size={13} className="shrink-0 text-faint" aria-hidden="true" /> : null}
          {split ? (
            <>
              <span className="font-medium text-fg">{split.verb}</span>{' '}
              <code
                className="min-w-0 truncate rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-fg"
                data-sw-chat-permission-path="true"
              >
                {split.path}
              </code>
            </>
          ) : (
            <span className="min-w-0 flex-1 font-medium break-words text-fg">{card.label}</span>
          )}
          {done ? (
            <Badge tone={done.tone} className="ml-auto shrink-0" data-sw-chat-permission-state={state}>
              {done.text}
            </Badge>
          ) : null}
        </p>
        {card.detail ? (
          looksLikeCode(card.detail) ? (
            <code className="block max-h-48 overflow-y-auto rounded-md bg-sunken px-2 py-1.5 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-muted">
              {card.detail}
            </code>
          ) : (
            <p className="max-h-48 overflow-y-auto text-xs leading-5 break-words whitespace-pre-wrap text-muted">{card.detail}</p>
          )
        ) : null}
        {card.answeredBy ? <p className="text-xs text-muted">Answered from {card.answeredBy}</p> : null}
        {allowForChat.auto.has(card.id) ? (
          <p className="flex items-center gap-1 text-xs text-muted" data-sw-chat-permission-auto="true">
            <ShieldCheck size={12} className="shrink-0 text-ok" aria-hidden="true" /> Allowed for this chat (Chat settings to remove)
          </p>
        ) : null}
        <DiffView diff={card.diff} />
      </div>
      {pending ? (
        <div className="space-y-1.5 border-t border-line px-3 py-2">
          <div className={cn('gap-1.5', touch ? 'grid grid-cols-2' : 'flex flex-wrap')}>
            {buttons.map((item) => (
              <Button
                key={item.key}
                size={touch ? 'touch' : 'sm'}
                variant={item.primary ? 'default' : 'secondary'}
                className={cn(
                  !touch && 'min-w-20',
                  touch && ((buttons.length % 2 && item === buttons.at(-1)) || item.key === 'allow-chat') && 'col-span-2',
                )}
                disabled={busy}
                onClick={item.run}
                {...item.hook}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <p className="flex items-center gap-1 text-xs text-muted">
            <Clock size={12} className="shrink-0" aria-hidden="true" /> No answer in 2 minutes counts as Deny.
          </p>
        </div>
      ) : null}
    </div>
  )
}

export function Card({ card, onAnswer, live, touch }) {
  if (card.kind === 'plan') return <PlanCard card={card} />
  if (card.kind === 'note') return <NoteCard card={card} />
  if (card.kind === 'permission') return <PermissionCard card={card} onAnswer={onAnswer} live={live} touch={touch} />
  return <ToolCard card={card} />
}

export function Reasoning({ text }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="text-xs">
      <Button
        variant="ghost"
        size="xs"
        className="-ml-2 gap-1 font-normal text-muted"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-sw-chat-reasoning="true"
      >
        <Brain size={12} aria-hidden="true" /> {open ? 'Hide thinking' : 'Show thinking'}
      </Button>
      {open ? <p className="mt-1 border-l-2 border-line pl-2 whitespace-pre-wrap text-muted">{text}</p> : null}
    </div>
  )
}
