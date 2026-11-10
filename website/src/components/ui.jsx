import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Copy, MousePointerClick } from 'lucide-react'
import { track } from '../analytics.js'
import { DEMO_URL } from '../routes.js'
import { ACCESS_LABEL, INSTALL_COMMAND } from '../launch.js'

export const cx = (...parts) => parts.filter(Boolean).join(' ')

// Buttons share one set of variants and sizes, the same names as the board's
// kit (client/src/components/ui/button.jsx) in the site's brand colours. No
// class merging here, so each variant carries its own radius.
const BUTTON_VARIANTS = {
  primary: 'rounded-xl bg-wall text-white shadow-sm shadow-wall/20 hover:bg-wall-deep',
  secondary: 'rounded-xl border border-line bg-white text-ink hover:border-zinc-300 hover:bg-zinc-50',
  'ghost-dark': 'rounded-xl border border-white/15 bg-white/5 text-white hover:bg-white/10',
  light: 'rounded-xl bg-white text-ink hover:bg-zinc-100',
  ghost: 'rounded-xl text-ink hover:bg-black/5',
  quiet: 'rounded-lg text-faint hover:bg-zinc-100 hover:text-ink',
  'quiet-dark': 'rounded-lg text-zinc-400 hover:bg-white/10 hover:text-white',
  'outline-dark': 'rounded-lg border border-white/15 text-zinc-300 hover:bg-white/10',
}
const BUTTON_SIZES = {
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-[15px]',
  icon: 'size-10',
  'icon-sm': 'size-9',
  'icon-lg': 'size-11',
}

export function buttonClass({ variant = 'primary', size = 'md', className } = {}) {
  return cx(
    'inline-flex shrink-0 items-center justify-center gap-2 font-semibold transition-colors select-none disabled:pointer-events-none disabled:opacity-35',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className,
  )
}

// A router link (`to`), a link (`href`) or, with neither, a button.
export function Button({ to, href, variant = 'primary', size = 'md', className, children, onClick, type = 'button', ...rest }) {
  const styles = buttonClass({ variant, size, className })
  if (!to && !href)
    return (
      <button type={type} className={styles} onClick={onClick} {...rest}>
        {children}
      </button>
    )
  if (to)
    return (
      <Link to={to} className={styles} onClick={onClick} {...rest}>
        {children}
      </Link>
    )
  return (
    <a href={href} className={styles} onClick={onClick} {...rest}>
      {children}
    </a>
  )
}

// An icon-only button: `label` is its accessible name.
export function IconButton({ label, variant = 'quiet', size = 'icon-sm', children, ...rest }) {
  return (
    <Button variant={variant} size={size} aria-label={label} {...rest}>
      {children}
    </Button>
  )
}

