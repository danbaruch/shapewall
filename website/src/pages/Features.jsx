import { Fragment, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Download } from 'lucide-react'
import { Badge, Container, Eyebrow, GetStarted, LiveDemo, Shot } from '../components/ui.jsx'
import {
  BeforeAfter,
  CaptureIllustration,
  FollowIllustration,
  GithubIllustration,
  JourneyIllustration,
  MapIllustration,
  NotifyIllustration,
  PhonePair,
  SetupIllustration,
  TriggersIllustration,
} from '../components/illustrations.jsx'
import { AgentTerminal } from '../components/terminal.jsx'
import { FinalCta } from './Home.jsx'
import liveComment960 from '../assets/shots/live-comment-960.webp'
import liveComment1440 from '../assets/shots/live-comment-1440.webp'
import liveComment2048 from '../assets/shots/live-comment-2048.webp'
import compareComment960 from '../assets/shots/compare-comment-960.webp'
import compareComment1440 from '../assets/shots/compare-comment-1440.webp'
import variant960 from '../assets/shots/variant-960.webp'
import variant1440 from '../assets/shots/variant-1440.webp'
import phoneComment from '../assets/shots/phone-comment.webp'
import { Reveal } from '../components/motion.jsx'
import { Clip, ClipTabs } from '../components/video.jsx'

// The workspace of the public demo (client/src/demo/fixtures.js WORKSPACE_ID), in its console.
const DEMO_CONSOLE = '/demo/console.html#/w/ws_4c756d000000000000000001'

