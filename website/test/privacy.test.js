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
