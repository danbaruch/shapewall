// Command line parsing: the flags each command takes, and "did you mean" for typos.

import { AUTH_FLAGS, AUTH_BOOLEAN_FLAGS } from '../auth/record.js'
import { cliCommand } from '../invocation.js'
import { removed } from '../deprecation.js'

const BOOLEAN_FLAGS = new Set([
  ...AUTH_BOOLEAN_FLAGS,
  'seo',
  'no-seo',
  'no-discover',
  'include-checks',
  'accounts',
  'tailscale',
  'lan',
  'no-identity',
  'no-remote-chat',
  'approve-on-host',
  'for-agent',
  'force',
  'read-only',
  'no-capture',
  'open',
  'print-owner-link',
  'skip-git-check',
  'resolved',
  'all',
  'json',
  'no-comments',
  'browser-comments',
  'noindex',
  'no-index',
  'help',
  'version',
  'new-only',
  'once',
  'install-browser',
  'no-launch',
  'trust-proxy',
  'new',
  'status',
  'pass-token',
  'takeover',
  'endpoint',
  'browser-no-sandbox',
  'include-guests',
  'dry-run',
  'chat',
  'no-chat',
  'allow-remote-agent',
  'pr',
  'retry',
  'trust-comment',
  'allow-ci-push',
  'no-egress',
  'yes',
  'check-external',
  'broken',
  'follow',
  'no-claim',
  'imported',
  'tailscale',
  'funnel',
  'tailnet-sign-in',
  'tailnet-passkeys',
  'yes',
  'link',
  'setup',
  'start',
  'print',
  'run',
  'check',
  'recapture',
  'ci',
  'fail-on-change',
  'allow-start',
  'claude',
  'codex',
  'remove',
  'write',
  'no-agent-docs',
  'rollback',
])
// Flag spellings removed in 2.0 (deprecated through 1.x), per command (or
// command and action, as actionScope names it): what to use instead. A strict parse refuses one with a one-line error naming
// the replacement, not "unknown option".
export const REMOVED_FLAGS = {
  export: { noindex: 'use --no-index' },
  'checks lighthouse': { production: 'use --build-mode' },
  capture: { yes: 'leave it out: capture never prompts' },
}

const REPEATABLE = new Set(['only', 'allowed-host', 'exclude', 'allow-host', 'trusted'])
// Flags that take a value but also work alone ("init --sitemap": the base
// URL's sitemap.xml). Alone, the flag is true.
const OPTIONAL_VALUE = new Set(['sitemap', 'compare'])
// A flag that is a plain switch elsewhere but takes an optional value for
// one command: "events --follow" keeps printing, "open --follow [AGENT]"
// opens the board following an agent (alone: any agent).
// "serve --team" turns team mode on, "serve --team off" off.
const COMMAND_OPTIONAL_VALUE = { open: new Set(['follow']), serve: new Set(['team']) }

