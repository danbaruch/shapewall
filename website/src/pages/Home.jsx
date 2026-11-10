import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  Camera,
  FolderOpen,
  GitCompare,
  KeyRound,
  LayoutGrid,
  Link2,
  MapPin,
  MousePointerClick,
  Radio,
  ShieldCheck,
  Smartphone,
  Users,
} from 'lucide-react'
import { GitHubIcon } from '../components/brand.jsx'
import { Badge, Button, Container, GetStarted, InstallCommand, LiveDemo, SectionHead, Shot } from '../components/ui.jsx'
import { BeforeAfter, CaptureIllustration, JourneyIllustration, MapIllustration } from '../components/illustrations.jsx'
import { AgentTerminal } from '../components/terminal.jsx'
import { Faq } from '../components/faq.jsx'
import { GITHUB_URL } from '../routes.js'
import { GITHUB_LABEL, LAUNCHED, LICENSE_SUMMARY } from '../launch.js'
import boardOverview from '../assets/shots/board-overview.webp'
import boardOverview960 from '../assets/shots/board-overview-960.webp'
import liveComment960 from '../assets/shots/live-comment-960.webp'

export default function Home() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <FeatureGrid />
      <AgentLoop />
      <Journeys />
      <BeforeAfterSection />
      <Teams />
      <OpenSourceSection />
      <FaqSection />
      <FinalCta />
    </>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="wall-dots absolute inset-x-0 top-0 h-[560px] [mask-image:linear-gradient(to_bottom,black_40%,transparent)]"
        aria-hidden="true"
      />
      <Container className="relative pt-14 pb-8 sm:pt-20 lg:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <Link
            to="/docs/getting-started#install"
            className="inline-flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-3 pl-1 text-[13px] font-medium text-slate shadow-sm shadow-black/[0.03] hover:text-ink"
          >
            <Badge>{LAUNCHED ? 'Open source' : 'Private early access'}</Badge>
            <span className="sm:hidden">Runs on your machine</span>
            <span className="hidden sm:inline">Apache 2.0 local tool, runs on your machine</span>
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
          <h1 className="mt-6 text-[40px] leading-[1.04] font-extrabold tracking-[-0.035em] text-balance text-ink sm:text-6xl lg:text-[68px]">
            Shape your product <span className="text-wall">on the wall.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-7 text-pretty text-slate sm:text-[19px] sm:leading-8">
            Shapewall captures every page of your site at desktop, tablet and phone width and lays them out on one zoomable wall. Pin a
            comment to the element you want changed, your coding agent makes the change, and you see before and after in place.
          </p>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-6 text-pretty text-ink">
            {LAUNCHED ? 'Free to use. ' : ''}Run it on your machine, or host the team server yourself for a shared wall.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <GetStarted where="hero" />
            <LiveDemo where="hero" />
            <Button href={GITHUB_URL} variant="secondary" size="lg">
              <GitHubIcon className="size-[18px]" /> {GITHUB_LABEL}
            </Button>
          </div>
          <p className="mt-4 text-[13.5px] text-slate">
            The live demo runs in your browser: comments, the agent chat and the team console, with nothing to install.
          </p>
          <div className="mt-5 flex flex-col items-center gap-2">
            <InstallCommand where="hero" />
            {LAUNCHED ? (
              <p className="text-[13px] text-faint">
                Needs Node.js 22.13 or newer.{' '}
                <Link to="/docs/getting-started#install" className="font-medium text-wall hover:text-wall-deep">
                  Install steps
                </Link>
              </p>
            ) : null}
          </div>
        </div>
        <div className="relative mx-auto mt-14 max-w-5xl sm:mt-16">
          <Shot
            src={boardOverview}
            srcSet={`${boardOverview960} 960w, ${boardOverview} 1440w`}
            sizes="(min-width: 1100px) 1024px, 100vw"
            width="1440"
            height="900"
            eager
            alt="The Shapewall board: the pages of a demo product at desktop and phone width, grouped into Marketing, Content, Get started, App and Admin, with numbered comment pins and a comments panel"
          />
          <div className="absolute -bottom-6 -left-3 hidden w-72 rounded-xl border border-line bg-card p-3.5 shadow-xl shadow-black/10 md:block lg:-left-10">
            <p className="flex items-center gap-2 text-[12px] font-semibold text-wall">
              <Bot className="size-4" aria-hidden="true" /> Agent resolved #1
            </p>
            <p className="mt-1.5 text-[13.5px] leading-snug text-ink">The Plus card now uses the primary button. Pricing recaptured.</p>
          </div>
          <div className="absolute -top-5 -right-3 hidden items-center gap-2 rounded-full border border-line bg-card py-1.5 pr-3.5 pl-2 text-[13px] font-medium text-ink shadow-lg shadow-black/10 md:flex lg:-right-8">
            <span className="grid size-6 place-items-center rounded-full bg-pin text-[11px] font-bold text-night">19</span>
            open comments on 26 pages
          </div>
        </div>
      </Container>
    </section>
  )
}

