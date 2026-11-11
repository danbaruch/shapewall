// The `shapewall` command line.
// Each command lives in src/cli/; this file parses the command line and dispatches.

import { devicesCommand } from './devices-cli.js'
import { loadConfig } from './config.js'
import { HELP, SECTIONS, VERSION, commandHelp } from './cli/help.js'
import { parseArgs } from './cli/args.js'
import { init, initCi, sitemap } from './cli/init.js'
import { serve } from './cli/serve.js'
import { notify } from './cli/notify.js'
import { comments } from './cli/comments.js'
import { variant } from './cli/variant.js'
import { watch } from './cli/watch.js'
import { doctor, github } from './cli/misc.js'
import { capture, links } from './cli/capture.js'
import { buzzBridge, events, exportCommand, journeys, mcp, settings } from './cli/commands.js'

// Re-exported for the tests and older imports.
export { COMMAND_FLAGS, suggestFlag } from './cli/args.js'
export { initNextHint } from './cli/init.js'
export { openerFor } from './cli/open.js'
export { acpFlag, allowedHostsFor, chatEnabledFor, detectedAgentsLine, remoteAgentProblem } from './cli/serve.js'
export { commandHelp, parseArgs }

// Re-exported for the tests and older imports; it lives in net.js.
export { isLoopback } from './net.js'

// Each command: ({ positional, flags, out, err, fetch }) => its exit code
// (null: it keeps running, e.g. a server).
const COMMANDS = {
  'buzz-bridge': ({ flags, out }) => buzzBridge(flags, out),
  auth: async ({ positional, flags, out }) => {
    const { authCommand } = await import('./auth/record.js')
    return authCommand(loadConfig(flags.config), positional, flags, out)
  },
  init: async ({ flags, out, fetch }) => {
    await (flags.ci ? initCi : init)(flags, out, { fetch })
    return 0
  },
  sitemap: async ({ positional, flags, out, fetch }) => {
    await sitemap(positional, flags, out, { fetch })
    return 0
  },
  capture: ({ flags, out, err }) => capture(flags, out, err),
  checks: async ({ positional, flags, out, err }) => {
    const { checksCommand } = await import('./checks/cli.js')
    return checksCommand(loadConfig(flags.config), positional, flags, out, err)
  },
  audit: async ({ positional, flags, out, err }) => {
    const { auditCommand } = await import('./checks/lighthouse.js')
    return auditCommand(loadConfig(flags.config), positional, flags, out, err)
  },
  links: ({ flags, out }) => links(flags, out),
  serve: async ({ flags, out }) => {
    await serve(flags, out)
    return null
  },
  devices: ({ positional, flags, out }) => {
    devicesCommand(loadConfig(flags.config), positional, flags, out)
    return 0
  },
  settings: ({ flags, out, err }) => settings(flags, out, err),
  comments: async ({ positional, flags, out, err }) => {
    await comments(positional, flags, out, err)
    return 0
  },
  notify: ({ positional, flags, out }) => notify(positional, flags, out),
  variant: async ({ positional, flags, out }) => {
    await variant(positional, flags, out)
    return 0
  },
  journeys: ({ positional, flags, out }) => journeys(positional, flags, out),
  watch: async ({ flags, out, err }) => {
    await watch(flags, out, err)
    return 0
  },
  events: ({ flags, out, err }) => events(flags, out, err),
  github: async ({ positional, flags, out }) => {
    await github(positional, flags, out)
    return 0
  },
  agent: async ({ positional, flags, out, err }) => {
    const { agentCommand } = await import('./agent/starter/cli.js')
    return agentCommand(positional, flags, out, err)
  },
  ci: async ({ positional, flags, out, fetch }) => {
    const { ciCommand } = await import('./cli/ci.js')
    return ciCommand(positional, flags, out, { fetch })
  },
  mcp: ({ flags, err }) => mcp(flags, err),
  doctor: ({ flags, out }) => doctor(flags, out),
  export: ({ flags, out }) => exportCommand(flags, out),
  login: async ({ flags, out }) => {
    const { login } = await import('./remote/login.js')
    await login(flags, out)
    return 0
  },
  share: async ({ flags, out }) => {
    const { share } = await import('./remote/share.js')
    return (await share(flags, out)).code
  },
  push: async ({ flags, out }) => {
    const { push } = await import('./remote/cli.js')
    await push(flags, out)
    return 0
  },
  hosted: async ({ positional, flags, out, err }) => {
    const { hostedCommand } = await import('./hosted/ops-cli.js')
    return hostedCommand(positional, flags, out, err)
  },
}

export async function main(
  argv = process.argv.slice(2),
  { out = (line) => console.log(line), err = (line) => console.error(line), fetch = globalThis.fetch } = {},
) {
  // "shapewall capture --help" is that command's help, whatever else is on the line.
  const wantsHelp = argv.includes('--help') || argv.includes('-h')
  const { command, positional, flags } = wantsHelp ? parseArgs(argv) : parseArgs(argv, { strict: true })
  if (flags.version && !wantsHelp) {
    out(VERSION)
    return 0
  }
  if (command === 'help') {
    out(positional[0] ? commandHelp(positional[0]) : HELP)
    return 0
  }
  if (flags.help || !command) {
    out(command && SECTIONS[command] ? commandHelp(command) : HELP)
    return command || flags.help ? 0 : 1
  }
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`unknown command "${command}" (try shapewall --help)`)
  return COMMANDS[command]({ positional, flags, out, err, fetch })
}
