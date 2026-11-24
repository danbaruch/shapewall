// The changelog (the repository's CHANGELOG.md, rendered by scripts/markdown.mjs) is large, so it is a chunk of its own,
// fetched only for /changelog: the prerender loads it before rendering, src/main.jsx before hydrating that page, and
// the page itself when it is reached by a link.
let data = null

export function loadChangelog() {
  return import('../../CHANGELOG.md').then((mod) => {
    data = mod.default
    return data
  })
}

export const loadedChangelog = () => data