const STEPS = [
  {
    icon: Camera,
    title: 'Capture',
    text: 'Run shapewall capture and every page is shot at desktop and phone width, or any sizes you add, with a live HTML copy you can zoom into.',
    art: <CaptureIllustration />,
  },
  {
    icon: LayoutGrid,
    title: 'See it all on the wall',
    text: 'Pages are laid out in sections. Zoom out to see every page and flow at once, zoom in to read a single button.',
    art: <MapIllustration />,
  },
  {
    icon: MousePointerClick,
    title: 'Point at it, your agent builds it',
    text: 'Click the element and say what should change. Your coding agent edits the code, recaptures the page and resolves the comment.',
    art: (
      <div className="wall-dots flex aspect-[4/3] items-center rounded-2xl p-4 sm:p-5">
        <Shot
          src={liveComment960}
          width="960"
          height="600"
          bar={false}
          alt="Live HTML of a pricing page with a comment pinned to the Try Plus free button"
        />
      </div>
    ),
  },
]

function HowItWorks() {
  return (
    <section className="py-16 sm:py-28" aria-labelledby="how">
      <Container>
        <SectionHead eyebrow="How it works" title={<span id="how">From your site to a wall you can shape, in three steps</span>}>
          Your agent writes the code. You review the result on the wall, across every page and screen size.
        </SectionHead>
        <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-6 lg:gap-8">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              {step.art}
              <div className="mt-6 flex items-center gap-3">
                <span className="grid size-8 place-items-center rounded-lg bg-ink text-[14px] font-bold text-card">{index + 1}</span>
                <h3 className="text-[19px] font-semibold tracking-tight text-ink">{step.title}</h3>
              </div>
              <p className="mt-3 text-[15.5px] leading-7 text-slate">{step.text}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  )
}

const FEATURES = [
  {
    icon: Smartphone,
    title: 'Desktop, tablet and phone',
    text: 'Every page at each width you set, side by side, so a broken phone layout is as obvious as a broken desktop one.',
  },
  {
    icon: ShieldCheck,
    title: 'Live HTML, safely inert',
    text: 'Zoom in and the screenshot becomes the captured page, with text you can select. Three independent safeguards keep it from running code.',
  },
  {
    icon: MapPin,
    title: 'Comments on the element',
    text: 'A pin stores the selector and text of what you clicked, so it follows the button through the next capture.',
  },
  {
    icon: Bot,
    title: 'Works with your agent',
    text: 'Claude Code, Codex or any agent reads comments as JSON or through the MCP server, and watch mode hands it each new one.',
  },
  {
    icon: GitCompare,
    title: 'Before and after, with history',
    text: 'Every recapture keeps the old shot. See a fix around its pin, compare any earlier capture with changed pixels in red, or put staging beside production.',
  },
  {
    icon: FolderOpen,
    title: 'Plain files in your project',
    text: 'Captures and comments are files in .shapewall/. Export a static, read-only copy any host can serve.',
  },
]

