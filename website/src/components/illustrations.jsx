// Product pictures built from real captures of the bundled demo site (src/assets/shots, made by
// scripts/imagery.mjs). Labels are HTML, never baked into the images.
import { useState } from 'react'
import {
  ArrowRight,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitMerge,
  GitPullRequest,
  Hash,
  Mail,
  MessageSquare,
  Webhook,
} from 'lucide-react'
import { IconButton, ToggleGroup, cx } from './ui.jsx'
import home from '../assets/shots/page-home.webp'
import pricing from '../assets/shots/page-pricing.webp'
import login from '../assets/shots/page-login.webp'
import dashboard from '../assets/shots/page-dashboard.webp'
import homePhone from '../assets/shots/page-home-phone.webp'
import pricingPhone from '../assets/shots/page-pricing-phone.webp'
import before from '../assets/shots/before.webp'
import after from '../assets/shots/after.webp'
import pricingV2 from '../assets/shots/page-pricing-v2.webp'

function Tile({ src, label, phone = false, className, highlight = false, dim = false, crop = false }) {
  return (
    <figure
      className={cx(
        'overflow-hidden rounded-lg border bg-card transition-all duration-300',
        highlight ? 'border-pin shadow-[0_0_0_3px_rgb(245_158_11_/_0.35)]' : 'border-edge shadow-sm',
        dim && 'opacity-45',
        className,
      )}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        width={phone ? 300 : 640}
        height={phone ? 649 : 489}
        className={crop ? 'block aspect-[16/10] w-full object-cover object-top' : 'block h-auto w-full'}
      />
      {label ? (
        <figcaption className="border-t border-hairline px-2.5 py-1.5 text-[12px] font-medium text-slate">{label}</figcaption>
      ) : null}
    </figure>
  )
}

// Step 1: one page, captured at desktop and phone width.
export function CaptureIllustration() {
  return (
    <div className="wall-dots flex aspect-[4/3] items-end justify-center gap-3 rounded-2xl p-5 sm:p-6">
      <Tile src={home} label="Home · desktop" className="w-[68%]" />
      <Tile src={homePhone} label="Phone" phone className="w-[24%]" />
    </div>
  )
}

// Step 2: the whole product, grouped into sections.
export function MapIllustration() {
  const group = (title, children) => (
    <div className="rounded-xl border border-wall/25 bg-wall/[0.06] p-2.5">
      <p className="px-0.5 pb-2 text-[11.5px] font-semibold text-wall">{title}</p>
      <div className="grid gap-2">{children}</div>
    </div>
  )
  return (
    <div className="wall-dots grid aspect-[4/3] grid-cols-2 content-center items-center gap-3 overflow-hidden rounded-2xl p-5 sm:p-6">
      {group(
        'Marketing',
        <>
          <Tile src={home} crop />
          <Tile src={pricing} crop highlight />
        </>,
      )}
      {group(
        'App',
        <>
          <Tile src={login} crop />
          <Tile src={dashboard} crop />
        </>,
      )}
    </div>
  )
}

// Journeys: a named path through real pages, stepped through one page at a time.
const STEPS = [
  { src: home, title: 'Home', link: 'Start free' },
  { src: pricing, title: 'Pricing', link: 'Try Plus free' },
  { src: login, title: 'Sign in', link: 'Continue' },
  { src: dashboard, title: 'Dashboard', link: null },
]

