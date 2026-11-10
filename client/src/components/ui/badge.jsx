import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

// Small status chips and counters.
export const badgeVariants = cva('inline-flex shrink-0 items-center gap-1 font-medium whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'border-line bg-surface-2 text-muted',
      accent: 'border-accent/40 bg-accent/10 text-accent',
      ok: 'border-ok/40 bg-ok/10 text-fg',
      warn: 'border-warn/50 bg-warn/15 text-fg',
      bad: 'border-bad/40 bg-bad/10 text-bad',
      solid: 'border-transparent bg-accent text-accent-fg',
    },
    shape: {
      // An outlined chip on a line of text (agent status, reopened).
      chip: 'rounded-full border px-1.5 text-[10.5px] leading-4',
      // A filled counter (comment counts, change percent on cards).
      count: 'h-5 rounded-full border-0 px-1.5 text-[10px] font-semibold',
      // A tiny square tag (group name, "agent").
      tag: 'rounded border-0 px-1 text-[10px] uppercase',
    },
  },
  defaultVariants: { tone: 'neutral', shape: 'chip' },
})

export function Badge({ tone, shape, className, ...props }) {
  return <span className={cn(badgeVariants({ tone, shape }), className)} {...props} />
}

// The numbered comment dot (the same colours as its pin).
export function CommentDot({ className, ...props }) {
  return (
    <span
      className={cn('inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white', className)}
      {...props}
    />
  )
}
