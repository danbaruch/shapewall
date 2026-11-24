// Every page of the site, with its search and share metadata. Plain data: the app (routing, head tags on client
// navigation) and scripts/prerender.mjs (one HTML file per route, sitemap) both read it.
// Search phrase first, brand last. Titles are at most 60 characters and descriptions 70 to 160, each unique
// (test/build.test.js checks).

import { GITHUB_URL, LAUNCHED } from './launch.js'
import { OG_VERSIONS } from './og-versions.js'

export { GITHUB_URL }
export const SITE_URL = 'https://shapewall.com'
export const SITE_HOST = 'shapewall.com'
// The live demo: a static Shapewall export served beside the site (not a React route).
export const DEMO_URL = '/demo/'
// Its search and share metadata, which ../scripts/demo-brackwell.js writes into the export's index.html (seo.js
// demoHeadTags). Never indexed: the demo is a tool to try, and its fixtures change.
export const DEMO_PAGE = {
  path: DEMO_URL,
  title: 'Live demo: a whole app on one wall | Shapewall',
  description:
    'Try Shapewall in your browser: a demo app with 146 screens on one wall, its journeys, pinned instructions, the agent chat and the team console.',
  og: 'home',
  alt: 'See your whole app, steer your agents from it: the Shapewall wall with every screen of a demo app at desktop and phone width',
  kind: 'page',
  noindex: true,
}
// The fictional apps the demo's two boards show (Brackwell and Lumen Notes), published beside it by ../scripts/demo-export.js
// (--publish; production and staging copies, see ../scripts/demo-publish.js). Never crawled, never in the sitemap,
// whatever the stealth setting.
export const DEMO_SITE_PATHS = ['/brackwell', '/brackwell-staging', '/lumen', '/lumen-staging']
export const AUTHOR = 'Dan Baruch'

export const PAGES = [
  {
    path: '/',
    title: 'See your whole app. Steer your agents from it. | Shapewall',
    description: LAUNCHED
      ? 'Every screen of your app on one wall, desktop and phone, with the flows between them. Point at anything and tell your coding agent what to build. Free.'
      : 'Every screen of your app on one wall, desktop and phone, with the flows between them. Point at anything and tell your coding agent what to build.',
    og: 'home',
    alt: 'See your whole app, steer your agents from it: the Shapewall wall with every screen of a demo app at desktop and phone width',
  },
  {
    path: '/features',
    title: 'Features: whole-app wall, journeys and agents | Shapewall',
    description:
      'Every screen at every size, journeys between them, comments that are instructions to your coding agent, watch and MCP, before and after, and team workspaces.',
    og: 'features',
    alt: 'Shapewall features: capture, the whole-app wall, journeys, comments as instructions and the agent loop',
  },
  {
    path: '/open-source',
    title: 'Licenses and self-hosting: Apache 2.0 and FSL | Shapewall',
    description:
      'The Shapewall local tool is open source under Apache 2.0. The team server you host yourself is source-available under the Functional Source License.',
    og: 'open-source',
    alt: 'Shapewall licenses and self-hosting: Apache 2.0 local tool, Functional Source License team server',
  },
  {
    path: '/changelog',
    title: 'Changelog: what changed in each release | Shapewall',
    description: 'Every Shapewall release, newest first: new features, changes and fixes, from the CHANGELOG.md in the repository.',
    og: 'changelog',
    alt: 'The Shapewall changelog: every release, newest first',
  },
  {
    path: '/contact',
    title: 'Contact the Shapewall maintainer | Shapewall',
    description: LAUNCHED
      ? 'Ask a question about Shapewall, tell us what works and what does not, or request a feature. Bugs go to GitHub issues, security reports to the policy.'
      : 'Ask a question, report a bug or request a feature from the Shapewall maintainer. For a private security report, use the email address on this page.',
    og: 'home',
    alt: 'See your whole app, steer your agents from it: the Shapewall wall with every screen of a demo app at desktop and phone width',
  },
  {
    path: '/privacy',
    title: 'Privacy policy: local tool and website | Shapewall',
    description:
      'What the Shapewall tool keeps on your machine, what agents, integrations and sharing send when you connect them, and how shapewall.com counts visits.',
    og: 'privacy',
  },
  {
    path: '/terms',
    title: 'Terms of use: website and public demo | Shapewall',
    description:
      'What these terms cover: this website and the public demo. The software is covered by its licenses, and a team server by its operator.',
    og: 'privacy',
  },
  {
    path: '/legal/terms',
    noindex: true,
    title: 'Terms template for self-hosted servers | Shapewall',
    description:
      'A terms of service template for the operator of a self-hosted Shapewall server. Complete it and have it reviewed before inviting users.',
    og: 'privacy',
  },
  {
    path: '/legal/privacy',
    noindex: true,
    title: 'Privacy template for self-hosted servers | Shapewall',
    description:
      'A privacy notice template for the operator of a self-hosted Shapewall server: what is stored, sharing, retention and the details to complete.',
    og: 'privacy',
  },
  {
    path: '/legal/subprocessors',
    noindex: true,
    title: 'Subprocessors template for self-hosted servers | Shapewall',
    description:
      'A subprocessors list template for the operator of a self-hosted Shapewall server, with the optional providers to review and how to announce changes.',
    og: 'privacy',
  },
  {
    path: '/legal/acceptable-use',
    noindex: true,
    title: 'Acceptable use template for self-hosting | Shapewall',
    description:
      'An acceptable use policy template for the operator of a self-hosted Shapewall server: authorized use, secrets and personal data, and abuse reports.',
    og: 'privacy',
  },
]

