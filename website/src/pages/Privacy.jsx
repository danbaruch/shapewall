import { Link } from 'react-router-dom'
import { PageHeader } from '../components/page.jsx'
import { Container } from '../components/ui.jsx'
import { GITHUB_URL } from '../routes.js'
import { LAUNCHED } from '../launch.js'

export const PRIVACY_UPDATED = '2026-11-07'

export default function Privacy() {
  return (
    <>
      <PageHeader eyebrow="Privacy" title="Privacy">
        Shapewall runs on your machine and sends no telemetry. Integrations you turn on connect only to the services you configure. This
        website uses cookieless analytics.
      </PageHeader>
      <Container className="py-14 sm:py-16">
        <div className="prose-docs max-w-2xl">
          <p>
            <em>
              Last updated{' '}
              {new Date(PRIVACY_UPDATED + 'T12:00:00Z').toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                timeZone: 'UTC',
              })}
              .
            </em>
          </p>
          <h2 id="this-website">This website</h2>
          <p>
            shapewall.com uses self-hosted, cookieless analytics (Umami) to count page views and a few clicks, such as opening the getting
            started guide. Umami sets no analytics cookies and writes no analytics identifiers to your device. It respects Do Not Track and
            does not build a profile of you. We see totals: pages, referrers, countries, browsers and device types.
          </p>
          <p>
            The site is served through Cloudflare, which adds Cloudflare Web Analytics: a script from static.cloudflareinsights.com that
            reports page views and load times to cloudflareinsights.com. It is cookieless too, stores nothing on your device and gives us
            aggregate numbers only, not a record of what one visitor did.
          </p>
          <p>
            The docs search runs in your browser. What you type is never sent anywhere. There are no forms, no newsletter signups and no ads
            on this site, and apart from the two analytics tools above, no third-party scripts.
          </p>
          <p>
            The site installs a small service worker so pages load fast and work offline. It caches this site&apos;s own files in your
            browser and nothing else. Clearing site data removes it.
          </p>
          <h2 id="the-shapewall-tool">The Shapewall tool</h2>
          <p>
            The tool sends no telemetry. Captures and page checks load your configured pages and their resources. Sitemap and link checks
            also make network requests. Optional features can download browser or voice assets. Captures, comments and journeys are files in
            your configured output folder, normally <code>.shapewall/</code>. Optional local passkey accounts also use a SQLite database on
            that installation.
          </p>
          <p>
            Coding agents, notifications, GitHub integration and remote sharing that you set up send the relevant data to the destinations
            you connect. An agent may receive comment text, page context or images you send; its own tools and provider privacy terms apply.
            Uploading or sharing a board sends it to the selected server or recipients. The server operator&apos;s privacy and retention
            terms apply there. These connections are optional.
          </p>
          <p>
            Screenshots show exactly what a page showed, so capture with test data. The <Link to="/docs/security">security model</Link>{' '}
            explains what live HTML keeps and drops.
          </p>
          <h2 id="hosted-version">Self-hosted team servers</h2>
          <p>
            A self-hosted team server is run by its operator, who stores the uploaded boards and the account and workspace data and is
            responsible for that server&apos;s privacy terms and retention. We do not run a hosted Shapewall service and hold none of that
            data.
          </p>
          <h2 id="questions">Questions</h2>
          <p>
            {LAUNCHED ? 'Open' : 'Invited repository users can open'} an issue on <a href={GITHUB_URL}>GitHub</a>, or use the private
            reporting described in the security policy for anything sensitive.
          </p>
        </div>
      </Container>
    </>
  )
}
