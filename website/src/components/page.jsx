import { Container, Eyebrow } from './ui.jsx'

export function PageHeader({ eyebrow, title, children }) {
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div className="wall-dots absolute inset-0 [mask-image:linear-gradient(to_bottom,black_30%,transparent)]" aria-hidden="true" />
      <Container className="relative py-16 sm:py-20">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-3 max-w-3xl text-[36px] leading-[1.08] font-extrabold tracking-[-0.03em] text-balance text-ink sm:text-5xl">
          {title}
        </h1>
        {children ? (
          <p className="mt-5 max-w-2xl text-[17px] leading-7 text-pretty text-slate sm:text-[18px] sm:leading-8">{children}</p>
        ) : null}
      </Container>
    </section>
  )
}
