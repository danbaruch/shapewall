// Mode 2: `shapewall hosted --setup --domain app.example.com`. Writes a
// Docker Compose project for one VPS (the server plus Caddy for TLS) into a
// folder, checks DNS, and with --start brings it up and prints the one-time
// setup link.
//
//   <dir>/compose.yml   the server (no published port) and Caddy (80, 443)
//   <dir>/Caddyfile     the app site, and the usercontent site when
//                       --usercontent-domain is given (live HTML only: no
//                       cookies, no auth)
//   <dir>/.env          origin, sign-up, email and legal settings (0600)
//   <dir>/data/         the server's data folder (back it up: hosted backup)
//
// The image is built from a Shapewall checkout (Dockerfile.hosted) until the
// package is on npm; --source points at it (default: this installation).
// examples/hosted/compose.yml and examples/hosted/Caddyfile.compose are these
// same templates for app.example.com (test/hosted-ops.test.js keeps them in
// step).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns/promises'
import { fileURLToPath } from 'node:url'
import { runCommand } from './tailscale.js'

export class SetupError extends Error {}

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..')
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function cleanDomain(value, flag) {
  const domain = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  if (!DOMAIN_RE.test(domain)) throw new SetupError(`${flag}: a host name such as app.example.com (no https://, no path)`)
  return domain
}

// The registrable part, roughly (the last two labels). Enough to warn that a
// usercontent domain under the app's own domain shares its cookies.
const siteOf = (domain) => domain.split('.').slice(-2).join('.')

export function renderCompose() {
  return `# Hosted Shapewall with Docker Compose: the server and Caddy (TLS) on one
# machine. Written by \`shapewall hosted --setup\` (docs/hosted.md, "Own
# domain"); settings live in .env next to this file.
#
#   docker compose up -d --build
#   docker compose exec shapewall cat /data/setup-link    # read privately, never in logs
#   docker compose exec shapewall node bin/shapewall.js hosted backup --data /data --to /backups --keep-days 30
#
# The server's port is never published: only Caddy reaches it, on the
# compose network, which is why it trusts X-Forwarded-For from private
# addresses (SHAPEWALL_HOSTED_TRUST_PROXY=uniquelocal).

services:
  shapewall:
    build:
      context: \${SHAPEWALL_SOURCE:-.}
      dockerfile: Dockerfile.hosted
    image: shapewall-hosted:local
    init: true
    restart: unless-stopped
    user: '\${SHAPEWALL_UID:-1000}:\${SHAPEWALL_GID:-1000}'
    env_file: .env
    environment:
      SHAPEWALL_HOSTED_DATA: /data
      SHAPEWALL_HOSTED_TRUST_PROXY: uniquelocal
    command: ['hosted', '--host', '0.0.0.0', '--port', '4700']
    volumes:
      - ./data:/data
      - ./backups:/backups
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 2g
    pids_limit: 256

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - shapewall
    ports:
      - '80:80'
      - '443:443'
      - '443:443/udp'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
`
}

const LOG_FILTER = `	log {
		output stdout
		# Never log cookies, tokens or the signature of a live-HTML URL.
		# Invite, setup and share tokens travel in the URL fragment, which
		# browsers never send.
		format filter {
			wrap json
			fields {
				request>headers>Cookie delete
				request>headers>Authorization delete
				request>uri query {
					delete s
				}
				resp_headers>Set-Cookie delete
			}
		}
	}`

