// A local board's turn, on the capability model (plan 3.3): what it may do
// (capabilities.js resolveCapabilities, path "local-chat" for an ACP agent,
// "local-endpoint" for an OpenAI-compatible one) and the tool host that
// enforces it (exec-mcp.js): named commands, the shell in the OS sandbox,
// dev servers and the throwaway browser.
//
// Who the turn is for: the local owner capability (the settings token on
// loopback, a paired device, the tailnet owner) is solo, and only while
// every word of the turn is the owner's: a board shared beyond this machine
// (share visitors, signed-in accounts other than the owner) can put other
// people's text in a comment thread, so such a turn is open. Display names
// never count (the same rule as the starter gate).
//
// Where commands run: the folder the agent edits (the checkout in place, as
// local boards always did until 2.0.0, or branch mode's worktree), with its
// .git and Shapewall's own folder never writable. Cards of Shapewall's own
// (a command that needs an answer) are answered on the board by its owner
// (routes.js). Approvals are remembered in `.shapewall/agent/approvals/`
// with the same key as a connected agent's (command-approvals.js: tier,
// sandbox mode, network, read only) and never for an open turn or a command
// outside the OS sandbox (exec-mcp.js mayRun).

import fs from 'node:fs'
import path from 'node:path'
import { hostPlatform, namedCommands, resolveCapabilities } from './capabilities.js'
import { createApprovalStore } from './command-approvals.js'
import { toPrompt } from './capability-render.js'
import { offeredCapabilities, startExecSession } from './exec-mcp.js'
import { localMachinePolicy, userAgentEntry } from './user-settings.js'
import { authFiles, loadConfig } from '../config.js'
import { policyExtensions, turnExtensions } from './agent-config-folder.js'
import { agentSettings } from './config.js'
import { acpAgentKind } from './acp/command.js'

let platformOnce = null
// One sandbox probe per process: every turn and the capability card read the same answer.
export const localPlatform = () => (platformOnce ||= hostPlatform())

// The trust block of a local turn (capabilities.js cleanTrust). `thread`:
// the thread's trust state (threads.js `trust`, thread-trust.js): only the
// owner's text ever ("owner"), or tainted; missing reads as tainted.
export function localTrust({ owner, shared = false, comment = false, thread = null }) {
  const authors = [{ handle: null, owner: owner === true, member: false }]
  // A comment thread on a board others can reach: its text may be theirs.
  if (comment && shared) authors.push({ handle: null, owner: false, member: false })
  const state = thread && typeof thread === 'object' ? thread : { tainted: true, authors: [] }
  return {
    authors,
    guests: false,
    thread: {
      tainted: state.tainted !== false,
      authors: (Array.isArray(state.authors) ? state.authors : []).map((id) => ({ handle: null, owner: id === 'owner', member: false })),
    },
  }
}

// The agent config folder this project's agent has (user-settings.js
// agentConfig), checked and read now: { found, names, error }.
export const localExtensions = (config, env = process.env) =>
  policyExtensions(localMachinePolicy(config.dir ? userAgentEntry(config.dir, env).entry : null).agentConfig, {
    projectDir: config.dir,
    outputDir: config.outputDir,
    env,
  })

// The ACP agent a local board's chat runs, as the resolver reads it
// (capabilities.js `agent`): its kind (only Claude Code takes extensions)
// and whether its session is the restricted one (agent.localSession, which
// is the default; "own" keeps the agent's own full session). `settings`:
// agentSettings() for the profile the chat uses.
export const localAgentOf = (config, settings) => ({
  kind: settings?.backend === 'acp' ? acpAgentKind(settings.acp?.argv || []) : null,
  hardened: config.agent?.localSession !== 'own',
})
// The same for the board's default agent: what its card and `agent status` show.
export function localAgent(config, env = process.env, { acp = null } = {}) {
  try {
    return localAgentOf(config, agentSettings(config, env, { acp }))
  } catch {
    return { kind: null, hardened: false }
  }
}

