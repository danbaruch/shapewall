// The only bridge process that reads existing Buzz credentials. Its parent
// starts it with a minimal environment. Never log inputs, CLI stderr or keys.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bech32 } from '@scure/base'
import { CLI, SIGNERS, HEX64, loadBridgeConfig, privatePath, projectFor } from './config.js'
import { envelope, MAX_TEXT_BYTES, ownerAttested } from './verify.js'
import { signerBaseEnvironment } from './environment.js'

const PERMITTED = new Set(['BUZZ_PRIVATE_KEY', 'BUZZ_AUTH_TAG', 'BUZZ_RELAY_URL'])

// Deliberately a strict subset of EnvironmentFile syntax, never a shell.
// Unsupported quoting fails closed. Unrelated lines are never interpreted.
export function parseSignerEnv(text) {
  if (Buffer.byteLength(text) > 131072) throw new Error('Invalid signer environment.')
  const result = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match || !PERMITTED.has(match[1])) continue
    if (Object.hasOwn(result, match[1])) throw new Error('Duplicate signer environment variable.')
    let value = match[2].trim()
    if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.slice(1, -1).includes("'")) throw new Error('Unsupported signer quoting.')
      value = value.slice(1, -1)
    } else if (value.startsWith('"')) {
      if (!value.endsWith('"') || /(?<!\\)"/.test(value.slice(1, -1))) throw new Error('Unsupported signer quoting.')
      value = value.slice(1, -1).replace(/\\([\\"`$])/g, '$1')
      if (/\\/.test(value)) throw new Error('Unsupported signer escaping.')
    } else if (/[\\'"\s]/.test(value)) throw new Error('Unsupported signer quoting.')
    if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid signer environment value.')
    result[match[1]] = value
  }
  if ([...PERMITTED].some((key) => !result[key])) throw new Error('Missing signer environment variable.')
  return result
}

export function checkSigner(env, signer, config) {
  let secret
  if (HEX64.test(env.BUZZ_PRIVATE_KEY)) secret = Buffer.from(env.BUZZ_PRIVATE_KEY, 'hex')
  else {
    const decoded = bech32.decode(env.BUZZ_PRIVATE_KEY, 100)
    if (decoded.prefix !== 'nsec') throw new Error('Invalid signer identity.')
    secret = Uint8Array.from(bech32.fromWords(decoded.words))
  }
  try {
    const pubkey = Buffer.from(schnorr.getPublicKey(secret)).toString('hex')
    if (
      pubkey !== signer.pubkey ||
      !ownerAttested(env.BUZZ_AUTH_TAG, pubkey, config.ownerPubkey) ||
      new URL(env.BUZZ_RELAY_URL).href !== new URL(config.relayUrl).href
    )
      throw new Error('Signer identity, owner attestation or relay does not match.')
  } finally {
    secret?.fill(0)
  }
}

// `buzz channels members` emits objects, not public-key strings. Do not
// coerce unknown/malformed records or accept an ambiguous duplicate identity.
export function memberPubkeys(members) {
  if (!Array.isArray(members) || !members.length || members.length > 256) throw new Error('Invalid channel membership response.')
  const seen = new Set()
  for (const member of members) {
    if (
      !member ||
      typeof member !== 'object' ||
      Array.isArray(member) ||
      Object.keys(member).some((key) => !['pubkey', 'role'].includes(key)) ||
      typeof member.pubkey !== 'string' ||
      !HEX64.test(member.pubkey) ||
      typeof member.role !== 'string' ||
      !/^[a-z][a-z-]{0,31}$/.test(member.role) ||
      seen.has(member.pubkey)
    )
      throw new Error('Invalid or duplicate channel membership record.')
    seen.add(member.pubkey)
  }
  return seen
}

function cli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, ['--format', 'json', ...args], {
      env: {
        ...signerBaseEnvironment(),
        BUZZ_PRIVATE_KEY: env.BUZZ_PRIVATE_KEY,
        BUZZ_AUTH_TAG: env.BUZZ_AUTH_TAG,
        BUZZ_RELAY_URL: env.BUZZ_RELAY_URL,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    let overflow = false
    child.stdout.on('data', (part) => {
      output += part
      if (Buffer.byteLength(output) > 1024 * 1024) {
        overflow = true
        child.kill('SIGKILL')
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('error', () => reject(new Error('Buzz CLI failed.')))
    child.on('close', (code) => {
      if (code || overflow) return reject(new Error('Buzz CLI failed.'))
      try {
        resolve(JSON.parse(output))
      } catch {
        reject(new Error('Invalid Buzz CLI response.'))
      }
    })
  })
}

export async function signerOperation(file, request) {
  const config = loadBridgeConfig(file)
  if (!['feed', 'dispatch', 'event'].includes(request.action)) throw new Error('Unsupported bridge operation.')
  const target = config.agents.find((a) => a.id === request.target)
  const signerId = request.action === 'dispatch' ? SIGNERS[target?.id] : 'codex'
  if (!signerId) throw new Error('Unmapped target.')
  privatePath(config.signerFiles[signerId])
  const env = parseSignerEnv(fs.readFileSync(config.signerFiles[signerId], 'utf8'))
  return performSignerOperation(config, request, env)
}

// Pure fixture seam: production obtains env only from the operator's signer files.
// Neither operator JSON nor browser input can replace the publisher.
export async function performSignerOperation(config, request, env, execute = cli) {
  if (!['feed', 'dispatch', 'event'].includes(request.action)) throw new Error('Unsupported bridge operation.')
  const target = config.agents.find((a) => a.id === request.target)
  const signerId = request.action === 'dispatch' ? SIGNERS[target?.id] : 'codex'
  const signer = config.agents.find((a) => a.id === signerId)
  if (!signer) throw new Error('Unmapped target.')
  checkSigner(env, signer, config)
  if (request.action === 'feed')
    return { events: await execute(['messages', 'get', '--channel', config.channel.id, '--limit', '100', '--kinds', '9'], env) }
  if (request.action === 'event') {
    if (!HEX64.test(request.eventId)) throw new Error('Invalid event id.')
    return { events: await execute(['social', 'event', '--event', request.eventId], env) }
  }
  const project = projectFor(config, request.root, request.board)
  if (
    typeof request.text !== 'string' ||
    !request.text.trim() ||
    Buffer.byteLength(request.text) > MAX_TEXT_BYTES ||
    !/^[0-9a-f-]{36}$/.test(request.requestId)
  )
    throw new Error('Invalid owner request.')
  const content = envelope({ ...request, project, signer, target })
  // These guards precede the only publishing call. Visible/URI mentions in
  // every envelope field have been JSON escaped, preserving decoded text.
  if (content.includes('@') || /nostr:/i.test(content)) throw new Error('Unsafe mention content.')
  const members = memberPubkeys(await execute(['channels', 'members', '--channel', config.channel.id], env))
  if (![config.ownerPubkey, signer.pubkey, target.pubkey].every((key) => members.has(key)))
    throw new Error('The configured identities must already belong to the channel.')
  let response
  try {
    response = await execute(
      ['messages', 'send', '--channel', config.channel.id, '--kind', '9', '--mention', target.pubkey, '--content', '-'],
      env,
      content,
    )
  } catch {
    return { outcome: 'unknown' }
  }
  // From this point a publish may already have happened. No response shape
  // or classification exception may escape to main's preflight/not_sent path.
  try {
    if (
      response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      response.accepted === true &&
      typeof response.event_id === 'string' &&
      HEX64.test(response.event_id) &&
      Array.isArray(response.mention_pubkeys) &&
      response.mention_pubkeys.length === 1 &&
      response.mention_pubkeys[0] === target.pubkey
    )
      return { outcome: 'accepted', eventId: response.event_id }
  } catch {
    /* published but unclassifiable: unknown, never not_sent */
  }
  return { outcome: 'unknown' }
}

async function main() {
  let input = ''
  for await (const part of process.stdin) {
    input += part
    if (Buffer.byteLength(input) > 32768) throw new Error('Request too large.')
  }
  // Failure before the publishing call is safely not sent; ambiguous send
  // outcomes are caught above and explicitly returned as unknown.
  const result = await signerOperation(process.argv[2], JSON.parse(input))
  process.stdout.write(JSON.stringify(result))
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stdout.write(JSON.stringify({ outcome: 'not_sent', code: 'preflight_failed' }))
    process.exitCode = 1
  })
