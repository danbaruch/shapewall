// The Shapewall mark (brand/shapewall-mark.svg) and the wordmark lockup, inline so they never flash in.
export function Mark({ className = 'size-7', title }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <rect width="32" height="32" rx="8" fill="#0f766e" />
      <rect x="6" y="6" width="9" height="12" rx="2" fill="#fff" />
      <rect x="6" y="20" width="9" height="6" rx="2" fill="#fff" fillOpacity="0.72" />
      <rect x="17" y="6" width="9" height="6" rx="2" fill="#f59e0b" />
      <rect x="17" y="14" width="9" height="12" rx="2" fill="#fff" />
    </svg>
  )
}

export function Logo({ dark = false }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark className="size-7" />
      <span className={`text-[19px] font-bold tracking-[-0.025em] ${dark ? 'text-white' : 'text-ink'}`}>Shapewall</span>
    </span>
  )
}

export function GitHubIcon({ className = 'size-5' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.27 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}
