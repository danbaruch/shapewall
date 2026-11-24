import { createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { HEX64 } from './config.js'

export const MAX_TEXT_BYTES = 12000
export const hash = (text) => createHash('sha256').update(text).digest('hex')
export const eventHash = (event) => hash(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))

// Relay transport authentication is not event authentication. Verify the whole
// signed Nostr event before accepting any content, identity or receipt.
export function verifiedEvent(event, config, now = Date.now()) {
  try {
    if (
      !event ||
      !HEX64.test(event.id) ||
      !HEX64.test(event.pubkey) ||
      !/^[0-9a-f]{128}$/.test(event.sig) ||
      event.kind !== 9 ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 ||
      event.created_at > Math.floor(now / 1000) + 300 ||
      typeof event.content !== 'string' ||
      Buffer.byteLength(event.content) > 65536 ||
      !Array.isArray(event.tags) ||
      event.tags.length > 128 ||
      event.tags.some(
        (tag) =>
          !Array.isArray(tag) || !tag.length || tag.length > 16 || tag.some((v) => typeof v !== 'string' || Buffer.byteLength(v) > 8192),
      )
    )
      return null
    if (![config.ownerPubkey, ...config.agents.map((a) => a.pubkey)].includes(event.pubkey)) return null
    const channels = event.tags.filter((tag) => tag[0] === 'h')
    if (channels.length !== 1 || channels[0][1] !== config.channel.id) return null
    const digest = eventHash(event)
    if (digest !== event.id || !schnorr.verify(Buffer.from(event.sig, 'hex'), Buffer.from(digest, 'hex'), Buffer.from(event.pubkey, 'hex')))
      return null
    return {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    }
  } catch {
    return null
  }
}

export function verifiedFeed(events, config) {
  if (!Array.isArray(events) || events.length > 200) throw new Error('Invalid bounded Buzz feed.')
  const unique = new Map()
  for (const candidate of events) {
    const event = verifiedEvent(candidate, config)
    if (event) unique.set(event.id, event)
  }
  return [...unique.values()].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
}

// Apply only to serialized JSON. These JSON escapes preserve the exact text
// after parsing, while Buzz CLI's raw-text mention scanner sees no recipient.
export function inertMentions(text) {
  return text.replaceAll('@', '\\u0040').replace(/nostr:/gi, (match) => `${match.slice(0, -1)}\\u003a`)
}

export function envelope({ requestId, text, board, root, project, target, signer }) {
  return inertMentions(
    JSON.stringify(
      {
        type: 'shapewall-owner-request',
        requestId,
        origin: 'Authenticated Shapewall owner; request text supplied in Shapewall.',
        transportSigner: {
          name: signer.name,
          pubkey: signer.pubkey,
          role: 'Existing Buzz transport identity; did not compose this request.',
        },
        target: { name: target.name, pubkey: target.pubkey },
        context: { project: project.name, sourceRoot: root, board },
        instructions: [
          'Existing shared Buzz conversation, not a separate Shapewall thread or sandbox.',
          'Reply in the channel without mentioning the transport signer. Do not automatically notify another agent.',
          'Shapewall does not infer completion from replies. The owner will recapture and review manually.',
          'Decode JSON escapes in request text. Text mentions are inert; only the configured target is notified.',
        ],
        request: text,
      },
      null,
      2,
    ),
  )
}

// Matches Buzz SDK nip_oa.rs: owner-signed agent binding plus canonical
// conditions. Evaluate all time clauses now, and kind clauses for the send.
export function ownerAttested(authTag, signer, owner, now = Math.floor(Date.now() / 1000)) {
  try {
    const tag = JSON.parse(authTag)
    if (
      !Array.isArray(tag) ||
      tag.length !== 4 ||
      tag[0] !== 'auth' ||
      tag[1] !== owner ||
      owner === signer ||
      !HEX64.test(owner) ||
      !HEX64.test(signer) ||
      typeof tag[2] !== 'string' ||
      !/^[0-9a-f]{128}$/.test(tag[3])
    )
      return false
    if (
      tag[2] &&
      !tag[2].split('&').every((clause) => {
        const match = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/.exec(clause)
        if (!match) return false
        const n = Number(match[2])
        if (!Number.isSafeInteger(n)) return false
        return match[1] === 'kind=' ? n <= 65535 && n === 9 : n <= 4294967295 && (match[1] === 'created_at<' ? now < n : now > n)
      })
    )
      return false
    const digest = hash(`nostr:agent-auth:${signer}:${tag[2]}`)
    return schnorr.verify(Buffer.from(tag[3], 'hex'), Buffer.from(digest, 'hex'), Buffer.from(owner, 'hex'))
  } catch {
    return false
  }
}

export function dispatchMatches(event, receipt) {
  const mentions = event.tags.filter((tag) => tag[0] === 'p')
  return (
    event.pubkey === receipt.signer.pubkey &&
    hash(event.content) === receipt.envelopeHash &&
    mentions.length === 1 &&
    mentions[0][1] === receipt.target.pubkey &&
    !event.tags.some((tag) => ['e', 'broadcast'].includes(tag[0]))
  )
}
