import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import { GitHubIcon, Logo } from './brand.jsx'
import { Container, GetStarted, IconButton, cx } from './ui.jsx'
import { ThemeMenu, ThemeSwitch } from './theme.jsx'
import { track } from '../analytics.js'
import { DEMO_URL, DOC_GROUPS, GITHUB_URL, NOT_FOUND, SITE_URL, canonicalUrl, routeFor } from '../routes.js'
import { GITHUB_LABEL, LAUNCHED } from '../launch.js'

// Set by vite.config.js from SHAPEWALL_STEALTH, the same switch scripts/prerender.mjs reads.
/* global __SHAPEWALL_STEALTH__ */
const INDEXABLE = typeof __SHAPEWALL_STEALTH__ !== 'undefined' && __SHAPEWALL_STEALTH__ === '0'

const NAV = [
  { to: '/features', label: 'Features' },
  { to: '/docs', label: 'Docs' },
  { to: '/open-source', label: 'Licenses' },
]

// Keeps the head tags in step on client-side navigation (the prerendered HTML already has them on first load).
function useHeadSync(pathname) {
  useEffect(() => {
    const route = routeFor(pathname) || NOT_FOUND
    const image = `${SITE_URL}/og/${route.og}.jpg`
    document.title = route.title
    const set = (selector, value) => document.querySelector(selector)?.setAttribute('content', value)
    set('meta[name="description"]', route.description)
    set('meta[property="og:title"]', route.title)
    set('meta[name="twitter:title"]', route.title)
    set('meta[property="og:description"]', route.description)
    set('meta[name="twitter:description"]', route.description)
    set('meta[property="og:image"]', image)
    set('meta[name="twitter:image"]', image)
    set('meta[property="og:url"]', canonicalUrl(route))
    // A page that is not found, or marked noindex, stays out of search however it was reached, and has no canonical.
    const hidden = !INDEXABLE || route.notFound || route.noindex
    set('meta[name="robots"]', hidden ? 'noindex,nofollow' : 'index,follow')
    let canonical = document.querySelector('link[rel="canonical"]')
    if (route.notFound) canonical?.remove()
    else {
      if (!canonical) {
        canonical = document.createElement('link')
        canonical.rel = 'canonical'
        document.head.append(canonical)
      }
      canonical.setAttribute('href', canonicalUrl(route))
    }
  }, [pathname])
}

function useScrollOnNavigate(location) {
  useEffect(() => {
    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)))
      if (target) {
        target.scrollIntoView()
        return
      }
    }
    window.scrollTo(0, 0)
  }, [location.pathname, location.hash])
}

function Header() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (event) => event.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-paper/85 backdrop-blur-md supports-[backdrop-filter]:bg-paper/75">
      <Container className="flex h-16 items-center gap-6">
        <Link to="/" className="shrink-0 rounded-lg" aria-label="Shapewall home">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx('rounded-lg px-3 py-2 text-[14.5px] font-medium transition-colors', isActive ? 'text-ink' : 'text-slate hover:text-ink')
              }
            >
              {item.label}
            </NavLink>
          ))}
          <a
            href={DEMO_URL}
            onClick={() => track('live-demo', { where: 'nav' })}
            className="rounded-lg px-3 py-2 text-[14.5px] font-medium text-slate transition-colors hover:text-ink"
          >
            Live demo
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={GITHUB_URL}
            className="hidden h-10 items-center gap-2 rounded-xl px-3 text-[14.5px] font-medium text-slate transition-colors hover:text-ink sm:inline-flex"
          >
            <GitHubIcon className="size-[18px]" />
            {GITHUB_LABEL}
          </a>
          <span className="hidden sm:inline-flex">
            <GetStarted where="header" size="md" />
          </span>
          <ThemeMenu className="hidden md:block" />
          <IconButton
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
          </IconButton>
        </div>
      </Container>
      <div id="mobile-nav" hidden={!open} className="border-t border-hairline bg-paper md:hidden">
        <Container className="flex flex-col gap-1 py-3">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className="rounded-xl px-3 py-3 text-[16px] font-medium text-ink hover:bg-ink/5">
              {item.label}
            </Link>
          ))}
          <a
            href={DEMO_URL}
            onClick={() => track('live-demo', { where: 'mobile-menu' })}
            className="rounded-xl px-3 py-3 text-[16px] font-medium text-ink hover:bg-ink/5"
          >
            Live demo
          </a>
          <a href={GITHUB_URL} className="flex items-center gap-2 rounded-xl px-3 py-3 text-[16px] font-medium text-ink hover:bg-ink/5">
            <GitHubIcon className="size-[18px]" /> {GITHUB_LABEL}
          </a>
          <div className="px-1 pt-2 pb-1 [&>a]:w-full">
            <GetStarted where="mobile-menu" />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line px-3 pt-3 pb-1">
            <span className="text-[14.5px] font-medium text-slate">Theme</span>
            <ThemeSwitch />
          </div>
        </Container>
      </div>
    </header>
  )
}

