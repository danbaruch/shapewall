// "What it can do": one agent's capability lines, per path (chat, Fix
// with, or a local board) and per trust tier (solo, team, open). Each line
// has an on, asks, off or unknown chip, one sentence, and where its machine
// can change it, the command to copy.
//
// The card arrives worked out: src/agent/capability-views.js builds it on
// the server (from what the agent's machine said at hello, with the
// project's own setting over it) or on the local board (from the resolver
// every turn uses). `shapewall agent status` and the agent's own
// instructions print the same lines. Nothing here decides a state.

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ListChecks } from 'lucide-react'
import { Badge, Button, ToggleGroup } from '../../components/ui'
import { cn } from '../../lib/utils'

export const STATE_WORDS = { on: 'On', ask: 'Asks first', off: 'Off', unknown: 'Unknown' }
const STATE_TONE = { on: 'ok', ask: 'accent', off: 'neutral', unknown: 'warn' }

export function StateChip({ state, className }) {
  return (
    <Badge tone={STATE_TONE[state] || 'neutral'} className={cn('px-2 py-0.5 text-[11px]', className)} data-sw-cap-state={state}>
      {STATE_WORDS[state] || state}
    </Badge>
  )
}

// A command on one line, with a copy button.
function CopyCommand({ command }) {
  const [copied, setCopied] = useState(false)
  const text = useRef(null)
  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch {
      // No clipboard: select it, so Ctrl+C or a long-press copies it.
      const range = document.createRange()
      range.selectNodeContents(text.current)
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
    }
  }
  return (
    <div className="mt-1.5 flex min-w-0 items-stretch gap-1.5">
      <code
        ref={text}
        className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1.5 font-mono text-[11.5px] leading-4 break-words text-fg select-all"
        data-sw-cap-fix
      >
        {command}
      </code>
      <Button
        size="touch"
        variant={copied ? 'secondary' : 'default'}
        className="shrink-0 lg:h-auto lg:px-2"
        onClick={copy}
        aria-label={copied ? 'Copied' : `Copy: ${command}`}
        data-sw-cap-copy
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span className="sr-only sm:not-sr-only">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  )
}

function Line({ line, settingsLink }) {
  return (
    <li
      className="grid gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[10rem_5.5rem_minmax(0,1fr)] sm:items-start"
      data-sw-cap-line={line.id}
      data-state={line.state}
      data-narrowed={line.narrowed ? 'true' : undefined}
    >
      <div className="flex items-center justify-between gap-2 sm:contents">
        <span className="text-xs font-medium text-fg sm:pt-0.5">{line.label}</span>
        <StateChip state={line.state} className="sm:mt-0.5 sm:justify-self-start" />
      </div>
      <div className="min-w-0 text-xs text-muted">
        <p className="text-fg">{line.text}</p>
        {line.state !== 'on' && line.why?.length && !line.narrowed ? <p className="mt-0.5">Why: {line.why.join('; ')}.</p> : null}
        {line.narrowed ? (
          <p className="mt-0.5" data-sw-cap-limited>
            Limited by this project's setting.{settingsLink ? <> {settingsLink}</> : null}
          </p>
        ) : null}
        {line.fix ? <CopyCommand command={line.fix} /> : null}
      </div>
    </li>
  )
}

// `card`: { paths: [{ id, label, tiers: [{ tier, label, limitedTo, lines }] }] }, or null.
// `settingsLink`: a link to the project setting (for admins), shown on limited lines.
// `note`: a line under the card (how to name the connection, for example).
export function CapabilityCard({ card, settingsLink = null, note = null, empty = null, testId = null }) {
  const paths = card?.paths || []
  const [pathId, setPathId] = useState(paths.find((item) => item.id === 'fix')?.id || paths[0]?.id || null)
  const path = paths.find((item) => item.id === pathId) || paths[0] || null
  const tiers = (path?.tiers || []).filter((item) => item.lines || item.limitedTo)
  const [tierId, setTierId] = useState('solo')
  const tier = tiers.find((item) => item.tier === tierId) || tiers[0] || null
  return (
    <section className="rounded-lg border border-line bg-surface-2/50" data-sw-capability-card={testId || true}>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
        <h3 className="flex flex-1 items-center gap-1.5 text-xs font-semibold text-fg">
          <ListChecks size={13} aria-hidden="true" /> What it can do
        </h3>
        {paths.length > 1 ? (
          <ToggleGroup
            label="Where"
            value={path?.id}
            onChange={setPathId}
            options={paths.map((item) => ({ id: item.id, label: item.label }))}
            className="max-w-full"
            itemClassName="min-h-11 lg:min-h-8"
          />
        ) : null}
      </div>
      {!card ? (
        <p className="px-3 py-3 text-xs text-muted" data-sw-cap-none>
          {empty ||
            'Its machine did not say what it can do: it runs an older Shapewall, or a program of its own. Update Shapewall there and connect again with shapewall agent connect.'}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
            <span className="text-xs text-muted">Turns written by</span>
            <ToggleGroup
              label="Trust tier"
              value={tier?.tier}
              onChange={setTierId}
              options={tiers.map((item) => ({ id: item.tier, label: TIER_WHO[item.tier] || item.label }))}
              className="max-w-full"
              itemClassName="min-h-11 lg:min-h-8"
            />
          </div>
          {tier?.limitedTo ? (
            <p className="px-3 py-3 text-xs text-muted" data-sw-cap-tier-limited={tier.limitedTo}>
              Limited by this project's setting: these turns get only what {tier.limitedTo} turns get. {settingsLink}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line border-t border-line" data-sw-cap-tier={tier?.tier} data-sw-cap-path={path?.id}>
              {(tier?.lines || []).map((line) => (
                <Line key={line.id} line={line} settingsLink={settingsLink} />
              ))}
            </ul>
          )}
        </>
      )}
      {note ? <p className="border-t border-line px-3 py-2 text-[11px] text-muted">{note}</p> : null}
    </section>
  )
}

const TIER_WHO = { solo: 'Its owner', team: 'The team', open: 'Anyone else' }
