import { useId, useState } from 'react'
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
  Play,
  Radio,
  ShieldCheck,
  Smartphone,
  Users,
} from 'lucide-react'
import { Badge, Button, Container, GetStarted, LiveDemo, Quickstart, SectionHead, Shot } from '../components/ui.jsx'
import { BeforeAfter, CaptureIllustration, JourneyIllustration, MapIllustration } from '../components/illustrations.jsx'
import { AgentTerminal } from '../components/terminal.jsx'
import { Reveal, stagger } from '../components/motion.jsx'
import { Faq } from '../components/faq.jsx'
import { FilmOverlay } from '../components/video.jsx'
import { FILMS, MEDIA, clock } from '../videos.js'
import { LAUNCHED, LICENSE_SUMMARY } from '../launch.js'
import { DEMO_APP, HERO_FILM, HERO_NOTES } from '../demo.js'
import boardOverview960 from '../assets/shots/board-overview-960.webp'
import boardOverview1440 from '../assets/shots/board-overview-1440.webp'
import boardOverview2048 from '../assets/shots/board-overview-2048.webp'
import liveComment960 from '../assets/shots/live-comment-960.webp'
import liveComment1440 from '../assets/shots/live-comment-1440.webp'

export default function Home() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <Journeys />
      <AgentLoop />
      <FeatureGrid />
      <BeforeAfterSection />
      <Teams />
      <OpenSourceSection />
      <FaqSection />
      <FinalCta />
    </>
  )
}

