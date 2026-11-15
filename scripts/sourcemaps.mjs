#!/usr/bin/env node
// Post-build source map handling for self-hosted GlitchTip (Sentry protocol).
//
//   node scripts/sourcemaps.mjs --dist <dist dir> --project <glitchtip project slug> --release <id the SDK reports>
//
// The build itself (scripts/vite-debug-ids.mjs) gives every JS chunk a debug id and
// emits hidden .map files. This script then:
// 1. Uploads the maps to GlitchTip for <release>, when an upload token is configured.
// 2. Always deletes every .map file from the dist dir, so they are never deployed.
// It never modifies the built JS (hashed file names must keep matching their bytes).
//
// Step 1 is optional and never fails the build: no sentry-cli, no token, no release
// id or an unreachable GlitchTip only print a warning. Step 2 always runs; a failure
// there does fail the build (maps must not ship).
//
// Upload config comes from the environment (SENTRY_URL, SENTRY_ORG,
// SENTRY_AUTH_TOKEN) or from a KEY=value file named by $GLITCHTIP_UPLOAD_ENV
// (kept outside the repository, mode 600, never committed).
// sentry-cli: $SENTRY_CLI, else `sentry-cli` on PATH.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const UPLOAD_TIMEOUT_MS = 180_000

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    args[key.slice(2)] = argv[i + 1]
    i += 1
  }
  return args
}

function warn(message) {
  console.warn(`[sourcemaps] warning: ${message}`)
}

function listMaps(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listMaps(path))
    else if (entry.isFile() && entry.name.endsWith('.map')) out.push(path)
  }
  return out
}

function readUploadConfig() {
  const config = {
    SENTRY_URL: process.env.SENTRY_URL,
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
  }
  const file = process.env.GLITCHTIP_UPLOAD_ENV
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*(SENTRY_URL|SENTRY_ORG|SENTRY_AUTH_TOKEN)\s*=\s*(.*?)\s*$/.exec(line)
      if (match && !config[match[1]]) config[match[1]] = match[2]
    }
  }
  return config.SENTRY_URL && config.SENTRY_ORG && config.SENTRY_AUTH_TOKEN ? config : null
}

function sentryCli(cli, args, env, timeout) {
  const result = spawnSync(cli, args, {
    env: { ...process.env, ...env, SENTRY_DISABLE_UPDATE_CHECK: '1', SENTRY_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout,
  })
  if (result.error) return { ok: false, detail: result.error.message }
  if (result.status !== 0) return { ok: false, detail: (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' | ') }
  return { ok: true, stdout: result.stdout }
}

const args = parseArgs(process.argv.slice(2))
const dist = resolve(args.dist || 'dist')
const project = args.project
const release = (args.release || '').trim()
if (!existsSync(dist) || !statSync(dist).isDirectory()) throw new Error(`No build output at ${dist}`)
if (!project) throw new Error('--project is required')

const maps = listMaps(dist)
if (maps.length === 0) {
  console.log('[sourcemaps] no .map files in build output; nothing to do')
  process.exit(0)
}

try {
  const withIds = maps.filter((map) => {
    try {
      return Boolean(JSON.parse(readFileSync(map, 'utf8')).debug_id)
    } catch {
      return false
    }
  }).length
  const cli = process.env.SENTRY_CLI || 'sentry-cli'
  if (withIds === 0) {
    warn('maps carry no debug ids (is the glitchtip-debug-ids Vite plugin enabled?); maps not uploaded')
  } else if (!/^[0-9a-zA-Z._-]{1,64}$/.test(release)) {
    warn('no release id; maps not uploaded')
  } else {
    const config = readUploadConfig()
    const probe = config ? sentryCli(cli, ['--version'], {}, 20_000) : null
    if (!config) {
      warn('no GlitchTip upload token configured; maps not uploaded')
    } else if (!probe.ok) {
      warn(`sentry-cli not available (${probe.detail}); maps not uploaded`)
    } else {
      const upload = sentryCli(cli, ['sourcemaps', 'upload', '--project', project, '--release', release, dist], config, UPLOAD_TIMEOUT_MS)
      if (upload.ok) console.log(`[sourcemaps] uploaded ${withIds} source maps to GlitchTip project ${project}, release ${release}`)
      else warn(`upload to GlitchTip failed (${upload.detail}); deploy continues without symbolication`)
    }
  }
} catch (error) {
  warn(`unexpected error (${error.message}); continuing`)
} finally {
  for (const file of maps) rmSync(file, { force: true })
  const left = listMaps(dist)
  if (left.length) {
    console.error(`[sourcemaps] could not delete: ${left.join(', ')}`)
    process.exit(1)
  }
  console.log(`[sourcemaps] removed ${maps.length} .map files from ${dist}`)
}
