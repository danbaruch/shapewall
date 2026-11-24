// `shapewall serve`: the local board server, and the checks that decide what it may share.

import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isLoopback } from '../net.js'
import http from 'node:http'
import https from 'node:https'
import { lanAccess, tailscaleAccess } from '../server/tailscale.js'
import { loadConfig } from '../config.js'
import { formatCommand } from '../agent/acp/command.js'
import { detectAgents } from '../agent/acp/detect.js'
import { agentSettings } from '../agent/config.js'
import { watchConfig } from '../config-reload.js'
import { cliCommand } from '../invocation.js'
import { DEFAULT_PORT, clearServeState, runningBoardUrl, servedUrl, writeServeState } from '../serve-state.js'
import { nextFreePort, portInUse } from '../ports.js'
import { keyWarningLines } from '../config-keys.js'
import { registerProject } from '../local-projects.js'
import { openBrowser } from './open.js'
import { startNotifier } from './notify.js'

// The Host header values `serve` accepts, or null for any. On a loopback
// address the local names are always allowed; --allowed-host and
// SHAPEWALL_ALLOWED_HOSTS add names (and keep the check on for any address);
// "*" in either turns the check off on purpose.
export function allowedHostsFor(host, flagHosts = [], envHosts = '') {
  const extra = [
    ...(flagHosts || []),
    ...String(envHosts || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ]
  if (extra.includes('*') || (!isLoopback(host) && !extra.length)) return null
  const name = host.toLowerCase()
  return new Set(['127.0.0.1', 'localhost', '[::1]', '::1', name, `[${name}]`, ...extra.map((item) => item.toLowerCase())])
}

// The board chat spends the server owner's model key, so it is on by default
// only for a board on this machine: bound to loopback with no extra Host
// names. --chat turns it on anyway, --no-chat off.
export function chatEnabledFor(flags, host, envHosts = '') {
  if (flags['no-chat']) return false
  if (flags.chat) return true
  const extra = (flags['allowed-host'] || []).length > 0 || String(envHosts || '').trim() !== ''
  return isLoopback(host) && !extra
}

// --agent-acp "CMD": the agent command, or null. A bare --agent-acp (no
// command) is a mistake worth saying, not an empty command.
export function acpFlag(flags) {
  const value = flags['agent-acp']
  if (value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) throw new Error('--agent-acp needs the agent command, e.g. --agent-acp "codex-acp"')
  return value
}

// An ACP agent on a board shared beyond this machine is remote command
// execution as you, for anyone who reaches the board. --chat alone does not
// allow that: it needs --allow-remote-agent as well.
export function remoteAgentProblem({ flags, host, chat, readOnly, config, acp, env = process.env }) {
  if (!chat || readOnly || flags['allow-remote-agent']) return null
  if (chatEnabledFor({ 'allowed-host': flags['allowed-host'] }, host, env.SHAPEWALL_ALLOWED_HOSTS)) return null
  const settings = agentSettings(config, env, { acp })
  if (settings.backend !== 'acp') return null
  const where = settings.sources?.backend === 'settings' ? ' (the agent is saved in Settings > Agent, ' + settings.settingsFile + ')' : ''
  return (
    `Refusing to start: --chat with an ACP agent${where} on a board shared beyond this machine lets anyone who reaches it run commands as you. ` +
    'Drop --chat (or the agent), or add --allow-remote-agent if every person who can reach this board may do that.'
  )
}

// One line on what Connect in the Agent panel will offer. A first run has
// not asked for chat, so by default it names only the agents ready to
// connect; agents that need an ACP adapter or a shell are spelled out only
// with an explicit --chat (the Agent panel always shows them, with the
// install line).
export function detectedAgentsLine(found, { detail = true } = {}) {
  const ready = found.filter((item) => item.state === 'ready').map((item) => item.label)
  const adapter = found.filter((item) => item.state === 'needs-adapter').map((item) => item.label)
  const parts = []
  if (ready.length) parts.push(`Agents found on this machine: ${ready.join(', ')}. Connect one in the Agent panel (open the link above).`)
  if (!detail) return parts.length ? parts.join(' ') : null
  if (adapter.length) parts.push(`Installed without their ACP adapter: ${adapter.join(', ')} (the Agent panel shows the install line).`)
  const wrapped = found.filter((item) => item.state === 'needs-shell').map((item) => item.label)
  if (wrapped.length) parts.push(`Installed only as .cmd wrappers, which need a shell: ${wrapped.join(', ')} (see the chat docs).`)
  return parts.length ? parts.join(' ') : null
}

// A port that is taken, in plain words and with a port that is free (the
// error Node gives is "listen EADDRINUSE: address already in use ...").
// Any other listen error is returned as it is.
export async function listenFailure(error, { port, host, config, flags = {} }) {
  if (error?.code !== 'EADDRINUSE') return error
  const running = runningBoardUrl(config)
  const mine = running && Number(new URL(running).port) === port ? running : null
  const free = mine ? null : await nextFreePort(port, host)
  const keep = ['config', 'board']
    .filter((name) => typeof flags[name] === 'string')
    .map((name) => ` --${name} ${flags[name]}`)
    .join('')
  const { message, fix } = portInUse({ port, host, free, running: mine, command: (next) => cliCommand(`serve --port ${next}${keep}`) })
  const friendly = new Error(`${message} ${fix}`)
  friendly.code = 'EADDRINUSE'
  return friendly
}

// What a managed installer's service manager restarts (SHAPEWALL_UPDATE_RESTART).
export const UPDATE_RESTART_EXIT = 75

export async function serve(flags, out) {
  const config = loadConfig(flags.config)
  // Keys the config has but Shapewall does not use (a typo, most often).
  for (const line of keyWarningLines(config.warnings)) out(line)
  const acp = acpFlag(flags)
  const { createApp, shutdownApp, stopChildren } = await import('../server/app.js')
  if (flags.lan && flags.tailscale) throw new Error('Choose --lan or --tailscale, not both.')
  if ((flags.lan || flags.tailscale) && flags.host)
    throw new Error('Use --lan=IP to select an interface; do not combine remote modes with --host.')
  if ((flags['tls-cert'] || flags['tls-key']) && (!flags.lan || !flags['tls-cert'] || !flags['tls-key']))
    throw new Error('TLS needs --lan, --tls-cert and --tls-key together.')
  if (flags.tailscale && flags.tailscale !== true && flags.tailscale !== 'print') throw new Error('Use --tailscale or --tailscale=print.')
  const lan = flags.lan ? lanAccess(flags.lan) : null
  const host = lan?.host || flags.host || '127.0.0.1'
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number')
  if (flags.tailscale && port === 0) throw new Error('--tailscale needs a fixed --port, not 0.')
  const tail = flags.tailscale ? await tailscaleAccess({ port, noIdentity: Boolean(flags['no-identity']), log: out }) : null
  if (flags.tailscale === 'print') {
    out(tail.command)
    out(tail.url)
    return
  }
  const remote =
    lan || tail
      ? { tailscale: tail, noRemoteChat: Boolean(flags['no-remote-chat']), approveOnHost: Boolean(flags['approve-on-host']) }
      : null
  const loopback = isLoopback(host)
  const configuredHosts = allowedHostsFor(remote ? '127.0.0.1' : host, flags['allowed-host'], process.env.SHAPEWALL_ALLOWED_HOSTS)
  if (remote && !configuredHosts) throw new Error('Remote owner mode does not allow wildcard Host names.')
  const allowedHosts = remote ? new Set([...(configuredHosts || []), ...(lan?.hosts || []), ...(tail ? [tail.host] : [])]) : configuredHosts
  const readOnly = Boolean(flags['read-only'])
  const chat = remote ? !flags['no-chat'] : chatEnabledFor(flags, host, process.env.SHAPEWALL_ALLOWED_HOSTS)
  const remoteAgent = remote ? null : remoteAgentProblem({ flags, host, chat, readOnly, config, acp, env: process.env })
  if (remoteAgent) throw new Error(remoteAgent)
  const shared = !remote && !chatEnabledFor({ 'allowed-host': flags['allowed-host'] }, host, process.env.SHAPEWALL_ALLOWED_HOSTS)
  // Settings > Agent needs this per-process token (in the link printed below),
  // so a visitor through a Host-rewriting proxy or tunnel cannot use it.
  const settingsToken = !shared && (remote || !readOnly) ? randomBytes(24).toString('base64url') : null
  const accountsEnabled = flags.accounts === undefined ? process.env.SHAPEWALL_ACCOUNTS === '1' : flags.accounts
  let localAccounts = null
  if (accountsEnabled) {
    const { openLocalAccountDatabase } = await import('../accounts/local.js')
    const origin =
      flags['accounts-origin'] ||
      process.env.SHAPEWALL_ACCOUNTS_ORIGIN ||
      tail?.url ||
      (loopback && port ? servedUrl('localhost', port) : null)
    // Beyond this machine with no gate of its own: the board waits for the owner account (src/accounts/local.js).
    localAccounts = { ...(await openLocalAccountDatabase(config, origin)), ownerFirst: !loopback && !remote }
  } else if (flags['accounts-origin']) {
    throw new Error('--accounts-origin needs --accounts.')
  }
  // A capture cut short while swapping in its folders: the last good one back.
  if (!readOnly) {
    const { recoverCaptureSwaps } = await import('../capture/capture.js')
    recoverCaptureSwaps(config, { log: out })
  }
  // The one teardown (defined once the server is up): signals and the update
  // restart (exit 75) both go through it.
  let shutdown = (code) => process.exit(code)
  // Opt-in error reports (SHAPEWALL_ERROR_DSN); nothing is loaded without it.
  const { startErrorTracking } = await import('../error-tracking.js')
  await startErrorTracking(process.env, { log: out })
  const app = createApp({
    config,
    readOnly,
    allowCapture: !readOnly && !flags['no-capture'],
    allowedHosts,
    chat,
    agentAcp: acp,
    remote,
    // Beyond this machine: no Settings > Agent, and no ACP agent without --allow-remote-agent.
    shared,
    settingsToken,
    localAccounts,
    buzzBridge: flags['buzz-bridge'] || null,
    allowRemoteAgent: Boolean(flags['allow-remote-agent']),
    // A managed installer opts in to restart only this serve process after
    // its fixed helper switches an immutable release pointer. The existing
    // service manager restarts exit 75; ordinary CLI installs never exit.
    appUpdate: process.env.SHAPEWALL_UPDATE_RESTART === '1' ? { onRestart: () => shutdown(UPDATE_RESTART_EXIT) } : {},
    log: (line) => out(line),
  })
  const tls = flags['tls-cert'] ? { cert: fs.readFileSync(flags['tls-cert']), key: fs.readFileSync(flags['tls-key']) } : null
  // With `--tailscale` and the identity proof, each request is first asked how it came in: the serve
  // entry's secret comes off its path here, before Express and before anything can echo the URL.
  const handler = tail?.gate
    ? (req, res) => {
        tail.gate.admit(req, res).then(
          (ok) => ok && app(req, res),
          () => res.writeHead(500).end(),
        )
      }
    : app
  const server = tls ? https.createServer(tls, handler).listen(port, host) : http.createServer(handler).listen(port, host)
  const unwatch = watchConfig(config, { log: out, server })
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
  } catch (error) {
    unwatch?.()
    stopChildren(app)
    throw await listenFailure(error, { port, host, config, flags })
  }
  let hostServer = null
  if (lan && host !== '0.0.0.0') {
    hostServer = tls
      ? https.createServer(tls, handler).listen(server.address().port, '127.0.0.1')
      : http.createServer(handler).listen(server.address().port, '127.0.0.1')
    try {
      await new Promise((resolve, reject) => {
        hostServer.once('listening', resolve)
        hostServer.once('error', reject)
      })
    } catch (error) {
      server.close()
      stopChildren(app)
      throw error
    }
  }
  try {
    await tail?.start(server)
  } catch (error) {
    server.close()
    hostServer?.close()
    stopChildren(app)
    throw error
  }
  const address = server.address()
  const shown = host.includes(':') ? `[${host}]` : host
  const accountUrl = localAccounts ? `${localAccounts.origin}/` : null
  const remoteAccountOrigin = accountUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(accountUrl).hostname)
  out(
    `Shapewall is serving ${config.boards.length} board${config.boards.length === 1 ? '' : 's'} at ${accountUrl || `${tls ? 'https' : 'http'}://${shown}:${address.port}/`}`,
  )
  if (tail) out(`Private Tailscale board: ${tail.url}${tail.ownerLogin ? '' : ' (pairing required; node has no owner identity)'}`)
  if (tail?.ownerLogin && !tail.gate)
    out(
      `Your other tailnet devices pair like any other device: this machine cannot prove that a request came through tailscale serve (${tail.identityOff}).`,
    )
  if (lan)
    out(
      'LAN pairing is on. Plain HTTP on Wi-Fi exposes the device cookie to sniffing and replay; use --tailscale or --tls-cert/--tls-key. HTTP installs only as a bookmark.',
    )
  if (settingsToken && !remoteAccountOrigin) {
    const ownerLink = `${accountUrl || `${tls ? 'https' : 'http'}://127.0.0.1:${address.port}/`}#settings-token=${settingsToken}`
    const what = `settings, sharing${remote ? ' and devices' : ''}`
    // The token in full only when asked for (--print-owner-link,
    // SHAPEWALL_PRINT_OWNER_LINK=1; scripts read that line). A service's
    // output goes to logs (journald), which would keep it, and a terminal is
    // often on a screen share or in a recording.
    const mode = ownerLinkMode({ flags, env: process.env, tty: process.stdout.isTTY })
    if (mode === 'full') {
      out(`Private owner link (${what}; keep it to yourself): ${ownerLink}`)
    } else if (mode === 'short' && flags.open) {
      // The browser gets the token through a one-time link (below).
      out(`Owner access: opening the board in your browser. "${cliCommand('serve --print-owner-link')}" prints the private link instead.`)
    } else if (mode === 'short') {
      // On screen the token is cut short; behind it (an OSC 8 terminal
      // hyperlink) is the full link, so Ctrl/Cmd+click still opens it.
      out(`Private owner link (${what}; don't share it): ${terminalLink(ownerLink, shortOwnerLink(ownerLink))}`)
      out(
        `  Ctrl/Cmd+click it, or run "${cliCommand('serve --open')}" to open it for you ("${cliCommand('serve --print-owner-link')}" prints it in full).`,
      )
    } else if (!flags.open) {
      out(
        `Private owner link: not printed, because this output is not a terminal and logs would keep it. Run "${cliCommand('serve --open')}" to open it in your browser, "${cliCommand('settings')} --open" for agent settings, or set SHAPEWALL_PRINT_OWNER_LINK=1.`,
      )
    }
  }
  if (remoteAccountOrigin) {
    out(`Host agent settings: ${cliCommand('settings')} --config ${formatCommand([config.file])} --open`)
    out('Agent settings use a separate temporary window on this computer. The account board keeps its existing access gates.')
  }
  const agent = agentSettings(config, process.env, { acp })
  if (settingsToken && chat && !readOnly && !agent.configured) {
    const line = detectedAgentsLine(detectAgents(process.env), { detail: Boolean(flags.chat) })
    if (line) out(line)
  }
  if (!loopback && !remote && !localAccounts)
    out(
      'Warning: listening beyond this machine with no login. Put it behind an authenticating proxy (https://shapewall.com/docs/self-hosting).',
    )
  else if (!loopback && !remote && app.locals.localAccounts?.auth.userCount() === 0)
    out(
      'Accounts: no owner account yet. Until it exists, the board answers only this machine and the owner link; create it at /signup (https://shapewall.com/docs/local-accounts).',
    )
  if ((config.agent || agent.backend === 'acp') && !readOnly && !chat) {
    out(
      agent.backend === 'acp'
        ? 'Chat is off for a shared board (anyone reaching it could drive your agent on this machine). Pass --chat to turn it on.'
        : 'Chat is off for a shared board (it would spend your model key). Pass --chat to turn it on.',
    )
  } else if (agent.backend === 'acp' && !readOnly) {
    out(
      agent.configured
        ? `Chat: ${agent.label} over ACP (${formatCommand(agent.acp.argv)}), started per thread in ${config.dir}`
        : `Chat: the ACP agent is not ready: ${agent.problem}`,
    )
    if (agent.acp?.refusedEnv.length) out(`Not passed to the agent (Shapewall or other tools' secrets): ${agent.acp.refusedEnv.join(', ')}`)
    if (
      flags['allow-remote-agent'] &&
      !chatEnabledFor({ 'allowed-host': flags['allowed-host'] }, host, process.env.SHAPEWALL_ALLOWED_HOSTS)
    ) {
      out('Warning: --allow-remote-agent: anyone who reaches this board can drive your agent on this machine, with your login.')
    }
  }
  // Other commands (comments resolve, watch, mcp, github) link to this port.
  const url = accountUrl || (remote ? `${tls ? 'https' : 'http'}://127.0.0.1:${address.port}/` : servedUrl(host, address.port))
  writeServeState(config, url)
  if (!shared) {
    try {
      registerProject(config)
    } catch (error) {
      out(`Local project switcher: ${error.message}`)
    }
  }
  // serve: the notifier for changes from every process (src/notify/run.js).
  const notifier = await startNotifier(config, out, { boardUrl: url, serve: true })
  if (notifier) out(`Notifications: ${notifier.channels.map((channel) => channel.id).join(', ')}`)
  server.on('close', () => {
    localAccounts?.db.close()
    hostServer?.close()
    notifier?.stop()
    tail?.stop().catch((error) => out(error.message))
    clearServeState(config)
  })
  // With a token: a one-time link the server answers once with the settings
  // link (src/server/app.js /open/<nonce>), so the token itself never goes on
  // a command line. Without one: the plain address.
  if (flags.open) {
    const link = !remoteAccountOrigin && app.locals.openLink ? app.locals.openLink() : null
    // No browser here: the printed one-time link gets five minutes, time to copy it into a browser on this machine.
    const onCannotOpen = link
      ? () => {
          app.locals.keepOpenLink(link)
          return 'it opens the board as its owner, works once and expires in 5 minutes'
        }
      : null
    openBrowser(link ? `${url}${link}` : url, out, { onCannotOpen })
  }
  let stopping = null
  shutdown = (code = 0) => {
    if (stopping) return stopping
    clearServeState(config)
    stopping = (async () => {
      // Children stop (bounded), and an update apply in flight is waited for.
      await shutdownApp(app, { log: out }).catch(() => {})
      const deadline = setTimeout(() => process.exit(code), tail ? 12000 : 2000)
      deadline.unref()
      // Hands the notifier lease over after a last read of the log; messages
      // still queued get a moment, inside the deadline.
      await Promise.allSettled([notifier?.close(1500), tail?.stop()])
      server.close(() => process.exit(code))
    })()
    return stopping
  }
  const onSignal = (signal) => {
    if (!stopping) return shutdown(0)
    // A second signal: out now. An update apply runs in its own process
    // group and carries on without this server.
    out('Stopping now.')
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return server
}

// How serve shows the private owner link: 'full' when asked for
// (--print-owner-link, SHAPEWALL_PRINT_OWNER_LINK=1, or a dumb terminal that
// has no hyperlinks), 'short' on a terminal (the token behind an OSC 8 link),
// 'none' when the output is not a terminal (logs would keep the token).
export function ownerLinkMode({ flags = {}, env = {}, tty = false } = {}) {
  if (flags['print-owner-link'] || env.SHAPEWALL_PRINT_OWNER_LINK === '1') return 'full'
  if (!tty) return 'none'
  if (env.TERM === 'dumb') return 'full'
  return 'short'
}

// The owner link with its token cut to four characters, for the screen.
export function shortOwnerLink(link) {
  return String(link).replace(/(#settings-token=[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/, '$1...')
}

// An OSC 8 terminal hyperlink: text on screen, url behind it. Terminals
// without hyperlinks show the text and drop the escapes.
export function terminalLink(url, text) {
  return ['\u001b]8;;', url, '\u001b\\', text, '\u001b]8;;\u001b\\'].join('')
}