// Each section's looping clip (src/media.json, made from the films' clips): `clip` is one, `clips` several behind tabs.
// A section with a clip shows it instead of its illustration. No clip: Capture, Before/after, GitHub, Notifications,
// Variants (they keep their illustrations). The order tells a story in chapters (`group`, shown above each title and
// as rules in the nav): the whole app and its flows, steering your agents, more ways to look, working together, anywhere.
const SECTIONS = [
  {
    id: 'capture',
    group: 'The whole app',
    nav: 'Capture',
    title: 'Every screen, at desktop, tablet and phone width',
    text: 'shapewall init finds your screens, or list them in shapewall.config.json or import them from a sitemap. Shapewall opens each one in Chromium at every viewport, waits for the network, your selectors and any scripted actions such as opening a menu, then saves a fixed-size shot and a live HTML snapshot.',
    points: [
      'Desktop, tablet and phone viewports with real mobile emulation; a screen can skip the ones it does not need',
      'shapewall sitemap fills the screen list from a sitemap.xml, grouped by path',
      'Signed-in screens through a storage state file or a login script',
      'A failed run keeps the previous captures; runs never overlap',
    ],
    art: <CaptureIllustration />,
  },
  {
    id: 'wall',
    group: 'The whole app',
    clip: {
      id: 'clip-wall',
      label: 'The wall zooming from every screen of a demo app in to its pricing screen at three widths, and back out',
    },
    nav: 'The wall',
    title: 'The whole app on one wall',
    text: 'Screens are grouped into sections, such as Marketing, App and Settings, on a zoomable canvas. Zoom out to see every screen at every size at once, whether that is 10 or 500. Zoom in and the tile becomes the captured screen, with text you can select.',
    points: [
      'Moves like a design tool: the wheel or a trackpad pans, a pinch or Ctrl/Cmd+wheel zooms at the cursor, Space+drag pans from anywhere',
      'Thumbnails far out, full images and live HTML up close',
      'Per-screen notes such as "signed-out state"',
      'A minimap and URL state, so a link opens the same view',
    ],
    art: <MapIllustration />,
  },
  {
    id: 'journeys',
    group: 'The whole app',
    clip: { id: 'clip-journeys', label: 'The Sign up journey stepping from Home to Pricing, Sign up and the Dashboard' },
    nav: 'Journeys',
    title: 'Journeys: the flows between screens',
    text: 'During a capture Shapewall reads the links on each screen and keeps the ones that lead to other screens on the wall. They become arrows. Name the flows that matter, such as sign up to dashboard, highlight one, and step through it screen by screen.',
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
    id: 'comments',
    group: 'Steer your agents',
    clips: [
      { id: 'clip-pin', tab: 'Pin a comment', label: 'A comment pinned to the Try Plus free button and posted' },
      { id: 'clip-say', tab: 'Say it or draw it', label: 'A dictated comment with a box drawn round the button, then posted' },
    ],
    nav: 'Comments',
    title: 'Comments are instructions, pinned to the element',
    text: 'Click Comment, click the element and say what to build or change. The comment stores a selector and the element text, so your agent knows exactly what you meant, and after the next capture the pin follows the element, not the old pixel. If the element is gone, the pin says so.',
    points: [
      'One comment box with everything inside it: attach images, draw boxes, arrows and pen strokes on the page, dictate, and Post',
      'Dictation uses your browser\u2019s own speech service to turn speech into text; Shapewall never receives the audio',
      'Resolve, reopen, search and filter by state',
      '@mention people, or @agent to hand it to your coding agent',
      'Replies from the agent on what it changed',
      'Works in screenshot mode too, by position',
    ],
    art: (
      <Shot
        src={liveComment1440}
        srcSet={`${liveComment960} 960w, ${liveComment1440} 1440w`}
        sizes="(min-width: 1024px) 560px, 100vw"
        width="1440"
        height="900"
        alt="A new instruction on the Growth plan's Start free trial button on live HTML, its box holding image and drawing tools, a microphone and Post"
      />
    ),
  },
  {
    id: 'agent',
    group: 'Steer your agents',
    clip: { id: 'clip-agent', label: 'Fix with agent: the agent plans, asks before it acts, changes one file and resolves the comment' },
    nav: 'Agents',
    title: 'An agent loop that works with the tools you already use',
    text: 'shapewall comments --json hands any agent the page, viewport, selector, text, position and screenshot path for each open comment. shapewall watch runs your agent once per new comment, and the MCP server gives Claude Code, Codex and other agents tools to list, reply, recapture and resolve.',
    points: [
      'Vendor neutral: anything that runs a command or speaks MCP',
      'Comment text reaches the agent as data, never as a command line',
      'Agent status on each pin: queued, working, done, needs a human',
      'Optional: the agent works on a branch, or fixes several comments in one batch',
      'A hardening guide for connecting an agent to a shared board',
    ],
    links: [{ to: '/docs/agent-hardening', label: 'Read the hardening guide' }],
    art: <AgentTerminal />,
    dark: true,
  },
  {
    id: 'setup',
    group: 'Steer your agents',
    nav: 'Agent setup',
    title: 'Your agent finds the board on its own',
    text: 'shapewall init adds a short Shapewall section to your project\u2019s AGENTS.md, so any agent that opens the project knows the board is there and how to read it. One more command registers the MCP server with Claude Code and Codex, or install the plugin for the same server plus skills.',
    points: [
      'A marked section in AGENTS.md (and a one-line CLAUDE.md that imports it); a file you already have is never edited unless you ask',
      'shapewall agent setup shows the change, asks first, backs up each file and undoes cleanly with --remove',
      'The Claude Code and Codex plugin (experimental): the MCP server plus skills to take the next comment, open the board and show status',
      'Connected agents follow your project\u2019s instruction files, and Claude Code\u2019s auto memory stays off for them',
    ],
    links: [
      { to: '/docs/agent-workflow#your-agent-finds-the-board', label: 'How your agent finds the board' },
      { to: '/docs/plugins', label: 'The plugin' },
    ],
    art: <SetupIllustration />,
  },
  {
    id: 'links',
    group: 'Steer your agents',
    nav: 'Links and follow',
    title: 'Links to the exact view, and follow your agent',
    text: 'Every link Shapewall makes opens the board flown to one place: a page, a comment, a screen size or a page\u2019s before and after. Your agent hands you the link when it is done. Turn on Follow agent and the board keeps up with it: it flies to each comment the agent takes and opens the before and after of the screen it changed.',
    points: [
      'shapewall open --page pricing, --comment 12, --viewport phone or --compare, on a local or a hosted board',
      'The MCP board_link tool gives the agent the same links, and every comment and page it reads carries one',
      'compare_captures shows the agent its own before and after, with a pixel diff',
      'Moving the canvas or opening another comment stops following; other changed screens wait in a quiet menu',
    ],
    links: [
      { to: '/docs/agent-workflow#links-to-the-board', label: 'Links to the board' },
      { to: '/docs/agent-workflow#follow-an-agent', label: 'Follow an agent' },
    ],
    art: <FollowIllustration />,
  },
  {
    id: 'threads',
    group: 'Steer your agents',
    nav: 'Shared threads',
    title: 'Shared threads: the agent answers when asked',
    text: 'On a shared board, people talk to each other in the board chat and in each comment\u2019s thread, like in a chat app. The agent starts work only when someone @mentions it or presses Send to agent, and then reads what people wrote since its last answer.',
    points: [
      '@agent, the agent\u2019s own handle, Send to agent or Fix with starts a turn; every other message stays with the people',
      'The person who connected the agent can let one thread answer every message, and the agent\u2019s machine can refuse that',
      'Text an agent wrote never starts an agent turn, so agents cannot set each other off',
      'A private chat, and a local board only you use, still answer every message',
    ],
    links: [{ to: '/docs/chat#when-an-agent-answers', label: 'When an agent answers' }],
    art: <TriggersIllustration />,
  },
  {
    id: 'before-after',
    group: 'Steer your agents',
    nav: 'Before/after',
    title: 'Before and after, in place',
    text: 'Every comment remembers the capture it was made on, and a recapture keeps the old shot. Open a resolved comment to see before and after around the pin, on the screen where the change was asked for.',
    points: [
      'Page history: every kept capture beside the current one, with a pixel diff of what changed in red',
      'Fixed in: a link to the pull request or commit',
      'On every pull request: one comment with the screens that changed, before, after and diff',
      'Reopen it with a note and the agent picks it up again',
    ],
    art: <BeforeAfter />,
  },
  {
    id: 'checks',
    group: 'Steer your agents',
    clip: { id: 'clip-checks', label: 'The Checks panel, then a before and after Lighthouse comparison' },
    nav: 'Page checks',
    title: 'See what needs attention, then verify the fix',
    text: 'Check your pages for reliability, SEO, social images and accessibility. Run Lighthouse for local performance metrics, compare saved reports and keep a performance budget beside the page.',
    points: [
      'Lab measurements for page loads and for scripted interaction flows',
      'Before and after reports under matching measurement conditions',
      'Reports stay private until you share them',
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
        <p className="text-xs text-faint">Example values.</p>
      </div>
    ),
  },
  {
    id: 'compare',
    group: 'More ways to look',
    clip: { id: 'clip-compare', label: 'Pricing on staging beside production, the diff overlay, and a comment left on production' },
    nav: 'Staging',
    title: 'Staging beside production',
    text: 'Point one board at several environments. Capture staging and production with the same pages, and see them side by side before you ship. Comment on either side while you compare: the pin stays with the environment it was left on.',
    points: [
      'Environments share one page list',
      'Changed pixels in red, and a filter for changed pages only',
      'A comment\u2019s thread says where it was left, such as \u201cLeft on Production\u201d',
    ],
    links: [{ to: '/docs/compare#comments-while-comparing', label: 'Commenting while comparing' }],
    art: (
      <Shot
        src={compareComment1440}
        srcSet={`${compareComment960} 960w, ${compareComment1440} 1440w`}
        sizes="(min-width: 1024px) 560px, 100vw"
        width="1440"
        height="900"
        alt="Compare mode: Pricing on staging beside production, changed pixels in red, and a comment thread marked Left on Production"
      />
    ),
  },
  {
    id: 'variants',
    group: 'More ways to look',
    nav: 'Variants',
    title: 'Variants: try a direction beside the screen',
    text: 'When a comment asks for a direction ("try a calmer hero"), have your agent build it on a branch and put it beside the original instead of replacing it. Comment on the variant like on any other screen.',
    points: [
      'shapewall variant add home --url ... --title "Calmer hero"',
      'Joined to its screen by a dashed line on the wall',
      'Remove it when the decision is made',
    ],
    art: (
      <Shot
        src={variant1440}
        srcSet={`${variant960} 960w, ${variant1440} 1440w`}
        sizes="(min-width: 1024px) 560px, 100vw"
        width="1440"
        height="900"
        alt="A pricing page with its redesigned variant beside it on the wall"
      />
    ),
  },
  {
    id: 'github',
    group: 'Work together',
    nav: 'GitHub',
    title: 'Comments, GitHub issues and pull requests, linked',
    text: 'Name your repo in the config and give Shapewall a token in the environment. Any wall comment becomes a GitHub issue in one click, with the text, the screen, the element and a link to the screenshot. A pull request that mentions shapewall:12 is linked to comment 12, and when it merges the comment resolves with the PR as its fix.',
    points: [
      'From the board, shapewall github issue, the API or MCP',
      'PRs linked by hand, by shapewall github sync, or by a signed webhook',
      'The token is read from the environment only, never stored',
    ],
    art: <GithubIllustration />,
  },
  {
    id: 'notifications',
    group: 'Work together',
    nav: 'Notifications',
    title: 'Tell the right people, where they already are',
    text: 'Comment events (created, replied, mentioned, agent status, resolved, reopened) go to a signed webhook, Slack, Discord, Telegram or email through Resend. Every message links to the comment on the board, and an @mention reaches the person it names once you map their handle.',
    points: [
      'Per-person routing: @robin pings Robin on Slack or emails Robin',
      'Sent in the background with retries; the board never waits',
      'Secrets live in environment variables; shapewall notify test checks a channel',
    ],
    art: <NotifyIllustration />,
  },
  {
    id: 'teams',
    group: 'Work together',
    clips: [
      { id: 'clip-team', tab: 'Invite and roles', label: 'Inviting a person and changing a member\u2019s role' },
      { id: 'clip-multi', tab: 'Multiplayer', label: 'Three people\u2019s named cursors on one board, and a pin arriving live' },
      { id: 'clip-log', tab: 'Activity and usage', label: 'The Activity log and the Usage chart of agent turns' },
      { id: 'clip-share', tab: 'Share links', label: 'Creating a share link and copying it' },
    ],
    nav: 'Teams',
    badge: 'Beta',
    title: 'Workspaces, roles and share links',
    text: 'Host the team server and everyone steers from one shared wall. People sign in with a passkey, or, on your tailnet, with just their tailnet login. Each workspace has owners, admins, members and viewers. Admins invite people, hand out expiring share links, issue API tokens for agents and read an audit log of who changed what. A Usage page charts every agent turn with the tokens and cost each agent reported, and Activity shows who signed in, changed a setting or approved what. The live demo has the roles, the links and both pages, with made-up numbers: switch who you are with View as.',
    points: [
      'Four workspace roles (owner, admin, member, viewer), checked on every request',
      'Expiring invites, and read-only or guest-comment share links with an optional passcode',
      'Agent usage from the numbers each agent reported, never estimated',
      'People\u2019s activity and an access review',
    ],
    // The demo's console, with made-up numbers (client/src/demo/usage).
    links: [
      { href: `${DEMO_CONSOLE}/usage`, label: 'See Usage in the live demo' },
      { href: `${DEMO_CONSOLE}/activity`, label: 'See Activity in the live demo' },
    ],
    art: <RolesIllustration />,
  },
  {
    id: 'phone',
    group: 'Anywhere',
    clip: { id: 'clip-phone', label: 'The board on a phone: a tap on the headline, a comment in the sheet, Post' },
    nav: 'Phone',
    title: 'The wall in your pocket',
    text: 'Steer from your phone: 44 px touch targets, a bottom sheet for comments, and Back closes the topmost panel instead of leaving the board. Served over HTTPS, it installs to your home screen and opens like an app.',
    points: [
      'Installs as an app over HTTPS',
      'Pinch to zoom, tap to pin an instruction, dictate with the microphone',
      'Staging beside production, on the phone too',
      'Same wall, same pins, same agent threads',
    ],
    art: (
      <div className="wall-dots flex items-center justify-center gap-4 rounded-2xl p-6">
        <div className="w-44 overflow-hidden rounded-[22px] border-4 border-device shadow-xl sm:w-52">
          <img
            src={phoneComment}
            alt="The Shapewall board on a phone comparing staging with production, a comment on the Production headline open in a sheet"
            width="640"
            height="1385"
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
]

const CLIP_SIZES = '(min-width: 1280px) 560px, (min-width: 1024px) 45vw, 100vw'
const CLIP_SIZES_WIDE = '(min-width: 1024px) 896px, 100vw'

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

// The page's hero: the promise on the left, one still of the thing it describes on the right (a comment being left on
// the exact button, the "change this" half of the headline). Stacks on phones: text, buttons, then the screenshot. The
// screenshot is the largest paint, so it loads eagerly; it only moves with the home hero's entrance.
function FeaturesHero() {
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div
        className="wall-dots absolute inset-x-0 top-0 h-[560px] [mask-image:linear-gradient(to_bottom,black_40%,transparent)]"
        aria-hidden="true"
      />
      <Container className="relative grid items-center gap-12 pt-14 pb-16 sm:pt-20 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] lg:gap-14 lg:pt-24 lg:pb-24">
        <div className="max-w-2xl">
          <Eyebrow>Features</Eyebrow>
          <h1 className="mt-4 text-[34px] leading-[1.06] font-extrabold tracking-[-0.035em] text-balance text-ink min-[380px]:text-[36px] sm:text-[52px] lg:text-[42px] xl:text-[52px]">
            Every screen, every flow, <span className="text-wall">every change your agents make</span>
          </h1>
          <p className="mt-6 text-[17px] leading-7 text-pretty text-slate sm:text-[19px] sm:leading-8">
            Capture every screen of your app, see the flows between them, point at anything and tell your coding agent what to build, then
            check the result where you asked for it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <GetStarted where="features-hero" />
            <LiveDemo where="features-hero" label="Try the live demo" />
          </div>
        </div>
        <Shot
          src={liveComment1440}
          srcSet={`${liveComment960} 960w, ${liveComment1440} 1440w, ${liveComment2048} 2048w`}
          sizes="(min-width: 1400px) 660px, (min-width: 1024px) 46vw, 100vw"
          width="1440"
          height="900"
          eager
          className="hero-rise min-[1400px]:-mr-28"
          alt="The Shapewall wall on a pricing screen: a new instruction pinned to the Growth plan's Start free trial button asks for the free-trial terms under it"
        />
      </Container>
    </section>
  )
}

// The section in the band across the middle of the screen, for the nav's "you are here". Null above the first one.
function useCurrentSection() {
  const [current, setCurrent] = useState(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined
    const seen = new Map()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting)
        setCurrent(SECTIONS.find((section) => seen.get(section.id))?.id ?? null)
      },
      { rootMargin: '-45% 0px -50% 0px' },
    )
    for (const section of SECTIONS) {
      const node = document.getElementById(section.id)
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [])
  return current
}

