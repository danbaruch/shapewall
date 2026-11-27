// Vite plugin: `import doc from './docs/x.md'` gives { html, headings, text }. Headings (h2, h3) get stable ids
// for anchors and the "On this page" list; `text` is the plain text, for the docs search.
//
// Two sources: src/docs/*.md (pages written for the site) and ../docs/*.md (the repository's own guides, shown on
// the site as they are, so the two cannot drift). A repository guide is adapted on the way in: its title goes (the
// page header shows it), links to other guides become site routes, and links to other repository files point at GitHub.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked, Renderer } from 'marked'
import { GITHUB_URL, INSTALL_PACKAGE, LAUNCHED } from '../src/launch.js'
import { publicChangelogEntry } from './changelog-public.mjs'

const REPO_DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs')
// Repository guides that are site pages: file name in docs/ -> route. Everything else links to GitHub.
// Publishing one of docs/*.md needs three lists to agree: a `repo:` entry in src/routes.js, the name here (or
// SITE_PATHS below when the route is not /docs/<file name>), and the two brace lists in src/docs-content.js.
const SAME_NAME = [
  'agent-capabilities',
  'agent-hardening',
  'agent-recipes',
  'agent-workflow',
  'buzz',
  'capture-warnings',
  'config',
  'github',
  'hosted',
  'interaction-audits',
  'journeys',
  'local-accounts',
  'monitoring',
  'notifications',
  'page-checks',
  'performance',
  'plugins',
  'pull-requests',
  'stability',
  'starter-agent',
  'updates',
  'where-to-run',
]
const SITE_PATHS = {
  'agents.md': '/docs/chat',
  'deployment.md': '/docs/self-hosting',
  ...Object.fromEntries(SAME_NAME.map((name) => [`${name}.md`, `/docs/${name}`])),
}

