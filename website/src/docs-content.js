// The docs pages' content, one chunk per page, so no page ships every guide. Each markdown file becomes { html, headings,
// text } at build time (scripts/markdown.mjs). The prerender loads them all before rendering (src/entry-server.jsx),
// src/main.jsx loads the current page's before hydrating, and a page reached by a link loads its own.
// A doc with `repo` is the repository's own guide in docs/ (one source for GitHub, the npm package and this site); the
// rest are src/docs/*.md. Publishing a repository guide: see the list in scripts/markdown.mjs.
import { DOCS } from './routes.js'

const FILES = import.meta.glob('./docs/*.md', { import: 'default' })
const REPO_FILES = import.meta.glob(
  '../../docs/{agent-capabilities,agent-hardening,agent-recipes,agent-workflow,agents,buzz,capture-warnings,config,deployment,github,hosted,interaction-audits,journeys,local-accounts,monitoring,notifications,page-checks,performance,plugins,pull-requests,stability,starter-agent,updates,upgrading,where-to-run}.md',
  { import: 'default' },
)
// The search index: the same files with `?search`, which the markdown plugin turns into { headings, text } only. Loaded
// the first time someone uses the docs search.
const SEARCH_FILES = import.meta.glob('./docs/*.md', { import: 'default', query: '?search' })
const REPO_SEARCH_FILES = import.meta.glob(
  '../../docs/{agent-capabilities,agent-hardening,agent-recipes,agent-workflow,agents,buzz,capture-warnings,config,deployment,github,hosted,interaction-audits,journeys,local-accounts,monitoring,notifications,page-checks,performance,plugins,pull-requests,stability,starter-agent,updates,upgrading,where-to-run}.md',
  { import: 'default', query: '?search' },
)

const key = (doc) => (doc.repo ? `../../docs/${doc.repo}.md` : `./docs/${doc.file}.md`)
const loaded = new Map()

export const loadedDoc = (doc) => loaded.get(doc.path) || null

export function loadDoc(doc) {
  if (loaded.has(doc.path)) return Promise.resolve(loaded.get(doc.path))
  const load = (doc.repo ? REPO_FILES : FILES)[key(doc)]
  if (!load) return Promise.reject(new Error(`no content for ${doc.path}`))
  return load().then((content) => {
    loaded.set(doc.path, content)
    return content
  })
}

export const loadAllDocs = () => Promise.all(DOCS.map(loadDoc))

let searchEntries = null
// Every page and its headings, for the docs search: [{ doc, id, label, haystack }].
export function loadSearchIndex() {
  if (!searchEntries) {
    searchEntries = Promise.all(
      DOCS.map((doc) => {
        const load = (doc.repo ? REPO_SEARCH_FILES : SEARCH_FILES)[key(doc)]
        return load ? load().then((md) => ({ doc, md })) : null
      }),
    ).then((pages) => {
      const entries = []
      for (const page of pages) {
        if (!page) continue
        const { doc, md } = page
        entries.push({ doc, id: null, label: doc.nav, haystack: `${doc.nav} ${doc.description} ${md.text}`.toLowerCase() })
        for (const heading of md.headings) {
          entries.push({ doc, id: heading.id, label: heading.text, haystack: `${heading.text} ${doc.nav}`.toLowerCase() })
        }
      }
      return entries
    })
    searchEntries.catch(() => {
      searchEntries = null
    })
  }
  return searchEntries
}