export function renderCaddyfile({ domain, usercontentDomain = null, email = null, upstream = 'shapewall:4700' }) {
  const global = email ? `{\n\temail ${email}\n}\n\n` : ''
  const app = `${domain} {
	encode zstd gzip

	# Pushes upload one file per request; the largest is a 10 MB PNG.
	request_body {
		max_size 12MB
	}

	reverse_proxy ${upstream}

	# The server sets its own security headers (CSP per route, nosniff,
	# no-referrer, HSTS, noindex, Cache-Control). Do not override them here.
	header -Server

	# A staging copy: keep it private (uncomment, make a hash with
	# caddy hash-password). Share links and /uc/ stay outside the gate.
	# @gated not path /s/* /share /api/shares/* /uc/* /report /api/health
	# basic_auth @gated {
	# 	reviewer <hash>
	# }

${LOG_FILTER}
}
`
  const usercontent = usercontentDomain
    ? `
# Live HTML on its own registrable domain: no cookies in, none out, no
# auth, nothing but /uc/ (signed, expiring URLs the board hands out).
${usercontentDomain} {
	request_header -Cookie
	request_header -Authorization
	@uc path /uc/*
	handle @uc {
		reverse_proxy ${upstream} {
			header_down -Set-Cookie
		}
	}
	handle {
		respond "Not found" 404
	}
	header -Server

${LOG_FILTER}
}
`
    : ''
  return `# Caddy for hosted Shapewall: TLS, then the server. Written by
# \`shapewall hosted --setup\` (docs/hosted.md, "Own domain").

${global}${app}${usercontent}`
}

export function renderEnv({ domain, usercontentDomain = null, uid = 1000, gid = 1000, source }) {
  return `# Hosted Shapewall settings (docs/hosted.md). This file holds secrets once
# you fill them in: keep it 0600 and out of git.
SHAPEWALL_HOSTED_ORIGIN=https://${domain}
SHAPEWALL_HOSTED_SIGNUP=invite
${usercontentDomain ? `SHAPEWALL_USERCONTENT_ORIGIN=https://${usercontentDomain}\n` : ''}SHAPEWALL_SOURCE=${source}
SHAPEWALL_UID=${uid}
SHAPEWALL_GID=${gid}

# Invite emails through Resend (optional): both or neither.
RESEND_API_KEY=
SHAPEWALL_EMAIL_FROM=

# Shown on sign-up and share pages and on /report (fill in before inviting
# anyone; examples/hosted/legal/ has templates).
SHAPEWALL_HOSTED_TERMS_URL=
SHAPEWALL_HOSTED_PRIVACY_URL=
SHAPEWALL_HOSTED_AUP_URL=
SHAPEWALL_HOSTED_SUBPROCESSORS_URL=
SHAPEWALL_HOSTED_ABUSE_EMAIL=
`
}

function localAddresses() {
  const out = new Set()
  for (const list of Object.values(os.networkInterfaces())) for (const item of list || []) if (!item.internal) out.add(item.address)
  return out
}

// Where each name points, and whether that is this machine. Behind NAT or a
// floating IP the public address is not on an interface: a warning, not an
// error.
export async function checkDns(names, { resolve = dns, addresses = localAddresses() } = {}) {
  const results = []
  for (const name of names) {
    const found = []
    for (const kind of ['resolve4', 'resolve6']) {
      try {
        found.push(...(await resolve[kind](name)))
      } catch {
        /* no record of this kind */
      }
    }
    const here = found.filter((address) => addresses.has(address))
    results.push({
      name,
      addresses: found,
      ok: found.length > 0,
      here: here.length > 0,
      message: !found.length
        ? `${name} has no A or AAAA record yet. Point it at this server; Caddy cannot get a certificate until it resolves.`
        : here.length
          ? `${name} points at this machine (${here.join(', ')}).`
          : `${name} points at ${found.join(', ')}, which is not an address on this machine (fine behind NAT or a floating IP; otherwise fix the record).`,
    })
  }
  return results
}

export function sourceProblem(source) {
  for (const file of ['Dockerfile.hosted', 'package.json', 'package-lock.json', 'client', 'src/hosted']) {
    if (!fs.existsSync(path.join(source, file)))
      return `${source} is not a Shapewall checkout (no ${file}). Clone https://github.com/danbaruch/shapewall and pass --source <that folder>.`
  }
  return null
}

