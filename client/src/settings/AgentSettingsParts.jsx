// Small pieces of the agent settings screen: a labelled field, a line to copy,
// the override note, the confirmation dialog and the test result.

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, Copy, KeyRound, Terminal, XCircle } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button, Dialog } from '../components/ui'

export function Field({ label, htmlFor, hint, problem, children, ...props }) {
  return (
    <div className="space-y-1" {...props}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-xs font-medium text-fg">
          {label}
        </label>
      ) : (
        <p className="text-xs font-medium text-fg">{label}</p>
      )}
      {children}
      {problem ? (
        <p id={htmlFor ? `${htmlFor}-problem` : undefined} className="text-xs text-bad" role="alert" data-sw-settings-problem="true">
          {problem}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  )
}

// A line to copy (an export command). The copy button says when it worked.
export function CopyLine({ text, label, touch }) {
  const [copied, setCopied] = useState(false)
  // The browser refused the clipboard: the line is selected instead.
  const [selected, setSelected] = useState(false)
  const line = useRef(null)
  // Cleared on unmount and on a second copy, like CopyField (console/components.jsx).
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setSelected(false)
      setCopied(true)
    } catch {
      if (line.current) {
        const range = document.createRange()
        range.selectNodeContents(line.current)
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
      setSelected(true)
    }
  }
  return (
    <div>
      <div className="flex items-center gap-1 rounded-md border border-line bg-sunken pl-2" data-sw-settings-export={label}>
        <code ref={line} className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-[11.5px] whitespace-nowrap text-fg">
          {text}
        </code>
        <Button variant="ghost" size={touch ? 'icon' : 'icon-sm'} onClick={copy} aria-label={copied ? 'Copied' : `Copy the ${label} line`}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </Button>
      </div>
      {selected ? (
        <p className="mt-1 text-xs text-muted" role="status">
          This browser did not allow copying. The line is selected: press Ctrl+C (or long-press) to copy it.
        </p>
      ) : null}
    </div>
  )
}

export function Override({ children }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-fg" data-sw-settings-override="true">
      <AlertTriangle size={13} className="mt-px shrink-0 text-warn" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

// The confirmation before a new command runs or a key goes to a new host.
export function ConfirmDialog({ items, keyVar, onCancel, onConfirm, busy, touch, confirmLabel = 'Allow and save' }) {
  const size = touch ? 'touch' : 'md'
  return (
    <Dialog
      open={Boolean(items)}
      onClose={() => (busy ? null : onCancel())}
      title="Allow this?"
      footer={
        <>
          <Button size={size} onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size={size} variant="default" onClick={onConfirm} disabled={busy} data-sw-settings-confirm="true">
            {busy ? 'Saving...' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-5 text-sm" data-sw-settings-confirm-list="true">
        {(items || []).map((item) =>
          item.kind === 'command' ? (
            <div key={`command:${item.command}`} className="space-y-1.5" data-sw-settings-confirm-item="command">
              <p className="flex items-center gap-1.5 font-medium text-fg">
                <Terminal size={14} aria-hidden="true" /> Run this command on this machine, as you
              </p>
              <code className="block rounded-md border border-line bg-sunken p-2 font-mono text-xs break-all text-fg">{item.command}</code>
              {item.projectRoot ? (
                <p className="text-xs text-muted">
                  Source folder for every board in this project:{' '}
                  <code className="font-mono break-all" data-sw-settings-confirm-root>
                    {item.projectRoot}
                  </code>
                </p>
              ) : null}
              <p className="text-xs text-muted">
                Shapewall starts it for each chat thread, with your login and a small environment. Anyone who can chat on this board drives
                it. Only allow a command you installed yourself.
              </p>
            </div>
          ) : (
            <div key={`host:${item.keyVar}@${item.host}`} className="space-y-1.5" data-sw-settings-confirm-item="host">
              <p className="flex items-center gap-1.5 font-medium text-fg">
                <KeyRound size={14} aria-hidden="true" /> Send your API key to {item.host}
              </p>
              <p className="text-xs text-muted">
                Every chat request carries the key in <code className="font-mono">{item.keyVar || keyVar}</code> to{' '}
                <span className="font-medium text-fg">{item.host}</span>. Allow it only if you trust that host with the key.
              </p>
            </div>
          ),
        )}
      </div>
    </Dialog>
  )
}

export function TestResult({ result }) {
  if (!result) return null
  const Icon = result.ok ? CheckCircle2 : XCircle
  return (
    <div
      className={cn('rounded-md border p-3 text-xs', result.ok ? 'border-ok/40 bg-ok/10' : 'border-bad/40 bg-bad/10')}
      role="status"
      data-sw-settings-test-result={result.ok ? 'ok' : 'failed'}
    >
      <p className={cn('flex items-start gap-1.5 font-medium', result.ok ? 'text-fg' : 'text-bad')}>
        <Icon size={14} className={cn('mt-px shrink-0', result.ok ? 'text-ok' : 'text-bad')} aria-hidden="true" />
        <span>{result.message}</span>
      </p>
      {result.details?.length ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">
          {result.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
