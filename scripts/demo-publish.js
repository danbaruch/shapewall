// Publishes the live demo's fictional site (Lumen Notes) as static files under
// shapewall.com, so the board's "Open live" and page links open a real page:
// production at /lumen, staging at /lumen-staging. Used by scripts/demo-export.js
// after the captures, so the board's screenshots never show what this adds.
//
// - Layout: one .html file per page (pricing/index.html becomes
//   lumen/pricing.html, the home page lumen.html), the way the site's own
//   pages are served (/features -> features.html, trailing slash redirected
//   away), so it works with the shapewall.com Caddy config as it is.
// - Links: the site uses root-absolute links (/pricing/, /styles.css); they
//   are rewritten to the prefix (/lumen/pricing, /lumen/styles.css).
// - Clearly a demo: a small fixed banner on every page linking back to the
//   board, noindex on every page, and forms that send nothing (no action, a
//   submit guard, a note under each form), so it can never pass for a real
//   sign-in page.
import fs from 'node:fs'
import path from 'node:path'

export const DEMO_SITES = {
  production: { prefix: '/lumen', label: '' },
  staging: { prefix: '/lumen-staging', label: ' (staging copy)' },
}
export const SITE_ORIGIN = 'https://shapewall.com'
export const BOARD_PATH = '/demo/'
export const BANNER_TEXT = 'Lumen Notes is a fictional demo site for Shapewall'
export const FORM_NOTE = 'Demo only: any details work, or none. Nothing is sent.'
// Where each form goes next in the demo (by its original action), so visitors
// can click through sign in and sign up without filling anything in.
const FORM_NEXT = { '/session': '/app/', '/accounts': '/welcome/', '/reset': '/login/', '/welcome': '/app/' }
const GUARD_FILE = 'demo-guard.js'

// The public URL of a published copy (the board's environment publicUrl).
export const publicUrl = (env) => `${SITE_ORIGIN}${DEMO_SITES[env].prefix}`

function walk(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(folder, entry.name)
      return entry.isDirectory() ? walk(file) : [file]
    })
}

