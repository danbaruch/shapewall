// The serve spellings kept through 2.x with a warning (removed in 3.0):
// `--lan`, `--accounts` (and SHAPEWALL_ACCOUNTS=1), and the `devices`
// command. They keep working; each says once per run what to use instead.
// Called before serve picks its server, so the warning is the same on both.

import { deprecated } from '../deprecation.js'

const TAILNET = 'reach the board from your other devices through the tailnet instead: shapewall serve --team'

export function warnServeDeprecations(flags = {}, env = process.env) {
  if (flags.lan !== undefined && flags.lan !== false) deprecated('serve --lan', TAILNET)
  const accounts = flags.accounts === undefined ? env.SHAPEWALL_ACCOUNTS === '1' : Boolean(flags.accounts)
  if (accounts)
    deprecated(
      flags.accounts === undefined ? 'SHAPEWALL_ACCOUNTS=1' : 'serve --accounts',
      'leave it out: the solo engine signs its owner in on this machine by itself, and shapewall serve --team signs in people on your tailnet',
    )
}

export function warnDevicesDeprecated() {
  deprecated(
    'the devices command',
    'reach the board over your tailnet instead (shapewall serve --team signs in people you invite on your tailnet)',
  )
}