function Hero() {
  // The narrated tour plays in the hero screenshot's own window (below its title bar), so the page never moves. The
  // screenshot stays the poster and the largest paint; the film loads only after a button is pressed. Every control that
  // starts it is described by the same line: narrated, with English subtitles (the player's captions button turns them on).
  // Which film, and the notes over the screenshot, live in src/demo.js so new media only changes that file.
  const [filmPlaying, setFilmPlaying] = useState(false)
  const [filmRequest, setFilmRequest] = useState(0)
  const watchFilm = () => setFilmRequest((n) => n + 1)
  const filmClock = clock(MEDIA[HERO_FILM].duration)
  const filmLabel = `Watch the tour, ${filmClock}, with sound`
  const filmNote = useId()
  return (
    <section className="relative overflow-hidden">
      <div
        className="wall-dots absolute inset-x-0 top-0 h-[560px] [mask-image:linear-gradient(to_bottom,black_40%,transparent)]"
        aria-hidden="true"
      />
      {/* Phone: the headline, then the wall, then the words and buttons, so the product shows on the first screen. From sm up
          the wall follows the buttons. One DOM order (headline, words, wall, notes); only the phone reorders. */}
      <Container className="relative flex flex-col pt-10 pb-8 sm:pt-12 lg:pt-14">
        <div className="order-1 mx-auto max-w-4xl text-center">
          <p className="inline-flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-3 pl-1 text-[13px] font-medium text-slate shadow-sm shadow-black/[0.03]">
            <Badge>{LAUNCHED ? 'Free & local-first' : 'Private early access'}</Badge>
            For building with coding agents
          </p>
          <h1 className="mt-6 text-[40px] leading-[1.04] font-extrabold tracking-[-0.035em] text-balance text-ink sm:text-6xl lg:text-[68px]">
            See your whole app. <span className="text-wall">Steer your agents from it.</span>
          </h1>
        </div>
        <div className="order-3 mx-auto max-w-3xl text-center sm:order-2">
          <p className="mx-auto mt-8 max-w-2xl text-[17px] leading-7 text-pretty text-slate sm:mt-6 sm:text-[19px] sm:leading-8">
            Coding agents read your code, not your screens. Shapewall captures every screen of your app on desktop and phone, maps the flows
            between them, and lets you point at anything and tell your agent what to build. 10 screens or 500.
          </p>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-6 text-pretty text-ink">
            {LAUNCHED ? 'Free to use. ' : ''}Start alone on your machine, invite people when you are ready, or host the team server
            yourself.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <GetStarted where="hero" />
            <LiveDemo where="hero" label="Try the live demo" />
            <span className="hidden sm:contents">
              <Button
                variant="ghost"
                size="lg"
                onClick={watchFilm}
                data-film-link="desktop"
                aria-label={filmLabel}
                aria-describedby={filmNote}
              >
                <Play className="size-4" aria-hidden="true" /> Watch the tour
                <span className="font-medium text-faint tabular-nums">{filmClock}</span>
              </Button>
            </span>
          </div>
          <button
            type="button"
            onClick={watchFilm}
            data-film-link="phone"
            aria-label={filmLabel}
            aria-describedby={filmNote}
            className="mx-auto mt-4 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[14.5px] font-medium text-slate underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-wall sm:hidden"
          >
            <Play className="size-3.5" aria-hidden="true" /> Watch the tour
            <span className="text-faint tabular-nums">{filmClock}</span>
          </button>
          <span id={filmNote} className="sr-only">
            Narrated, with English subtitles.
          </span>
        </div>
        <div className="relative order-2 mx-auto mt-8 w-full max-w-5xl sm:order-3 sm:mt-10">
          <Shot
            src={boardOverview1440}
            srcSet={`${boardOverview960} 960w, ${boardOverview1440} 1440w, ${boardOverview2048} 2048w`}
            sizes="(min-width: 1100px) 1024px, 100vw"
            width="1440"
            height="900"
            eager
            className="hero-rise"
            alt="The Shapewall wall: all 146 screens of a demo app, grouped into sections such as Marketing, Work orders, Invoices and Technician app, with instruction pins"
          >
            <FilmOverlay
              id={HERO_FILM}
              title={FILMS[HERO_FILM].name}
              cta="Watch the tour"
              describedBy={filmNote}
              inset="inset-x-0 top-7 bottom-0"
              onActiveChange={setFilmPlaying}
              playRequest={filmRequest}
            />
          </Shot>
          <div
            hidden={filmPlaying}
            className="hero-note absolute -bottom-6 -left-3 hidden w-72 rounded-xl border border-line bg-card p-3.5 shadow-xl shadow-black/10 md:block lg:-left-10"
          >
            <p className="flex items-center gap-2 text-[12px] font-semibold text-wall">
              <Bot className="size-4" aria-hidden="true" /> {HERO_NOTES.resolved.title}
            </p>
            <p className="mt-1.5 text-[13.5px] leading-snug text-ink">{HERO_NOTES.resolved.text}</p>
          </div>
          <div
            hidden={filmPlaying}
            className="hero-note absolute -top-5 -right-3 hidden items-center gap-2 rounded-full border border-line bg-card py-1.5 pr-3.5 pl-2 text-[13px] font-medium text-ink shadow-lg shadow-black/10 md:flex lg:-right-8"
          >
            <span className="grid size-6 place-items-center rounded-full bg-pin text-[11px] font-bold text-night">
              {HERO_NOTES.open.count}
            </span>
            {HERO_NOTES.open.text}
          </div>
        </div>
        <div className="order-4 mx-auto mt-14 max-w-3xl text-center">
          <p className="text-[13.5px] text-pretty text-slate">
            The live demo is {DEMO_APP} on the wall, with comments, the agent chat and the team console, in your browser.
          </p>
          <div className="mt-6 flex flex-col items-center gap-2">
            <Quickstart where="hero" />
            {LAUNCHED ? (
              <p className="text-[13px] text-faint">
                Needs Node.js 22.19 or newer.{' '}
                <Link to="/docs/getting-started#install" className="font-medium text-wall hover:text-wall-deep">
                  Install steps
                </Link>
              </p>
            ) : null}
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
    text: 'Run shapewall capture and every screen of your app is shot at desktop and phone width, or any sizes you add, with a live HTML copy you can zoom into.',
    art: <CaptureIllustration />,
  },
  {
    icon: LayoutGrid,
    title: 'See the whole app and its flows',
    text: 'Screens are laid out in sections, with arrows for the flows between them. Zoom out to see 10 screens or 500 at once, zoom in to read a single button.',
    art: <MapIllustration />,
  },
  {
    icon: MousePointerClick,
    title: 'Point at it, your agent builds it',
    text: 'Click anything and say what to build or change. The comment is an instruction: your coding agent edits the code, recaptures the screen and reports back.',
    art: (
      <div className="wall-dots flex aspect-[4/3] items-center rounded-2xl p-4 sm:p-5">
        <Shot
          src={liveComment960}
          srcSet={`${liveComment960} 960w, ${liveComment1440} 1440w`}
          sizes="(min-width: 768px) 360px, 100vw"
          width="1440"
          height="900"
          bar={false}
          alt="Live HTML of a pricing page with a new instruction on the Growth plan's Start free trial button: the comment box holds image and drawing tools, a microphone and Post"
        />
      </div>
    ),
  },
]