// The flags each command reads. Anything else is a typo worth stopping for:
// "capture --onyl home" would otherwise capture every page.
const GLOBAL_FLAGS = ['config', 'help', 'version']
const REMOTE_FLAGS = ['remote', 'token-file', 'include-guests']
const CHECKS_FLAGS = ['board', 'only', 'env', 'seo', 'no-seo', 'limit', 'source-build', 'json', 'flow-file', 'viewport']
// `checks lighthouse` (once `audit`) takes the flags `audit` took.
const LIGHTHOUSE_FLAGS = [
  'board',
  'only',
  'env',
  'viewports',
  'samples',
  'max-pages',
  'max-runs',
  'cache',
  'build-mode',
  'source-build',
  'browser-version',
  'seo',
  'no-seo',
  'json',
]
// Commands whose actions take different flags: the action (the first word
// after the command) picks its list, '*' is every other action.
export const SUBCOMMAND_FLAGS = {
  checks: { lighthouse: LIGHTHOUSE_FLAGS, '*': CHECKS_FLAGS },
}
export const COMMAND_FLAGS = {
  'buzz-bridge': ['bridge-config'],
  settings: ['port', 'open'],
  auth: AUTH_FLAGS,
  init: ['base-url', 'sitemap', 'no-discover', 'force', 'limit', 'group', 'exclude', 'ci', 'no-agent-docs'],
  sitemap: ['limit', 'group', 'exclude', 'board', 'dry-run', 'json'],
  migrate: ['dry-run', 'board', 'rollback', 'all', 'abandon', 'give-up', 'json'],
  capture: ['board', 'only', 'env', 'json', 'check-external'],
  // Every flag any `checks` action takes; SUBCOMMAND_FLAGS narrows it per action.
  checks: [...new Set([...CHECKS_FLAGS, ...LIGHTHOUSE_FLAGS])],
  serve: [
    'engine',
    'skip-git-check',
    'buzz-bridge',
    'accounts',
    'accounts-origin',
    'port',
    'host',
    'open',
    'print-owner-link',
    'read-only',
    'no-capture',
    'allowed-host',
    'chat',
    'no-chat',
    'agent-acp',
    'allow-remote-agent',
    'tailscale',
    'lan',
    'no-identity',
    'no-remote-chat',
    'approve-on-host',
    'tls-cert',
    'tls-key',
    'team',
    'team-port',
  ],
  devices: ['json', 'all'],
  comments: [
    'open',
    'resolved',
    'all',
    'page',
    'mention',
    'since',
    'viewport',
    'selector',
    'text',
    'json',
    'for-agent',
    'note',
    'ref',
    'body',
    'author',
    'board',
    'yes',
    'imported',
    ...REMOTE_FLAGS,
  ],
  events: ['follow', 'since', 'limit', 'json', 'board'],
  journeys: ['json', 'board'],
  links: ['broken', 'board', 'env', 'json'],
  watch: ['recapture', 'exec', 'concurrency', 'new-only', 'once', 'timeout', 'mention', 'no-claim', 'board', 'pass-token', ...REMOTE_FLAGS],
  agent: [
    'comment',
    'pr',
    'git-remote',
    'fork-remote',
    'retry',
    'trust-comment',
    'max-turns',
    'max-tokens',
    'max-minutes',
    'max-disk',
    'model-timeout',
    'trusted',
    'runtime',
    'image',
    'profile',
    'allow-host',
    'registry',
    'work-dir',
    'once',
    'no-egress',
    'allow-ci-push',
    'json',
    'board',
    // agent connect
    'agent',
    'endpoint',
    'name',
    'as',
    'audience',
    'concurrency',
    'takeover',
    'approvals',
    'project',
    'workspace',
    'used-by',
    'icon',
    'tint',
    'allow-command',
    'allow-path',
    'auto',
    'base',
    'browser-profile',
    'browser-no-sandbox',
    // agent setup, agent docs
    'claude',
    'codex',
    'scope',
    'force',
    'dry-run',
    'remove',
    'yes',
    'write',
    'print',
    'instructions',
    'agent-config',
    'respond',
    ...REMOTE_FLAGS,
  ],
  github: ['board', 'json'],
  ci: [
    'base-url',
    'head-url',
    'base-dir',
    'head-dir',
    'out',
    'threshold',
    'max-pages',
    'fail-on-change',
    'url',
    'allow-start',
    'checkout',
    'timeout',
    'dir',
    'artifact-url',
    'repo',
    'pull',
    'board',
    'json',
  ],
  mcp: ['read-only', 'no-capture', 'board', ...REMOTE_FLAGS],
  open: ['board', 'page', 'comment', 'viewport', 'compare', 'follow', 'print', 'json', ...REMOTE_FLAGS],
  notify: ['json', 'to', 'board'],
  doctor: ['install-browser', 'port', 'agent-acp', 'json', 'no-launch'],
  variant: ['url', 'path', 'title', 'note', 'source', 'id', 'viewport', 'board', 'json'],
  export: ['out', 'no-comments', 'browser-comments', 'no-index', 'include-checks', 'include-guests'],
  push: ['remote', 'token-file', 'board', 'include-checks', 'page'],
  share: ['remote', 'token-file', 'board', 'dry-run', 'no-comments', 'include-checks'],
  login: ['remote', 'project', 'workspace'],
  join: ['remote', 'invite'],
  admin: ['remote', 'workspace', 'name', 'login', 'link', 'role', 'days', 'json', 'yes'],
  hosted: [
    'data',
    'origin',
    'port',
    'host',
    'signup',
    'trust-proxy',
    'previous-origin',
    'report-email',
    'new',
    'days',
    'status',
    'tailscale',
    'tailscale-port',
    'funnel',
    'tailnet-sign-in',
    'tailnet-passkeys',
    'yes',
    'role',
    'workspace',
    'link',
    'workspace-name',
    'login',
    'handle',
    'setup-link',
    'funnel-port',
    'quotas',
    'retention-hours',
    'retention-keep',
    'usage-days',
    'owners-see-sign-ins',
    'setup',
    'domain',
    'usercontent-domain',
    'usercontent-origin',
    'email',
    'dir',
    'source',
    'dry-run',
    'force',
    'start',
    'print',
    'operator',
    'json',
    'reason',
    'note',
    'confirm',
    'out',
    'all',
    'keep',
    'run',
    'limit',
    'to',
    'from',
    'keep-days',
    'check',
  ],
}