// The folder of recorded logins for the agent browser (agent-browser.js readAuthState).
export const AUTH_DIR = '.shapewall-auth'

// The folder a local approval record lives in: the board's project, never the server.
export const localApprovalsDir = (config) => path.join(config.outputDir, 'agent', 'approvals')

// The paths in `root` no command may read: Shapewall's own folder and every
// login file the config records (auth.storageState, auth.loginScript, at the
// top and per board), wherever in the folder they are (PR #39 review). A
// login file of the checkout is found in `root` too when root is a copy or
// worktree of it (the same path relative to config.dir). Only paths that
// exist and are inside root (the sandbox denies the rest of the home folder
// anyway).
// The recorded logins' folder in `dir`, made (0700) when missing: a folder
// the sandbox can hide from commands from their start. A link or a file
// in its place is left alone (it is denied by its path all the same).
export function ensureAuthDir(dir) {
  try {
    fs.mkdirSync(path.join(dir, AUTH_DIR), { mode: 0o700 })
  } catch {
    /* there already, or not ours to make */
  }
}

export function commandReadDenied(config, root) {
  if (!root || !config) return []
  let real
  try {
    real = fs.realpathSync(root)
  } catch {
    return []
  }
  const inside = (file) => {
    const rel = path.relative(real, file)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  const out = new Set()
  const add = (file) => {
    if (!file) return
    let resolved
    try {
      resolved = fs.realpathSync(file)
    } catch {
      return
    }
    if (inside(resolved) && resolved !== real) out.add(resolved)
  }
  if (config.outputDir) add(path.resolve(config.outputDir))
  // The recorded logins the agent browser loads (.shapewall-auth/<name>.auth.json), always (Q7 C4).
  add(path.join(real, AUTH_DIR))
  if (config.dir) add(path.join(path.resolve(config.dir), AUTH_DIR))
  for (const file of authFiles(config)) {
    const absolute = path.resolve(config.dir || real, file)
    add(absolute)
    if (config.dir) {
      const rel = path.relative(path.resolve(config.dir), absolute)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) add(path.join(real, rel))
    }
  }
  return [...out]
}

// resolveCapabilities for one local turn. `inPlace`: edits land in the
// checkout (not branch mode), which is what the agent's Edit tools do.
export function localCapabilities({
  config,
  env = process.env,
  acp,
  owner,
  shared,
  comment,
  inPlace,
  thread = null,
  extensions = null,
  agent = null,
  extensionsFailed = false,
  platform = localPlatform(),
}) {
  const machine = localMachinePolicy(config.dir ? userAgentEntry(config.dir, env).entry : null)
  const view = inPlace ? { ...config, agent: { ...(config.agent || {}), fixIn: 'checkout' } } : config
  return resolveCapabilities({
    path: acp ? 'local-chat' : 'local-endpoint',
    trust: localTrust({ owner, shared, comment, thread }),
    audience: 'owner',
    machine,
    server: null,
    config: view,
    platform,
    extensions,
    agent,
    extensionsFailed,
  })
}