function HowItWorks() {
  return (
    <section className="py-16 sm:py-28" aria-labelledby="how">
      <Container>
        <SectionHead eyebrow="How it works" title={<span id="how">From a running app to one wall in three steps</span>}>
          Stop describing UI changes in prose or clicking through thirty routes to see what broke. Put every screen in front of you and work
          straight from the app you ship.
        </SectionHead>
        <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-6 lg:gap-8">
          {STEPS.map((step, index) => (
            <Reveal as="li" key={step.title} delay={stagger(index)}>
              {step.art}
              <div className="mt-6 flex items-center gap-3">
                <span className="grid size-8 place-items-center rounded-lg bg-ink text-[14px] font-bold text-card">{index + 1}</span>
                <h3 className="text-[19px] font-semibold tracking-tight text-ink">{step.title}</h3>
              </div>
              <p className="mt-3 text-[15.5px] leading-7 text-slate">{step.text}</p>
            </Reveal>
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
    text: 'Every screen at each width you set, side by side, so a broken phone layout is as obvious as a broken desktop one.',
  },
  {
    icon: ShieldCheck,
    title: 'Live HTML, safely inert',
    text: 'Zoom in and the screenshot becomes the captured page, with text you can select. Three independent safeguards keep it from running code.',
  },
  {
    icon: MapPin,
    title: 'Comments are instructions',
    text: 'A pin stores the selector and text of what you clicked, so it follows the element through the next capture. Type, dictate, attach images or draw on the screen.',
  },
  {
    icon: Bot,
    title: 'Works with your agent',
    text: 'Claude Code, Codex or any agent reads comments as JSON or through the MCP server, and shapewall watch hands it each new one.',
  },
  {
    icon: GitCompare,
    title: 'Before and after, with history',
    text: 'Every recapture keeps the old shot. See a change around its pin, compare any earlier capture with changed pixels in red, or put staging beside production and comment on either side.',
  },
  {
    icon: FolderOpen,
    title: 'Everything in your project',
    text: 'Captures and comments stay in .shapewall/ in your project, with no account to make. Export a static, read-only copy any host can serve.',
  },
]

function FeatureGrid() {
  return (
    <section className="border-y border-line bg-band py-16 sm:py-28" aria-labelledby="features">
      <Container>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <SectionHead eyebrow="Features" title={<span id="features">Built for apps with a lot of screens</span>}>
            Every comment carries what an agent needs to build the change, and the wall shows you the result on every screen.
          </SectionHead>
          <Link
            to="/features"
            className="inline-flex shrink-0 items-center gap-1.5 text-[15px] font-semibold text-wall hover:text-wall-deep"
          >
            All features <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <Reveal as="ul" className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
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
        </Reveal>
      </Container>
    </section>
  )
}

function AgentLoop() {
  const loop = [
    { title: 'You point', text: 'at the exact element on the wall and say what to build, in plain words.' },
    {
      title: 'Your agent gets the full context:',
      text: 'screen, viewport, CSS selector, element text, screenshot and any drawings or attached images.',
    },
    { title: 'It builds and recaptures', text: 'only the screens it touched, then replies on the thread with what changed.' },
    { title: 'You verify in place', text: 'with before and after. Resolve it, or reopen it with the next instruction.' },
  ]
  return (
    <section className="wall-dots-dark py-16 text-white sm:py-28" aria-labelledby="loop">
      <Container className="grid items-center gap-12 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
        <div>
          <SectionHead dark eyebrow="Steer your agents" title={<span id="loop">Your agents write the code. You steer from the wall.</span>}>
            Bring the coding agent you already use. <code>shapewall watch</code> hands it each new instruction, and{' '}
            <code>shapewall mcp</code> gives it the same workflow over MCP.
          </SectionHead>
          <ol className="mt-10 space-y-5">
            {loop.map((item, index) => (
              <Reveal as="li" key={item.title} className="flex gap-4" delay={stagger(index)}>
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-wall-bright/40 text-[13px] font-bold text-wall-bright">
                  {index + 1}
                </span>
                <p className="pt-1 text-[16px] leading-6 text-zinc-300">
                  <strong className="font-semibold text-white">{item.title}</strong> {item.text}
                </p>
              </Reveal>
            ))}
          </ol>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button to="/docs/agent-workflow" variant="light">
              Read the agent workflow <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <Reveal className="min-w-0">
          <AgentTerminal />
        </Reveal>
      </Container>
    </section>
  )
}

function Journeys() {
  return (
    <section className="py-16 sm:py-28" aria-labelledby="journeys">
      <Container>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <SectionHead eyebrow="Journeys" title={<span id="journeys">See the flows, not just the screens</span>}>
            Shapewall draws arrows between screens from the real links in your app. Name the flows that matter, such as sign up to first
            project, highlight one, and step through it screen by screen, telling your agent what to change as you go.
          </SectionHead>
          <Link
            to="/docs/journeys"
            className="inline-flex shrink-0 items-center gap-1.5 text-[15px] font-semibold text-wall hover:text-wall-deep"
          >
            How journeys work <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <Reveal className="mt-12">
          <JourneyIllustration />
        </Reveal>
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
            production, or a branch preview beside the screen it changes.
          </SectionHead>
          <ul className="mt-8 space-y-3 text-[15.5px] text-slate">
            {[
              'Before and after on every resolved wall comment',
              'Staging beside production, screen by screen, with changed pixels in red',
              'Branch variants: try a direction beside the screen instead of replacing it',
              'One GitHub PR summary per pull request, with every screen that changed',
            ].map((item) => (
              <li key={item} className="flex gap-3">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-pin" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <Reveal className="min-w-0">
          <BeforeAfter />
        </Reveal>
      </Container>
    </section>
  )
}

const TEAM_POINTS = [
  {
    icon: KeyRound,
    title: 'Passkey accounts and roles',
    text: 'Each person signs in with their own passkey, or, on your tailnet, just their tailnet login. Four roles: owner, admin, member and viewer.',
  },
  {
    icon: Link2,
    title: 'Expiring share links',
    text: 'Share one project read-only, or with guest comments, with an expiry date and an optional passcode.',
  },
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
                <span id="teams">Start alone, invite when ready</span>{' '}
                <span className="align-middle">
                  <Badge tone="amber">Beta</Badge>
                </span>
              </>
            }
          >
            <code>shapewall serve</code> is your board, on your machine. When people should see it, <code>shapewall serve --team</code>{' '}
            invites them over your tailnet to the same board, with nothing copied. When the wall should stay on, run{' '}
            <code>shapewall hosted</code> on a machine you control and the whole team steers its agents from it.
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
          {TEAM_POINTS.map((point, index) => (
            <Reveal key={point.title} delay={stagger(index)}>
              <dt className="flex items-center gap-2.5 text-[15.5px] font-semibold text-ink">
                <point.icon className="size-[18px] text-wall" aria-hidden="true" />
                {point.title}
              </dt>
              <dd className="mt-2 text-[14.5px] leading-6 text-slate">{point.text}</dd>
            </Reveal>
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
          <SectionHead eyebrow="Licenses and self-hosting" title={<span id="open-source">Your screens stay on machines you control</span>}>
            Captures, comments and journeys are files in your project, or on the team server you run. {LICENSE_SUMMARY}
          </SectionHead>
          <dl className="mt-10 grid gap-6 sm:grid-cols-2">
            {[
              ['No account', 'Nothing to sign up for. No telemetry.'],
              ['Local by default', 'The board listens on 127.0.0.1 and checks the Host header.'],
              ['Share safely', 'Invite people over your tailnet, host the team server, or export a read-only copy.'],
              ['Hackable', 'Built on Node.js, Playwright, Express, SQLite and React Flow.'],
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
            <span className="ml-2 font-sans text-[12px] text-zinc-400">Terminal</span>
          </div>
          <pre tabIndex={0} aria-label="Quickstart in a terminal" className="overflow-x-auto px-5 py-4 font-mono text-zinc-300">
            <code>
              <span className="text-zinc-400"># in your app&apos;s folder, with the app running</span>
              {'\n'}
              <span className="text-wall-bright">$</span> npx shapewall init --base-url http://localhost:3000
              {'\n'}
              <span className="text-wall-bright">$</span> npx shapewall capture
              {'\n'}
              <span className="text-zinc-400">Capturing 7 pages (14 shots) from http://localhost:3000</span>
              {'\n'}
              <span className="text-zinc-400"> ok home desktop 1840 ms</span>
              {'\n'}
              <span className="text-zinc-400"> ok home phone 1215 ms</span>
              {'\n'}
              <span className="text-zinc-400"> ...</span>
              {'\n'}
              <span className="text-wall-bright">$</span> npx shapewall serve
              {'\n'}
              <span className="text-zinc-400">
                Shapewall is serving 1 board at http://lumen-notes-k3x7q2mvw9a4bd.shapewall.localhost:4600 (the solo engine)
              </span>
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
        <div>
          <SectionHead eyebrow="FAQ" title={<span id="faq">Frequently asked questions</span>}>
            More in the{' '}
            <Link to="/docs/faq" className="font-semibold text-wall hover:text-wall-deep">
              docs FAQ
            </Link>
            .
          </SectionHead>
          <p className="mt-4 text-[17px] leading-7 text-slate">
            <Link to="/contact" className="font-semibold text-wall hover:text-wall-deep">
              Questions or feature requests? Contact us
            </Link>
          </p>
        </div>
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
          Put your whole app on the wall.
        </h2>
        <p className="mt-4 max-w-xl text-[17px] leading-7 text-zinc-400">
          {LAUNCHED
            ? 'Four commands in your app\u2019s folder, or try the live demo first.'
            : 'Try the live demo: the wall, the comments and the team console run in your browser.'}
        </p>
        <div className="mt-8 flex w-full flex-col items-center gap-6">
          <Quickstart dark where="footer-cta" />
          <div className="flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
            <GetStarted where="footer-cta" variant="light" />
            <LiveDemo where="footer-cta" variant="ghost-dark" label="Try the live demo" />
          </div>
        </div>
      </Container>
    </section>
  )
}
