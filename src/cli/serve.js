// `shapewall serve`: the local board server, and the checks that decide what it may share.

import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isLoopback } from '../net.js'
import https from 'node:https'
import { lanAccess, tailscaleAccess } from '../server/tailscale.js'
import { loadConfig } from '../config.js'
import { formatCommand } from '../agent/acp/command.js'
import { detectAgents } from '../agent/acp/detect.js'
import { agentSettings } from '../agent/config.js'
import { watchConfig } from '../config-reload.js'
import { cliCommand } from '../invocation.js'
import { DEFAULT_PORT, clearServeState, servedUrl, writeServeState } from '../serve-state.js'
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

// One line on what Connect in the Agent panel will offer.
export function detectedAgentsLine(found) {
  const ready = found.filter((item) => item.state === 'ready').map((item) => item.label)
  const adapter = found.filter((item) => item.state === 'needs-adapter').map((item) => item.label)
  const parts = []
  if (ready.length) parts.push(`Agents found on this machine: ${ready.join(', ')}. Connect one in the Agent panel (open the link above).`)
  if (adapter.length) parts.push(`Installed without their ACP adapter: ${adapter.join(', ')} (the Agent panel shows the install line).`)
  const wrapped = found.filter((item) => item.state === 'needs-shell').map((item) => item.label)
  if (wrapped.length) parts.push(`Installed only as .cmd wrappers, which need a shell: ${wrapped.join(', ')} (see the chat docs).`)
  return parts.length ? parts.join(' ') : null
}

export async function serve(flags, out) {
  const config = loadConfig(flags.config)
  const acp = acpFlag(flags)
  const { createApp, stopChildren } = await import('../server/app.js')
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
  const tail = flags.tailscale ? await tailscaleAccess({ port, noIdentity: Boolean(flags['no-identity']) }) : null
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
    localAccounts = await openLocalAccountDatabase(config, origin)
  } else if (flags['accounts-origin']) {
    throw new Error('--accounts-origin needs --accounts.')
  }
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
    appUpdate: process.env.SHAPEWALL_UPDATE_RESTART === '1' ? { onRestart: () => process.exit(75) } : {},
    log: (line) => out(line),
  })
  const tls = flags['tls-cert'] ? { cert: fs.readFileSync(flags['tls-cert']), key: fs.readFileSync(flags['tls-key']) } : null
  const server = tls ? https.createServer(tls, app).listen(port, host) : app.listen(port, host)
  watchConfig(config, { log: out, server })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  let hostServer = null
  if (lan && host !== '0.0.0.0') {
    hostServer = tls
      ? https.createServer(tls, app).listen(server.address().port, '127.0.0.1')
      : app.listen(server.address().port, '127.0.0.1')
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
    await tail?.start()
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
  if (lan)
    out(
      'LAN pairing is on. Plain HTTP on Wi-Fi exposes the device cookie to sniffing and replay; use --tailscale or --tls-cert/--tls-key. HTTP installs only as a bookmark.',
    )
  if (settingsToken && !remoteAccountOrigin) {
    // Only to a terminal: a service's output goes to logs (journald), which
    // keep the token. SHAPEWALL_PRINT_OWNER_LINK=1 prints it anyway.
    if (process.stdout.isTTY || process.env.SHAPEWALL_PRINT_OWNER_LINK === '1') {
      out(
        `Private owner link (settings, sharing${remote ? ' and devices' : ''}; keep it to yourself): ${accountUrl || `${tls ? 'https' : 'http'}://127.0.0.1:${address.port}/`}#settings-token=${settingsToken}`,
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
    const line = detectedAgentsLine(detectAgents(process.env))
    if (line) out(line)
  }
  if (!loopback && !remote)
    out('Warning: listening beyond this machine with no login. Put it behind an authenticating proxy (docs/deployment.md).')
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
  if (flags.open) openBrowser(!remoteAccountOrigin && app.locals.openLink ? `${url}${app.locals.openLink()}` : url, out)
  const stop = () => {
    clearServeState(config)
    stopChildren(app)
    // Hands the lease over after a last read of the log; messages still
    // queued get a moment, inside the exit deadline below.
    Promise.allSettled([notifier?.close(1500), tail?.stop()]).finally(() => server.close(() => process.exit(0)))
    setTimeout(() => process.exit(0), tail ? 12000 : 2000).unref()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return server
}