// Where a source file lands, relative to the site root (posix separators).
export function targetPath(relative, prefix) {
  const rel = relative.split(path.sep).join('/')
  const base = prefix.replace(/^\//, '')
  if (rel === 'index.html') return `${base}.html`
  if (rel.endsWith('/index.html')) return `${base}/${rel.slice(0, -'/index.html'.length)}.html`
  return `${base}/${rel}`
}

// A root-absolute link in the source site, as a link under the prefix: page
// directories lose their trailing slash (the clean URL the host serves without
// a redirect), files keep their name.
export function rewriteLink(value, prefix) {
  if (!value.startsWith('/') || value.startsWith('//')) return value
  const [, pathname, rest = ''] = value.match(/^([^?#]*)(.*)$/s)
  if (pathname === '/') return `${prefix}${rest}`
  return `${prefix}${pathname.replace(/\/+$/, '')}${rest}`
}

export function rewriteLinks(text, prefix) {
  return text.replace(/\b(href|src|action)="([^"]*)"/g, (all, name, value) => `${name}="${rewriteLink(value, prefix)}"`)
}

function banner(label) {
  return (
    '<div data-lumen-demo-banner role="note" style="position:fixed;left:50%;bottom:12px;transform:translateX(-50%);' +
    'z-index:2147483647;box-sizing:border-box;max-width:calc(100% - 24px);padding:8px 14px;border-radius:12px;' +
    'background:#111827;color:#f9fafb;font:500 13px/1.4 system-ui,-apple-system,sans-serif;text-align:center;' +
    'box-shadow:0 4px 18px rgba(0,0,0,.28)">' +
    `<a href="${BOARD_PATH}" style="color:inherit;text-decoration:underline;text-underline-offset:2px">${BANNER_TEXT}</a>${label}` +
    '</div>'
  )
}

// Forms keep their look but go nowhere: no action or method, a submit guard
// (inline and in demo-guard.js), no click alerts, no prefilled password or
// token (capture fixtures), and a note under each one.
function guardForms(html, prefix) {
  return html
    .replace(/<form\b([^>]*)>/g, (all, attrs) => {
      const action = (attrs.match(/\saction="([^"]*)"/) || [])[1]
      const kept = attrs.replace(/\s+(action|method)="[^"]*"/g, '')
      const local = action?.startsWith(prefix) ? action.slice(prefix.length) || '/' : action
      const next = FORM_NEXT[local?.replace(/(.)\/+$/, '$1')]
      const nextAttr = next ? ` data-lumen-demo-next="${rewriteLink(next, prefix)}"` : ''
      return `<form${kept} data-lumen-demo-form${nextAttr} novalidate onsubmit="return false">`
    })
    .replace(/(<(?:input|select|textarea)\b[^>]*?)\s+required(?:="[^"]*")?/g, '$1')
    .replace(/\s+onclick="[^"]*"/g, '')
    .replace(/(<input\b[^>]*type="password"[^>]*?)\s+value="[^"]*"/g, '$1')
    .replace(/\n?[ \t]*<input type="hidden" name="csrf_token"[^>]*>/g, '')
    .replace(
      /<\/form>/g,
      `  <p class="meta" data-lumen-demo-note role="note" style="margin:0;font-weight:600">${FORM_NOTE}</p>\n        </form>`,
    )
}

const GUARD_SCRIPT = `// Lumen Notes is a fictional demo site for Shapewall: its forms send nothing.
document.addEventListener(
  'submit',
  (event) => {
    event.preventDefault()
    const next = event.target.getAttribute('data-lumen-demo-next')
    if (next) {
      location.assign(next)
      return
    }
    const note = event.target.querySelector('[data-lumen-demo-note]')
    if (note) note.textContent = 'Nothing was sent: Lumen Notes is a demo site.'
  },
  true,
)
`

// One page of a published copy.
export function publishHtml(html, { prefix, label = '' }) {
  let out = rewriteLinks(html, prefix)
  const hasForm = /<form\b/.test(out)
  if (hasForm) out = guardForms(out, prefix)
  const head = [
    '<meta name="robots" content="noindex,nofollow" />',
    // Room below the last content for the fixed banner.
    '<style>body{padding-bottom:64px}</style>',
    ...(hasForm ? [`<script src="${prefix}/${GUARD_FILE}" defer></script>`] : []),
  ]
  if (!/<\/head>/.test(out) || !/<body\b[^>]*>/.test(out)) throw new Error('demo publish: a page without <head> or <body>')
  out = out.replace('</head>', `  ${head.join('\n    ')}\n  </head>`)
  out = out.replace(/<body\b[^>]*>/, (tag) => `${tag}\n    ${banner(label)}`)
  return out
}

// Writes a copy of `sourceDir` (a Lumen Notes site) under `siteRoot` for one
// of DEMO_SITES. Returns the files written, relative to siteRoot.
export function publishDemoSite(sourceDir, siteRoot, env) {
  const { prefix, label } = DEMO_SITES[env]
  const base = prefix.replace(/^\//, '')
  fs.rmSync(path.join(siteRoot, base), { recursive: true, force: true })
  fs.rmSync(path.join(siteRoot, `${base}.html`), { force: true })
  const written = []
  const write = (rel, data) => {
    const file = path.join(siteRoot, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
    written.push(rel)
  }
  for (const file of walk(sourceDir)) {
    const rel = path.relative(sourceDir, file)
    const target = targetPath(rel, prefix)
    if (rel.endsWith('.html')) write(target, publishHtml(fs.readFileSync(file, 'utf8'), { prefix, label }))
    else if (rel.endsWith('.js') || rel.endsWith('.css')) write(target, rewriteLinks(fs.readFileSync(file, 'utf8'), prefix))
    else write(target, fs.readFileSync(file))
  }
  write(`${base}/${GUARD_FILE}`, GUARD_SCRIPT)
  return written
}