function Footer() {
  const docs = DOC_GROUPS.flatMap((group) => group.docs).slice(0, 6)
  return (
    <footer className="border-t border-line bg-band">
      <Container className="grid grid-cols-2 gap-x-6 gap-y-10 py-14 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="col-span-2 max-w-xs lg:col-span-1">
          <Logo />
          <p className="mt-4 text-[14.5px] leading-6 text-slate">
            Shape your product on the wall. Runs on your machine. The local tool is open source under Apache 2.0, and the team server is
            source-available.
          </p>
        </div>
        <FooterColumn
          title="Product"
          links={[
            { to: '/features', label: 'Features' },
            { to: '/features#teams', label: 'Teams' },
            { to: '/open-source', label: 'Licenses' },
            { to: '/docs/self-hosting', label: 'Self-hosting' },
          ]}
        />
        <FooterColumn title="Docs" links={docs.map((doc) => ({ to: doc.path, label: doc.nav }))} />
        <FooterColumn
          title="Project"
          links={
            LAUNCHED
              ? [
                  { href: GITHUB_URL, label: GITHUB_LABEL },
                  { href: `${GITHUB_URL}/blob/main/CHANGELOG.md`, label: 'Changelog' },
                  { href: `${GITHUB_URL}/blob/main/SECURITY.md`, label: 'Security policy' },
                  { to: '/privacy', label: 'Privacy' },
                ]
              : [
                  { href: GITHUB_URL, label: GITHUB_LABEL },
                  { to: '/docs/security', label: 'Security model' },
                  { to: '/privacy', label: 'Privacy' },
                ]
          }
        />
      </Container>
      <Container>
        <div className="flex flex-col gap-2 border-t border-line py-6 text-[13.5px] text-faint sm:flex-row sm:justify-between">
          <p>© 2026 Dan Baruch and Shapewall contributors. Apache 2.0; the team server is under the Functional Source License.</p>
          <p>Made for people who build with AI agents.</p>
        </div>
        <div className="flex items-center gap-3 pb-8 text-[13.5px] text-faint">
          <span>Theme</span>
          <ThemeSwitch />
        </div>
      </Container>
    </footer>
  )
}

function FooterColumn({ title, links }) {
  return (
    <div>
      <h2 className="text-[13px] font-semibold tracking-wide text-ink uppercase">{title}</h2>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.label}>
            {link.to ? (
              <Link to={link.to} className="text-[14.5px] text-slate hover:text-ink">
                {link.label}
              </Link>
            ) : (
              <a href={link.href} className="text-[14.5px] text-slate hover:text-ink">
                {link.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Layout() {
  const location = useLocation()
  useHeadSync(location.pathname)
  useScrollOnNavigate(location)
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only z-50 rounded-lg bg-ink px-3 py-2 text-card focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <Header />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