export function JourneyIllustration() {
  const [step, setStep] = useState(1)
  const last = STEPS.length - 1
  return (
    <div className="wall-dots-dark rounded-2xl border border-night-line p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-pin" aria-hidden="true" />
          <p className="text-[14px] font-semibold text-white">Journey: visitor to first note</p>
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton
            variant="outline-dark"
            onClick={() => setStep((value) => Math.max(0, value - 1))}
            disabled={step === 0}
            label="Previous step"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </IconButton>
          <span className="min-w-14 text-center text-[13px] text-zinc-400 tabular-nums" aria-live="polite">
            Step {step + 1} of {STEPS.length}
          </span>
          <IconButton
            variant="outline-dark"
            onClick={() => setStep((value) => Math.min(last, value + 1))}
            disabled={step === last}
            label="Next step"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <ol className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] sm:items-center sm:gap-2">
        {STEPS.map((item, index) => (
          <li key={item.title} className="contents">
            <button
              type="button"
              onClick={() => setStep(index)}
              className="group block text-left"
              aria-current={index === step ? 'step' : undefined}
            >
              <span className="mb-1.5 flex items-center gap-2 text-[12px] font-medium whitespace-nowrap text-zinc-400">
                <span
                  className={cx(
                    'grid size-5 place-items-center rounded-full text-[11px] font-bold',
                    index === step ? 'bg-pin text-night' : 'bg-white/10 text-zinc-300',
                  )}
                >
                  {index + 1}
                </span>
                {item.title}
              </span>
              <Tile src={item.src} highlight={index === step} dim={index !== step} />
            </button>
            {index < last ? (
              <span
                className={cx(
                  'hidden items-center justify-center gap-1.5 text-[11px] font-medium sm:flex sm:flex-col sm:pt-6',
                  index < step ? 'text-pin' : 'text-zinc-500',
                )}
                aria-hidden="true"
              >
                <ArrowRight className="size-4" />
                <span className="max-w-20 truncate sm:text-center">{item.link}</span>
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

// Before and after on a resolved comment.
export function BeforeAfter() {
  const [view, setView] = useState('after')
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-[0_12px_32px_-12px_rgb(15_40_38_/_0.22)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-wall text-[12px] font-bold text-on-wall">1</span>
          <div className="min-w-0">
            <p className="text-[14.5px] leading-snug text-ink">Make the Plus button stand out more. Maybe show the yearly price too?</p>
            <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-wall">
              <Check className="size-3.5" aria-hidden="true" /> Resolved: bolder Plus card, yearly billing switch
            </p>
          </div>
        </div>
        <ToggleGroup
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { id: 'before', label: 'Before' },
            { id: 'after', label: 'After' },
          ]}
        />
      </div>
      <div className="relative">
        <img
          src={before}
          alt="The pricing page before the change"
          width="960"
          height="600"
          loading="lazy"
          className="block h-auto w-full"
        />
        <img
          src={after}
          alt="The pricing page after the change: a yearly switch and a highlighted Plus card"
          width="960"
          height="600"
          loading="lazy"
          className={cx(
            'absolute inset-0 block h-auto w-full transition-opacity duration-300',
            view === 'after' ? 'opacity-100' : 'opacity-0',
          )}
        />
        <span className="absolute top-3 left-3 rounded-md bg-zinc-900/80 px-2 py-1 text-[11px] font-semibold tracking-wide text-white uppercase">
          {view}
        </span>
      </div>
    </div>
  )
}

// Staging beside production.
export function CompareIllustration() {
  return (
    <div className="wall-dots grid grid-cols-2 gap-3 rounded-2xl p-4 sm:gap-4 sm:p-6">
      {[
        { label: 'Production', src: pricing, tone: 'bg-sunk-3 text-slate' },
        { label: 'Staging', src: pricingV2, tone: 'bg-pin text-night' },
      ].map((side) => (
        <div key={side.label}>
          <span className={cx('mb-2 inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase', side.tone)}>
            {side.label}
          </span>
          <Tile src={side.src} />
        </div>
      ))}
      <div className="col-span-2 flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-[13px] text-slate">
        <MessageSquare className="size-4 shrink-0 text-wall" aria-hidden="true" />
        <span className="min-w-0 truncate">Pricing differs: yearly switch and new Plus card on staging only</span>
      </div>
    </div>
  )
}

export function PhonePair() {
  return (
    <div className="flex justify-center gap-3">
      <Tile src={homePhone} phone className="w-36 sm:w-40" />
      <Tile src={pricingPhone} phone className="w-36 sm:w-40" />
    </div>
  )
}

// GitHub connect: a comment becomes an issue, a pull request names it, the merge resolves it.
export function GithubIllustration() {
  const steps = [
    { icon: MessageSquare, tone: 'text-pin-ink', title: 'Comment #12 on Pricing', text: 'Make the Plus button stand out more.' },
    { icon: CircleDot, tone: 'text-wall', title: 'Issue #45 opened', text: 'Comment text, page, element and a screenshot crop.' },
    { icon: GitPullRequest, tone: 'text-wall', title: 'Pull request #46', text: 'Its description says shapewall:12.' },
    { icon: GitMerge, tone: 'text-merged', title: 'Merged', text: 'Comment #12 resolved, with the PR as its fix.' },
  ]
  return (
    <div className="wall-dots rounded-2xl p-4 sm:p-6">
      <ol className="space-y-3">
        {steps.map((step) => (
          <li
            key={step.title}
            className="flex items-start gap-3 rounded-xl border border-line bg-card px-4 py-3 shadow-sm shadow-black/[0.03]"
          >
            <step.icon className={cx('mt-0.5 size-4.5 shrink-0', step.tone)} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[14.5px] font-semibold text-ink">{step.title}</p>
              <p className="mt-0.5 text-[13.5px] leading-5 text-slate">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

// Notifications: one comment event, fanned out to the channels a board has.
export function NotifyIllustration() {
  const channels = [
    { icon: Hash, name: 'Slack', text: 'Robin commented on Pricing (desktop)' },
    { icon: MessageSquare, name: 'Discord', text: 'Comment #12 resolved' },
    { icon: Mail, name: 'Email', text: '@sam, you were mentioned on Pricing' },
    { icon: Webhook, name: 'Webhook', text: 'comment.created, signed with HMAC-SHA256' },
  ]
  return (
    <div className="wall-dots rounded-2xl p-4 sm:p-6">
      <div className="flex items-center gap-2 rounded-xl border border-pin/60 bg-card px-4 py-3 text-[14px] font-semibold text-ink shadow-sm">
        <Bell className="size-4.5 shrink-0 text-pin-ink" aria-hidden="true" /> A comment changes
      </div>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {channels.map((channel) => (
          <li key={channel.name} className="rounded-xl border border-line bg-card px-4 py-3 shadow-sm shadow-black/[0.03]">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-wall">
              <channel.icon className="size-4 shrink-0" aria-hidden="true" /> {channel.name}
            </p>
            <p className="mt-1 text-[13.5px] leading-5 text-slate">{channel.text}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
