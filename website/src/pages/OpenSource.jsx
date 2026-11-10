import { Link } from 'react-router-dom'
import { ArrowRight, FileJson, Laptop, Package, Scale, Server, Users } from 'lucide-react'
import { GitHubIcon } from '../components/brand.jsx'
import { PageHeader } from '../components/page.jsx'
import { Button, Container, InstallCommand } from '../components/ui.jsx'
import { GITHUB_URL } from '../routes.js'
import { GITHUB_LABEL, LAUNCHED } from '../launch.js'

const WAYS = [
  {
    icon: Laptop,
    title: 'On your machine',
    text: 'The default. shapewall serve listens on 127.0.0.1 with no login, refuses requests with a non-local Host header, and only accepts JSON writes, so other sites cannot reach it.',
    code: 'shapewall serve',
    link: ['/docs/getting-started', 'Getting started'],
  },
  {
    icon: Users,
    title: 'For a team',
    text: 'Run one self-hosted server over Tailscale. Each teammate signs in with their own passkey and joins a workspace, with roles, comments, scoped agents and live presence.',
    code: 'shapewall hosted --tailscale --tailscale-port 8443',
    link: ['/docs/self-hosting', 'Deployment and self-hosting'],
  },
  {
    icon: FileJson,
    title: 'As static files',
    text: 'Export a read-only copy of the boards: client, captures and comments. Any static host can serve it, and live HTML still carries its content security policy.',
    code: 'shapewall export --out shapewall-export',
    link: ['/docs/self-hosting#as-static-files', 'Static export'],
  },
  {
    icon: Server,
    title: 'On CI',
    text: 'Capture every pull request preview and upload the wall as an artifact. shapewall capture exits 0 when every shot worked and 2 when some failed. The repository has a Dockerfile on the Playwright image.',
    code: 'shapewall capture && shapewall export',
    link: ['/docs/self-hosting#captures-on-ci', 'Captures on CI'],
  },
]

export default function OpenSource() {
  return (
    <>
      <PageHeader eyebrow="Licenses and self-hosting" title="Local tool: Apache 2.0. Multiplayer: self-hosted.">
        The local tool keeps captures and comments on your disk and is open source under Apache 2.0. The optional team server is yours to
        host, and its source is available under the Functional Source License.
      </PageHeader>
      <Container className="py-16 sm:py-20">
        <div className="grid gap-5 md:grid-cols-2">
          {WAYS.map((way) => (
            <section key={way.title} className="flex min-w-0 flex-col rounded-2xl border border-line bg-card p-6 sm:p-7">
              <way.icon className="size-5 text-wall" aria-hidden="true" />
              <h2 className="mt-4 text-[20px] font-bold tracking-tight text-ink">{way.title}</h2>
              <p className="mt-2 flex-1 text-[15px] leading-7 text-slate">{way.text}</p>
              <pre className="mt-5 overflow-x-auto rounded-xl bg-night px-4 py-3 ring-1 ring-code-edge font-mono text-[13px] text-zinc-200">
                <code>
                  <span className="text-wall-bright select-none">$ </span>
                  {way.code}
                </code>
              </pre>
              <Link
                to={way.link[0]}
                className="mt-4 inline-flex items-center gap-1.5 text-[14.5px] font-semibold text-wall hover:text-wall-deep"
              >
                {way.link[1]} <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </section>
          ))}
        </div>

        <div className="mt-16 grid gap-10 lg:grid-cols-3">
          <div>
            <Scale className="size-5 text-wall" aria-hidden="true" />
            <h2 className="mt-3 text-[19px] font-bold tracking-tight text-ink">Two licenses</h2>
            <p className="mt-2 text-[15px] leading-7 text-slate">
              The CLI, capture, the board, MCP and the agents are Apache 2.0: use them at work, fork them, ship them inside your own tools,
              and keep the license and NOTICE file when you redistribute. The team server (src/hosted) is under the Functional Source
              License 1.1: free to read, modify and self-host, not to offer as a competing service, and each release becomes Apache 2.0 two
              years later. Copyright Dan Baruch and Shapewall contributors.
            </p>
          </div>
          <div>
            <Package className="size-5 text-wall" aria-hidden="true" />
            <h2 className="mt-3 text-[19px] font-bold tracking-tight text-ink">The stack</h2>
            <p className="mt-2 text-[15px] leading-7 text-slate">
              Node 22, Playwright for capture, parse5 for sanitizing, Express for the board server, React Flow for the wall. Data is JSON
              files written atomically under a file lock for local projects; the optional multiplayer server uses SQLite and files.
            </p>
          </div>
          <div>
            <GitHubIcon className="size-5 text-wall" />
            <h2 className="mt-3 text-[19px] font-bold tracking-tight text-ink">Contributing</h2>
            <p className="mt-2 text-[15px] leading-7 text-slate">
              {LAUNCHED
                ? 'Issues and pull requests are welcome. The repository has a contributing guide and a code of conduct.'
                : 'The repository opens to everyone at launch. Until then, invited contributors can open issues and pull requests.'}{' '}
              Security reports go through the private reporting in the security policy, not public issues.
            </p>
          </div>
        </div>

        <div className="mt-16 flex flex-col items-start gap-5 rounded-2xl bg-night p-7 text-white sm:p-10 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-[24px] font-bold tracking-tight">Start in your project</h2>
            <p className="mt-2 max-w-lg text-[15.5px] leading-7 text-zinc-400">
              Install it into the project you want to review, with Node 22.13 or newer, then capture and open the board.{' '}
              <Link to="/docs/getting-started#install" className="font-medium text-wall-bright hover:text-white">
                Read the install steps
              </Link>
              .
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <InstallCommand dark where="open-source" className="sm:w-[30rem]" />
            <Button href={GITHUB_URL} variant="ghost-dark" size="lg">
              <GitHubIcon className="size-[18px]" /> {GITHUB_LABEL}
            </Button>
          </div>
        </div>
      </Container>
    </>
  )
}
