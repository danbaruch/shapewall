import { ChevronDown } from 'lucide-react'
import { PageHeader } from '../components/page.jsx'
import { Badge, Container } from '../components/ui.jsx'
import { GITHUB_URL } from '../routes.js'
import { LAUNCHED } from '../launch.js'
// The repository's CHANGELOG.md, split into versions at build time by scripts/markdown.mjs (renderChangelog).
import changelog from '../../../CHANGELOG.md'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// "2026-11-16" -> "November 16, 2026". Done by hand, not with the locale, so the server and the browser agree.
export function longDate(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  return `${MONTHS[month - 1]} ${day}, ${year}`
}

function VersionList({ className }) {
  return (
    <ul className={className}>
      {changelog.versions.map((entry) => (
        <li key={entry.id}>
          <a
            href={`#${entry.id}`}
            className="flex items-baseline justify-between gap-3 rounded-lg px-3 py-1.5 text-[14px] text-slate transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            <span className="font-medium tabular-nums">{entry.version}</span>
            <span className="text-[12.5px] text-faint tabular-nums">{entry.date}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

export default function Changelog() {
  const latest = changelog.versions[0]
  return (
    <>
      <PageHeader eyebrow="Changelog" title="What changed in each release">
        Every Shapewall release, newest first. This page is built from CHANGELOG.md in the repository, so the two always match.
      </PageHeader>
      <Container className="max-w-6xl lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-14">
        <aside className="hidden lg:block" aria-label="Versions">
          <div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto py-12 pr-1">
            <h2 className="px-3 text-[12px] font-semibold tracking-wide text-faint uppercase">Versions</h2>
            <VersionList className="mt-2 space-y-0.5" />
          </div>
        </aside>
        <div className="min-w-0 py-10 lg:py-12">
          <details className="group mb-8 rounded-xl border border-line bg-card lg:hidden">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-[14.5px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
              <span>
                All versions <span className="font-normal text-faint">({changelog.versions.length})</span>
              </span>
              <ChevronDown className="size-4 text-faint transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <VersionList className="max-h-72 space-y-0.5 overflow-y-auto border-t border-line p-1.5" />
          </details>
          <ol className="space-y-14">
            {changelog.versions.map((entry) => (
              <li key={entry.id} id={entry.id} className="scroll-mt-24 border-t border-line pt-10 first:border-t-0 first:pt-0">
                <article aria-labelledby={`${entry.id}-title`}>
                  <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 id={`${entry.id}-title`} className="text-[26px] leading-tight font-bold tracking-[-0.02em] text-ink tabular-nums">
                      <a href={`#${entry.id}`} className="hover:text-wall-deep">
                        {entry.version}
                      </a>
                    </h2>
                    {entry === latest ? <Badge>Latest</Badge> : null}
                    <time dateTime={entry.date} className="w-full text-[14px] text-faint sm:w-auto">
                      {longDate(entry.date)}
                    </time>
                  </header>
                  <div className="prose-docs mt-5 max-w-[70ch]" dangerouslySetInnerHTML={{ __html: entry.html }} />
                </article>
              </li>
            ))}
          </ol>
          <div
            className="prose-docs mt-16 max-w-[70ch] border-t border-line pt-8 text-[14px] text-slate"
            dangerouslySetInnerHTML={{ __html: changelog.intro }}
          />
          {LAUNCHED ? (
            <p className="mt-3 text-[14px]">
              <a href={`${GITHUB_URL}/blob/main/CHANGELOG.md`} className="font-medium text-wall hover:text-wall-deep">
                CHANGELOG.md on GitHub
              </a>
            </p>
          ) : null}
        </div>
      </Container>
    </>
  )
}
