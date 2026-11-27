// Which server `shapewall serve` runs (2.0.0, plan R5).
//
// The solo engine (src/hosted/solo/serve.js) is the default: the hosted
// engine for this project, one owner, on this machine. The 1.x board server
// (src/cli/serve.js) stays through 2.x as a deprecated escape hatch:
//
//   serve --engine legacy        the 1.x server (deprecated, removed in 3.0)
//   SHAPEWALL_ENGINE=legacy      the same, for a service or a script
//   serve --engine hosted        the engine (the default; also SHAPEWALL_ENGINE=hosted)
//
// The flag wins over the variable. With neither, a flag only the 1.x server
// has (--lan, --tailscale, --host, --accounts, --agent-acp, ...) runs the 1.x
// server, with the same deprecation line, so `serve --host 0.0.0.0` in a
// container or `serve --tailscale` keeps doing what it did. With the engine
// asked for by name, such a flag is refused as before (engineFlagProblem).

import { deprecated } from '../deprecation.js'

export const ENGINE_VAR = 'SHAPEWALL_ENGINE'
export const ENGINE_NAMES = ['hosted', 'legacy']

// Flags of the 1.x server that the engine does not take: each one means the
// person runs the 1.x server on purpose. Kept in step with REFUSED in
// src/hosted/solo/serve.js (a test checks they match).
export const LEGACY_ONLY_FLAGS = [
  'host',
  'lan',
  'tailscale',
  'tls-cert',
  'tls-key',
  'allowed-host',
  'no-identity',
  'no-remote-chat',
  'approve-on-host',
  'accounts',
  'accounts-origin',
  'buzz-bridge',
  'agent-acp',
  'allow-remote-agent',
  'trust-proxy',
]

const LEGACY_HOW =
  'it runs the 1.x board server, which goes in Shapewall 3.0. Leave it out for the solo engine (the default), and see https://shapewall.com/docs/upgrading'

// -> { engine: 'hosted' | 'legacy', source: 'flag' | 'env' | 'flags' | 'default', flag? }.
// Throws on a value that names no engine. Says the deprecation line for
// legacy (once per run, through src/deprecation.js).
export function chooseEngine(flags = {}, env = process.env, { warn = deprecated } = {}) {
  let choice
  if (flags.engine !== undefined) {
    if (!ENGINE_NAMES.includes(flags.engine))
      throw new Error(`--engine: "hosted" (the solo engine, the default) or "legacy" (the 1.x board server, deprecated).`)
    choice = { engine: flags.engine, source: 'flag' }
  } else if (env[ENGINE_VAR] !== undefined && String(env[ENGINE_VAR]).trim() !== '') {
    const value = String(env[ENGINE_VAR]).trim().toLowerCase()
    if (!ENGINE_NAMES.includes(value))
      throw new Error(`${ENGINE_VAR}: "hosted" (the solo engine, the default) or "legacy" (the 1.x board server, deprecated).`)
    choice = { engine: value, source: 'env' }
  } else {
    const flag = LEGACY_ONLY_FLAGS.find((name) => flags[name] !== undefined)
    choice = flag ? { engine: 'legacy', source: 'flags', flag } : { engine: 'hosted', source: 'default' }
  }
  if (choice.engine === 'legacy') {
    const what =
      choice.source === 'flag'
        ? 'serve --engine legacy'
        : choice.source === 'env'
          ? `${ENGINE_VAR}=legacy`
          : `serve --${choice.flag} (which only the 1.x board server takes)`
    warn(what, LEGACY_HOW, { removedIn: '3.0' })
  }
  return choice
}