// The tool host of one local turn, or null when it offers nothing.
// -> { caps, prompt, exec } where exec is startExecSession's result (null: none).
export async function startLocalTools({
  config,
  env = process.env,
  acp,
  owner,
  shared = false,
  comment = false,
  // The folder the agent works in (config.dir, or branch mode's worktree).
  root,
  inPlace,
  ask,
  // Shapewall's own server port: never opened in the agent browser.
  denyPorts = [],
  // false: an endpoint backend calls the host in process.
  serve = true,
  platform = localPlatform(),
  // The thread's trust state (threads.js `trust`): extensions only while it is clean.
  thread = null,
  // The thread's key, for the extension plugin Shapewall builds.
  key = null,
  // The ACP agent the turn runs (localAgentOf): extensions for Claude Code's restricted session only.
  agent = null,
  log = () => {},
}) {
  const folder = acp ? localExtensions(config, env) : { found: null, names: null, error: null }
  if (folder.error) log(`agent extensions: ${folder.error}`)
  let failed = false
  const resolve = (current) =>
    localCapabilities({
      config: current,
      env,
      acp,
      owner,
      shared,
      comment,
      inPlace,
      thread,
      extensions: folder.names,
      agent,
      extensionsFailed: failed,
      platform,
    })
  let caps = resolve(config)
  let extensions = null
  try {
    extensions = turnExtensions(caps, folder.found, JSON.stringify(['local', config.dir, key]), { env })
  } catch (error) {
    log(`agent extensions: ${error.message}`)
    extensions = null
  }
  // On, but nothing to give the session (the plugin could not be built):
  // the prompt says off, as the session has them.
  if (caps.extensions.on && !extensions) {
    failed = true
    caps = resolve(config)
  }
  // `commands` come from the checkout's config, read again for each check.
  const fresh = () => {
    if (!config.file) return config
    try {
      return loadConfig(config.file)
    } catch {
      return null
    }
  }
  let real = null
  try {
    real = root ? fs.realpathSync(root) : null
  } catch {
    real = null
  }
  // The recorded logins' folder exists before any command does, so the
  // sandbox can hide it (it hides only what is there when it starts: Q7 C4).
  if (real) ensureAuthDir(real)
  if (config.dir) ensureAuthDir(config.dir)
  // A local checkout keeps its repository, Shapewall's folder and the
  // recorded logins read only for commands. Commands never run in the
  // checkout itself (capabilities.js: in_place_commands), only in a copy.
  const denyWrite = real
    ? [path.join(real, '.git'), path.resolve(config.outputDir), path.join(real, AUTH_DIR)].filter((dir) => fs.existsSync(dir))
    : []
  const exec = await startExecSession({
    capabilities: caps,
    platform,
    recheck: () => {
      const current = fresh()
      return current ? resolve(current) : null
    },
    commands: namedCommands(config),
    readCommands: () => namedCommands(fresh()),
    root: real,
    expect: real,
    checkout: null,
    readOnly: !caps.edit.on,
    denyWrite,
    // Shapewall's own folder and the login files the config names hold the
    // logins captures record: no command reads them.
    denyRead: commandReadDenied(config, real),
    network: caps.shell.mode !== 'off' ? caps.shell.network : 'none',
    approvals: createApprovalStore(localApprovalsDir(config)),
    scope: JSON.stringify(['local', config.dir]),
    ask,
    shellCard: caps.shell.mode !== 'off' && localMachinePolicy(userAgentEntry(config.dir, env).entry).commandApproval === 'always',
    // Local edits are the agent's own: the run summary and Undo see the checkout as it is.
    onChanged: () => {},
    // In place, the checkout holds the agent's earlier edits: the base is what is committed (Q7 B7).
    committedBase: Boolean(inPlace && real),
    browserCheckout: real,
    denyPorts,
    serve,
    env,
    log,
  })
  // What the tool host offers, not what was asked for (a session that did not start offers no commands).
  const prompt = toPrompt(offeredCapabilities(caps, exec))
  return { caps, prompt, exec, extensions }
}

// Whether every word an owner's local turn reads is the owner's (solo).
// `kind`: threads.js threadKind. A private chat belongs to the viewer who
// opened it; the board thread and a comment's thread are shared, so they
// count as the owner's only where nobody else can post in them (an ACP
// agent behind the owner gate, no signed-in accounts) and, for a comment,
// when the owner wrote it and every reply is the owner's agent's. Anything
// else is open: the commands it may run are asked about every time.
export function localOwnerOnly({ ownerWrites, kind, thread = null, comment = null, ownerGate = false, accounts = false, acp = false }) {
  if (!ownerWrites) return false
  if (kind === 'chat') return thread?.owner === 'owner'
  const gated = ownerGate && acp && !accounts
  if (kind === 'board') return gated
  if (kind === 'comment') return gated && comment?.byOwner === true && (comment.replies || []).every((reply) => reply?.agent === true)
  return false
}
