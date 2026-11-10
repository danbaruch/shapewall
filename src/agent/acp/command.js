// The ACP agent command: which program the chat panel starts, and with what
// environment.
//
// The command comes only from the person running Shapewall: the
// `--agent-acp "<command>"` flag or SHAPEWALL_AGENT_ACP. Never from
// shapewall.config.json, which is usually committed: a repo that could name a
// command would run code on the machine of anyone who opens a chat in it.
//
// The command is split into argv like `watch --exec` (no shell: no
// variables, globs, pipes or redirects) and started with a small environment:
// what a CLI needs to find itself and its login (PATH, HOME, locale, temp and
// XDG folders), never Shapewall's or other tools' secrets. Extra variables an
// agent needs (an API key, say) are passed only when named in
// SHAPEWALL_AGENT_ACP_ENV.

import path from 'node:path'
import { findProgram, splitCommand } from '../../watch.js'

export const ACP_COMMAND_VAR = 'SHAPEWALL_AGENT_ACP'
export const ACP_ENV_VAR = 'SHAPEWALL_AGENT_ACP_ENV'
export const ACP_FLAG = '--agent-acp'

// Always passed when set: where programs, the home folder, the locale, temp
// files, proxies and per-tool config folders are. None of them is a secret.
const BASE_VARS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  // The desktop keyring, where some CLIs keep their login.
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Config folders (not credentials) of the agents in docs/agents.md.
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GOOSE_PROVIDER',
  'GOOSE_MODEL',
  'GOOSE_MODE',
  // A goose profile of its own for Shapewall (docs/agent-hardening.md).
  'GOOSE_PATH_ROOT',
  // Windows: what a program needs to start at all.
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
]
const BASE_PREFIXES = ['LC_']

// Never passed, even when named in SHAPEWALL_AGENT_ACP_ENV: Shapewall's own
// settings and secrets, and tokens that belong to other tools.
const DENIED_VARS = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'RESEND_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'])
// npm_config_* (any case) too: npm settings such as script-shell or registry
// would let a variable decide what `npx` runs.
const DENIED_RE = /^(SHAPEWALL_|npm_config_)|(WEBHOOK_SECRET|_PASSWORD)$/i

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function deniedVar(name) {
  return DENIED_VARS.has(name) || DENIED_RE.test(name)
}

// A terminal the agent asks for runs with the agent's environment. The
// agent may add only these harmless names (shown on the approval card); the
// ones below change what a program loads or runs, so a request naming them
// is refused outright, and anything else is ignored.
export const TERMINAL_ENV_ALLOWED = new Set(['TERM', 'COLUMNS', 'LINES', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ', 'LANG', 'LC_ALL'])
const TERMINAL_ENV_REFUSED_RE =
  /^(LD_|DYLD_|GIT_|npm_config_|PYTHON|RUBY|PERL|JAVA_TOOL|_JAVA)|^(NODE_OPTIONS|NODE_PATH|PATH|PATHEXT|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|IFS|SHELL|HOME|PAGER|GIT_PAGER|MANPAGER|EDITOR|VISUAL|GIT_EDITOR|SSH_ASKPASS|GIT_ASKPASS|SUDO_ASKPASS|COMSPEC)$/i

export function terminalEnvRefused(name) {
  return TERMINAL_ENV_REFUSED_RE.test(name) || deniedVar(name)
}

// The extra variable names from SHAPEWALL_AGENT_ACP_ENV, and the ones refused.
export function extraVarNames(env = process.env) {
  const names = String(env[ACP_ENV_VAR] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const refused = names.filter((name) => !ENV_NAME_RE.test(name) || deniedVar(name))
  return { names: names.filter((name) => !refused.includes(name)), refused }
}

// The environment for the agent process: the base variables, any extra ones
// the person named, and nothing else.
export function agentEnv(env = process.env, { extra = extraVarNames(env).names } = {}) {
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    const base = BASE_VARS.includes(name) || BASE_PREFIXES.some((prefix) => name.startsWith(prefix))
    if ((base || extra.includes(name)) && !deniedVar(name)) out[name] = value
  }
  return out
}

// A name for the panel, from the command: "Claude Code" for claude-agent-acp,
// and so on. Never the command line itself, which may hold paths.
const KNOWN = [
  [/claude-(agent|code)-acp/, 'Claude Code'],
  [/codex-acp/, 'Codex'],
  [/gemini/, 'Gemini CLI'],
  [/goose/, 'goose'],
  [/qwen/, 'Qwen Code'],
  [/opencode/, 'OpenCode'],
]

export function acpLabel(argv) {
  const words = argv.map((arg) => path.basename(String(arg)).toLowerCase())
  for (const [re, label] of KNOWN) if (words.some((word) => re.test(word))) return label
  return path.basename(String(argv[0] || 'agent')).replace(/\.(exe|cmd|bat|m?js)$/i, '') || 'ACP agent'
}

// Which agent a command starts, from the path segments of its words (so
// `npx @agentclientprotocol/claude-agent-acp` and
// `node .../claude-agent-acp/dist/index.js` count too): 'claude', 'codex',
// 'goose', 'gemini' or null.
export function acpAgentKind(argv = []) {
  const words = argv.flatMap((arg) =>
    String(arg)
      .toLowerCase()
      .split(/[\\/]/)
      .map((word) => word.replace(/\.(exe|cmd|bat|m?js)$/, '')),
  )
  if (words.some((word) => /^claude-(agent|code)-acp$/.test(word))) return 'claude'
  if (words.some((word) => /^codex-acp$/.test(word))) return 'codex'
  if (words.some((word) => /^goose$/.test(word))) return 'goose'
  if (words.some((word) => /^gemini(-cli)?$/.test(word))) return 'gemini'
  return null
}

// How to log the agent in, for the chat error and the server log when it
// answers "authentication required".
const LOGIN_HINTS = {
  claude: 'run `claude` in a terminal and use /login, or start the agent with `claude-agent-acp --cli` and use /login there',
  codex: 'run `codex login` in a terminal',
  goose: 'run `goose configure` in a terminal and set up a provider',
  gemini: 'run `gemini` in a terminal and sign in',
}

export function loginHint(argv) {
  return LOGIN_HINTS[acpAgentKind(argv)] || 'run the agent once in a terminal on this machine and log in'
}

// The command the person gave (flag first, then the environment, then the
// one saved in Settings > Agent: src/agent/user-settings.js), parsed.
// { source, argv, program, label, problem }; null when there is none.
export const SETTINGS_SOURCE = 'Settings > Agent'

export function acpCommand({ flag = null, env = process.env, saved = null } = {}) {
  const given = (value) => typeof value === 'string' && value.trim() !== ''
  const [raw, source] = given(flag)
    ? [flag, ACP_FLAG]
    : given(env[ACP_COMMAND_VAR])
      ? [env[ACP_COMMAND_VAR], ACP_COMMAND_VAR]
      : given(saved)
        ? [saved, SETTINGS_SOURCE]
        : ['', null]
  if (!source) return null
  let argv
  try {
    argv = splitCommand(raw, source)
  } catch (error) {
    return { source, argv: null, program: null, label: 'ACP agent', problem: error.message }
  }
  const label = acpLabel(argv)
  const program = findProgram(argv[0], env)
  if (!program) return { source, argv, program: null, label, problem: `${source}: "${argv[0]}" is not an executable on PATH` }
  return { source, argv: [program, ...argv.slice(1)], program, label, problem: null }
}

// The command as shown in the terminal and by `shapewall doctor`: words with
// spaces quoted. Only ever printed on this machine, never sent to the board.
export function formatCommand(argv) {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`)).join(' ')
}
