// Fictional identities only. Never use real environment files or relays.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { randomUUID } from 'node:crypto'
import { eventHash, hash } from '../../src/buzz/verify.js'

export const keys = Object.fromEntries(['owner', 'codex', 'claude', 'goose', 'stranger'].map((id, i) => [id, Buffer.alloc(32, i + 1)]))
export const pubkeys = Object.fromEntries(
  Object.entries(keys).map(([id, key]) => [id, Buffer.from(schnorr.getPublicKey(key)).toString('hex')]),
)
export const channel = 'f1111111-1111-4111-8111-111111111111'

export function signed(content, { author = 'codex', tags = [['h', channel]], created_at = Math.floor(Date.now() / 1000) } = {}) {
  const event = { pubkey: pubkeys[author], kind: 9, content, tags, created_at }
  event.id = eventHash(event)
  event.sig = Buffer.from(schnorr.sign(Buffer.from(event.id, 'hex'), keys[author])).toString('hex')
  return event
}

export function attestation(id, { owner = 'owner', conditions = '' } = {}) {
  const digest = hash(`nostr:agent-auth:${pubkeys[id]}:${conditions}`)
  return JSON.stringify([
    'auth',
    pubkeys[owner],
    conditions,
    Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), keys[owner])).toString('hex'),
  ])
}

export function signerEnv(id) {
  return { BUZZ_PRIVATE_KEY: keys[id].toString('hex'), BUZZ_AUTH_TAG: attestation(id), BUZZ_RELAY_URL: 'wss://relay.invalid' }
}

export function fixture() {
  // A fresh machine (CI) has no ~/.cache yet.
  const cache = path.join(os.homedir(), '.cache')
  fs.mkdirSync(cache, { recursive: true })
  const dir = fs.mkdtempSync(path.join(cache, 'sw-bz-test-'))
  const root = path.join(dir, 'source')
  const privateDir = path.join(dir, 'private')
  fs.mkdirSync(root)
  fs.mkdirSync(privateDir, { mode: 0o700 })
  const config = {
    version: 1,
    relayUrl: 'wss://relay.invalid',
    ownerPubkey: pubkeys.owner,
    channel: { id: channel, name: 'fictional' },
    agents: ['codex', 'claude', 'goose'].map((id) => ({ id, name: id === 'claude' ? 'Claude Code' : id, pubkey: pubkeys[id] })),
    projects: [{ root, name: 'Fictional project', boards: ['home'] }],
    socketPath: path.join(privateDir, 'b.sock'),
    stateDir: path.join(privateDir, 'journal'),
    signerFiles: { codex: path.join(privateDir, 'codex.env'), claude: path.join(privateDir, 'claude.env') },
  }
  const file = path.join(privateDir, 'bridge.json')
  const save = () => fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  save()
  return { dir, root, privateDir, config: { ...config, file }, file, save, close: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

export const ownerRequest = (f, more = {}) => ({
  root: f.root,
  board: 'home',
  target: 'codex',
  text: 'Please inspect the fictional source.',
  requestId: randomUUID(),
  ...more,
})

export function fixtureTransport() {
  const calls = []
  const events = []
  let ambiguous = false
  return {
    calls,
    events,
    set ambiguous(value) {
      ambiguous = value
    },
    async run(file, request) {
      calls.push(request)
      if (request.action === 'feed') return { events }
      if (request.action === 'event') return { events: events.filter((e) => e.id === request.eventId) }
      throw new Error(`Set dispatch fixture explicitly: ${file ? 'configured' : 'missing'}`)
    },
    async dispatch(request, content, signer = 'claude') {
      const event = signed(content, {
        author: signer,
        tags: [
          ['h', channel],
          ['p', pubkeys[request.target]],
        ],
      })
      events.push(event)
      return ambiguous ? { outcome: 'unknown' } : { outcome: 'accepted', eventId: event.id }
    },
  }
}
