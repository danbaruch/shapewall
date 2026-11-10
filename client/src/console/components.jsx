// Console building blocks on top of the board's kit (components/ui):
// cards, headers, notices, copy fields, confirm dialogs, role badges.

import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, Check, CircleAlert, Copy, Info, KeyRound, RefreshCw } from 'lucide-react'
import { Badge, Button, Dialog, Input, Skeleton, Spinner, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'
import { DEMO } from '../lib/demo'
import { ROLE_LABEL, formatDateTime, formatRelative } from './lib/format'
import { useReauth } from './state'

export function Logo({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-7 w-7 shrink-0', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0f766e" />
      <rect x="6" y="6" width="9" height="12" rx="2" fill="#ffffff" />
      <rect x="6" y="20" width="9" height="6" rx="2" fill="#ffffff" fillOpacity="0.72" />
      <rect x="17" y="6" width="9" height="6" rx="2" fill="#f59e0b" />
      <rect x="17" y="14" width="9" height="12" rx="2" fill="#ffffff" />
    </svg>
  )
}

export function Card({ className, children, ...props }) {
  return (
    <section className={cn('rounded-xl border border-line bg-surface shadow-card', className)} {...props}>
      {children}
    </section>
  )
}

export function CardHeader({ title, description, actions, icon: Icon, className }) {
  return (
    <div className={cn('flex flex-wrap items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5', className)}>
      {Icon ? (
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <Icon size={16} aria-hidden="true" />
        </span>
      ) : null}
      <div className="min-w-0 flex-[1_1_12rem]">
        <h2 className="text-title font-semibold text-fg">{title}</h2>
        {description ? <p className="mt-0.5 text-ui text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

// The actions sit level with the title, so they stay put whether the
// description takes one line or two; the description uses the free width.
export function PageHeader({ title, description, actions, badge }) {
  return (
    <div className="mb-5 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-[1_1_16rem]">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-heading font-semibold text-fg sm:text-display">{title}</h1>
          {badge}
        </div>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

const NOTICE = {
  info: ['border-line bg-surface-2 text-fg', Info],
  ok: ['border-ok/40 bg-ok/10 text-fg', Check],
  warn: ['border-warn/50 bg-warn/10 text-fg', AlertTriangle],
  bad: ['border-bad/40 bg-bad/10 text-fg', CircleAlert],
}

export function Notice({ tone = 'info', title, children, action, className, ...rest }) {
  const [classes, Icon] = NOTICE[tone]
  return (
    <div
      className={cn('flex gap-3 rounded-lg border px-3.5 py-3 text-sm', classes, className)}
      role={tone === 'bad' ? 'alert' : undefined}
      {...rest}
    >
      <Icon
        size={16}
        className={cn('mt-0.5 shrink-0', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted')}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn('text-muted', title && 'mt-0.5')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  )
}

export function FormError({ error }) {
  if (!error) return null
  return (
    <p className="text-sm text-bad" role="alert" data-sw-error>
      {error}
    </p>
  )
}

// A label, the control, a hint and an error, wired with ids: the control is
// described by both, and marked invalid while there is an error.
export function Field({ label, hint, error, children, className }) {
  const id = useId()
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ')
  const control =
    typeof children === 'function'
      ? children({ id, 'aria-describedby': described || undefined, ...(error ? { 'aria-invalid': true } : {}) })
      : children
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-ui font-medium text-fg">
        {label}
      </label>
      {control}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { Avatar } from '../components/ui/avatar'

const ROLE_TONE = { owner: 'solid', admin: 'accent', member: 'neutral', viewer: 'neutral', guest: 'warn' }
export function RoleBadge({ role }) {
  return (
    <Badge tone={ROLE_TONE[role] || 'neutral'} className="px-2 py-0.5 text-caption" data-sw-role-badge={role}>
      {ROLE_LABEL[role] || role}
    </Badge>
  )
}

// A time as "3 days ago", with the exact time as a tooltip. Not a tab stop:
// a list of these would put two or three stops on every row, and a screen
// reader has the exact time from dateTime.
export function Time({ value, empty = 'Never', prefix = '' }) {
  if (!value) return <span className="text-faint">{empty}</span>
  return (
    <Tooltip content={formatDateTime(value)}>
      <time dateTime={value}>
        {prefix}
        {formatRelative(value)}
      </time>
    </Tooltip>
  )
}

// A secret shown once (an invite or share link, a token) with a copy button.
export function CopyField({ value, label = 'Copy', className, testId }) {
  const [copied, setCopied] = useState(false)
  // The browser refused the clipboard: the text is selected instead.
  const [selected, setSelected] = useState(false)
  const text = useRef(null)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setSelected(false)
      setCopied(true)
    } catch {
      // No clipboard permission: select the text so a long-press or Ctrl+C copies it.
      if (text.current) {
        const range = document.createRange()
        range.selectNodeContents(text.current)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
      setSelected(true)
    }
  }
  return (
    <div className={className}>
      <div className="flex items-stretch gap-2">
        <code
          ref={text}
          className="sw-secret min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] leading-5 text-fg select-all"
          data-sw-copy-value={testId}
          data-sw-secret
        >
          {value}
        </code>
        <Button size="touch" variant={copied ? 'secondary' : 'default'} onClick={copy} className="lg:h-auto" data-sw-copy={testId}>
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          {copied ? 'Copied' : label}
        </Button>
      </div>
      <CopyFallback shown={selected} />
    </div>
  )
}

// Said when the browser would not copy: the text is selected, the person copies it.
export function CopyFallback({ shown }) {
  if (!shown) return null
  return (
    <p className="mt-1.5 text-xs text-muted" role="status" data-sw-copy-fallback>
      This browser did not allow copying. The text is selected: press Ctrl+C (or long-press) to copy it.
    </p>
  )
}

// The public demo answers from the browser, so a few things that need a
// server (passkeys, exports, deleting an account) are switched off there,
// with this note beside them instead of an error after the click.
export const DEMO_NOTE = 'Not in the demo: this needs a real Shapewall server.'
export const demoNote = (text) => (DEMO ? [text, DEMO_NOTE].filter(Boolean).join(' ') : text)

// A dialog with a form that makes something shown only once (a token, a
// share or invite link). While the result shows, only Done closes it: a
// stray click outside or Escape would lose the secret for good.
export function SecretResultDialog({ open, onClose, busy, result, title, resultTitle, renderResult, resultProps, doneProps, children }) {
  return (
    <Dialog open={open} onClose={() => (busy ? null : onClose())} title={result ? resultTitle : title} size="md" sticky={Boolean(result)}>
      {result ? (
        <div className="space-y-4 px-5 py-4" {...resultProps}>
          {renderResult(result)}
          <div className="flex justify-end">
            <Button size="touch" variant="default" onClick={onClose} className="lg:h-10" {...doneProps}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        children
      )}
    </Dialog>
  )
}

// The state behind SecretResultDialog: `reset` runs each time the dialog
// opens (not when something else re-renders it), and the secret is dropped
// when it closes.
export function useSecretResult(open, reset) {
  const [result, setResult] = useState(null)
  const wasOpen = useRef(false)
  const latest = useRef(reset)
  useEffect(() => {
    latest.current = reset
  })
  useEffect(() => {
    if (open && !wasOpen.current) latest.current()
    if (!open) setResult(null)
    wasOpen.current = open
  }, [open])
  return [result, setResult]
}

// Placeholder rows shaped like the list that is coming; the label is for
// screen readers. `rows` sets how many.
export function Loading({ label = 'Loading', rows = 3 }) {
  return (
    <div className="space-y-4 px-4 py-5 sm:px-5" role="status" data-sw-loading>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3" aria-hidden="true">
          <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={index % 2 ? 'h-3 w-1/3' : 'h-3 w-2/5'} />
            <Skeleton className={index % 2 ? 'h-3 w-3/5' : 'h-3 w-1/2'} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function LoadError({ error, onRetry }) {
  // Outside the signed-in console there is no re-auth dialog.
  const withReauth = useReauth()
  // An admin page after a long idle: confirm with a passkey, then load again.
  if (error?.code === 'reauth_required' && onRetry && withReauth) {
    const confirm = () => {
      let first = true
      withReauth(async () => {
        if (first) {
          first = false
          throw error
        }
        return onRetry()
      }).catch(() => null)
    }
    return (
      <Notice
        tone="warn"
        title="Confirm it's you"
        data-sw-load-reauth
        action={
          <Button size="touch" variant="default" onClick={confirm} className="lg:h-8">
            <KeyRound size={14} aria-hidden="true" /> Confirm
          </Button>
        }
      >
        {error.message}
      </Notice>
    )
  }
  return (
    <Notice
      tone="bad"
      title="This did not load"
      action={
        onRetry ? (
          <Button size="touch" variant="secondary" onClick={onRetry} className="lg:h-8">
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </Button>
        ) : null
      }
    >
      {error?.message || 'Something went wrong.'}
    </Notice>
  )
}

// A dialog that asks before doing something. `confirmText` makes the person
// type a word (the workspace name) first.
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  confirmLabel = 'Confirm',
  tone = 'default',
  onConfirm,
  busy = false,
  error = null,
  confirmText = null,
  disabled = false,
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setTyped('')
  }, [open])
  const blocked = confirmText !== null && typed.trim() !== confirmText
  return (
    <Dialog
      open={open}
      onClose={() => (busy ? null : onClose())}
      title={title}
      footer={
        <>
          <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
            Cancel
          </Button>
          <Button
            size="touch"
            variant={tone === 'danger' ? 'secondary' : 'default'}
            className={cn('lg:h-10', tone === 'danger' && 'border-bad/50 bg-bad text-white hover:bg-bad/90')}
            onClick={onConfirm}
            disabled={busy || blocked || disabled}
            data-sw-confirm
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 px-5 py-4 text-sm text-muted">
        {children}
        {confirmText !== null ? (
          <Field label={`Type "${confirmText}" to confirm`}>
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                data-sw-confirm-input
              />
            )}
          </Field>
        ) : null}
        <FormError error={error} />
      </div>
    </Dialog>
  )
}

// An on/off switch: a button with role="switch" (the kit has no Switch).
export function Switch({ checked, onChange, disabled, label, id }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex h-11 w-12 shrink-0 items-center outline-none disabled:opacity-50 lg:h-7"
      data-sw-switch={checked ? 'on' : 'off'}
    >
      <span
        className={cn(
          'relative inline-flex h-7 w-12 items-center rounded-full border transition-colors group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent',
          checked ? 'border-accent bg-accent' : 'border-line bg-surface-2',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 rounded-full bg-surface shadow-card transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
          )}
        />
      </span>
    </button>
  )
}

// A two-state "I did this" check, used where a checkbox would go.
export function CheckToggle({ checked, onChange, children, id }) {
  return (
    <button
      type="button"
      id={id}
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-line px-3 text-left text-sm text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border',
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface',
        )}
        aria-hidden="true"
      >
        {checked ? <Check size={14} /> : null}
      </span>
      {children}
    </button>
  )
}