function siteHref(href) {
  if (href.startsWith('https://shapewall.com/')) return href.slice('https://shapewall.com'.length)
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href
  // SITE_PATHS is keyed by bare file name, so `./config.md` has to lose the `./` or it would leak to GitHub.
  const [file, hash] = href.replace(/^\.\//, '').split('#')
  const anchor = hash ? `#${hash}` : ''
  if (SITE_PATHS[file]) return SITE_PATHS[file] + anchor
  return `${GITHUB_URL}/blob/main/${path.posix.normalize(path.posix.join('docs', file))}${anchor}`
}

// A guide from ../docs as a site page. Fenced code is left alone.
// Writing a guide: an image only drops out when `![alt](images/x.png)` is the whole line. An inline one, or one under
// another folder, stays and its href becomes a GitHub blob URL, which is a picture the site cannot show.
export function fromRepoDoc(source) {
  return source
    .replace(/^# .*\n+/, '')
    .split(/(^```[\s\S]*?^```$)/m)
    .map((part) =>
      part.startsWith('```')
        ? part
        : part
            .replace(/^!\[[^\]]*\]\(images\/[^)]*\)\n+/gm, '')
            // The optional second group keeps a link title, `](config.md "Config")`, which the href alone would drop.
            .replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (all, href, title = '') => `](${siteHref(href)}${title})`),
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

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

// Width and height of a WebP or PNG in public/, read from its header. Null for anything else.
export function siteImageSize(href) {
  if (!href.startsWith('/images/')) return null
  let data
  try {
    data = fs.readFileSync(path.join(PUBLIC, href.slice(1)))
  } catch {
    return null
  }
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = data.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = data.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
  return null
}

export function renderMarkdown(source, { idPrefix = '' } = {}) {
  const headings = []
  const used = new Map()
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        if (depth !== 2 && depth !== 3) return `<h${depth}>${inner}</h${depth}>\n`
        const base = idPrefix + (slugify(inner) || 'section')
        const count = used.get(base) || 0
        used.set(base, count + 1)
        const id = count ? `${base}-${count}` : base
        headings.push({ id, depth, text: decode(inner) })
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`
      },
      table(token) {
        // Wide tables scroll on their own instead of the whole page.
        return `<div class="table-wrap" tabindex="0">${Renderer.prototype.table.call(this, token)}</div>\n`
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
        return `<div class="code"${label ? ` data-label="${label}"` : ''}><pre tabindex="0"><code${lang ? ` class="language-${escapeAttr(lang)}"` : ''}>${body}</code></pre></div>\n`
      },
      // A checklist item ("- [ ] ...") is read-only on the site; its state is its name for screen readers.
      checkbox({ checked }) {
        return `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? 'Done' : 'To do'}"> `
      },
      image({ href, title, text }) {
        // A site image (public/images) gets its real size, so the page does not move as it loads, and loads lazily.
        const size = siteImageSize(href)
        const attrs = size ? ` width="${size.width}" height="${size.height}"` : ''
        return `<img src="${escapeAttr(href)}" alt="${escapeAttr(text)}"${title ? ` title="${escapeAttr(title)}"` : ''}${attrs} loading="lazy" decoding="async">`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        const external = /^https?:\/\//.test(href)
        const download = /^\/downloads\//.test(href)
        return `<a href="${escapeAttr(href)}"${title ? ` title="${escapeAttr(title)}"` : ''}${external ? ' rel="noopener"' : ''}${download ? ' download' : ''}>${text}</a>`
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

// The repository's CHANGELOG.md as the /changelog page: one entry per version, from the same file, so the page never
// drifts from it. Its links are relative to the repository root: guides that are site pages become routes, other files
// point at GitHub. Text such as "Left on <environment>" is text, not a tag.
export const CHANGELOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md')

function changelogHref(href) {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href
  const [file, hash] = href.replace(/^\.\//, '').split('#')
  const anchor = hash ? `#${hash}` : ''
  if (file.startsWith('docs/') && !file.slice(5).includes('/')) return siteHref(file.slice(5) + anchor)
  const page = /^website\/src\/docs\/([\w-]+)\.md$/.exec(file)
  if (page) return (page[1] === 'index' ? '/docs' : `/docs/${page[1]}`) + anchor
  return `${GITHUB_URL}/blob/main/${path.posix.normalize(file)}${anchor}`
}

const textNotTags = (markdownText) =>
  markdownText
    .split(/(^```[\s\S]*?^```$|`[^`\n]*`)/m)
    .map((part, index) => (index % 2 ? part : part.replace(/</g, '&lt;')))
    .join('')

export function renderChangelog(source) {
  const [head, ...entries] = source.replace(/^# .*\n+/, '').split(/^## /m)
  const links = (text) => text.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (all, href, title = '') => `](${changelogHref(href)}${title})`)
  // Work merged but not yet released stays off the site until it ships: Keep a Changelog's "## Unreleased", and a version
  // whose date is still the placeholder ("## 1.2.3 - YYYY-MM-DD"), set when the release is cut.
  const versions = entries
    .filter((entry) => !/^Unreleased\s*\n/i.test(entry) && !/^\S+\s+-\s+YYYY-MM-DD\s*\n/.test(entry))
    .map((entry) => {
      const [title, ...body] = entry.split('\n')
      const match = /^(\d+\.\d+\.\d+(?:-[\w.]+)?)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(title)
      if (!match) throw new Error(`CHANGELOG.md: a version heading reads "## ${title}"; expected "## 1.2.3 - YYYY-MM-DD"`)
      const id = `v${match[1].replace(/\./g, '-')}`
      // Lines about building and deploying shapewall.com itself stay in the file and off the page (scripts/changelog-public.mjs).
      const rendered = renderMarkdown(textNotTags(links(publicChangelogEntry(body.join('\n').trim()))), { idPrefix: `${id}-` })
      // A local address quoted in an entry (an error message, say) stays text: on this site it would link to the reader's machine.
      const html = rendered.html.replace(/<a href="https?:\/\/(?:127\.0\.0\.1|localhost)[^"]*"[^>]*>([^<]*)<\/a>/g, '$1')
      return { version: match[1], date: match[2], id, html, headings: rendered.headings }
    })
  return { intro: renderMarkdown(textNotTags(links(head.trim()))).html, versions }
}

export function markdown() {
  return {
    name: 'shapewall-markdown',
    enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0]
      if (!file.endsWith('.md')) return null
      if (path.resolve(file) === CHANGELOG) return { code: `export default ${JSON.stringify(renderChangelog(source))}`, map: null }
      const fromRepo = path.resolve(file).startsWith(REPO_DOCS + path.sep)
      const text = applyLaunch(fromRepo ? fromRepoDoc(source) : source)
      const rendered = renderMarkdown(text)
      // `?search` (src/docs-content.js): only what the docs search reads, so the search index is a fraction of the pages.
      const body = /[?&]search\b/.test(id) ? { headings: rendered.headings, text: rendered.text } : rendered
      return { code: `export default ${JSON.stringify(body)}`, map: null }
    },
  }
}
