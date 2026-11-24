// The privacy page's contact-form paragraph matches what the contact service (contact/server.mjs) keeps and
// where it can send it: every stored field, and the optional forward to a messaging service. Generic wording:
// the paragraph names no messaging vendor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const privacy = read('../src/pages/Privacy.jsx')
const server = read('../contact/server.mjs')
const contactParagraph = (/<p id="contact-form">([\s\S]*?)<\/p>/.exec(privacy)?.[1] || '').replace(/\s+/g, ' ')

test('the contact-form notice lists every field the service stores', () => {
  assert.ok(contactParagraph, 'the paragraph is there')
  // What the service writes for each message (the INSERT of a contact message).
  assert.match(server, /insert\.run\(t, entry\.kind, entry\.message, entry\.email, ipHash, userAgent\)/)
  for (const said of [
    'your message',
    'the topic you chose',
    'your email address if you gave one',
    'User-Agent',
    'one-way hash of your IP address',
  ])
    assert.ok(contactParagraph.includes(said), `says: ${said}`)
})

test('the contact-form notice says messages may be forwarded to a messaging service, without naming one', () => {
  assert.match(server, /status = await send\(formatForTelegram\(entry\)\)/, 'the service can forward each message')
  assert.match(contactParagraph, /If the site operator has set it up, .*forwarded to a messaging service/)
  assert.ok(!/telegram/i.test(contactParagraph), 'no vendor name')
})

// Privacy docs stay generic: the page says what each service gets, never which vendor runs it.
test('the privacy page names no analytics, hosting, error-tracking or messaging vendor', () => {
  const vendors = [
    'umami',
    'cloudflare',
    'cloudflareinsights',
    'glitchtip',
    'sentry',
    'telegram',
    'digitalocean',
    'droplet',
    'caddy',
    'plausible',
    'google analytics',
    'resend',
    'tailscale',
  ]
  const text = privacy.toLowerCase()
  for (const name of vendors) assert.ok(!text.includes(name), `names ${name}`)
  // The facts stay: both analytics tools, what they keep, and the content delivery network.
  const flat = privacy.replace(/\s+/g, ' ')
  assert.match(flat, /a privacy-friendly analytics service we host ourselves/)
  assert.match(flat, /served through a content delivery network/)
  assert.match(flat, /reports page views and load times/)
  assert.match(flat, /apart from the two analytics tools above, no third-party scripts/)
})

// The error-reports paragraph matches what the site's error setup sends (src/main.jsx, src/errors.js and the shared
// scrubber ../src/error-scrub.js): only with a build-time DSN, only on the real site, and scrubbed before it leaves.
test('the error-reports notice matches what the site sends, and names no vendor', () => {
  const main = read('../src/main.jsx')
  const errors = read('../src/errors.js')
  const scrub = read('../../src/error-scrub.js')
  const paragraph = (/<p id="error-reports">([\s\S]*?)<\/p>/.exec(privacy)?.[1] || '').replace(/\s+/g, ' ')
  assert.ok(paragraph, 'the paragraph is there')
  // Off unless the build turns it on, and only on shapewall.com itself.
  assert.match(main, /if \(__SHAPEWALL_ERROR_DSN__ && window\.location\.hostname === __SHAPEWALL_ERROR_HOST__\)/)
  assert.match(read('../vite.config.js'), /SHAPEWALL_ERROR_HOST \|\| ''\)\.trim\(\)\.toLowerCase\(\) \|\| 'shapewall\.com'/)
  assert.match(paragraph, /When error reporting is turned on for this site/)
  // Scrubbed before sending: no identities, no default personal data, no console lines or clicks.
  assert.match(errors, /sendDefaultPii: false/)
  assert.match(errors, /beforeSend: \(event\) => scrubEvent\(event\)/)
  assert.match(errors, /breadcrumbsIntegration\(\{ console: false, dom: false,/)
  assert.match(scrub, /const bare = value\.replace\(\/\[\?#\]/, 'query strings and fragments are cut from every URL')
  assert.match(
    scrub,
    /\.\.\.\(typeof userAgent === 'string' \? \{ headers: \{ 'User-Agent': userAgent \} \} : \{\}\)/,
    'only the User-Agent header',
  )
  assert.match(scrub, /export function scrubMessage/)
  for (const said of [
    'the error message with any quoted text removed',
    'where in our code it happened',
    'the page path',
    'the pages and requests just before it',
    'User-Agent',
    'never carry cookies, form contents, query strings or what you typed',
    'an error-tracking service we host ourselves',
  ])
    assert.ok(paragraph.includes(said), `says: ${said}`)
})
