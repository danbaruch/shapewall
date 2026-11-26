// What a `shapewall watch --exec` command is told it may do (plan 3.3):
// the resolved capabilities of path "watch-exec", written to a 0600 file
// next to the comment's file, its path in SHAPEWALL_CAPABILITIES_FILE.
//
// Shapewall does not run what that program runs, so nothing here is
// enforced by Shapewall (`enforced: false`): the program's own sandbox and
// permission rules are the boundary. The file says what this machine's
// rules and the turn's authors allow, so a well-behaved agent can keep to
// it (and show it), and `prompt` is the same text a board's agent reads.

import fs from 'node:fs'
import path from 'node:path'
import { hostPlatform, resolveCapabilities } from './capabilities.js'
import { toPrompt } from './capability-render.js'
import { localMachinePolicy, userAgentEntry } from './user-settings.js'

let platformOnce = null
const platformNow = () => (platformOnce ||= hostPlatform())

// The capabilities of one handed-out comment.
//   owner   the server knows the board's owner wrote all of it (a local
//           comment's byOwner, with no reply but its agent's)
//   machine this machine's policy; default: a local project's (user settings)
export function watchCapabilities({ config = null, env = process.env, owner = false, machine = undefined, platform = platformNow() }) {
  const policy =
    machine !== undefined ? machine : config?.dir ? localMachinePolicy(userAgentEntry(config.dir, env).entry) : localMachinePolicy(null)
  return resolveCapabilities({
    path: 'watch-exec',
    trust: { authors: [{ handle: null, owner: owner === true, member: false }], guests: false },
    audience: 'owner',
    machine: policy,
    server: null,
    config,
    platform,
  })
}

// Writes `<dir>/comment-<id>.capabilities.json` (0600, never through a link) -> its path.
export function writeCapabilitiesFile(dir, id, caps) {
  const file = path.join(dir, `comment-${id}.capabilities.json`)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(file, flags, 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ capabilities: caps, prompt: toPrompt(caps) }, null, 2)}\n`)
  } finally {
    fs.closeSync(fd)
  }
  return file
}

// Whether a local comment is all its owner's words (watch.js).
export const ownersComment = (comment) => comment?.byOwner === true && (comment.replies || []).every((reply) => reply?.agent === true)
