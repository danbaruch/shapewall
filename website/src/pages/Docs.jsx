import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ChevronDown, Download, Pencil, Search } from 'lucide-react'
import { Container, cx } from '../components/ui.jsx'
import { track } from '../analytics.js'
import { DOCS, DOC_GROUPS, GITHUB_URL } from '../routes.js'
import { LAUNCHED } from '../launch.js'

// Markdown turned into { html, headings, text } by scripts/markdown.mjs at build time. A doc with `repo` is the
// repository's own guide in docs/ (one source for GitHub, the npm package and this site); the rest are src/docs/*.md.
const FILES = import.meta.glob('../docs/*.md', { eager: true, import: 'default' })
const REPO_FILES = import.meta.glob(
  '../../../docs/{agent-hardening,agent-recipes,agent-workflow,agents,buzz,capture-warnings,config,deployment,github,hosted,journeys,local-accounts,notifications,page-checks,pull-requests,starter-agent,updates,where-to-run}.md',
  { eager: true, import: 'default' },
)
const content = (doc) => (doc.repo ? REPO_FILES[`../../../docs/${doc.repo}.md`] : FILES[`../docs/${doc.file}.md`])

function searchIndex() {
  const entries = []
  for (const doc of DOCS) {
    const md = content(doc)
    if (!md) continue
    entries.push({ doc, id: null, label: doc.nav, haystack: `${doc.nav} ${doc.description} ${md.text}`.toLowerCase() })
    for (const heading of md.headings) {
      entries.push({ doc, id: heading.id, label: heading.text, haystack: `${heading.text} ${doc.nav}`.toLowerCase() })
    }
  }
  return entries
}

