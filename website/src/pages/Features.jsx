import { Link } from 'react-router-dom'
import { ArrowRight, Check, Download } from 'lucide-react'
import { PageHeader } from '../components/page.jsx'
import { Badge, Container, Shot } from '../components/ui.jsx'
import {
  BeforeAfter,
  CaptureIllustration,
  CompareIllustration,
  GithubIllustration,
  JourneyIllustration,
  MapIllustration,
  NotifyIllustration,
  PhonePair,
} from '../components/illustrations.jsx'
import { AgentTerminal } from '../components/terminal.jsx'
import { FinalCta } from './Home.jsx'
import { HARDENING_PDF } from '../routes.js'
import liveComment from '../assets/shots/live-comment.webp'
import liveComment960 from '../assets/shots/live-comment-960.webp'
import variant from '../assets/shots/variant.webp'
import variant960 from '../assets/shots/variant-960.webp'
import phoneComment from '../assets/shots/phone-comment.webp'

const SECTIONS = [
  {
    id: 'capture',
    nav: 'Capture',
    title: 'Every page, at desktop, tablet and phone width',
    text: 'List your pages in shapewall.config.json, or take them from your sitemap. Playwright opens each one in Chromium at every viewport, waits for the network to settle, your selectors and any actions you scripted (open a menu, fill a search), then takes a fixed-size shot and a live HTML snapshot.',
    points: [
      'Desktop, tablet and phone viewports, with real mobile emulation; a page can skip the ones it does not need',
      'shapewall sitemap fills the page list from a sitemap.xml, grouped by path',
      'Signed-in pages through a storage state file or a login script',
      'A failed run keeps the previous captures; runs never overlap',
    ],
    art: <CaptureIllustration />,
  },
  {
    id: 'wall',
    nav: 'The wall',
    title: 'The whole product on one wall',
    text: 'Pages are grouped into sections, like Marketing, App and Settings, and laid out on a zoomable canvas. Zoom out to see every page and both screen sizes at once. Zoom in and the tile turns into the real captured page, text you can select and all.',
    points: [
      'Per-page notes such as "signed-out state"',
      'Thumbnails far out, full images and live HTML up close',
      'A minimap and URL state, so a link opens the same view',
    ],
    art: <MapIllustration />,
  },
  {
    id: 'comments',
    nav: 'Comments',
    title: 'Comments on the exact element',
    text: 'Click Comment, click the button that needs work, say what should change. The comment stores a selector and the element text, so after the next capture the pin follows the button, not the old pixel. If the element is gone, the pin says so.',
    points: [
      'Resolve, reopen, search and filter by state',
      '@mention people, or @agent to hand it to your coding agent',
      'Replies from the agent on what it changed',
      'Works in screenshot mode too, by position',
    ],
    art: (
      <Shot
        src={liveComment}
        srcSet={`${liveComment960} 960w, ${liveComment} 1440w`}
        sizes="(min-width: 1024px) 560px, 100vw"
        width="1440"
        height="900"
        alt="A comment pinned to the Try Plus free button on live HTML"
      />
    ),
  },
  {
    id: 'agent',
    nav: 'Agent loop',
    title: 'An agent loop that runs itself',
    text: 'shapewall comments --json hands any agent the page, viewport, selector, text, position and screenshot path for each open comment. shapewall watch runs your agent once per new comment, and the MCP server gives Claude Code, Codex and other agents tools to list, reply, recapture and resolve.',
    points: [
      'Vendor neutral: anything that runs a command or speaks MCP',
      'Comment text reaches the agent as data, never as a command line',
      'Agent status on each pin: queued, working, done, needs a human',
      'A hardening guide for connecting an agent to a shared board',
    ],
    links: [
      { to: '/docs/agent-hardening', label: 'Read the hardening guide' },
      { href: HARDENING_PDF, label: 'Download the PDF', download: true },
    ],
    art: <AgentTerminal />,
    dark: true,
  },
  {
    id: 'journeys',
    nav: 'Journeys',
    title: 'Journeys across real links',
    text: 'During a capture Shapewall reads the links on each page and keeps the ones that lead to other pages on the wall. They become arrows. Name the paths that matter, like visitor to first note, highlight one, and step through it page by page.',
    points: [
      'Arrows from real links, not guesses',
      'Named journeys in the config or made on the wall',
      'Step through with the keyboard or the arrow buttons',
    ],
    art: <JourneyIllustration />,
    dark: true,
    wide: true,
  },
  {
    id: 'before-after',
    nav: 'Before and after',
    title: 'Before and after, in place',
    text: 'Every comment remembers the capture it was made on, and a recapture keeps the old shot. Open a resolved comment and see before and after around the pin, so checking a change takes a second, on the page where it was asked for.',
    points: [
      'Page history: every kept capture beside the current one, with a pixel diff of what changed in red',
      'Fixed in: a link to the pull request or commit',
      'Reopen it if it is not right yet; the agent picks it up again',
    ],
    art: <BeforeAfter />,
  },
  {
    id: 'github',
    nav: 'GitHub connect',
    title: 'Comments, issues and pull requests, linked',
    text: 'Name your repo in the config and give Shapewall a token in the environment. A comment becomes a GitHub issue with one click, carrying the text, the page, the element and a link to the screenshot. A pull request that says shapewall:12 is linked to comment 12, and when it merges the comment resolves with the PR as its fix.',
    points: [
      'From the board, shapewall github issue, the API or MCP',
      'PRs linked by hand, by shapewall github sync, or by a signed webhook',
      'The token is read from the environment only, never stored',
    ],
    art: <GithubIllustration />,
  },
  {
    id: 'notifications',
    nav: 'Notifications',
    title: 'Tell the right people, where they already are',
    text: 'Comment events (created, replied, mentioned, agent status, resolved, reopened) go to a signed webhook, Slack, Discord or email through Resend. Every message links to the comment on the board, and an @mention reaches the person it names once you map their handle.',
    points: [
      'Per-person routing: @robin pings Robin on Slack or emails Robin',
      'Sent in the background with retries; the board never waits',
      'Secrets live in environment variables; shapewall notify test checks a channel',
    ],
    art: <NotifyIllustration />,
  },
  {
    id: 'compare',
    nav: 'Staging and production',
    title: 'Staging beside production',
    text: 'Point one board at several environments. Capture staging and production with the same pages, and see them side by side before you ship. Variants put a branch preview or a redesign right next to the page it would replace.',
    points: ['Environments share one page list', 'Changed pixels in red, changed pages only', 'Variants for directions, not just fixes'],
    art: <CompareIllustration />,
  },
  {
    id: 'variants',
    nav: 'Variants',
    title: 'Variants for trying a direction',
    text: 'When a comment asks for a direction ("try a calmer hero"), have the agent build it on a branch and put it beside the page instead of replacing it. Reviewers comment on the variant too.',
    points: [
      'shapewall variant add home --url ... --title "Calmer hero"',
      'Joined to its page by a dashed edge',
      'Remove it when the decision is made',
    ],
    art: (
      <Shot
        src={variant}
        srcSet={`${variant960} 960w, ${variant} 1440w`}
        sizes="(min-width: 1024px) 560px, 100vw"
        width="1440"
        height="900"
        alt="A pricing page with its redesigned variant beside it on the wall"
      />
    ),
  },
  {
    id: 'teams',
    nav: 'Teams',
    title: 'Workspaces, roles and share links',
    text: 'Host Shapewall for a team: people sign in with a passkey, and each workspace has owners, admins, members and viewers. Admins invite people, hand out expiring share links to clients, issue API tokens for agents and read an audit log of who changed what. The live demo has all of it, running in your browser: switch who you are with View as.',
    points: ['Four roles, checked on every request', 'Invites and share links that expire', 'An audit log of every admin change'],
    art: <RolesIllustration />,
  },
  {
    id: 'phone',
    nav: 'On a phone',
    title: 'The wall in your pocket',
    text: 'The board works on a phone: 44 px touch targets, a bottom sheet for comments, and Back closes the topmost panel instead of leaving the board. Install it as an app and review from the couch.',
    points: ['Installable board app', 'Pinch to zoom, tap to comment', 'Same comments, same pins'],
    art: (
      <div className="wall-dots flex items-center justify-center gap-4 rounded-2xl p-6">
        <div className="w-44 overflow-hidden rounded-[22px] border-4 border-device shadow-xl sm:w-52">
          <img
            src={phoneComment}
            alt="The Shapewall board on a phone with a comment sheet open"
            width="520"
            height="1125"
            loading="lazy"
            className="block h-auto w-full"
          />
        </div>
        <div className="hidden sm:block">
          <PhonePair />
        </div>
      </div>
    ),
  },
  {
    id: 'checks',
    nav: 'Page checks',
    title: 'See what needs attention, then verify the fix',
    text: 'Check your original pages for reliability, SEO, social images and accessibility. Run Chrome Lighthouse for local performance metrics, compare retained reports and keep an explicit performance budget beside the page.',
    points: [
      'Separate navigation lab measurements and explicit interaction flows',
      'Before and after reports with matching measurement conditions',
      'Private by default, with deliberate report sharing',
      'Findings become editable comment drafts; you decide what reaches an agent',
    ],
    links: [{ to: '/docs/page-checks', label: 'Read about page checks' }],
    art: (
      <div className="space-y-4 rounded-2xl border border-line bg-card p-6 text-ink shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <strong>Page checks</strong>
          <Badge>Example</Badge>
        </div>
        <p className="text-sm text-slate">Pricing · phone · separate lab samples</p>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <span>Metric</span>
          <span>Before</span>
          <span>After</span>
          <strong>LCP</strong>
          <span>3.8 s</span>
          <strong className="text-wall">2.1 s</strong>
          <strong>TBT</strong>
          <span>430 ms</span>
          <strong className="text-wall">120 ms</strong>
        </div>
        <p className="border-t border-line pt-3 text-sm text-slate">Recorded budget: LCP under 2.5 seconds</p>
        <p className="text-xs text-faint">Illustrative values. No real-user performance claim.</p>
      </div>
    ),
  },
]

