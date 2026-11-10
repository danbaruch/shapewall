// Invite emails for the hosted server, through Resend like the local
// notifications (src/notify). Off unless RESEND_API_KEY and
// SHAPEWALL_EMAIL_FROM are set. The key is read from the environment when a
// message is sent and never logged; log lines name the outcome only.
//
// The message carries the invite link (its token is in the fragment, as on
// the console). Everything else in it is plain text the server wrote; the
// workspace name and the inviter's name are escaped for the HTML part.

import { RESEND_URL } from '../notify/index.js'

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/
const TIMEOUT_MS = 10_000

export function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim() : ''
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null
}

const htmlEscape = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ')

export function inviteMessage({ from, to, workspaceName, role, url, inviterName, expiresAt }) {
  const expires = new Date(expiresAt).toUTCString().replace(/ GMT$/, ' UTC')
  // Names are free text that anyone with an account chooses, so they stay out
  // of the subject (where they would read as the sender's own words) and are
  // quoted as names in the body.
  const subject = 'You have an invite to a Shapewall workspace'
  const text = [
    `${oneLine(inviterName)} (a name they chose) invited you to the workspace "${oneLine(workspaceName)}" on Shapewall as ${role === 'admin' ? 'an' : 'a'} ${role}.`,
    '',
    `Open this link to join (it works once and expires ${expires}):`,
    url,
    '',
    'Shapewall uses passkeys, so there is no password to set. If you did not expect this, ignore it.',
  ].join('\n')
  const html = [
    `<p>${htmlEscape(oneLine(inviterName))} (a name they chose) invited you to the workspace &ldquo;${htmlEscape(oneLine(workspaceName))}&rdquo; on Shapewall as ${role === 'admin' ? 'an' : 'a'} ${htmlEscape(role)}.</p>`,
    `<p><a href="${htmlEscape(url)}">Open the invite</a> (${htmlEscape(new URL(url).host)})</p>`,
    `<p style="color:#666">The link works once and expires ${htmlEscape(expires)}. Shapewall uses passkeys, so there is no password to set. If you did not expect this, ignore it.</p>`,
  ].join('')
  return { from, to: [to], subject, text, html }
}

// createMailer({ env, fetch, log }) -> { configured, sendInvite(details) }.
// sendInvite resolves { ok, error }; it never throws.
export function createMailer({ env = process.env, fetch = globalThis.fetch, log = () => {} } = {}) {
  const configured = Boolean(env.RESEND_API_KEY && env.SHAPEWALL_EMAIL_FROM)
  async function sendInvite(details) {
    if (!configured) return { ok: false, error: 'email is not configured' }
    const message = inviteMessage({ ...details, from: env.SHAPEWALL_EMAIL_FROM })
    try {
      const response = await fetch(env.SHAPEWALL_RESEND_URL || RESEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}`, 'User-Agent': 'Shapewall-Hosted' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      })
      await response.arrayBuffer().catch(() => null)
      if (!response.ok) {
        log(`mail: invite email failed (HTTP ${response.status})`)
        return { ok: false, error: `the email service answered ${response.status}` }
      }
      return { ok: true }
    } catch (error) {
      log(`mail: invite email failed (${error?.name === 'TimeoutError' ? 'timed out' : 'network error'})`)
      return { ok: false, error: 'the email service could not be reached' }
    }
  }
  return { configured, sendInvite }
}