// Edit distance with swapped neighbours as one edit ("onyl" is one from
// "only"), for "did you mean".
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)))
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

// The closest known flag, if it is close enough to be a typo.
export function suggestFlag(key, known) {
  let best = null
  let bestScore = Infinity
  for (const name of known) {
    const score = distance(key, name)
    if (score < bestScore) {
      best = name
      bestScore = score
    }
  }
  const allowed = Math.max(1, Math.min(3, Math.floor(key.length / 3)))
  return best && (bestScore <= allowed || best.startsWith(key) || key.startsWith(best)) ? best : null
}

const takes = (command, key) => GLOBAL_FLAGS.includes(key) || COMMAND_FLAGS[command].includes(key)

// The error for a flag this command no longer takes: the removed-in-2.0
// line when it is an old spelling (REMOVED_FLAGS), else "unknown option".
function refusedFlag(key, scope) {
  if (Object.hasOwn(REMOVED_FLAGS[scope.name] || {}, key)) return removed(`${scope.name} --${key}`, REMOVED_FLAGS[scope.name][key])
  return unknownFlag(key, scope.name, scope.flags)
}

// The flags a command takes for the action named after it, and that
// command line's name ("checks lighthouse") for the error.
function actionScope(command, action) {
  const scoped = SUBCOMMAND_FLAGS[command]
  if (!scoped) return { name: command, flags: COMMAND_FLAGS[command] }
  if (action !== '*' && Object.hasOwn(scoped, action)) return { name: `${command} ${action}`, flags: scoped[action] }
  return { name: command, flags: scoped['*'] }
}

function unknownFlag(key, command, flags = COMMAND_FLAGS[command] || []) {
  const known = [...flags, ...GLOBAL_FLAGS]
  const hint = suggestFlag(key, known)
  const error = new Error(
    `unknown option --${key} for "${command}"${hint ? ` (did you mean --${hint}?)` : ''}. "${cliCommand(`${command} --help`)}" lists its options.`,
  )
  error.code = 'unknown_flag'
  return error
}

// Parses argv into { command, positional, flags }. With `strict`, a flag
// the command does not take is an error (before it can swallow the next word
// as its value), with the closest real flag as a hint, or the replacement
// when it is a spelling removed in 2.0.
export function parseArgs(argv, { strict = false } = {}) {
  const positional = []
  const flags = {}
  const seen = []
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index]
    if (arg === '-h') arg = '--help'
    if (arg === '-v') arg = '--version'
    if (arg === '-y') arg = '--yes'
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    let key = arg.slice(2)
    let value
    const eq = key.indexOf('=')
    if (eq >= 0) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    const command = positional[0]
    if (strict && command && COMMAND_FLAGS[command] && !takes(command, key)) {
      throw refusedFlag(key, actionScope(command, positional[1]))
    }
    seen.push(key)
    const ownValue = Boolean(command && COMMAND_OPTIONAL_VALUE[command]?.has(key))
    const boolean = BOOLEAN_FLAGS.has(key) && !ownValue
    if (eq >= 0) {
      if (boolean) {
        if (value === 'true' || value === 'false') value = value === 'true'
        else if (!['tailscale', 'lan'].includes(key)) throw new Error(`--${key} accepts only true or false.`)
      }
    } else if (boolean) {
      value = true
    } else {
      value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        if (!OPTIONAL_VALUE.has(key) && !ownValue) throw new Error(`--${key} needs a value`)
        value = true
      } else index += 1
    }
    if (REPEATABLE.has(key))
      flags[key] = [
        ...(flags[key] || []),
        ...String(value)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ]
    else flags[key] = value
  }
  const command = positional[0] || null
  // Flags written before the command are checked once it is known.
  if (strict && command && COMMAND_FLAGS[command]) {
    const scope = actionScope(command, positional[1])
    for (const key of seen) if (!takes(command, key)) throw refusedFlag(key, scope)
    // Each action takes only its own flags ("checks run --samples 3" is a mistake).
    if (SUBCOMMAND_FLAGS[command]) {
      for (const key of seen) {
        if (GLOBAL_FLAGS.includes(key) || scope.flags.includes(key)) continue
        throw unknownFlag(key, scope.name, scope.flags)
      }
    }
  }
  return { command, positional: positional.slice(1), flags }
}
