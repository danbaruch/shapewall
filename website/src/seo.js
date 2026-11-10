// Head tags, structured data, robots.txt and sitemap.xml. Plain JS, used by scripts/prerender.mjs at build time
// (Node only: it reads the package version from disk).
import fs from 'node:fs'
import { AUTHOR, DEMO_SITE_PATHS, GITHUB_URL, ROUTES, SITE_URL, canonicalUrl } from './routes.js'
import { LAUNCHED } from './launch.js'
import { FAQ } from './faq-data.js'

// The version people install: the root package.json, so a release bump reaches the structured data by itself.
const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
// Two licenses: the local tool (Apache 2.0) and the self-hosted team server in src/hosted (FSL 1.1, Apache 2.0 future).
const LICENSES = ['https://www.apache.org/licenses/LICENSE-2.0', 'https://fsl.software/']
const DEFAULT_ALT = 'The Shapewall logo beside a wall of captured pages'
export const ogImageAlt = (route) => route.alt || (route.kind === 'doc' ? `Shapewall docs: ${route.nav}` : DEFAULT_ALT)

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const ogImageUrl = (route) => `${SITE_URL}/og/${route.og}.jpg`

// Home > Docs > page, or Home > page: the trail search results show above the title.
function breadcrumbs(route, url) {
  const crumb = (position, name, item) => ({ '@type': 'ListItem', position, name, item })
  const trail = [crumb(1, 'Shapewall', `${SITE_URL}/`)]
  if (route.kind === 'doc' && route.path !== '/docs') trail.push(crumb(2, 'Docs', `${SITE_URL}/docs`))
  trail.push(crumb(trail.length + 1, route.nav || route.title.split(/[:|]/)[0].trim(), url))
  return { '@type': 'BreadcrumbList', itemListElement: trail }
}

function jsonLd(route) {
  const url = canonicalUrl(route)
  const website = { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, name: 'Shapewall', url: `${SITE_URL}/`, inLanguage: 'en' }
  const organization = {
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: 'Shapewall',
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/icon-512.png`,
    sameAs: [GITHUB_URL],
  }
  if (route.path === '/') {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        organization,
        { ...website, publisher: { '@id': `${SITE_URL}/#organization` } },
        // The same questions and answers the page shows.
        {
          '@type': 'FAQPage',
          mainEntity: FAQ.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })),
        },
        {
          '@type': 'SoftwareApplication',
          name: 'Shapewall',
          url: `${SITE_URL}/`,
          description: route.description,
          applicationCategory: 'DeveloperApplication',
          operatingSystem: 'macOS, Linux, Windows (Node.js 22 or newer)',
          softwareVersion: VERSION,
          license: LICENSES,
          // Free to use once it is public. Before launch there is nothing a visitor can get, so no Offer.
          ...(LAUNCHED ? { offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, codeRepository: GITHUB_URL } : {}),
          image: ogImageUrl(route),
          author: { '@type': 'Person', name: AUTHOR },
          publisher: { '@id': `${SITE_URL}/#organization` },
        },
      ],
    }
  }
  if (route.kind === 'doc') {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'TechArticle',
          headline: route.nav === 'Introduction' ? 'Shapewall docs' : route.nav,
          description: route.description,
          url,
          image: ogImageUrl(route),
          inLanguage: 'en',
          author: { '@type': 'Person', name: AUTHOR },
          publisher: organization,
          isPartOf: website,
        },
        breadcrumbs(route, url),
      ],
    }
  }
  // Every other public page: what it is, whose site it belongs to, and where it sits.
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        name: route.title,
        description: route.description,
        url,
        inLanguage: 'en',
        primaryImageOfPage: ogImageUrl(route),
        isPartOf: website,
        publisher: organization,
      },
      breadcrumbs(route, url),
    ],
  }
}

// The tags between <!--seo--> and <!--/seo--> in each page's <head>.
export function headTags(route, { stealth }) {
  const url = canonicalUrl(route)
  const image = ogImageUrl(route)
  const noindex = stealth || route.notFound || route.noindex
  const tags = [
    `<title>${esc(route.title)}</title>`,
    `<meta name="description" content="${esc(route.description)}">`,
    noindex ? '<meta name="robots" content="noindex,nofollow">' : '<meta name="robots" content="index,follow">',
    route.notFound ? '' : `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:site_name" content="Shapewall">',
    `<meta property="og:type" content="${route.kind === 'doc' ? 'article' : 'website'}">`,
    `<meta property="og:title" content="${esc(route.title)}">`,
    `<meta property="og:description" content="${esc(route.description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${esc(ogImageAlt(route))}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(route.title)}">`,
    `<meta name="twitter:description" content="${esc(route.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<meta name="twitter:image:alt" content="${esc(ogImageAlt(route))}">`,
  ]
  const data = route.notFound ? null : jsonLd(route)
  if (data) tags.push(`<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`)
  return tags.filter(Boolean).join('\n    ')
}

export function robotsTxt({ stealth }) {
  if (stealth) return 'User-agent: *\nDisallow: /\n'
  // Prefix rules: /lumen covers /lumen.html's clean URL /lumen and everything under /lumen/.
  const demoSites = DEMO_SITE_PATHS.map((prefix) => `Disallow: ${prefix}\n`).join('')
  return `User-agent: *\nAllow: /\n${demoSites}\nSitemap: ${SITE_URL}/sitemap.xml\n`
}

export function sitemapXml(lastmod = () => null) {
  // Pages marked noindex (the operator legal templates) stay out of the sitemap.
  const urls = ROUTES.filter((route) => !route.noindex).map((route) => {
    const date = lastmod(route)
    return `  <url>\n    <loc>${canonicalUrl(route)}</loc>${date ? `\n    <lastmod>${date}</lastmod>` : ''}\n  </url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}
