import { ChevronDown } from 'lucide-react'
import { PageHeader } from '../components/page.jsx'
import { Badge, Container } from '../components/ui.jsx'
import { GITHUB_URL } from '../routes.js'
import { LAUNCHED } from '../launch.js'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { hashId } from '../links.js'
// The repository's CHANGELOG.md, split into versions at build time by scripts/markdown.mjs (renderChangelog), in a
// chunk of its own (src/changelog.js).
import { loadChangelog, loadedChangelog } from '../changelog.js'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// "2026-11-16" -> "November 16, 2026". Done by hand, not with the locale, so the server and the browser agree.
export function longDate(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  return `${MONTHS[month - 1]} ${day}, ${year}`
}

// How many releases are open on the page; older ones are folded, each under its own version and date.
export const OPEN_RELEASES = 3

// What the product does now, above the release notes, so a first-time reader does not have to add up every entry.
const TODAY = [
  ['See the whole app', 'Every screen captured at desktop, tablet and phone width on one zoomable wall, with live HTML up close.'],
  ['Journeys', 'Arrows from the real links between screens, and named flows you step through screen by screen.'],
  [
    'Steer your agents',
    'A comment pinned to an element is an instruction. Agents read it as JSON, through shapewall watch or the MCP server, build the change, recapture and reply; the board chat connects the agent CLI you already use.',
  ],
  [
    'Check the result',
    'Before and after on every comment, capture history with pixel diffs, staging beside production, page checks and a comment on each pull request.',
  ],
  [
    'Work together',
    'GitHub issues and pull requests, notifications, and a self-hosted team server (beta) with passkeys, roles, share links, live presence and connected agents.',
  ],
  [
    'Yours',
    'Runs on your machine with no account to make and no telemetry. An Apache 2.0 core, with the engine and team server under the Functional Source License.',
  ],
]

function Today({ latest }) {
  return (
    <section aria-labelledby="today" className="rounded-2xl border border-line bg-card p-6 sm:p-8">
      <h2 id="today" className="text-[22px] font-bold tracking-tight text-ink">
        What Shapewall does today
      </h2>
      <p className="mt-2 text-[15px] leading-6 text-slate">
        {latest ? (
          <>
            As of <span className="font-semibold text-ink tabular-nums">{latest.version}</span>, {longDate(latest.date)}.{' '}
          </>
        ) : null}
        The{' '}
        <Link to="/features" className="font-medium text-wall hover:text-wall-deep">
          features page
        </Link>{' '}
        has the details.
      </p>
      <dl className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {TODAY.map(([term, text]) => (
          <div key={term}>
            <dt className="text-[15px] font-semibold text-ink">{term}</dt>
            <dd className="mt-1 text-[14.5px] leading-6 text-slate">{text}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

// A link to a folded release opens it.
function useOpenOnHash() {
  useEffect(() => {
    const open = () => {
      const id = hashId(window.location.hash)
      const details = id && document.getElementById(id)?.querySelector('details')
      if (details && !details.open) {
        details.open = true
        document.getElementById(id).scrollIntoView()
      }
    }
    open()
    window.addEventListener('hashchange', open)
    return () => window.removeEventListener('hashchange', open)
  }, [])
}

// The line under the page's title, true to what is below it: no release yet, a
// few (all open), or more than OPEN_RELEASES (the older ones folded). `count`
// is null while the changelog loads.
const OPEN_WORD = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' }
export function introFor(count) {
  if (count === 0) return 'What Shapewall does today. The notes for each release start here with the first one.'
  const every = 'What Shapewall does today, then every release, newest first.'
  if (count === null || count <= OPEN_RELEASES) return every
  return `${every} The latest ${OPEN_WORD[OPEN_RELEASES] ?? OPEN_RELEASES} are open; older ones fold under their version.`
}

function ReleaseHeader({ entry, latest, folded }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2
        id={`${entry.id}-title`}
        className={`${folded ? 'text-[19px]' : 'text-[26px]'} leading-tight font-bold tracking-[-0.02em] text-ink tabular-nums`}
      >
        {folded ? (
          entry.version
        ) : (
          <a href={`#${entry.id}`} className="hover:text-wall-deep">
            {entry.version}
          </a>
        )}
      </h2>
      {entry === latest ? <Badge>Latest</Badge> : null}
      <time dateTime={entry.date} className="w-full text-[14px] text-faint sm:w-auto">
        {longDate(entry.date)}
      </time>
    </header>
  )
}

function VersionList({ versions, className }) {
  return (
    <ul className={className}>
      {versions.map((entry) => (
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
  const [changelog, setChangelog] = useState(loadedChangelog)
  useOpenOnHash()
  useEffect(() => {
    if (!changelog) loadChangelog().then(setChangelog, () => {})
  }, [changelog])
  const header = (
    <PageHeader eyebrow="Changelog" title="What changed in each release">
      {introFor(changelog ? changelog.versions.length : null)}
    </PageHeader>
  )
  if (!changelog)
    return (
      <>
        {header}
        <div className="min-h-[60vh]" aria-busy="true" />
      </>
    )
  const latest = changelog.versions[0]
  return (
    <>
      {header}
      <Container className={latest ? 'max-w-6xl lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-14' : 'max-w-6xl'}>
        <aside className={latest ? 'hidden lg:block' : 'hidden'} aria-label="Versions">
          <div className="sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto py-12 pr-1">
            <h2 className="px-3 text-[12px] font-semibold tracking-wide text-faint uppercase">Versions</h2>
            <VersionList versions={changelog.versions} className="mt-2 space-y-0.5" />
          </div>
        </aside>
        <div className="min-w-0 py-10 lg:py-12">
          <details className={`group mb-8 rounded-xl border border-line bg-card lg:hidden ${latest ? '' : 'hidden'}`}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-[14.5px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
              <span>
                All versions <span className="font-normal text-faint">({changelog.versions.length})</span>
              </span>
              <ChevronDown className="size-4 text-faint transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <VersionList versions={changelog.versions} className="max-h-72 space-y-0.5 overflow-y-auto border-t border-line p-1.5" />
          </details>
          <Today latest={latest} />
          <ol className="mt-14 space-y-14">
            {changelog.versions.map((entry, index) =>
              index < OPEN_RELEASES ? (
                <li key={entry.id} id={entry.id} className="scroll-mt-24 border-t border-line pt-10 first:border-t-0 first:pt-0">
                  <article aria-labelledby={`${entry.id}-title`}>
                    <ReleaseHeader entry={entry} latest={latest} />
                    <div className="prose-docs mt-5 max-w-[70ch]" dangerouslySetInnerHTML={{ __html: entry.html }} />
                  </article>
                </li>
              ) : (
                <li key={entry.id} id={entry.id} className={`scroll-mt-24 ${index === OPEN_RELEASES ? 'border-t border-line pt-10' : ''}`}>
                  {index === OPEN_RELEASES ? (
                    <p className="mb-4 text-[13px] font-semibold tracking-wide text-faint uppercase">Older releases</p>
                  ) : null}
                  <details className="group rounded-xl border border-line bg-card">
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
                      <ReleaseHeader entry={entry} latest={latest} folded />
                      <ChevronDown className="size-4 shrink-0 text-faint transition-transform group-open:rotate-180" aria-hidden="true" />
                    </summary>
                    <article aria-labelledby={`${entry.id}-title`} className="border-t border-line px-4 pt-4 pb-6">
                      <div className="prose-docs max-w-[70ch]" dangerouslySetInnerHTML={{ __html: entry.html }} />
                    </article>
                  </details>
                </li>
              ),
            )}
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