// Plans (and unless dryRun, writes) the folder. Returns { dir, files, dns,
// warnings, next }.
export async function setupHosted({
  domain: rawDomain,
  usercontentDomain: rawUsercontent = null,
  email = null,
  dir: rawDir = 'shapewall-hosted',
  source = PACKAGE_ROOT,
  dryRun = false,
  force = false,
  resolve = dns,
  addresses = undefined,
  uid = typeof process.getuid === 'function' ? process.getuid() : 1000,
  gid = typeof process.getgid === 'function' ? process.getgid() : 1000,
}) {
  if (!rawDomain) throw new SetupError('--setup needs --domain app.example.com (the name people will open)')
  const domain = cleanDomain(rawDomain, '--domain')
  const usercontentDomain = rawUsercontent ? cleanDomain(rawUsercontent, '--usercontent-domain') : null
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email)))
    throw new SetupError('--email: an email address (for the TLS certificate)')
  const warnings = []
  if (usercontentDomain === domain) throw new SetupError('--usercontent-domain must differ from --domain')
  if (usercontentDomain && siteOf(usercontentDomain) === siteOf(domain))
    warnings.push(
      `${usercontentDomain} shares a registrable domain with ${domain}: cookies set for ${siteOf(domain)} would reach live HTML. Use a separate domain (for example ${siteOf(domain).replace(/\..*$/, '')}content.com).`,
    )
  const dir = path.resolve(rawDir)
  const sourceDir = path.resolve(source)
  const problem = sourceProblem(sourceDir)
  if (problem) warnings.push(problem)
  // Running as root: the container still runs as an unprivileged user.
  const runAs = uid === 0 ? { uid: 1000, gid: 1000 } : { uid, gid }
  const files = {
    'compose.yml': renderCompose(),
    Caddyfile: renderCaddyfile({ domain, usercontentDomain, email }),
    '.env': renderEnv({ domain, usercontentDomain, source: sourceDir, ...runAs }),
  }
  const existing = Object.keys(files).filter((name) => fs.existsSync(path.join(dir, name)))
  if (existing.length && !force && !dryRun)
    throw new SetupError(`${dir} already has ${existing.join(', ')}. Pass --force to overwrite (the data folder is never touched).`)
  const dnsResults = await checkDns([domain, ...(usercontentDomain ? [usercontentDomain] : [])], {
    resolve,
    ...(addresses ? { addresses } : {}),
  })
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const [name, text] of Object.entries(files))
      fs.writeFileSync(path.join(dir, name), text, { mode: name === '.env' ? 0o600 : 0o644 })
    fs.chmodSync(path.join(dir, '.env'), 0o600)
    for (const sub of ['data', 'backups']) {
      const folder = path.join(dir, sub)
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
      if (uid === 0) fs.chownSync(folder, runAs.uid, runAs.gid)
    }
  }
  const next = [
    `cd ${dir}`,
    'Fill in .env (legal page links, abuse email; Resend for invite emails, optional)',
    'docker compose up -d --build',
    'docker compose exec shapewall cat /data/setup-link (read privately)',
  ]
  return { dir, domain, usercontentDomain, files, existing, dns: dnsResults, warnings, next, dryRun }
}

// --start is explicit: no containers or services start during file generation.
// Setup URLs stay out of Compose/journald logs; read the private file directly.
export async function startCompose({ dir, run = runCommand, out = () => {} }) {
  const compose = await run('docker', ['compose', 'version'])
  if (compose.missing || compose.code !== 0)
    throw new SetupError(
      'Docker Compose is not available (docker compose version failed). Install Docker Engine with the compose plugin first.',
    )
  out('Building and starting (docker compose up -d --build)...')
  const up = await run('docker', ['compose', '--project-directory', dir, 'up', '-d', '--build', '--wait'], { timeoutMs: 30 * 60_000 })
  if (up.code !== 0)
    throw new SetupError('docker compose up failed; inspect its status locally (output can contain sensitive configuration).')
  const link = await run('docker', ['compose', '--project-directory', dir, 'exec', '-T', 'shapewall', 'cat', '/data/setup-link'])
  const setupLink = String(link.stdout || '').trim()
  if (link.code === 0 && /^https:\/\/[^\s]+\/signup#setup=[A-Za-z0-9_-]+$/.test(setupLink)) return { setupLink }
  return {
    setupLink: null,
    note: 'The server is healthy. Read its setup link privately: docker compose exec shapewall cat /data/setup-link. Existing accounts do not need it.',
  }
}
