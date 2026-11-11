// Uploaded agent icons, stored next to the agent settings file
// (user-settings.js): <settings folder>/agent-icons/<32 hex>.png, private
// like the settings (folder 0700, files 0600), named by the hash of their
// bytes. A settings entry refers to one as "upload:<hash>" (identity.js).
//
// The image goes through the profile photo pipeline (src/accounts/avatar.js
// cleanAvatar): the board crops the chosen PNG, JPEG or WebP to a square and
// sends a 256 by 256 PNG; the server checks its signature, size, chunks and
// CRCs, decodes it and writes the pixels out again, so nothing but pixels is
// stored (no metadata, no trailing data, never an SVG) and what is served is
// always a PNG this server encoded.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cleanAvatar } from '../accounts/avatar.js'
import { uploadHashes } from './identity.js'
import { readUserSettings, userSettingsFile } from './user-settings.js'

const HASH_RE = /^[0-9a-f]{32}$/

export class IconError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// The folder the icons live in, or null when there is no settings file.
export function iconDir(env = process.env) {
  const file = userSettingsFile(env)
  return file ? path.join(path.dirname(file), 'agent-icons') : null
}

const iconFile = (dir, hash) => path.join(dir, `${hash}.png`)

// Checks and re-encodes an upload ({ png: base64 }), stores it and returns
// its hash. The same picture twice is one file.
export function saveIcon(png, env = process.env) {
  const dir = iconDir(env)
  if (!dir) throw new IconError(500, 'no_settings_file', 'There is no home folder to save agent settings in (set XDG_CONFIG_HOME or HOME).')
  let clean
  try {
    clean = cleanAvatar(png)
  } catch (error) {
    // cleanAvatar speaks of profile images: say what this upload needs.
    if (error.code === 'avatar_too_large') throw new IconError(413, 'icon_too_large', 'The icon is too large. Choose a smaller image.')
    throw new IconError(400, 'invalid_icon', 'The icon must be a PNG, JPEG or WebP image, cropped to a square by the board.')
  }
  const hash = crypto.createHash('sha256').update(clean).digest('hex').slice(0, 32)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = iconFile(dir, hash)
  if (!fs.existsSync(file)) {
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temp, clean, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
    } catch (error) {
      fs.rmSync(temp, { force: true })
      throw error
    }
  }
  return hash
}

// The stored PNG, or null. Only a hash is ever joined to the folder.
export function readIcon(hash, env = process.env) {
  const dir = iconDir(env)
  if (!dir || !HASH_RE.test(String(hash))) return null
  try {
    const file = iconFile(dir, hash)
    // A link planted in the folder is not followed.
    if (!fs.lstatSync(file).isFile()) return null
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

// Removes the icons no project's settings refer to any more (after an icon
// was replaced or removed). Best effort: a file left behind is only a few
// kilobytes in a private folder.
export function pruneIcons(env = process.env) {
  const dir = iconDir(env)
  const { data } = readUserSettings(env)
  if (!dir || !data) return
  const used = new Set()
  for (const entry of Object.values(data.projects)) for (const hash of uploadHashes(entry)) used.add(hash)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const hash = /^([0-9a-f]{32})\.png$/.exec(name)?.[1]
    if (hash && !used.has(hash)) fs.rmSync(path.join(dir, name), { force: true })
  }
}
