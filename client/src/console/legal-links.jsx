import { useEffect, useState } from 'react'
import { api } from './lib/api'
import { AppUpdates } from '../components/app-updates'
import { cn } from '../lib/utils'

export function LegalLinks({ className }) {
  const [legal, setLegal] = useState(null)
  useEffect(() => {
    if (document.querySelector('meta[name="shapewall-local-console"]')) return
    let active = true
    api
      .get('/api/legal')
      .then((value) => {
        if (active) setLegal(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  if (!legal) return null
  const links = [
    ['terms', 'Terms'],
    ['privacy', 'Privacy'],
    ['acceptableUse', 'Acceptable use'],
    ['subprocessors', 'Subprocessors'],
    ['report', 'Report abuse'],
  ].filter(([key]) => legal[key] && (/^https?:\/\//.test(legal[key]) || legal[key] === '/report'))
  return (
    <nav aria-label="Legal" className={cn('mt-6 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-muted', className)}>
      {links.map(([key, label]) => (
        <a key={key} href={legal[key]} className="inline-flex min-h-11 items-center px-2 underline underline-offset-2">
          {label}
        </a>
      ))}
    </nav>
  )
}

// The quiet bottom row of every console page: legal links (hosted) and
// About Shapewall. Sits at the bottom of the full-height shell, on the page's
// own background. `legal={false}` when the page already shows them.
// Its links carry their own 8px side padding, so the row is inset 8px less
// than the page: their text lines up with the page's headings and cards.
export function ConsoleFooter({ transport, legal = true, updatesRef, className }) {
  return (
    <footer
      className={cn(
        'mx-auto flex w-full max-w-6xl flex-col items-center gap-1 px-1 pt-8 sm:flex-row sm:justify-between sm:px-4',
        className,
      )}
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 1rem)' }}
      data-sw-console-footer
    >
      {legal ? <LegalLinks className="mt-0 justify-start gap-x-1 text-caption text-faint" /> : <span />}
      <AppUpdates ref={updatesRef} transport={transport} placement="link" />
    </footer>
  )
}