const ROLES = [
  ['Robin', 'Owner', 'Everything, including deleting the workspace'],
  ['Jo', 'Admin', 'Invites, share links, tokens, audit log'],
  ['Mei', 'Member', 'Comments, replies, resolves, chats with the agent'],
  ['Alex', 'Viewer', 'Reads the board'],
  ['Taylor', 'Guest', 'One project, through a share link'],
]

function RolesIllustration() {
  return (
    <div className="wall-dots rounded-2xl p-6">
      <ul className="mx-auto max-w-md divide-y divide-line overflow-hidden rounded-xl border border-line bg-card shadow-lg">
        {ROLES.map(([name, role, can]) => (
          <li key={name} className="flex items-center gap-3 px-4 py-3">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-wall/10 text-[13px] font-semibold text-wall-deep"
              aria-hidden="true"
            >
              {name[0]}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold text-ink">
                {name} <span className="font-normal text-slate">· {role}</span>
              </span>
              <span className="block truncate text-[13px] text-slate">{can}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-center text-[13px] text-slate">The people in the live demo, all fictional.</p>
    </div>
  )
}

export default function Features() {
  return (
    <>
      <PageHeader eyebrow="Features" title="Everything between “change this” and “it is changed”">
        Shapewall captures your product, puts it on one wall, turns pointing into precise work for an agent, and shows you the result where
        you asked for it.
      </PageHeader>
      <nav className="sticky top-16 z-30 border-b border-line bg-paper/90 backdrop-blur" aria-label="Features on this page">
        <Container className="flex gap-1 overflow-x-auto py-2 [scrollbar-width:none]">
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="shrink-0 rounded-lg px-3 py-1.5 text-[13.5px] font-medium text-slate hover:bg-ink/5 hover:text-ink"
            >
              {section.nav}
            </a>
          ))}
        </Container>
      </nav>
      {SECTIONS.map((section, index) => (
        <section
          key={section.id}
          id={section.id}
          className={
            section.dark
              ? 'bg-night py-20 text-white sm:py-24'
              : index % 2
                ? 'border-y border-line bg-band py-20 sm:py-24'
                : 'py-20 sm:py-24'
          }
        >
          <Container className={`grid items-center gap-10 ${section.wide ? '' : 'lg:grid-cols-2 lg:gap-16'}`}>
            <div className={index % 2 && !section.wide ? 'lg:order-2' : section.wide ? 'max-w-2xl' : undefined}>
              {section.badge ? <Badge tone={section.dark ? 'dark' : 'amber'}>{section.badge}</Badge> : null}
              <h2
                className={`mt-3 text-[28px] leading-tight font-bold tracking-[-0.02em] text-balance sm:text-[34px] ${section.dark ? 'text-white' : 'text-ink'}`}
              >
                {section.title}
              </h2>
              <p className={`mt-4 text-[16.5px] leading-7 ${section.dark ? 'text-zinc-400' : 'text-slate'}`}>{section.text}</p>
              <ul className="mt-6 space-y-2.5">
                {section.points.map((point) => (
                  <li key={point} className={`flex gap-3 text-[15px] leading-6 ${section.dark ? 'text-zinc-300' : 'text-ink'}`}>
                    <Check className={`mt-0.5 size-4.5 shrink-0 ${section.dark ? 'text-wall-bright' : 'text-wall'}`} aria-hidden="true" />
                    <span className="min-w-0 break-words">{point}</span>
                  </li>
                ))}
              </ul>
              {section.links ? (
                <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-semibold">
                  {section.links.map((link) => {
                    const className = `inline-flex items-center gap-1.5 ${section.dark ? 'text-wall-bright hover:text-white' : 'text-wall hover:text-wall-deep'}`
                    const Icon = link.download ? Download : ArrowRight
                    const body = (
                      <>
                        {link.label}
                        <Icon className="size-4" aria-hidden="true" />
                      </>
                    )
                    return link.to ? (
                      <Link key={link.label} to={link.to} className={className}>
                        {body}
                      </Link>
                    ) : (
                      <a key={link.label} href={link.href} download={link.download || undefined} className={className}>
                        {body}
                      </a>
                    )
                  })}
                </p>
              ) : null}
            </div>
            <div className={`min-w-0 ${index % 2 && !section.wide ? 'lg:order-1' : ''}`}>{section.art}</div>
          </Container>
        </section>
      ))}
      <section className="border-t border-line bg-band py-16">
        <Container className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-[22px] font-bold tracking-tight text-ink">Small, local, and yours</h2>
            <p className="mt-2 max-w-xl text-[15.5px] leading-7 text-slate">
              Node 22, Playwright, Express and React Flow. Data is plain JSON and images in your project. The local tool is open source
              under Apache 2.0.
            </p>
          </div>
          <Link to="/open-source" className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-wall hover:text-wall-deep">
            Licenses and self-hosting <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Container>
      </section>
      <FinalCta />
    </>
  )
}
