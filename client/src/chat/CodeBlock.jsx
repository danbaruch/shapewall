// A fenced code block in an agent's answer: the language, a Copy button, the
// code on one horizontal scroll (lines never wrap, so indentation reads
// right), with light highlighting (highlight.js, no dependency).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../components/ui'
import { cn } from '../lib/utils'
import { highlight, langName } from './highlight'

const TONES = {
  comment: 'text-faint italic',
  string: 'text-ok',
  number: 'text-warn',
  keyword: 'text-accent font-medium',
  tag: 'text-accent',
  add: 'bg-ok/10 text-fg',
  del: 'bg-bad/10 text-fg',
  meta: 'text-faint',
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // No clipboard permission (an insecure origin, an old browser): the
    // hidden-textarea way still works where a person pressed the button.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0'
    document.body.append(area)
    area.select()
    let ok
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

export default function CodeBlock({ lang, text, touch = false }) {
  const [copied, setCopied] = useState(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const pieces = useMemo(() => highlight(text, lang), [text, lang])
  const copy = async () => {
    const ok = await copyText(text)
    setCopied(ok ? 'ok' : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 1600)
  }
  const name = langName(lang)
  return (
    <div
      className="overflow-hidden rounded-md border border-line bg-sunken"
      data-sw-chat-code={lang || 'code'}
      data-lang={lang || undefined}
    >
      <div className={cn('flex items-center gap-2 border-b border-line pr-1 pl-2.5', touch ? 'h-11' : 'h-7')}>
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" data-sw-chat-code-lang="true">
          {name}
        </span>
        <Button
          variant="ghost"
          size={touch ? 'touch' : 'xs'}
          className={cn('shrink-0 gap-1 font-normal text-muted', touch && 'min-w-11')}
          onClick={copy}
          aria-label={copied === 'ok' ? `Copied ${name} code` : `Copy ${name} code`}
          data-sw-chat-code-copy={copied || 'ready'}
        >
          {copied === 'ok' ? <Check size={12} className="text-ok" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
        </Button>
        <span className="sr-only" role="status" aria-live="polite">
          {copied === 'ok' ? 'Copied to the clipboard' : copied === 'failed' ? 'Could not copy' : ''}
        </span>
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-[12px] leading-5 whitespace-pre" tabIndex={0} aria-label={`${name} code`}>
        <code className="inline-block min-w-full">
          {pieces.map((piece, index) =>
            piece.line ? (
              // A diff line: a whole row, so its colour spans the block.
              <span key={index} className={cn('-mx-2.5 block px-2.5', TONES[piece.type])}>
                {piece.text || ' '}
              </span>
            ) : piece.type === 'plain' ? (
              piece.text
            ) : (
              // Pieces never move: the index is the key.
              <span key={index} className={TONES[piece.type]}>
                {piece.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  )
}
