import { Gauge, PersonStanding, SearchCheck, ShieldCheck } from 'lucide-react'
import { cn } from '../../lib/utils'

const ICONS = { reliability: ShieldCheck, performance: Gauge, accessibility: PersonStanding, seo: SearchCheck }

// A Lighthouse lab score (0-100) as a small ring in its status colour.
export function ScoreRing({ score, size = 36, label }) {
  const r = (size - 5) / 2
  const c = 2 * Math.PI * r
  const tone = score === null ? 'text-faint' : score >= 90 ? 'text-ok' : score >= 50 ? 'text-warn' : 'text-bad'
  return (
    <span className={cn('relative inline-grid shrink-0 place-items-center', tone)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="3.5" />
        {score !== null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={`${(c * score) / 100} ${c}`}
          />
        ) : null}
      </svg>
      <span className="absolute text-[11px] font-semibold text-fg tabular" aria-label={label}>
        {score === null ? '--' : score}
      </span>
    </span>
  )
}

// Four category tiles: issues to fix per category, the median Lighthouse
// score for Performance and SEO. A tile filters the Issues tab (SEO opens
// the SEO tab). Every row as tall as the tallest tile (one with notes).
export default function ChecksSummary({ totals, active, onPick }) {
  return (
    <div className="grid auto-rows-fr grid-cols-2 gap-2" data-sw-checks-summary="true">
      {totals.map((t) => {
        const Icon = ICONS[t.id]
        const count = t.warnings
        const pressed = active === t.id
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => onPick(t.id)}
            data-sw-checks-tile={t.id}
            className={cn(
              'flex min-h-16 items-center gap-2.5 rounded-lg border bg-surface px-2.5 py-2 text-left shadow-card transition-colors outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent',
              pressed ? 'border-accent bg-accent/5' : 'border-line',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
                <Icon size={13} aria-hidden="true" />
                {t.label}
              </span>
              <span className="mt-0.5 block text-[15px] leading-5 font-semibold">
                {count ? (
                  <span className={t.id === 'reliability' ? 'text-bad' : 'text-warn'}>
                    <span className="tabular">{count}</span> to fix
                  </span>
                ) : t.unchecked ? (
                  <span className="text-muted">Not checked</span>
                ) : (
                  <span className="text-ok">No issues</span>
                )}
              </span>
              {t.advisories ? (
                <span className="block text-[11px] text-muted">
                  <span className="tabular">{t.advisories}</span> {t.advisories === 1 ? 'note' : 'notes'}
                </span>
              ) : null}
            </span>
            {t.id === 'performance' || t.id === 'seo' ? (
              <ScoreRing score={t.score} label={t.score === null ? 'No Lighthouse score' : `Lighthouse ${t.label} ${t.score}`} />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
