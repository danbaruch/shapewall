// The public demo's strip above the nav: whose view this is (View as) and a
// way to start over (after a confirmation), plus the screen a share link
// shows when it does not open. Renders nothing outside the demo build.

import { ChevronDown, Link2Off, RotateCcw } from 'lucide-react'
import { useDemo } from '../lib/demo'
import { cn } from '../lib/utils'
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  IconButton,
} from './ui'

// Who you are viewing as, switchable in place (the page reloads as them).
function ViewAsMenu({ demo, className, children, align = 'start' }) {
  if (!demo.viewAs) return children
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn('w-64', className)}>
        <DropdownMenuLabel>View as (demo)</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={demo.viewAs.value} onValueChange={demo.viewAs.onChange}>
          {demo.viewAs.options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id} data-sw-view-as={option.id}>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.hint ? <span className="truncate text-xs text-faint">{option.hint}</span> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const DemoMark = () => (
  <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-accent/12 px-2 text-caption font-semibold text-accent">
    <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
    Demo
  </span>
)

// variant "strip" (default): a slim line above the board's nav.
// variant "chip": a compact control for a header (the console's top bar).
export function DemoBanner({ variant = 'strip', className }) {
  const demo = useDemo()
  if (!demo) return null
  if (variant === 'chip') {
    return (
      <div
        className={cn('flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-surface-2/60 p-0.5', className)}
        role="region"
        aria-label="Demo"
        data-sw-demo-banner={demo.role}
      >
        <ViewAsMenu demo={demo} align="end">
          <Button
            variant="ghost"
            size="touch"
            className="h-11 gap-1.5 rounded-full px-2 text-ui text-fg lg:h-8"
            aria-label={'Demo, viewing as ' + demo.roleLabel + '. Change who you view as'}
            data-sw-demo-view-as
          >
            <DemoMark />
            <span className="hidden max-w-28 truncate font-medium sm:inline">{demo.roleLabel}</span>
            <ChevronDown size={13} className="text-faint" aria-hidden="true" />
          </Button>
        </ViewAsMenu>
        {/* Desktop only: on a phone the chip stays a Demo label so the
            workspace name keeps its room; Reset the demo is in the profile menu. */}
        <IconButton
          label="Reset the demo"
          size="icon"
          className="rounded-full text-muted max-lg:hidden lg:h-8 lg:w-8"
          onClick={demo.reset}
          data-sw-demo-reset
        >
          <RotateCcw size={14} aria-hidden="true" />
        </IconButton>
        <DemoResetDialog />
      </div>
    )
  }
  return (
    <div
      className={cn('flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2 text-ui text-muted sm:px-3 lg:h-9', className)}
      role="region"
      aria-label="Demo"
      data-sw-demo-banner={demo.role}
    >
      <DemoMark />
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className="hidden shrink-0 sm:inline">Viewing as</span>
        <ViewAsMenu demo={demo}>
          <Button
            variant="ghost"
            size="touch"
            className="min-w-0 gap-1 px-1.5 text-ui text-fg lg:h-7"
            aria-label={'Viewing as ' + demo.roleLabel + '. Change who you view as'}
            data-sw-demo-view-as
          >
            <span className="truncate font-semibold">{demo.roleLabel}</span>
            <span className="hidden truncate font-normal text-muted sm:inline">({demo.personaName})</span>
            <ChevronDown size={13} className="shrink-0 text-faint" aria-hidden="true" />
          </Button>
        </ViewAsMenu>
        <span className="hidden truncate text-faint md:inline">· Changes stay in this browser</span>
      </span>
      <Button
        variant="ghost"
        size="touch"
        className="shrink-0 gap-1.5 px-2 text-ui text-muted lg:h-7"
        onClick={demo.reset}
        data-sw-demo-reset
      >
        <RotateCcw size={13} aria-hidden="true" /> Reset
      </Button>
      <DemoResetDialog />
    </div>
  )
}

// "Reset the demo?" for the banner's Reset and the profile menu's item
// (both call demo.reset, which only asks; Reset here does it).
export function DemoResetDialog() {
  const demo = useDemo()
  if (!demo) return null
  return (
    <Dialog
      open={Boolean(demo.resetAsked)}
      onClose={demo.cancelReset}
      title="Reset the demo?"
      footer={
        <>
          <Button size="touch" variant="ghost" onClick={demo.cancelReset} className="lg:h-10" data-sw-demo-reset-cancel>
            Cancel
          </Button>
          <Button
            size="touch"
            className="border-bad/50 bg-bad text-bad-fg hover:bg-bad/90 lg:h-10"
            onClick={demo.resetNow}
            data-sw-demo-reset-confirm
          >
            <RotateCcw size={14} aria-hidden="true" /> Reset
          </Button>
        </>
      }
    >
      <p className="px-5 py-4 text-sm text-muted">Your comments, invites and changes in this browser go back to the start.</p>
    </Dialog>
  )
}

// Mirrors the server: a link nobody made, one that was revoked, one past its
// expiry, or one that share link settings turned off opens nothing.
const SHARE_PROBLEMS = {
  unknown: {
    title: 'This share link is not valid',
    text: 'Check that you have the whole link, or ask whoever shared it for a new one.',
  },
  revoked: {
    title: 'This share link was revoked',
    text: 'Whoever shared it turned it off. Ask them for a new link.',
  },
  expired: {
    title: 'This share link has expired',
    text: 'Share links work for a set time. Ask whoever shared it for a new one.',
  },
  off: {
    title: 'This share link is turned off',
    text: 'The workspace no longer allows share links, or the person who made it can no longer share. Ask them for a new link.',
  },
}

export function DemoShareProblem({ problem, onLeave }) {
  const copy = SHARE_PROBLEMS[problem?.status] || SHARE_PROBLEMS.unknown
  const when = problem?.at ? new Date(problem.at) : null
  return (
    <div className="flex h-full flex-col">
      <DemoBanner />
      <main className="flex flex-1 items-center justify-center p-4">
        <div
          className="w-full max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-card sm:p-8"
          role="alert"
          data-sw-share-problem={problem?.status || 'unknown'}
        >
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-bad/10 text-bad">
            <Link2Off size={20} aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-fg">{copy.title}</h1>
          <p className="mt-2 text-sm text-muted">
            {copy.text}
            {when && Number.isFinite(when.getTime()) ? (
              <>
                {' '}
                {problem.status === 'revoked' ? 'Revoked' : 'Expired'}{' '}
                {when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.
              </>
            ) : null}
          </p>
          <p className="mt-4 text-xs text-muted">In the demo, share links are made on a project&apos;s page in the console.</p>
          <Button size="touch" variant="default" className="mt-5 lg:h-10" onClick={onLeave} data-sw-share-problem-leave>
            Open the demo board
          </Button>
        </div>
      </main>
    </div>
  )
}