function DocsSearch({ onPick }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const counted = useRef(false)
  const navigate = useNavigate()
  const index = useMemo(searchIndex, [])
  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const scored = []
    for (const entry of index) {
      if (!words.every((word) => entry.haystack.includes(word))) continue
      const label = entry.label.toLowerCase()
      const score = (words.every((word) => label.includes(word)) ? 2 : 0) + (entry.id ? 0 : 1)
      scored.push({ entry, score })
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((item) => item.entry)
  }, [query, index])
  const go = (entry) => {
    navigate(entry.doc.path + (entry.id ? `#${entry.id}` : ''))
    setQuery('')
    onPick?.()
  }
  return (
    <div className="relative">
      <label className="relative block">
        <span className="sr-only">Search the docs</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="Search the docs"
          autoComplete="off"
          spellCheck="false"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="docs-search-results"
          aria-autocomplete="list"
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            if (!counted.current && event.target.value.trim()) {
              counted.current = true
              track('docs-search')
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((value) => Math.min(results.length - 1, value + 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((value) => Math.max(0, value - 1))
            } else if (event.key === 'Enter' && results[active]) {
              event.preventDefault()
              go(results[active])
            } else if (event.key === 'Escape') {
              setQuery('')
            }
          }}
          className="h-10 w-full rounded-xl border border-line bg-card pr-3 pl-9 text-[14.5px] text-ink placeholder:text-faint focus:border-wall focus:outline-none"
        />
      </label>
      {query.trim() ? (
        <ul
          id="docs-search-results"
          role="listbox"
          className="absolute inset-x-0 top-12 z-20 max-h-80 overflow-auto rounded-xl border border-line bg-card p-1.5 shadow-xl shadow-black/10"
        >
          {results.length ? (
            results.map((entry, position) => (
              <li key={entry.doc.path + (entry.id || '')} role="option" aria-selected={position === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(position)}
                  onClick={() => go(entry)}
                  className={cx('block w-full rounded-lg px-3 py-2 text-left', position === active && 'bg-wall-wash')}
                >
                  <span className="block text-[14px] font-medium text-ink">{entry.label}</span>
                  {entry.id ? <span className="block text-[12.5px] text-faint">{entry.doc.nav}</span> : null}
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-[14px] text-slate">No matches. Try another word.</li>
          )}
        </ul>
      ) : null}
    </div>
  )
}

function Sidebar({ onPick }) {
  return (
    <nav aria-label="Docs" className="space-y-7">
      {DOC_GROUPS.map((group) => (
        <div key={group.title}>
          <h2 className="px-3 text-[12px] font-semibold tracking-wide text-faint uppercase">{group.title}</h2>
          <ul className="mt-2 space-y-0.5">
            {group.docs.map((doc) => (
              <li key={doc.path}>
                <NavLink
                  to={doc.path}
                  end
                  onClick={onPick}
                  className={({ isActive }) =>
                    cx(
                      'block rounded-lg px-3 py-1.5 text-[14.5px] transition-colors',
                      isActive ? 'bg-wall-wash font-semibold text-wall-deep' : 'text-slate hover:bg-ink/[0.04] hover:text-ink',
                    )
                  }
                >
                  {doc.nav}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function DocsLayout() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const current = DOCS.find((doc) => doc.path === location.pathname.replace(/\/+$/, ''))
  return (
    <Container className="max-w-7xl lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-10 xl:grid-cols-[230px_minmax(0,1fr)_200px]">
      <aside className="hidden lg:block">
        <div className="sticky top-16 max-h-[calc(100dvh-4rem)] space-y-7 overflow-y-auto py-10 pr-2">
          <DocsSearch />
          <Sidebar />
        </div>
      </aside>
      <div className="sticky top-16 z-30 -mx-5 border-b border-line bg-paper/95 px-5 py-3 backdrop-blur sm:-mx-8 sm:px-8 lg:hidden">
        <DocsSearch onPick={() => setOpen(false)} />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="docs-mobile-nav"
          className="mt-2 flex w-full items-center justify-between rounded-xl px-1 py-1.5 text-[14.5px] font-semibold text-ink"
        >
          <span>
            <span className="font-normal text-faint">Docs / </span>
            {current?.nav || 'Menu'}
          </span>
          <ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </button>
        <div id="docs-mobile-nav" hidden={!open} className="max-h-[60dvh] overflow-y-auto pt-3 pb-2">
          <Sidebar onPick={() => setOpen(false)} />
        </div>
      </div>
      <Outlet />
    </Container>
  )
}

export function DocPage({ doc }) {
  const md = content(doc)
  const navigate = useNavigate()
  const article = useRef(null)
  const position = DOCS.findIndex((item) => item.path === doc.path)
  const prev = DOCS[position - 1]
  const next = DOCS[position + 1]
  // Links inside the markdown are plain <a>: route the internal ones without a full page load.
  useEffect(() => {
    const node = article.current
    if (!node) return
    const onClick = (event) => {
      const link = event.target.closest('a')
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const href = link.getAttribute('href')
      if (!href || !href.startsWith('/') || href.startsWith('//')) return
      // Files (the PDF download) load as themselves, not as a route.
      if (link.hasAttribute('download') || /\.[a-z0-9]+$/i.test(href.split(/[?#]/)[0])) return
      event.preventDefault()
      navigate(href)
    }
    node.addEventListener('click', onClick)
    return () => node.removeEventListener('click', onClick)
  }, [navigate])
  const toc = md.headings.filter((heading) => heading.depth === 2)
  return (
    <>
      <article className="min-w-0 py-10 lg:py-12">
        <p className="text-[13px] font-semibold tracking-wide text-wall uppercase">{doc.group}</p>
        <h1 className="mt-2 text-[32px] leading-tight font-extrabold tracking-[-0.025em] text-ink sm:text-[40px]">
          {doc.path === '/docs' ? 'Shapewall docs' : doc.nav}
        </h1>
        <p className="mt-4 max-w-2xl text-[17px] leading-7 text-slate">{doc.description}</p>
        {doc.pdf ? (
          <a
            href={doc.pdf.href}
            download
            className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-card px-4 text-[14.5px] font-semibold text-ink hover:border-wall/40 hover:text-wall-deep"
          >
            <Download className="size-4" aria-hidden="true" />
            Download the PDF <span className="font-normal text-faint">({doc.pdf.size})</span>
          </a>
        ) : null}
        <div ref={article} className="prose-docs mt-8 max-w-3xl" dangerouslySetInnerHTML={{ __html: md.html }} />
        <div className="mt-14 grid max-w-3xl gap-3 border-t border-line pt-8 sm:grid-cols-2">
          {prev ? (
            <Link to={prev.path} className="group rounded-xl border border-line bg-card p-4 hover:border-wall/40">
              <span className="flex items-center gap-1.5 text-[12.5px] text-faint">
                <ArrowLeft className="size-3.5" aria-hidden="true" /> Previous
              </span>
              <span className="mt-1 block text-[15px] font-semibold text-ink group-hover:text-wall-deep">{prev.nav}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={next.path} className="group rounded-xl border border-line bg-card p-4 text-right hover:border-wall/40">
              <span className="flex items-center justify-end gap-1.5 text-[12.5px] text-faint">
                Next <ArrowRight className="size-3.5" aria-hidden="true" />
              </span>
              <span className="mt-1 block text-[15px] font-semibold text-ink group-hover:text-wall-deep">{next.nav}</span>
            </Link>
          ) : null}
        </div>
        {LAUNCHED ? (
          <a
            href={`${GITHUB_URL}/blob/main/${doc.repo ? `docs/${doc.repo}.md` : `website/src/docs/${doc.file}.md`}`}
            className="mt-6 inline-flex items-center gap-1.5 text-[13.5px] text-faint hover:text-ink"
          >
            <Pencil className="size-3.5" aria-hidden="true" /> Edit on GitHub
          </a>
        ) : null}
      </article>
      <aside className="hidden xl:block">
        {toc.length ? (
          <div className="sticky top-16 py-12">
            <h2 className="text-[12px] font-semibold tracking-wide text-faint uppercase">On this page</h2>
            <ul className="mt-3 space-y-2 border-l border-line">
              {toc.map((heading) => (
                <li key={heading.id}>
                  <a
                    href={`#${heading.id}`}
                    className="-ml-px block border-l border-transparent pl-3 text-[13.5px] leading-5 text-slate hover:border-wall hover:text-ink"
                  >
                    {heading.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </>
  )
}
