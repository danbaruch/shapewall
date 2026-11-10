import { PageHeader } from '../../components/page.jsx'
import { Container } from '../../components/ui.jsx'
import { LEGAL_TEMPLATES } from './templates.js'

export default function LegalTemplate({ slug }) {
  const [title, sections] = LEGAL_TEMPLATES[slug]
  return (
    <>
      <PageHeader eyebrow="Self-host operator template" title={title}>
        A starting point for the operator of a self-hosted server. Complete it and have it reviewed before inviting users.
      </PageHeader>
      <Container className="py-14 sm:py-16">
        <div className="prose-docs max-w-2xl">
          <p>
            <strong>This is a template for the operator of a self-hosted Shapewall server. It is not an agreement with Shapewall.</strong>
          </p>
          {sections.map(([heading, text]) => (
            <section key={heading}>
              <h2>{heading}</h2>
              <p>{text}</p>
            </section>
          ))}
        </div>
      </Container>
    </>
  )
}