// One choice out of a few (the board kit's ToggleGroup). options: [{ id, label }]
export function ToggleGroup({ label, options, value, onChange, className }) {
  return (
    <div
      className={cx('flex rounded-lg border border-line bg-zinc-50 p-0.5 text-[13px] font-medium', className)}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={cx(
            'h-8 rounded-md px-3 transition-colors',
            value === option.id ? 'bg-white text-ink shadow-sm' : 'text-slate hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function GetStarted({ where, size = 'lg', variant = 'primary', label = 'Get started' }) {
  return (
    <Button to="/docs/getting-started" size={size} variant={variant} onClick={() => track('get-started', { where })}>
      {label}
      <ArrowRight className="size-4" aria-hidden="true" />
    </Button>
  )
}

// The live demo is a separate static app, so a full page load, not a router link.
export function LiveDemo({ where, size = 'lg', variant = 'secondary', label = 'Live demo' }) {
  return (
    <Button href={DEMO_URL} size={size} variant={variant} onClick={() => track('live-demo', { where })}>
      <MousePointerClick className="size-[18px]" aria-hidden="true" /> {label}
    </Button>
  )
}

// The install command, selectable and copyable. Before launch (no command yet) it is the one place besides the hero
// badge that says the repository is invite only.
export function InstallCommand({ dark = false, where, command = INSTALL_COMMAND, className }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1800)
      track('copy-install-command', { where })
    } catch {
      // Clipboard blocked: the text is still selectable.
    }
  }
  if (!command)
    return (
      <div
        className={cx(
          'w-full max-w-sm rounded-xl border p-4 text-left',
          dark ? 'border-white/15 bg-white/5' : 'border-line bg-white',
          className,
        )}
      >
        <p className={cx('text-[14px] font-semibold', dark ? 'text-white' : 'text-ink')}>{ACCESS_LABEL}</p>
        <p className={cx('mt-1 text-[13px] leading-6', dark ? 'text-zinc-400' : 'text-slate')}>
          The repository is invite only until launch. The install steps work for invited GitHub accounts.
        </p>
        <Link
          to="/docs/getting-started#install"
          className={cx('mt-2 inline-flex min-h-11 items-center gap-2 text-[14px] font-semibold', dark ? 'text-wall-bright' : 'text-wall')}
        >
          Install steps <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    )
  return (
    <div
      className={cx(
        'flex min-h-12 w-full max-w-lg min-w-0 items-center gap-3 rounded-xl border pr-0.5 pl-4 text-left font-mono text-[14px]',
        dark ? 'border-white/15 bg-white/5 text-zinc-100' : 'border-line bg-white text-ink shadow-sm shadow-black/[0.03]',
        className,
      )}
    >
      <span className={dark ? 'text-wall-bright' : 'text-wall'} aria-hidden="true">
        $
      </span>
      {/* Wraps on a narrow phone rather than hiding the end of the command. */}
      <code className="block min-w-0 flex-1 py-2 leading-snug break-words select-all">{command}</code>
      <IconButton
        variant={dark ? 'quiet-dark' : 'quiet'}
        size="icon-lg"
        onClick={copy}
        label={copied ? 'Copied' : 'Copy the install command'}
      >
        {copied ? <Check className="size-4 text-wall-bright" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      </IconButton>
    </div>
  )
}

// A product screenshot. `src` is an imported asset; `srcSet` optional.
export function Shot({ src, srcSet, sizes, alt, width, height, className, eager = false, bar = true }) {
  return (
    <figure className={cx('shot', className)}>
      {bar ? (
        <div className="flex h-7 items-center gap-1.5 border-b border-black/[0.06] bg-zinc-50 px-3" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-zinc-300" />
          <span className="size-2.5 rounded-full bg-zinc-300" />
          <span className="size-2.5 rounded-full bg-zinc-300" />
        </div>
      ) : null}
      <img
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={eager ? 'high' : undefined}
      />
    </figure>
  )
}

export function Eyebrow({ children, dark = false }) {
  return <p className={cx('text-[13px] font-semibold tracking-wide uppercase', dark ? 'text-wall-bright' : 'text-wall')}>{children}</p>
}

export function SectionHead({ eyebrow, title, children, dark = false, center = false }) {
  return (
    <div className={cx('max-w-2xl', center && 'mx-auto text-center')}>
      {eyebrow ? <Eyebrow dark={dark}>{eyebrow}</Eyebrow> : null}
      <h2
        className={cx(
          'mt-3 text-[28px] leading-[1.15] font-bold tracking-[-0.02em] text-balance sm:text-4xl',
          dark ? 'text-white' : 'text-ink',
        )}
      >
        {title}
      </h2>
      {children ? <p className={cx('mt-4 text-[17px] leading-7 text-pretty', dark ? 'text-zinc-400' : 'text-slate')}>{children}</p> : null}
    </div>
  )
}

export function Badge({ children, tone = 'teal' }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase',
        tone === 'teal' && 'bg-wall-tint text-wall-deep',
        tone === 'amber' && 'bg-amber-100 text-pin-ink',
        tone === 'zinc' && 'bg-zinc-100 text-slate',
        tone === 'dark' && 'bg-white/10 text-wall-bright',
      )}
    >
      {children}
    </span>
  )
}

export function Container({ className, children }) {
  const width = /(^|\s)max-w-/.test(className || '') ? '' : 'max-w-6xl'
  return <div className={cx('mx-auto w-full px-5 sm:px-8', width, className)}>{children}</div>
}
