import { Link } from 'react-router-dom'
import { PageHeader } from '../components/page.jsx'
import { Container } from '../components/ui.jsx'
import { GITHUB_URL } from '../routes.js'
import { LAUNCHED } from '../launch.js'

export const TERMS_UPDATED = '2026-11-14'

// Two things on this page are Dan's to decide, and the page is written so that it is complete and accurate without
// them (see the PR description):
//   1. A governing-law / jurisdiction clause. Deliberately absent: naming a state or country is a legal choice, not
//      a fact to be guessed. Nothing else on the page depends on it.
//   2. Whether to keep naming the maintainer in "Who these terms are with". The name is already in the site footer
//      and in NOTICE, so this adds nothing new, but it is the one personal detail on the page.
// No legal entity, address, jurisdiction, support guarantee or dispute process is stated anywhere here, because
// none of those exist for this project.

export default function Terms() {
  return (
    <>
      <PageHeader eyebrow="Terms" title="Terms of use">
        These terms cover this website and the public demo. The Shapewall software itself is covered by its licenses, and a team server
        someone else hosts is covered by that operator&apos;s terms.
      </PageHeader>
      <Container className="py-14 sm:py-16">
        <div className="prose-docs max-w-2xl">
          <p>
            <em>
              Last updated{' '}
              {new Date(TERMS_UPDATED + 'T12:00:00Z').toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                timeZone: 'UTC',
              })}
              .
            </em>
          </p>

          <h2 id="scope">What these terms cover</h2>
          <p>
            They cover your use of shapewall.com: these pages, the documentation and the <a href="/demo/">public demo</a>. They are short
            because this site does not sell anything, does not have accounts and does not store work for you.
          </p>
          <p>Three things are outside them:</p>
          <ul>
            <li>
              <strong>The Shapewall software.</strong> Your right to use, change and redistribute the code comes from its licenses, not from
              this page. See <Link to="/open-source">licenses</Link> below.
            </li>
            <li>
              <strong>A team server someone hosts.</strong> If you sign in to a Shapewall server run by your company or by anyone else, that
              operator decides its terms, keeps the data and is responsible for it. Not us.
            </li>
            <li>
              <strong>Services you connect.</strong> Coding agents, model providers, GitHub, notification services: each has its own terms,
              and you connect them yourself.
            </li>
          </ul>

          <h2 id="licenses">The software and its licenses</h2>
          <p>
            The Shapewall local tool is open source under the Apache License, Version 2.0. The hosted team server (the{' '}
            <code>src/hosted</code> directory) is source-available under the Functional Source License, Version 1.1, with an Apache 2.0
            future license: each release becomes Apache 2.0 two years after it is published. The{' '}
            <Link to="/open-source">licenses page</Link> explains what each one lets you do, and the{' '}
            <a href={`${GITHUB_URL}/blob/main/LICENSE`}>license files</a> are authoritative.
          </p>
          <p>
            Where a license and this page could be read differently about the code, the license wins. Nothing here takes away a right the
            Apache License gives you.
          </p>

          <h2 id="demo">The public demo</h2>
          <p>
            The <a href="/demo/">demo</a> is a read-only Shapewall board, exported as static files. The product it shows, Lumen Notes, is
            invented for the demo: the pages, people, comments and data in it are fictional.
          </p>
          <p>
            It is a shared public page, not your workspace. Treat anything you type into it as public and temporary: do not put real,
            private or sensitive content there. The demo is replaced whenever the site is rebuilt, so nothing you do in it is kept.
          </p>

          <h2 id="website">Using this website</h2>
          <p>Please do not:</p>
          <ul>
            <li>try to break, overload or probe the site, or get around a restriction on it</li>
            <li>use it to host or distribute malware, or to attack anyone else</li>
            <li>scrape it hard enough to degrade it for other people (reading the docs normally, or with a normal crawler, is fine)</li>
          </ul>
          <p>
            Otherwise, read the docs, copy the examples, quote them, translate them and use them in your own work. The documentation is part
            of the repository and carries the same Apache 2.0 license as the rest of it.
          </p>

          <h2 id="no-service">There is no hosted service, and no support promise</h2>
          <p>
            We do not run a hosted Shapewall service. There is no subscription, no paid plan, no account on this site and no service level
            to miss. Shapewall is something you run yourself.
          </p>
          <p>
            Help is best effort and public: {LAUNCHED ? 'open' : 'invited repository users can open'} an issue on{' '}
            <a href={GITHUB_URL}>GitHub</a>. Nobody is on call, nothing is guaranteed to be answered or fixed, and the project can change or
            stop. Security reports have their own private route, in the{' '}
            <a href={`${GITHUB_URL}/blob/main/SECURITY.md`}>security policy</a>.
          </p>

          <h2 id="no-warranty">No warranty, and the limits of our liability</h2>
          <p>
            This site, the documentation and the demo are provided as they are, with no warranty of any kind. The software is provided under
            its licenses, which disclaim warranties and limit liability in their own words (Apache 2.0, sections 7 and 8); those sections
            govern the software, and this paragraph is about the site.
          </p>
          <p>
            To the extent the law allows, we are not liable for loss or damage arising from your use of this site, the documentation or the
            demo, including anything you do, or an agent does, by following something written here. Shapewall drives a real browser against
            real pages and connects to tools that can change your code: read the{' '}
            <Link to="/docs/security">security model</Link> and the{' '}
            <Link to="/docs/agent-hardening">agent hardening guide</Link>, capture with test data, and keep a coding agent on a branch you
            review. Some jurisdictions do not allow these exclusions, in which case they apply only as far as they lawfully can.
          </p>

          <h2 id="contributions">Contributions</h2>
          <p>
            If you contribute, your contribution is licensed under the same license as the file you are changing: Apache 2.0, or the
            Functional Source License for files under <code>src/hosted</code>. That is stated in{' '}
            <a href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}>CONTRIBUTING.md</a>, which also covers how to open a pull request. The{' '}
            <a href={`${GITHUB_URL}/blob/main/CODE_OF_CONDUCT.md`}>code of conduct</a> applies to the repository and its discussions.
          </p>

          <h2 id="brand">The Shapewall name and mark</h2>
          <p>
            The Apache License covers the code, not the name or the logo (Apache 2.0, section 6, grants no trademark rights). You may use
            the name to say truthfully what your project does: that it uses Shapewall, works with it, or is a fork of it. Please do not use
            the name or the mark in a way that suggests the project endorses you, and do not use them as the name of your own product. The{' '}
            <a href={`${GITHUB_URL}/tree/main/brand`}>brand folder</a> has the files and how they are meant to look.
          </p>
          <p>
            The board shows other companies&apos; product marks as the default icons of the coding agents you connect. Those marks belong to
            their owners and imply no endorsement or affiliation; <a href={`${GITHUB_URL}/blob/main/THIRD_PARTY.md`}>THIRD_PARTY.md</a>{' '}
            lists them and their terms.
          </p>

          <h2 id="privacy">Privacy</h2>
          <p>
            What this site counts, what the tool keeps on your machine and what an integration sends when you turn it on are all in the{' '}
            <Link to="/privacy">privacy policy</Link>.
          </p>

          <h2 id="self-hosting">If you host Shapewall for other people</h2>
          <p>
            Then you are the operator, and you need your own terms, privacy notice, acceptable use policy and subprocessor list. Starting
            points are in <a href={`${GITHUB_URL}/tree/main/examples/hosted/legal`}>examples/hosted/legal</a> in the repository, with the
            same text at <Link to="/legal/terms">/legal/terms</Link>, <Link to="/legal/privacy">/legal/privacy</Link>,{' '}
            <Link to="/legal/acceptable-use">/legal/acceptable-use</Link> and{' '}
            <Link to="/legal/subprocessors">/legal/subprocessors</Link>. They are templates, not finished documents, and they are not an
            agreement with us. Complete them and have them reviewed before you invite anyone. The{' '}
            <Link to="/docs/hosted">hosted operator guide</Link> explains where the server shows those links.
          </p>

          <h2 id="changes">Changes to these terms</h2>
          <p>
            These terms can change. The date at the top says when they last did, and the{' '}
            <a href={`${GITHUB_URL}/commits/main/website/src/pages/Terms.jsx`}>page&apos;s history</a> shows every change, because this page
            lives in the repository. Continuing to use the site after a change means the new version applies.
          </p>

          <h2 id="who">Who these terms are with, and how to reach us</h2>
          <p>
            Shapewall is a personal open-source project maintained by Dan Baruch with its contributors. &quot;We&quot; on this page means
            that project. It is not a company, and this site does not create a business relationship between us.
          </p>
          <p>
            For a question about these terms: <a href="mailto:hello@shapewall.com">hello@shapewall.com</a>. For a bug or a feature idea, the{' '}
            <Link to="/contact">contact page</Link> and <a href={GITHUB_URL}>GitHub issues</a> are better. For something security sensitive,
            use the private route in the <a href={`${GITHUB_URL}/blob/main/SECURITY.md`}>security policy</a>.
          </p>
        </div>
      </Container>
    </>
  )
}
