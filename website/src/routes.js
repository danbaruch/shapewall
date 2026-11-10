// Every page of the site, with its search and share metadata. Plain data: the app (routing, head tags on client
// navigation) and scripts/prerender.mjs (one HTML file per route, sitemap) both read it.
// Titles stay under 60 characters and descriptions between 120 and 160 (test/build.test.js checks).

import { GITHUB_URL, LAUNCHED } from './launch.js'

export { GITHUB_URL }
export const SITE_URL = 'https://shapewall.com'
export const SITE_HOST = 'shapewall.com'
// The live demo: a static Shapewall export served beside the site (not a React route).
export const DEMO_URL = '/demo/'
// The fictional site the demo board shows (Lumen Notes), published beside it by ../scripts/demo-export.js
// (--publish; production and staging copies, see ../scripts/demo-publish.js). Never crawled, never in the sitemap,
// whatever the stealth setting.
export const DEMO_SITE_PATHS = ['/lumen', '/lumen-staging']
export const AUTHOR = 'Dan Baruch'
// Retired marketing URLs redirect to the canonical Features page.
export const REDIRECTS = { '/roadmap': '/features', '/roadmap/': '/features', '/roadmap.html': '/features' }
// The agent hardening guide as a PDF: public/downloads/, printed from src/docs/agent-hardening.md by scripts/pdf.mjs.
export const HARDENING_PDF = '/downloads/shapewall-agent-hardening.pdf'

export const PAGES = [
  {
    path: '/',
    title: 'Shapewall: shape your product on the wall',
    description: LAUNCHED
      ? 'Shapewall captures every page of your site onto one zoomable wall. Pin comments to elements and let your coding agent build the change. Free, runs locally.'
      : 'Shapewall captures every page of your site onto one zoomable wall. Pin comments to elements and let your coding agent build the change. In early access.',
    og: 'home',
    alt: 'The Shapewall wall: every page of a demo product at desktop and phone width, with comment pins',
  },
  {
    path: '/features',
    title: 'Features: capture, wall, comments, journeys | Shapewall',
    description:
      'Desktop, tablet and phone captures, live HTML, element comments, journeys, page history, GitHub connect, notifications and a self-running agent loop.',
    og: 'features',
    alt: 'Shapewall features: capture, the wall, element comments, the agent loop, journeys and page checks',
  },
  {
    path: '/open-source',
    title: 'Licenses and self-hosting | Shapewall',
    description:
      'Shapewall runs on your machine. The local tool is Apache 2.0 open source; the self-hosted team server is source-available under the Functional Source License.',
    og: 'open-source',
    alt: 'Shapewall licenses and self-hosting: Apache 2.0 local tool, Functional Source License team server',
  },
  {
    path: '/privacy',
    title: 'Privacy | Shapewall',
    description:
      'How Shapewall keeps data local by default, what optional agents and sharing send, and how website analytics differs from cached files and account data.',
    og: 'privacy',
  },
  {
    path: '/legal/terms',
    noindex: true,
    title: 'Terms: operator template | Shapewall',
    description:
      'Draft terms template for a self-hosted Shapewall server. Operators must review and replace this text before inviting their workspace users.',
    og: 'privacy',
  },
  {
    path: '/legal/privacy',
    noindex: true,
    title: 'Privacy: operator template | Shapewall',
    description:
      'Draft privacy template for a self-hosted Shapewall server. Operators must review and replace this text before inviting their workspace users.',
    og: 'privacy',
  },
  {
    path: '/legal/subprocessors',
    noindex: true,
    title: 'Subprocessors: operator template | Shapewall',
    description:
      'Draft subprocessors template for a self-hosted Shapewall server. Operators must review and replace this text before inviting their workspace users.',
    og: 'privacy',
  },
  {
    path: '/legal/acceptable-use',
    noindex: true,
    title: 'Acceptable use: operator template | Shapewall',
    description:
      'Draft acceptable use template for a self-hosted Shapewall server. Operators must review and replace this text before inviting their workspace users.',
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
        title: 'Shapewall docs: introduction',
        description:
          'How Shapewall works in a few minutes: capture every page, see the whole product on one wall, comment on elements, and let an agent make the change.',
      },
      {
        path: '/docs/getting-started',
        file: 'getting-started',
        nav: 'Getting started',
        title: 'Getting started: install, capture, serve | Shapewall',
        description:
          'Install Shapewall, create a config with shapewall init, capture your pages at desktop and phone width, and open the board with shapewall serve.',
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
          'Hand wall comments to Claude Code, Codex or any coding agent: comments as JSON, a prompt that works, watch mode, the MCP server, and safety rules.',
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
          'Connect the board chat to any OpenAI-compatible model: OpenAI, DeepSeek, OpenRouter, Ollama. Images, voice, read aloud, and board text kept as data.',
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
        nav: 'Journeys',
        title: 'Journeys: real user paths across the wall | Shapewall',
        description:
          'Journeys draw arrows between pages from the real links on them, and let you name a user path such as sign up to first project and step through it.',
      },
      {
        path: '/docs/compare',
        file: 'compare',
        nav: 'Before, after and staging',
        title: 'Before and after, staging and production | Shapewall',
        description:
          'See each resolved comment before and after the change, put a branch preview beside the page as a variant, and compare staging with production.',
      },
      {
        path: '/docs/page-checks',
        file: 'page-checks',
        repo: 'page-checks',
        nav: 'Page checks and performance',
        title: 'Page checks: SEO, Lighthouse and accessibility | Shapewall',
        description:
          'Check original pages for reliability, SEO, social images and accessibility. Compare retained lab reports, configure budgets and share diagnostics explicitly.',
      },
    ],
  },
  {
    title: 'Run it',
    docs: [
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
          'Connect a coding agent to a shared board safely: how prompt injection arrives, built-in defenses, least privilege, a sandbox checklist and a PDF.',
        pdf: { href: HARDENING_PDF, size: '8 pages' },
      },
      {
        path: '/docs/faq',
        file: 'faq',
        nav: 'FAQ',
        title: 'FAQ: single-page apps, logins, data | Shapewall',
        description:
          'Answers about single-page apps, signed-in pages, fixed-height frames, browsers, where your data lives, and whether captured pages are safe to share.',
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
        title: 'Notifications: webhook, Slack, Discord, email | Shapewall',
        description:
          'Send comment events to a signed webhook, Slack, Discord or email through Resend, with mentions routed to the right person and secrets kept in env vars.',
      },
      {
        path: '/docs/buzz',
        file: 'buzz',
        repo: 'buzz',
        nav: 'Buzz bridge',
        title: 'Buzz bridge: reach agents in a Buzz channel | Shapewall',
        description:
          'Optional: send board feedback to coding agents that already run in a self-hosted Buzz chat channel, through an owner-only local gateway with signed messages.',
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
    'This page is not on the wall. Try the home page, the features, or the docs, which cover install, config, the agent loop and self-hosting.',
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

export const canonicalUrl = (route) => SITE_URL + (route.path === '/' ? '/' : route.path)