function FeatureGrid() {
  return (
    <section className="border-y border-line bg-band py-16 sm:py-28" aria-labelledby="features">
      <Container>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <SectionHead eyebrow="Features" title={<span id="features">From comment to finished change</span>}>
            Every comment carries what an agent needs to build the change, and the wall shows you the result.
          </SectionHead>
          <Link
            to="/features"
            className="inline-flex shrink-0 items-center gap-1.5 text-[15px] font-semibold text-wall hover:text-wall-deep"
          >
            All features <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <ul className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="bg-card p-6">
              <div className="flex items-center justify-between">
                <feature.icon className="size-5 text-wall" aria-hidden="true" />
                {feature.badge ? <Badge tone="amber">{feature.badge}</Badge> : null}
              </div>
              <h3 className="mt-4 text-[16px] font-semibold tracking-tight text-ink">{feature.title}</h3>
              <p className="mt-2 text-[14.5px] leading-6 text-slate">{feature.text}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}

function AgentLoop() {
  const loop = [
    { title: 'You comment', text: 'on the wall, on the exact element, in plain words.' },
    { title: 'The agent fixes it', text: 'using the page, viewport, selector, element text and screenshot.' },
    { title: 'It recaptures', text: 'only the pages it touched.' },
    { title: 'You check', text: 'before and after, in place. Resolve, or reopen with a note.' },
  ]
  return (
    <section className="wall-dots-dark py-16 text-white sm:py-28" aria-labelledby="loop">
      <Container className="grid items-center gap-12 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
        <div>
          <SectionHead dark eyebrow="The agent loop" title={<span id="loop">Your agent does the building. You stay on the wall.</span>}>
            Shapewall works with the coding agent you already use. It hands the agent precise feedback and shows you what changed.
          </SectionHead>
          <ol className="mt-10 space-y-5">
            {loop.map((item, index) => (
              <li key={item.title} className="flex gap-4">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-wall-bright/40 text-[13px] font-bold text-wall-bright">
                  {index + 1}
                </span>
                <p className="pt-1 text-[16px] leading-6 text-zinc-300">
                  <strong className="font-semibold text-white">{item.title}</strong> {item.text}
                </p>
              </li>
            ))}
          </ol>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button to="/docs/agent-workflow" variant="light">
              Read the agent workflow <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <AgentTerminal />
      </Container>
    </section>
  )
}

function Journeys() {
  return (
    <section className="py-16 sm:py-28" aria-labelledby="journeys">
      <Container>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <SectionHead eyebrow="Journeys" title={<span id="journeys">See the flows, not just the pages</span>}>
            Shapewall draws arrows between pages from the real links on them. Name the paths that matter, highlight one, and step through it
            page by page, commenting as you go.
          </SectionHead>
          <Link
            to="/docs/journeys"
            className="inline-flex shrink-0 items-center gap-1.5 text-[15px] font-semibold text-wall hover:text-wall-deep"
          >
            How journeys work <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <div className="mt-12">
          <JourneyIllustration />
        </div>
      </Container>
    </section>
  )
}

function BeforeAfterSection() {
  return (
    <section className="border-y border-line bg-band py-16 sm:py-28" aria-labelledby="before-after">
      <Container className="grid items-center gap-12 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
        <div>
          <SectionHead eyebrow="Before and after" title={<span id="before-after">Every change, checked where you asked for it</span>}>
            A resolved comment keeps the capture it was made on, so you flip between before and after right on the pin. Put staging beside
            production, or a branch preview beside the page it changes.
          </SectionHead>
          <ul className="mt-8 space-y-3 text-[15.5px] text-slate">
            {[
              'Before and after on each resolved comment',
              'Staging next to production, page by page',
              'Variants: try a direction without replacing the page',
            ].map((item) => (
              <li key={item} className="flex gap-3">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-pin" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <BeforeAfter />
      </Container>
    </section>
  )
}

const TEAM_POINTS = [
  {
    icon: KeyRound,
    title: 'Passkey accounts and roles',
    text: 'Everyone signs in with their own passkey. Owners, admins, members and viewers.',
  },
  { icon: Link2, title: 'Share links for clients', text: 'One project, view only or with guest comments, with an expiry and a passcode.' },
  { icon: Radio, title: 'Live presence', text: 'See who is on the wall, follow their cursor, comment together.' },
  {
    icon: Bot,
    title: 'Agents on the shared wall',
    text: 'A project token lets your agent read, reply to and resolve the shared comments.',
  },
]

function Teams() {
  return (
    <section className="py-16 sm:py-28" aria-labelledby="teams">
      <Container className="grid gap-12 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
        <div>
          <SectionHead
            eyebrow="Teams"
            title={
              <>
                <span id="teams">One wall for the whole team, on your own server</span>{' '}
                <span className="align-middle">
                  <Badge tone="amber">Beta</Badge>
                </span>
              </>
            }
          >
            Run <code>shapewall hosted</code> on a machine you control and your team shares one wall. Captures upload from your computers to
            your server.
          </SectionHead>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button to="/features#teams" variant="secondary">
              <Users className="size-4" aria-hidden="true" /> How teams work
            </Button>
            <Button to="/docs/hosted" variant="ghost">
              Team server guide <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <dl className="grid gap-x-8 gap-y-8 sm:grid-cols-2">
          {TEAM_POINTS.map((point) => (
            <div key={point.title}>
              <dt className="flex items-center gap-2.5 text-[15.5px] font-semibold text-ink">
                <point.icon className="size-[18px] text-wall" aria-hidden="true" />
                {point.title}
              </dt>
              <dd className="mt-2 text-[14.5px] leading-6 text-slate">{point.text}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  )
}

function OpenSourceSection() {
  return (
    <section className="border-t border-line py-16 sm:py-28" aria-labelledby="open-source">
      <Container className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHead eyebrow="Licenses and self-hosting" title={<span id="open-source">Your pages stay on machines you control</span>}>
            Captures, comments and journeys are files in your project, or on the team server you run. {LICENSE_SUMMARY}
          </SectionHead>
          <dl className="mt-10 grid gap-6 sm:grid-cols-2">
            {[
              ['No account', 'Nothing to sign up for. No telemetry.'],
              ['Local by default', 'The board listens on 127.0.0.1 and checks the Host header.'],
              ['Share safely', 'Pair your own devices, host the team server, or export a read-only copy.'],
              ['Hackable', 'Built on Node.js, Playwright, Express and React Flow, with plain JSON data.'],
            ].map(([term, text]) => (
              <div key={term}>
                <dt className="text-[15px] font-semibold text-ink">{term}</dt>
                <dd className="mt-1 text-[14.5px] leading-6 text-slate">{text}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button to="/open-source" variant="secondary">
              Licenses and self-hosting <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="self-center overflow-hidden rounded-2xl bg-night text-[13.5px] leading-7 ring-1 ring-code-edge shadow-xl shadow-black/10">
          <div className="flex items-center gap-1.5 border-b border-night-line px-4 py-2.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="ml-2 font-sans text-[12px] text-zinc-500">Terminal</span>
          </div>
          <pre className="overflow-x-auto px-5 py-4 font-mono text-zinc-300">
            <code>
              <span className="text-zinc-500"># in your project, with your dev server running</span>
              {'\n'}
              <span className="text-wall-bright">$</span> shapewall init --base-url http://localhost:3000
              {'\n'}
              <span className="text-wall-bright">$</span> shapewall capture
              {'\n'}
              <span className="text-zinc-500">Capturing 7 pages (14 shots) from http://localhost:3000</span>
              {'\n'}
              <span className="text-zinc-500"> ok home desktop 1840 ms</span>
              {'\n'}
              <span className="text-zinc-500"> ok home phone 1215 ms</span>
              {'\n'}
              <span className="text-zinc-500"> ...</span>
              {'\n'}
              <span className="text-wall-bright">$</span> shapewall serve
              {'\n'}
              <span className="text-zinc-500">Shapewall is serving 1 board at http://127.0.0.1:4600/</span>
            </code>
          </pre>
        </div>
      </Container>
    </section>
  )
}

function FaqSection() {
  return (
    <section className="border-y border-line bg-band py-16 sm:py-28" aria-labelledby="faq">
      <Container className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
        <SectionHead eyebrow="FAQ" title={<span id="faq">Frequently asked questions</span>}>
          More in the{' '}
          <Link to="/docs/faq" className="font-semibold text-wall hover:text-wall-deep">
            docs FAQ
          </Link>
          .
        </SectionHead>
        <Faq />
      </Container>
    </section>
  )
}

export function FinalCta() {
  return (
    <section className="wall-dots-dark py-20 text-white sm:py-24">
      <Container className="flex flex-col items-center text-center">
        <h2 className="max-w-2xl text-[30px] leading-tight font-bold tracking-[-0.02em] text-balance sm:text-[42px]">
          Put your product on the wall.
        </h2>
        <p className="mt-4 max-w-xl text-[17px] leading-7 text-zinc-400">
          {LAUNCHED
            ? 'Install it in your project, or try the live demo first.'
            : 'Try the live demo: the wall, the comments and the team console run in your browser.'}
        </p>
        <div className="mt-8 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
          <GetStarted where="footer-cta" variant="light" />
          <InstallCommand dark where="footer-cta" className="sm:w-[30rem]" />
        </div>
      </Container>
    </section>
  )
}
