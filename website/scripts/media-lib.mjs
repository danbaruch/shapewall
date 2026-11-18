// The site's videos and their posters are not in git: they live in website/media/ (git-ignored), made from the film
// masters by scripts/media-encode.mjs, and on the server in one shared folder beside the releases (deploy/deploy.sh).
// What the pages show is pinned by src/media.json (committed): every file in it has a content hash in its name, so a URL
// never changes meaning and can be cached for a year. This module is the one place that reads that manifest outside the
// browser: the build checks it (a file missing locally fails the build), deploy.sh asks it what to upload.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MEDIA_DIR = path.join(WEBSITE, 'media')
export const MANIFEST_PATH = path.join(WEBSITE, 'src', 'media.json')
export const MEDIA_URL_BASE = '/media/'
// A media file name: <id>-<variant>.<10 hex of its sha256>.<ext>. Nothing else is ever uploaded or served from /media/.
export const MEDIA_NAME = /^[a-z0-9][a-z0-9-]*\.[0-9a-f]{10}\.(mp4|webm|jpg|webp|vtt)$/

export function readManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Every file the manifest references, once each, with its expected size: sources, poster images, caption tracks.
export function manifestFiles(manifest) {
  const files = new Map()
  const add = (entry) => {
    if (!entry || !entry.file) return
    if (!MEDIA_NAME.test(entry.file)) throw new Error(`src/media.json: "${entry.file}" is not a hashed media file name`)
    files.set(entry.file, entry.bytes)
  }
  for (const video of Object.values(manifest.videos || {})) {
    for (const source of video.sources || []) add(source)
    for (const image of video.poster?.webp || []) add(image)
    add(video.poster?.jpg)
    for (const track of video.tracks || []) add(track)
  }
  return [...files].map(([file, bytes]) => ({ file, bytes })).sort((a, b) => a.file.localeCompare(b.file))
}

// Which referenced files are missing in `dir`, or there with a different size (a stale or half-copied file).
export function checkMediaFiles(manifest, dir = MEDIA_DIR) {
  const missing = []
  const wrongSize = []
  for (const { file, bytes } of manifestFiles(manifest)) {
    const full = path.join(dir, file)
    if (!fs.existsSync(full)) missing.push(file)
    else if (typeof bytes === 'number' && fs.statSync(full).size !== bytes) wrongSize.push(file)
  }
  return { missing, wrongSize, ok: missing.length === 0 && wrongSize.length === 0 }
}

export function mediaProblem(result, dir = MEDIA_DIR) {
  if (result.ok) return ''
  const lines = [`src/media.json references media files that are not in ${path.relative(process.cwd(), dir) || dir}/:`]
  for (const file of result.missing) lines.push(`  missing     ${file}`)
  for (const file of result.wrongSize) lines.push(`  wrong size  ${file}`)
  lines.push(
    'Make them from the film masters: node scripts/media-encode.mjs <masters folder> (see README, "Videos").',
    'To build without them (pages then show broken posters; never for a release): SHAPEWALL_MEDIA_CHECK=0.',
  )
  return lines.join('\n')
}

// The build's check. SHAPEWALL_MEDIA_CHECK=0 skips it (tests and CI, which have no media); deploy.sh never sets it.
export function assertMedia({ manifest = readManifest(), dir = MEDIA_DIR, env = process.env } = {}) {
  if ((env.SHAPEWALL_MEDIA_CHECK ?? '1').trim() === '0') return { skipped: true }
  const result = checkMediaFiles(manifest, dir)
  if (!result.ok) throw new Error(mediaProblem(result, dir))
  return result
}

// deploy.sh: `node scripts/media-lib.mjs files` prints the referenced files (one per line); `check` exits 1 with the
// problem when one is missing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  const manifest = readManifest()
  if (command === 'files') {
    for (const { file, bytes } of manifestFiles(manifest)) console.log(`${file}\t${bytes}`)
  } else if (command === 'check') {
    const result = checkMediaFiles(manifest)
    if (!result.ok) {
      console.error(mediaProblem(result))
      process.exit(1)
    }
    console.log(`media ok: ${manifestFiles(manifest).length} files in ${path.relative(process.cwd(), MEDIA_DIR) || MEDIA_DIR}/`)
  } else {
    console.error('usage: node scripts/media-lib.mjs files|check')
    process.exit(2)
  }
}
