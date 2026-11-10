import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Container } from '../components/ui.jsx'

export default function NotFound({ inDocs = false }) {
  const links = inDocs
    ? [
        ['/docs', 'Docs introduction'],
        ['/docs/getting-started', 'Getting started'],
        ['/docs/config', 'Config reference'],
      ]
    : [
        ['/', 'Home'],
        ['/features', 'Features'],
        ['/docs', 'Docs'],
      ]
  return (
    <section className={inDocs ? 'py-6' : 'wall-dots py-24 sm:py-32'}>
      <Container className={inDocs ? 'px-0 sm:px-0' : 'max-w-xl text-center'}>
        <div className={`flex gap-2 ${inDocs ? '' : 'justify-center'}`} aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={`h-16 w-12 rounded-lg border bg-card ${index === 1 ? 'border-dashed border-pin' : 'border-edge shadow-sm'}`}
            />
          ))}
        </div>
        <p className="mt-8 text-[13px] font-semibold tracking-wide text-pin-ink uppercase">404</p>
        <h1 className="mt-2 text-[34px] leading-tight font-extrabold tracking-[-0.03em] text-ink sm:text-[44px]">
          This page is not on the wall
        </h1>
        <p className="mt-4 text-[17px] leading-7 text-slate">The link may be old, or the page moved. These are a good place to start.</p>
        <ul className={`mt-8 flex flex-col gap-2 sm:flex-row ${inDocs ? '' : 'justify-center'}`}>
          {links.map(([to, label]) => (
            <li key={to}>
              <Link
                to={to}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-card px-4 text-[14.5px] font-semibold text-ink hover:border-line-strong"
              >
                {label} <ArrowRight className="size-4 text-faint" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}
