// How this `shapewall` was started, so messages print a command that works
// for the person reading them: "npx shapewall" from npm, a GitHub spec for
// an unreleased build, a local install, a global one or the checkout itself.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The npx cache keeps the spec it installed in a package.json two folders
// up: { "dependencies": { "shapewall": "github:danbaruch/shapewall" } }.
function npxSpec(root, readFile) {
  try {
    const spec = JSON.parse(readFile(path.join(root, '..', '..', 'package.json'), 'utf8'))?.dependencies?.shapewall
    // A local tarball or folder (file:...) is relative to the npx cache, so no use to print.
    if (typeof spec === 'string' && spec.startsWith('file:')) return null
    if (typeof spec === 'string' && /^[\w@:/.#+^~-]{1,200}$/.test(spec))
      return /^[\d^~]/.test(spec) || spec === 'latest' ? 'shapewall' : spec
  } catch {
    /* not there */
  }
  return 'shapewall'
}

const NEUTRAL = {
  how: 'unknown',
  command: 'shapewall',
  note: 'run it the way you started this command (npx shapewall, or shapewall after a global install)',
}

// Returns { how, command, note }: how is npx, local, global, direct or
// unknown; command is what to type before the subcommand; note is set when
// the guess is a neutral "shapewall".
export function invocation({ argv1 = process.argv[1], root = ROOT, cwd = process.cwd(), readFile = fs.readFileSync } = {}) {
  const sep = path.sep
  if (root.includes(`${sep}_npx${sep}`)) {
    const spec = npxSpec(root, readFile)
    return spec ? { how: 'npx', command: `npx ${spec}`, note: null } : { ...NEUTRAL, how: 'npx' }
  }
  const script = argv1 ? path.resolve(cwd, argv1) : ''
  const base = path.basename(script)
  if (base === 'shapewall' || base === 'shapewall.cmd') {
    if (script.includes(`${sep}node_modules${sep}.bin${sep}`)) return { how: 'local', command: 'npx shapewall', note: null }
    return { how: 'global', command: 'shapewall', note: null }
  }
  if (script === path.join(root, 'bin', 'shapewall.js')) {
    const relative = path.relative(cwd, script)
    const shown = relative && !relative.startsWith(`..${sep}..${sep}..`) ? relative : script
    return { how: 'direct', command: `node ${shown.includes(' ') ? JSON.stringify(shown) : shown}`, note: null }
  }
  return { ...NEUTRAL }
}

// "shapewall doctor" for this invocation, e.g. "npx shapewall doctor".
export function cliCommand(args, options) {
  return `${invocation(options).command}${args ? ` ${args}` : ''}`
}
