// Small hosted-board pieces: the banner when access ends mid-visit, the note
// a viewer sees where Comment would be, and the way back to the project.

import { useEffect, useState } from 'react'
import { Eye, Link2Off, Lock } from 'lucide-react'
import { ACCESS_LOST_EVENT } from '../lib/api'
import { Tooltip } from '../components/ui'
import { cn } from '../lib/utils'

const LOST_TEXT = {
  share: {
    title: 'This link was revoked',
    body: 'Or it expired. The board stops updating and you cannot comment. Ask whoever shared it for a new link.',
    href: null,
  },
  signed_out: { title: 'You were signed out', body: 'Sign in again to keep working on this board.', href: 'signin' },
  removed: {
    title: "You don't have access to this board any more",
    body: 'You may have been removed from the workspace. Ask an admin to invite you again.',
    href: 'home',
  },
}

// Shown from the first request that comes back "share ended", "signed out"
// or "no such workspace" (lib/api.js), and stays.
export function AccessLostBanner() {
  const [kind, setKind] = useState(null)
  useEffect(() => {
    const onLost = (event) => setKind((current) => current || event.detail?.kind || null)
    window.addEventListener(ACCESS_LOST_EVENT, onLost)
    return () => window.removeEventListener(ACCESS_LOST_EVENT, onLost)
  }, [])
  if (!kind) return null
  const text = LOST_TEXT[kind]
  const next = encodeURIComponent(window.location.pathname + window.location.search)
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-bad/30 bg-bad/10 px-4 py-2 text-sm text-fg"
      role="alert"
      data-sw-access-lost={kind}
    >
      {kind === 'share' ? (
        <Link2Off size={15} className="shrink-0 text-bad" aria-hidden="true" />
      ) : (
        <Lock size={15} className="shrink-0 text-bad" aria-hidden="true" />
      )}
      <span className="font-medium">{text.title}</span>
      <span className="min-w-0 flex-1 text-muted">{text.body}</span>
      {text.href === 'signin' ? (
        <a
          href={`/signin?next=${next}`}
          className="inline-flex h-11 items-center font-medium text-accent underline-offset-2 hover:underline lg:h-auto"
        >
          Sign in
        </a>
      ) : text.href === 'home' ? (
        <a href="/" className="inline-flex h-11 items-center font-medium text-accent underline-offset-2 hover:underline lg:h-auto">
          Your workspaces
        </a>
      ) : null}
    </div>
  )
}

// Where the Comment button would be, for a viewer on a hosted board: a
// one-line "Viewer" chip; the sentence is its tooltip (and its accessible
// name), so it never wraps over the canvas.
export const VIEWER_TEXT = "You're a viewer. Ask an admin for member access to comment."

export function ViewerNote({ compact = false }) {
  return (
    <Tooltip content={VIEWER_TEXT} side="bottom">
      <span
        role="note"
        tabIndex={0}
        aria-label={VIEWER_TEXT}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 text-xs font-medium whitespace-nowrap text-muted outline-none focus-visible:outline-2 focus-visible:outline-accent',
          compact ? 'h-11 px-2.5' : 'h-8 px-2.5',
        )}
        data-sw-viewer-note
      >
        <Eye size={14} aria-hidden="true" /> Viewer
      </span>
    </Tooltip>
  )
}

// The project a member's hosted board belongs to, as a small link above the
// board name (the board switcher shows the board itself).
export function ProjectCrumb({ project }) {
  return (
    <Tooltip content={`Back to ${project.name}`} side="bottom" align="start">
      <a
        href={project.url}
        className="block max-w-full min-w-0 truncate rounded-sm px-2.5 text-[11px] leading-3.5 font-medium text-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        data-sw-project-crumb
      >
        {project.name}
      </a>
    </Tooltip>
  )
}