// Docs: sidebar order and groups. `file` names the page (and its share image); the markdown is src/docs/<file>.md,
// or, with `repo`, the repository's own guide docs/<repo>.md (see scripts/markdown.mjs).
export const DOC_GROUPS = [
  {
    title: 'Start here',
    docs: [
      {
        path: '/docs',
        file: 'index',
        nav: 'Introduction',
        title: 'Docs: how it works and where to start | Shapewall',
        description:
          'How Shapewall works in a few minutes: capture every screen, see the whole app and its flows on one wall, and steer your coding agent from it.',
      },
      {
        path: '/docs/getting-started',
        file: 'getting-started',
        nav: 'Getting started',
        // The quickstart video above the steps (src/media.json, components/video.jsx).
        video: 'docs-quickstart',
        title: 'Getting started: install, capture, serve | Shapewall',
        description:
          'Install Shapewall, create a config with shapewall init, capture every screen of your app at desktop and phone width, and open the wall with serve.',
      },
      {
        path: '/docs/config',
        file: 'config',
        repo: 'config',
        nav: 'Config reference',
        title: 'Config reference: shapewall.config.json | Shapewall',
        description:
          'Every key in shapewall.config.json: pages, viewports, actions before a shot, setup, localStorage seeds, request blocking, signed-in pages and boards.',
      },
      {
        path: '/docs/cli',
        file: 'cli',
        nav: 'CLI reference',
        title: 'CLI reference: every shapewall command | Shapewall',
        description:
          'The shapewall command line: init, capture, serve, comments, watch, checks, github, notify, push and hosted, full help text and environment variables.',
      },
    ],
  },
  {
    title: 'Workflows',
    docs: [
      {
        path: '/docs/agent-workflow',
        file: 'agent-workflow',
        repo: 'agent-workflow',
        nav: 'The agent workflow',
        title: 'The agent workflow: comments, watch, MCP | Shapewall',
        description:
          'Steer Claude Code, Codex or any coding agent from the wall: comments as JSON instructions, a prompt that works, watch mode, the MCP server and safety rules.',
      },
      {
        path: '/docs/agent-recipes',
        file: 'agent-recipes',
        repo: 'agent-recipes',
        nav: 'Agent recipes',
        title: 'Agent recipes: Claude Code, Codex, goose | Shapewall',
        description:
          'Exact commands to connect Claude Code, Codex, goose, Ollama and chat bots to a Shapewall board: MCP, watch, the board chat and the event stream.',
      },
      {
        path: '/docs/chat',
        file: 'chat',
        repo: 'agents',
        nav: 'Chat with an agent',
        title: 'Chat with an agent: connect a model | Shapewall',
        description:
          'Connect the board chat to a model or an agent CLI, let it fix comments on a branch or several at once, with images, voice and board text kept as data.',
      },
      {
        path: '/docs/starter-agent',
        file: 'starter-agent',
        repo: 'starter-agent',
        nav: 'Sandboxed starter agent',
        title: 'Sandboxed starter agent for shared boards | Shapewall',
        description:
          'Let an agent work on board comments inside a container: one checkout, an egress allow list, fixed tools, a trigger gate, budgets and a branch.',
      },
      {
        path: '/docs/journeys',
        file: 'journeys',
        repo: 'journeys',
        nav: 'Journeys and links',
        title: 'Journeys: the flows between your screens | Shapewall',
        description:
          'Turn on Links to see arrows drawn from the real links between your screens, and name a flow such as sign up to first project to step through it.',
      },
      {
        path: '/docs/compare',
        file: 'compare',
        nav: 'Before, after and staging',
        title: 'Before and after, staging and production | Shapewall',
        description:
          'See each resolved comment before and after, put a branch preview beside the page, and compare staging with production, commenting on either side.',
      },
      {
        path: '/docs/pull-requests',
        file: 'pull-requests',
        repo: 'pull-requests',
        nav: 'Capture on pull requests',
        title: 'Capture on pull requests: a visual diff comment | Shapewall',
        description:
          'Capture every page before and after each pull request and keep one comment up to date with what changed, the pixel share and diff images.',
        og: 'docs-compare',
      },
      {
        path: '/docs/page-checks',
        file: 'page-checks',
        repo: 'page-checks',
        nav: 'Page checks',
        title: 'Page checks: SEO, Lighthouse and accessibility | Shapewall',
        description:
          'Check original pages for reliability, SEO, social images and accessibility. Compare retained lab reports, configure budgets and share diagnostics explicitly.',
      },
      {
        path: '/docs/performance',
        file: 'performance',
        repo: 'performance',
        nav: 'Lighthouse audits',
        title: 'Lighthouse audits: local performance runs | Shapewall',
        description:
          'Run shapewall checks lighthouse on your own pages: Lighthouse metrics, repeat samples, measurement profiles, signed-in runs, budgets and report history.',
        og: 'docs-page-checks',
      },
      {
        path: '/docs/interaction-audits',
        file: 'interaction-audits',
        repo: 'interaction-audits',
        nav: 'Interaction flows and accessibility',
        title: 'Interaction flows and accessibility checks | Shapewall',
        description:
          'Run a named click and fill flow with step budgets, and take a local axe-core accessibility snapshot: the flow file, actions and limits.',
        og: 'docs-page-checks',
      },
    ],
  },
  {
    title: 'Run it',
    docs: [
      {
        path: '/docs/where-to-run',
        file: 'where-to-run',
        repo: 'where-to-run',
        nav: 'Where to run Shapewall',
        title: 'Where to run Shapewall: local or hosted | Shapewall',
        description:
          'Choose between the local board in your project and a hosted server for a team: who can reach each, what Tailscale adds, and where the work happens.',
        og: 'docs-self-hosting',
      },
      {
        path: '/docs/self-hosting',
        file: 'self-hosting',
        repo: 'deployment',
        nav: 'Deployment and self-hosting',
        title: 'Deployment and self-hosting | Shapewall',
        description:
          'Run the board on your machine, share it with a team behind an authenticating proxy, export a static read-only copy, or capture on CI with Docker.',
      },
      {
        path: '/docs/capture-warnings',
        file: 'capture-warnings',
        repo: 'capture-warnings',
        nav: 'Capture warnings and pacing',
        title: 'Capture warnings and pacing | Shapewall',
        description:
          'Understand API failures and rate limits beside usable screenshots, safe aggregate network counts, and bounded foreground capture pacing settings.',
        og: 'docs-config',
      },
      {
        path: '/docs/local-accounts',
        file: 'local-accounts',
        repo: 'local-accounts',
        nav: 'Local accounts and photos',
        title: 'Local accounts and profile photos | Shapewall',
        description:
          'Set up an optional local owner account with passkeys, recovery codes, sessions and a cropped profile photo, while keeping your existing board files.',
        og: 'docs-getting-started',
      },
      {
        path: '/docs/updates',
        file: 'updates',
        repo: 'updates',
        nav: 'Manual installation updates',
        title: 'Manual installation updates | Shapewall',
        description:
          'See which version is running, update a clone or a project install by hand, and optionally let the board apply releases through your own update helper.',
        og: 'docs-self-hosting',
      },
      {
        path: '/docs/hosted',
        file: 'hosted',
        repo: 'hosted',
        nav: 'Hosted operator guide',
        title: 'Hosted operator guide: accounts and backups | Shapewall',
        description:
          'Operate a self-hosted team server: passkeys, workspace roles, capture uploads, scoped agents, quotas, retention, backups and a restore drill.',
        og: 'docs-self-hosting',
      },
      {
        path: '/docs/monitoring',
        file: 'monitoring',
        repo: 'monitoring',
        nav: 'Monitoring your server',
        title: 'Monitoring your server: health, logs, errors | Shapewall',
        description:
          'Watch a self-hosted Shapewall: the /api/health check for uptime probes, where the logs go, opt-in error reports, metrics and a triage checklist.',
        og: 'docs-self-hosting',
      },
      {
        path: '/docs/stability',
        file: 'stability',
        repo: 'stability',
        nav: 'Stability and versioning',
        title: 'Stability and versioning: what 1.x keeps | Shapewall',
        description:
          'What Shapewall 1.x keeps stable under semantic versioning: commands, config, JSON, the token API and files on disk, and what is experimental.',
        og: 'docs-config',
      },
      {
        path: '/docs/security',
        file: 'security',
        nav: 'Security model',
        title: 'Security model: how captured pages stay inert | Shapewall',
        description:
          'Why captured HTML can never run code: an allowlist sanitizer, a strict content security policy and a sandboxed frame. Plus the local server rules.',
      },
      {
        path: '/docs/agent-hardening',
        file: 'agent-hardening',
        repo: 'agent-hardening',
        nav: 'Agent hardening',
        title: 'Agent hardening: prompt injection, sandboxes | Shapewall',
        description:
          'Connect a coding agent to a shared board safely: how prompt injection arrives, built-in defenses, least privilege and a printable sandbox checklist.',
      },
      {
        path: '/docs/faq',
        file: 'faq',
        nav: 'FAQ',
        title: 'FAQ: single-page apps, logins, data, teams | Shapewall',
        description:
          'Answers about single-page apps, signed-in pages, browsers, where your data lives, safe sharing, team use, licenses and what Shapewall needs to run.',
      },
    ],
  },
  {
    title: 'Integrations',
    docs: [
      {
        path: '/docs/github',
        file: 'github',
        repo: 'github',
        nav: 'GitHub connect',
        title: 'GitHub connect: issues and pull requests | Shapewall',
        description:
          'Turn a comment into a GitHub issue, link the pull requests that fix it, and resolve the comment when the PR merges. Your token, no GitHub App.',
      },
      {
        path: '/docs/notifications',
        file: 'notifications',
        repo: 'notifications',
        nav: 'Notifications',
        title: 'Notifications: Slack, Discord, Telegram, email | Shapewall',
        description:
          'Send comment events to a signed webhook, Slack, Discord, Telegram or email, with mentions routed to the right person and secrets kept in env vars.',
      },
    ],
  },
  {
    // Kept last and out of the main groups: an optional bridge for people who already run Buzz.
    title: 'Optional bridges (experimental)',
    docs: [
      {
        path: '/docs/buzz',
        file: 'buzz',
        repo: 'buzz',
        nav: 'Buzz bridge',
        title: 'Buzz bridge: reach agents in a Buzz channel | Shapewall',
        description:
          'Experimental: send board comments to coding agents already in a self-hosted Buzz chat channel, through an owner-only local gateway with signed messages.',
        og: 'docs-chat',
      },
    ],
  },
]

export const DOCS = DOC_GROUPS.flatMap((group) =>
  group.docs.map((doc) => ({ ...doc, group: group.title, og: doc.og || `docs-${doc.file}`, kind: 'doc' })),
)

export const ROUTES = [...PAGES.map((page) => ({ ...page, kind: 'page' })), ...DOCS]

export const NOT_FOUND = {
  path: '/404',
  title: 'Page not found | Shapewall',
  description:
    'This page is not on the wall. Try the home page, the features or the docs, which cover install, config, journeys, the agent loop and self-hosting.',
  og: 'home',
  kind: 'page',
  notFound: true,
}

export function routeFor(pathname) {
  const clean =
    pathname
      .replace(/\.html$/, '')
      .replace(/\/index$/, '/')
      .replace(/(.)\/+$/, '$1') || '/'
  return ROUTES.find((route) => route.path === clean) || null
}

// A share card's URL, with its content hash (src/og-versions.js), so a new card is a new URL to every cache.
export const ogImageUrl = (route) => `${SITE_URL}/og/${route.og}.jpg${OG_VERSIONS[route.og] ? `?v=${OG_VERSIONS[route.og]}` : ''}`

export const canonicalUrl = (route) => SITE_URL + (route.path === '/' ? '/' : route.path)
