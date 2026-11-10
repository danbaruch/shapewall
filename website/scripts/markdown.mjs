// Vite plugin: `import doc from './docs/x.md'` gives { html, headings, text }. Headings (h2, h3) get stable ids
// for anchors and the "On this page" list; `text` is the plain text, for the docs search.
//
// Two sources: src/docs/*.md (pages written for the site) and ../docs/*.md (the repository's own guides, shown on
// the site as they are, so the two cannot drift). A repository guide is adapted on the way in: its title goes (the
// page header shows it), links to other guides become site routes, and links to other repository files point at GitHub.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked, Renderer } from 'marked'
import { GITHUB_URL, INSTALL_PACKAGE, LAUNCHED } from '../src/launch.js'

const REPO_DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs')
// Repository guides that are site pages: file name in docs/ -> route. Everything else links to GitHub.
const SAME_NAME = [
  'agent-hardening',
  'agent-recipes',
  'agent-workflow',
  'buzz',
  'capture-warnings',
  'config',
  'github',
  'hosted',
  'journeys',
  'local-accounts',
  'notifications',
  'page-checks',
  'starter-agent',
  'updates',
]
const SITE_PATHS = {
  'agents.md': '/docs/chat',
  'deployment.md': '/docs/self-hosting',
  ...Object.fromEntries(SAME_NAME.map((name) => [`${name}.md`, `/docs/${name}`])),
}

function siteHref(href) {
  if (href.startsWith('https://shapewall.com/')) return href.slice('https://shapewall.com'.length)
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href
  const [file, hash] = href.split('#')
  const anchor = hash ? `#${hash}` : ''
  if (SITE_PATHS[file]) return SITE_PATHS[file] + anchor
  return `${GITHUB_URL}/blob/main/${path.posix.normalize(path.posix.join('docs', file))}${anchor}`
}

// A guide from ../docs as a site page. Fenced code is left alone.
export function fromRepoDoc(source) {
  return source
    .replace(/^# .*\n+/, '')
    .split(/(^```[\s\S]*?^```$)/m)
    .map((part) =>
      part.startsWith('```')
        ? part
        : part.replace(/^!\[[^\]]*\]\(images\/[^)]*\)\n+/gm, '').replace(/\]\(([^)\s]+)\)/g, (all, href) => `](${siteHref(href)})`),
    )
    .join('')
}

// Site pages can say different things before and after launch:
//   <!-- launched --> ... <!-- /launched -->      kept when SHAPEWALL_LAUNCHED=1
//   <!-- prelaunch --> ... <!-- /prelaunch -->    kept otherwise
// and %INSTALL_PACKAGE% is what `npm install` takes (github:owner/repo until the package is on npm).
export function applyLaunch(source, launched = LAUNCHED) {
  const drop = launched ? 'prelaunch' : 'launched'
  const keep = launched ? 'launched' : 'prelaunch'
  return source
    .replace(new RegExp(`<!-- ${drop} -->[\\s\\S]*?<!-- /${drop} -->\\n?`, 'g'), '')
    .replace(new RegExp(`<!-- /?${keep} -->\\n?`, 'g'), '')
    .replaceAll('%INSTALL_PACKAGE%', INSTALL_PACKAGE)
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

const decode = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export function renderMarkdown(source) {
  const headings = []
  const used = new Map()
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        if (depth !== 2 && depth !== 3) return `<h${depth}>${inner}</h${depth}>\n`
        const base = slugify(inner) || 'section'
        const count = used.get(base) || 0
        used.set(base, count + 1)
        const id = count ? `${base}-${count}` : base
        headings.push({ id, depth, text: decode(inner) })
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`
      },
      table(token) {
        // Wide tables scroll on their own instead of the whole page.
        return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`
      },
      code(token) {
        const lang = (token.lang || '').split(/\s/)[0]
        const label = {
          sh: 'Terminal',
          json: 'JSON',
          js: 'JavaScript',
          caddyfile: 'Caddyfile',
          text: '',
          yaml: 'YAML',
          dockerfile: 'Dockerfile',
        }[lang]
        const body = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<div class="code"${label ? ` data-label="${label}"` : ''}><pre><code${lang ? ` class="language-${lang}"` : ''}>${body}</code></pre></div>\n`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        const external = /^https?:\/\//.test(href)
        const download = /^\/downloads\//.test(href)
        return `<a href="${href}"${title ? ` title="${title}"` : ''}${external ? ' rel="noopener"' : ''}${download ? ' download' : ''}>${text}</a>`
      },
    },
  })
  const html = marked.parse(source)
  const text = decode(
    html
      .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
      .replace(/<a class="anchor"[^>]*>#<\/a>/g, '')
      .replace(/<\/(p|h\d|li|td|th)>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
  return { html, headings, text }
}

export function markdown() {
  return {
    name: 'shapewall-markdown',
    enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0]
      if (!file.endsWith('.md')) return null
      const fromRepo = path.resolve(file).startsWith(REPO_DOCS + path.sep)
      const text = applyLaunch(fromRepo ? fromRepoDoc(source) : source)
      return { code: `export default ${JSON.stringify(renderMarkdown(text))}`, map: null }
    },
  }
}
