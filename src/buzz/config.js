// Operator-only configuration. This file contains public identities and paths,
// never credentials. The browser cannot supply any of these values.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const HEX64 = /^[0-9a-f]{64}$/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const CLI = path.join(os.homedir(), '.local/bin/buzz')
// Where each transport signer's private EnvironmentFile is. There is no
// default: the bridge is off until the operator names both files, in the
// operator map (`signerFiles`) or in these variables (the map wins).
export const SIGNER_FILE_VARS = Object.freeze({ codex: 'SHAPEWALL_BUZZ_SIGNER_CODEX', claude: 'SHAPEWALL_BUZZ_SIGNER_CLAUDE' })
export function signerFiles(config, env = process.env) {
  if (
    config.signerFiles !== undefined &&
    (!config.signerFiles || typeof config.signerFiles !== 'object' || Array.isArray(config.signerFiles))
  )
    throw new Error('signerFiles must map codex and claude to absolute file paths.')
  const out = {}
  for (const [id, name] of Object.entries(SIGNER_FILE_VARS)) {
    const value = config.signerFiles?.[id] ?? env[name]
    if (value === undefined || value === '')
      throw new Error(
        `The Buzz bridge is off: no signer file for ${id}. Set signerFiles.${id} in the bridge configuration, or ${name}, to its private EnvironmentFile.`,
      )
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Signer file paths must be absolute.')
    out[id] = path.resolve(value)
  }
  return Object.freeze(out)
}
export const SIGNERS = Object.freeze({ codex: 'claude', claude: 'codex', goose: 'codex' })
export const within = (file, dir) => {
  const relative = path.relative(dir, file)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export class BridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function noSymlinks(file) {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Bridge paths must not contain symlinks.')
  }
  return absolute
}

export function privatePath(file, kind = 'file') {
  noSymlinks(file)
  const stat = fs.lstatSync(file)
  if (
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    (kind === 'dir' ? !stat.isDirectory() : kind === 'socket' ? !stat.isSocket() : !stat.isFile())
  )
    throw new Error('Bridge paths must be owned by this user and private to this user.')
  return file
}

export function loadBridgeConfig(file, env = process.env) {
  file = path.resolve(file)
  privatePath(path.dirname(file), 'dir')
  privatePath(file)
  if (fs.statSync(file).size > 65536) throw new Error('Bridge configuration is too large.')
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (
    config.version !== 1 ||
    !UUID.test(config.channel?.id) ||
    typeof config.channel?.name !== 'string' ||
    config.channel.name.length > 80 ||
    !HEX64.test(config.ownerPubkey)
  )
    throw new Error('Invalid bridge identity or channel configuration.')
  if (!Array.isArray(config.agents) || config.agents.length !== 3 || new Set(config.agents.map((a) => a.id)).size !== 3)
    throw new Error('Configure exactly codex, claude and goose.')
  for (const agent of config.agents) {
    if (!Object.hasOwn(SIGNERS, agent.id) || !HEX64.test(agent.pubkey) || typeof agent.name !== 'string' || agent.name.length > 80)
      throw new Error('Invalid bridge agent configuration.')
  }
  if (new Set([config.ownerPubkey, ...config.agents.map((a) => a.pubkey)]).size !== 4)
    throw new Error('Bridge identities must be distinct.')
  if (!Array.isArray(config.projects) || !config.projects.length || config.projects.length > 16)
    throw new Error('Configure the allowed source projects.')
  for (const project of config.projects) {
    if (
      typeof project.root !== 'string' ||
      !path.isAbsolute(project.root) ||
      fs.realpathSync(project.root) !== project.root ||
      typeof project.name !== 'string' ||
      project.name.length > 100 ||
      !Array.isArray(project.boards) ||
      !project.boards.length ||
      project.boards.length > 32 ||
      project.boards.some((id) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    )
      throw new Error('Invalid fixed project mapping.')
  }
  if (new Set(config.projects.map((p) => p.root)).size !== config.projects.length) throw new Error('Duplicate project mapping.')
  const relay = new URL(config.relayUrl)
  if (
    !['https:', 'wss:'].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.pathname !== '/' ||
    relay.search ||
    relay.hash
  )
    throw new Error('Use the fixed authenticated HTTPS/WSS Buzz relay origin.')
  for (const key of ['socketPath', 'stateDir']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error('Bridge paths must be absolute.')
    privatePath(path.dirname(config[key]), 'dir')
  }
  if (
    Buffer.byteLength(config.socketPath) > 100 ||
    config.socketPath === config.stateDir ||
    path.dirname(config.socketPath) === config.stateDir
  )
    throw new Error('Use a short socket path outside the journal directory.')
  const signers = signerFiles(config, env)
  if (
    config.projects.some((project) =>
      [file, config.socketPath, config.stateDir, ...Object.values(signers)].some((p) => within(p, project.root)),
    )
  )
    throw new Error('Keep bridge configuration, socket, journal and signer files outside source projects and capture/export data.')
  return Object.freeze({ ...config, signerFiles: signers, file })
}

export function projectFor(config, root, board) {
  const project = config.projects.find((p) => p.root === root && p.boards.includes(board))
  if (!project) throw new BridgeError('project_denied', 'This source project and board are not mapped to Buzz.', 403)
  return project
}

export function publicBridge(config, root, board) {
  projectFor(config, root, board)
  return {
    channel: config.channel,
    sourceRoot: root,
    agents: config.agents.map((agent) => ({ ...agent, signer: config.agents.find((a) => a.id === SIGNERS[agent.id]) })),
    semantics: 'shared-channel',
  }
}