export default function Features() {
  const current = useCurrentSection()
  const navRow = useRef(null)
  // On a phone the nav is one row that scrolls sideways: keep the current item in view. This moves the row only,
  // never the page.
  useEffect(() => {
    const row = navRow.current
    const link = current && row?.querySelector(`a[href="#${current}"]`)
    if (!link || row.scrollWidth <= row.clientWidth) return
    const left = link.offsetLeft - (row.clientWidth - link.offsetWidth) / 2
    row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }, [current])
  return (
    <>
      <FeaturesHero />
      <nav className="sticky top-16 z-30 border-b border-line bg-paper/90 backdrop-blur" aria-label="Features on this page">
        {/* Phone: one row that scrolls sideways, faded at both edges so clipped items read as more. Wider: the row wraps,
            so every item is always visible. */}
        <Container
          ref={navRow}
          className="relative flex snap-x snap-proximity gap-1 overflow-x-auto py-2 pr-12 [mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-3rem),transparent)] [scrollbar-width:none] sm:pr-12 md:flex-wrap md:gap-y-1 md:overflow-visible md:pr-8 md:[mask-image:none]"
        >
          {SECTIONS.map((section, index) => (
            <Fragment key={section.id}>
              {/* A thin rule where one chapter (The loop, More ways to look, ...) gives way to the next. */}
              {index > 0 && SECTIONS[index - 1].group !== section.group ? (
                <span aria-hidden="true" className="mx-1 my-2 w-px shrink-0 self-stretch bg-line" />
              ) : null}
              <a
                href={`#${section.id}`}
                aria-current={current === section.id ? 'location' : undefined}
                className={`shrink-0 scroll-ml-5 snap-start rounded-lg px-2 py-1.5 text-[13.5px] font-medium transition-colors hover:bg-ink/5 hover:text-ink ${current === section.id ? 'bg-wall/10 text-wall' : 'text-slate'}`}
              >
                {section.nav}
              </a>
            </Fragment>
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
            <Reveal className={index % 2 && !section.wide ? 'lg:order-2' : section.wide ? 'max-w-2xl' : undefined}>
              <div className="flex flex-wrap items-center gap-3">
                <Eyebrow dark={section.dark}>{section.group}</Eyebrow>
                {section.badge ? <Badge tone={section.dark ? 'dark' : 'amber'}>{section.badge}</Badge> : null}
              </div>
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
            </Reveal>
            <Reveal
              className={`min-w-0 ${index % 2 && !section.wide ? 'lg:order-1' : ''} ${section.wide && (section.clip || section.clips) ? 'mx-auto w-full max-w-4xl' : ''}`}
              delay={0.06}
            >
              {section.clips ? (
                <ClipTabs clips={section.clips} dark={section.dark} sizes={section.wide ? CLIP_SIZES_WIDE : CLIP_SIZES} />
              ) : section.clip ? (
                <Clip
                  id={section.clip.id}
                  label={section.clip.label}
                  dark={section.dark}
                  sizes={section.wide ? CLIP_SIZES_WIDE : CLIP_SIZES}
                />
              ) : (
                section.art
              )}
            </Reveal>
          </Container>
        </section>
      ))}
      <section className="border-t border-line bg-band py-16">
        <Container className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-[22px] font-bold tracking-tight text-ink">Small, local, and yours</h2>
            <p className="mt-2 max-w-xl text-[15.5px] leading-7 text-slate">
              Built on Node.js, Playwright, Express and React Flow. Data is plain JSON and images in your project. The local tool is open
              source under Apache 2.0.
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
