// The `shapewall` command line.
// Each command lives in src/cli/; this file parses the command line and dispatches.

import { devicesCommand } from './devices-cli.js'
import { loadConfig } from './config.js'
import { HELP, SECTIONS, SHORT_HELP, VERSION, commandHelp } from './cli/help.js'
import { parseArgs } from './cli/args.js'
import { pinSoloLoopback, soloHttpRemote } from './remote/loopback-pin.js'
import { ENGINE_COMMANDS, engineMode } from './cli/engine-mode.js'
import { removed, setDeprecationSink } from './deprecation.js'
import { init, initCi, sitemap } from './cli/init.js'
import { serveCommand } from './cli/serve-command.js'
import { warnDevicesDeprecated, warnServeDeprecations } from './cli/serve-deprecations.js'
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

// Command spellings removed in 2.0 (deprecated through 1.x): what to use
// instead. Using one is a one-line error that names the replacement.
export const REMOVED_COMMANDS = { audit: 'use checks lighthouse' }

// Each command: ({ positional, flags, out, err, fetch }) => its exit code
// (null: it keeps running, e.g. a server).
const COMMANDS = {
  'buzz-bridge': ({ flags, out }) => buzzBridge(flags, out),
  auth: async ({ positional, flags, out }) => {
    const { authCommand } = await import('./auth/record.js')
    return authCommand(loadConfig(flags.config), positional, flags, out)
  },
  init: async ({ flags, out, fetch }) => {
    if (flags.ci) {
      await initCi(flags, out, { fetch })
      return 0
    }
    return init(flags, out, { fetch })
  },
  sitemap: async ({ positional, flags, out, fetch }) => {
    await sitemap(positional, flags, out, { fetch })
    return 0
  },
  capture: ({ flags, out, err }) => capture(flags, out, err),
  checks: async ({ positional, flags, out, err }) => {
    const { checksCommand } = await import('./checks/cli.js')
    // Check reports live in the board folder: the engine's once it holds the project (src/cli/board-home.js).
    const { projectConfig } = await import('./cli/board-home.js')
    return checksCommand(await projectConfig(flags), positional, flags, out, err)
  },
  links: ({ flags, out }) => links(flags, out),
  serve: async ({ flags, out }) => {
    warnServeDeprecations(flags)
    // The solo engine by default (src/hosted/solo/serve.js), after moving any 1.x board data into it;
    // --engine legacy or SHAPEWALL_ENGINE=legacy: the 1.x board server, deprecated (src/cli/serve-command.js).
    await serveCommand(flags, out, {
      version: VERSION,
      startEngine: async (...args) => (await import('./hosted/ops-cli.js')).serveEngine(...args),
      preflight: async (...args) => (await import('./hosted/ops-cli.js')).preflightEngine(...args),
    })
    return null
  },
  devices: ({ positional, flags, out }) => {
    warnDevicesDeprecated()
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
  open: async ({ flags, out }) => {
    const { openCommand } = await import('./cli/open-command.js')
    return openCommand(flags, out)
  },
  doctor: ({ flags, out }) => doctor(flags, out),
  export: ({ flags, out }) => exportCommand(flags, out),
  login: async ({ flags, out }) => {
    const { login } = await import('./remote/login.js')
    await login(flags, out)
    return 0
  },
  join: async ({ flags, out, fetch }) => {
    const { joinCommand } = await import('./remote/tailnet-cli.js')
    return joinCommand(flags, out, { fetchImpl: fetch })
  },
  admin: async ({ positional, flags, out, fetch }) => {
    const { adminCommand } = await import('./remote/tailnet-cli.js')
    return adminCommand(positional, flags, out, { fetchImpl: fetch })
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
  // Experimental in 1.5.0: local .shapewall/ into the solo engine (src/migrate).
  migrate: async ({ flags, out }) => {
    const { migrateCommand } = await import('./migrate/index.js')
    return migrateCommand(loadConfig(flags.config), flags, out, { version: VERSION })
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
  setDeprecationSink(err)
  // A command spelling removed in 2.0 says what replaced it, even with --help.
  // (A line that does not parse is left to the strict parse below, which says why.)
  let invoked = null
  try {
    invoked = parseArgs(argv).command
  } catch {
    invoked = argv.find((arg) => !arg.startsWith('-')) || null
  }
  if (invoked && Object.hasOwn(REMOVED_COMMANDS, invoked)) throw removed(invoked, REMOVED_COMMANDS[invoked])
  const { command, positional, flags } = wantsHelp ? parseArgs(argv) : parseArgs(argv, { strict: true })
  if (flags.version && !wantsHelp) {
    out(VERSION)
    return 0
  }
  // `shapewall --help` (and a bare `shapewall`) is the short list; `--help all` every command in full.
  if (command === 'help') {
    const topic = positional[0]
    if (topic && Object.hasOwn(REMOVED_COMMANDS, topic)) throw removed(topic, REMOVED_COMMANDS[topic])
    out(topic === 'all' ? HELP : topic ? commandHelp(topic) : SHORT_HELP)
    return 0
  }
  if (flags.help || !command) {
    out(command === 'all' ? HELP : command && SECTIONS[command] ? commandHelp(command) : SHORT_HELP)
    return command || flags.help ? 0 : 1
  }
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`unknown command "${command}" (try shapewall --help)`)
  // In a project folder whose solo engine runs, comments, watch and mcp go to it (G15, src/cli/engine-mode.js).
  // With no engine running in a project it holds, comments, watch and mcp start one for themselves (R5c), through
  // the engine's own start (the one place core loads src/hosted, as serve does), and stop it when they end.
  const engine = ENGINE_COMMANDS.includes(command)
    ? await engineMode(command, flags, {
        err,
        startEngine: async (config, options) => (await import('./hosted/ops-cli.js')).startEngineHeadless(config, options),
      })
    : null
  // http to the solo engine's own name: every connection of this process to it goes to 127.0.0.1 (src/remote/loopback-pin.js).
  const remote = typeof flags.remote === 'string' ? flags.remote : process.env.SHAPEWALL_REMOTE
  const run = async () => {
    if (remote && soloHttpRemote(remote)) await pinSoloLoopback()
    return COMMANDS[command]({ positional, flags, out, err, fetch })
  }
  if (!engine?.stop) return run()
  try {
    return await run()
  } finally {
    await engine.stop()
  }
}
