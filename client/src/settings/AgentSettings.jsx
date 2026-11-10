// Settings > Agent: what the board chat talks to, set from the board instead
// of config files. Saved by the server to a file of the person's own outside
// the repo (src/agent/user-settings.js), never shapewall.config.json, and
// applied at once. Keys are never typed in here: the screen names the
// environment variable and shows the lines to set it.
//
// Only offered on a board served to this machine and opened from it
// (info.agent.settingsEditable); the server refuses everyone else anyway.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bot, Check, KeyRound, Plug, X } from 'lucide-react'
import { api, forgetSettingsToken } from '../lib/api'
import { cn } from '../lib/utils'
import { Badge, Button, Dialog, Input, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, Toggle, ToggleGroup } from '../components/ui'
import { SettingsHint, TOKEN_HINT } from './SettingsHint'
import { ConfirmDialog, CopyLine, Field, Override, TestResult } from './AgentSettingsParts'
import { AgentsCard } from './AgentsCard'

// Used by the chat panel's quick connect too.
export { ConfirmDialog, CopyLine }

// The same rule as the server (src/agent/config.js): only a variable that is
// plainly a model key, never another tool's token.
const KEY_VAR_RE = /^(SHAPEWALL_AGENT_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_API_KEY)$/
const DENIED_KEY_VARS = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SHAPEWALL_GITHUB_TOKEN',
  'SHAPEWALL_GITHUB_WEBHOOK_SECRET',
  'SHAPEWALL_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'SHAPEWALL_AGENT_BASE_URL',
  'SHAPEWALL_AGENT_MODEL',
  'SHAPEWALL_AGENT_KEY_HOSTS',
])

const BACKENDS = [
  { id: 'openai-compatible', label: 'OpenAI-compatible' },
  { id: 'acp', label: 'ACP agent' },
]

// docs/agents.md "Connect an agent CLI over ACP", in their restricted forms
// (docs/agent-hardening.md): goose with only its developer extension added
// by Shapewall; Claude Code and Codex keep the permission and sandbox modes
// of their own settings.
const PRESETS = [
  { label: 'Claude Code', command: 'claude-agent-acp' },
  { label: 'Codex', command: 'codex-acp' },
  { label: 'goose', command: 'goose acp --with-builtin developer' },
  { label: 'Gemini CLI', command: 'gemini --acp' },
]

const SOURCE_TEXT = { env: 'the environment', settings: 'these settings', config: 'shapewall.config.json', flag: '--agent-acp' }

export function keyVarProblem(name) {
  if (!name) return null
  if (!KEY_VAR_RE.test(name) || DENIED_KEY_VARS.has(name))
    return 'Use SHAPEWALL_AGENT_API_KEY or a name ending in _API_KEY (never another tool’s token).'
  return null
}

function hostOf(url) {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.host.toLowerCase() : null
  } catch {
    return null
  }
}

function formFrom(view) {
  const saved = view?.saved || {}
  return {
    backend: saved.backend || view?.effective?.backend || 'openai-compatible',
    baseUrl: saved.baseUrl || '',
    model: saved.model || '',
    apiKeyEnv: saved.apiKeyEnv || '',
    label: saved.label || '',
    acpCommand: saved.acpCommand || '',
    keyHosts: saved.keyHosts || [],
    // null: not set here (an ACP agent says itself; an endpoint is assumed to take images).
    vision: typeof saved.vision === 'boolean' ? saved.vision : null,
  }
}

function sameForm(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// `buzz`: this installation has the Buzz bridge on (info.buzzAvailable); only
// then is it mentioned. `onDirtyChange` tells the dialog there are unsaved edits.
// `agents`: where the connected agents are managed. 'inline' shows the
// Agents card here (the chat's agent dialog, the host-only window); 'link'
// points to it in Workspace settings (the board's general Settings); 'none'
// leaves it out (the Agents card's own "Other" dialog).
export function AgentSettings({ onSaved, touch, buzz = false, onDirtyChange, agents = 'inline' }) {
  const [view, setView] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [form, setForm] = useState(formFrom(null))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [savedNote, setSavedNote] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState(null)
  // A profile change reloads the form when it ends.
  const [profileBusy, setProfileBusy] = useState(false)
  // The answer to a save or a profile change replaces the form: no typing meanwhile.
  const locked = saving || profileBusy

  const load = useCallback(async () => {
    try {
      const next = await api.get('/api/agent/settings')
      setView(next)
      setForm(formFrom(next))
      setLoadError(null)
    } catch (caught) {
      // 404: this tab's settings token is not the server's (it restarted).
      if (caught.status === 404) forgetSettingsToken()
      setLoadError(caught.status === 404 ? TOKEN_HINT : caught.message)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const set = (key) => (event) => {
    const value = typeof event === 'string' ? event : event.target.value
    setForm((current) => ({ ...current, [key]: value }))
    setSavedNote(false)
  }
  const dirty = view ? !sameForm(form, formFrom(view)) : false
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])
  const discard = () => {
    setForm(formFrom(view))
    setError(null)
    setSavedNote(false)
  }
  const config = view?.config || {}
  const effective = view?.effective || {}
  const acp = form.backend === 'acp'
  const keyVar = form.apiKeyEnv.trim() || config.apiKeyEnv || view?.defaultKeyVar || 'SHAPEWALL_AGENT_API_KEY'
  const keyVarError = keyVarProblem(form.apiKeyEnv.trim())
  const keySet = Boolean(view?.keyVarsSet?.includes(keyVar))
  const url = view?.env?.baseUrl ? effective.baseUrl : form.baseUrl.trim() || config.baseUrl || ''
  const host = hostOf(url)
  const urlProblem = form.baseUrl.trim() && !hostOf(form.baseUrl.trim()) ? 'An http(s) URL, such as https://api.deepseek.com' : null
  // A local server without a key (Ollama, LM Studio): plain http and no key
  // variable named. A key never goes over plain http to another machine, so
  // there is nothing to export.
  const keyless = !keySet && !form.apiKeyEnv.trim() && !config.apiKeyEnv && /^http:/i.test(url)
  // The command in use when --agent-acp or SHAPEWALL_AGENT_ACP wins over these settings.
  const overridden = Boolean(view?.env?.acp)

  const body = useMemo(
    () => ({
      backend: form.backend,
      baseUrl: form.baseUrl.trim() || null,
      model: form.model.trim() || null,
      apiKeyEnv: form.apiKeyEnv.trim() || null,
      label: form.label.trim() || null,
      acpCommand: form.acpCommand.trim() || null,
      keyHosts: form.keyHosts,
      vision: form.vision,
    }),
    [form],
  )

  // `confirmed`: the hash of the items the dialog showed (the server asks
  // again when the items changed since).
  const save = async (confirmed = null) => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.post('/api/agent/settings', { settings: body, confirm: confirmed })
      if (next.confirm) {
        // A new command or key host: ask, then save again with their hash.
        setConfirm({ items: next.confirm, hash: next.confirmHash })
        return
      }
      setView(next)
      setForm(formFrom(next))
      setConfirm(null)
      setSavedNote(true)
      setResult(null)
      onSaved?.()
    } catch (caught) {
      setConfirm(null)
      setError(caught.message)
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const next = await api.post('/api/agent/settings/test', {})
      setResult(next)
      // What the test found out about images: set the toggle (saved with Save).
      if (typeof next.vision === 'boolean' && next.vision !== (form.vision ?? true)) {
        setForm((current) => ({ ...current, vision: next.vision }))
      }
    } catch (caught) {
      setResult({ ok: false, message: caught.message, details: [] })
    } finally {
      setTesting(false)
    }
  }

  if (loadError) {
    return (
      <div className="space-y-3 p-5" data-sw-settings-error="load">
        <p className="text-sm text-bad" role="alert">
          {loadError === TOKEN_HINT ? <SettingsHint /> : `Could not load the agent settings: ${loadError}`}
        </p>
        {loadError === TOKEN_HINT ? null : (
          <Button
            size={touch ? 'touch' : 'sm'}
            onClick={() => {
              setLoadError(null)
              load()
            }}
          >
            Try again
          </Button>
        )}
      </div>
    )
  }
  if (!view) {
    return (
      <div className="flex items-center gap-2 p-5 text-sm text-muted">
        <Spinner /> Loading
      </div>
    )
  }

  if (view.editable === false)
    return (
      <div className="space-y-3 p-5" data-sw-settings-readonly>
        <p className="text-sm text-muted">{view.message}</p>
        <dl className="space-y-2 text-sm text-fg">
          {[
            ['Agent', effective.label],
            ['Backend', effective.backend],
            ['Command', effective.acpCommand],
            ['Model', effective.model],
            ['Endpoint', effective.baseUrl],
            ['Key variable', effective.keyVar],
          ]
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
        </dl>
      </div>
    )

  const size = touch ? 'touch' : 'sm'
  const sourceNote = (key) => (effective.sources?.[key] === 'config' ? 'from shapewall.config.json' : null)
  const placeholder = (key, fallback) => (config[key] ? `${config[key]} (${sourceNote(key) || 'from the config'})` : fallback)

  return (
    <div className="space-y-5" data-sw-settings="agent">
      {agents === 'inline' ? (
        <section className="space-y-3 rounded-md border border-line p-3" aria-labelledby="sw-agents-inline">
          <div>
            <h3 id="sw-agents-inline" className="text-sm font-semibold text-fg">
              Agents
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              Connect several agents, then choose one per chat. Each runs its own session with its own login on this computer.
              {buzz ? ' Buzz conversations are separate.' : ''}
            </p>
          </div>
          <AgentsCard
            view={view}
            disabled={dirty || saving || testing}
            touch={touch}
            onBusy={setProfileBusy}
            onChanged={async () => {
              await load()
              onSaved?.()
            }}
          />
          {dirty ? <p className="text-xs text-muted">Save or discard your changes below before changing agents.</p> : null}
        </section>
      ) : agents === 'link' ? (
        <AgentsLink view={view} touch={touch} />
      ) : null}
      {view.project?.root ? (
        <section className="space-y-1.5 rounded-md border border-line p-3 text-xs" data-sw-agent-project>
          <h3 className="font-semibold text-fg">Source folder on the Shapewall computer</h3>
          <code className="block font-mono break-all text-fg" data-sw-agent-project-root>
            {view.project.root}
          </code>
          <p className="text-muted">
            Native agents work in this folder for every board in this project. Capturing a website does not give access to its source. To
            work on another repository, serve a separate project from that checkout on the computer with your agent login.
          </p>
        </section>
      ) : null}
      <section
        className="flex items-start gap-3 rounded-md border border-line bg-surface-2/60 p-3 text-xs"
        data-sw-settings-status={effective.configured ? 'connected' : 'not-connected'}
      >
        <Bot size={16} className="mt-px shrink-0 text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-medium text-fg">
            {effective.configured ? (
              <>
                Chat uses {effective.label || 'the agent'}
                {effective.backend === 'acp' ? ' over ACP, on this machine' : effective.host ? ` at ${effective.host}` : ''}
              </>
            ) : (
              'Chat is not connected yet'
            )}
          </p>
          {effective.problem ? <p className="text-bad">{effective.problem}</p> : null}
        </div>
        {/* An ACP command being set says nothing about its login: not "Connected". */}
        <Badge tone={effective.configured ? 'ok' : 'warn'}>
          {effective.configured ? (effective.backend === 'acp' ? 'Command set' : 'Connected') : 'Not connected'}
        </Badge>
      </section>

      {overridden ? (
        <div className="space-y-1.5" data-sw-settings-acp-override={view.env.acp}>
          <Override>
            The agent command comes from{' '}
            {view.env.acp === 'flag' ? 'the --agent-acp option on the command line' : 'SHAPEWALL_AGENT_ACP in the environment'} and wins
            over these settings until Shapewall is started without it.
          </Override>
          <label htmlFor="sw-agent-acp-in-use" className="block text-xs font-medium text-fg">
            Command in use
          </label>
          <Input
            id="sw-agent-acp-in-use"
            size={size}
            value={effective.acpCommand || ''}
            readOnly
            className="font-mono"
            data-sw-settings-acp-in-use="true"
          />
        </div>
      ) : null}
      {view.fileProblem ? <p className="text-xs text-bad">{view.fileProblem}</p> : null}

      <Field label="Connect to">
        <ToggleGroup
          label="Connect to"
          options={BACKENDS}
          value={form.backend}
          onChange={(value) => {
            set('backend')(value)
            setResult(null)
          }}
          large={touch}
          disabled={locked}
          className="max-w-sm"
        />
      </Field>

      {acp ? (
        <div className="space-y-4" data-sw-settings-backend="acp">
          <section
            className="space-y-1.5 rounded-md border border-warn/60 bg-warn/10 p-3 text-xs text-fg"
            role="note"
            data-sw-settings-acp-warning="true"
          >
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle size={14} className="shrink-0 text-warn" aria-hidden="true" /> An ACP agent brings its own tools
            </p>
            <p>
              It runs with its own tools and extensions (a shell, browser control, MCP servers from its own config), and Shapewall does not
              sandbox them: Shapewall only asks you before its own file writes and commands. Use a restricted profile:
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>
                Claude Code: permission mode <code className="font-mono">default</code> or <code className="font-mono">plan</code> in your
                Claude settings, never <code className="font-mono">bypassPermissions</code>.
              </li>
              <li>
                Codex: <code className="font-mono">sandbox_mode = "workspace-write"</code> or <code className="font-mono">"read-only"</code>
                , never <code className="font-mono">danger-full-access</code>.
              </li>
              <li>
                goose: <code className="font-mono">goose acp --with-builtin developer</code> with a profile of its own that has no other
                extensions (<code className="font-mono">GOOSE_PATH_ROOT</code>).
              </li>
            </ul>
          </section>
          <Field
            label={overridden ? 'Saved agent command (used when Shapewall starts without the override)' : 'Agent command'}
            htmlFor="sw-agent-acp"
            hint="One program and its arguments, no shell. It runs on this machine, as you, with its own login; Shapewall asks you before it writes files or runs commands."
          >
            <Input
              id="sw-agent-acp"
              size={size}
              value={form.acpCommand}
              onChange={set('acpCommand')}
              placeholder="claude-agent-acp"
              disabled={locked}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className="font-mono"
              data-sw-settings-field="acpCommand"
            />
          </Field>
          <div className="flex flex-wrap gap-1.5" aria-label="Common agents">
            {PRESETS.map((preset) => (
              <Button
                key={preset.command}
                size={touch ? 'touch' : 'xs'}
                variant={form.acpCommand.trim() === preset.command ? 'default' : 'secondary'}
                disabled={locked}
                onClick={() => set('acpCommand')(preset.command)}
                data-sw-settings-preset={preset.command}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted">
            Install the adapter first (for Claude Code:{' '}
            <code className="font-mono">npm install -g @agentclientprotocol/claude-agent-acp</code>). See{' '}
            <a
              className="text-accent underline-offset-2 hover:underline"
              href="https://shapewall.com/docs/chat"
              target="_blank"
              rel="noreferrer"
            >
              the chat docs
            </a>{' '}
            for Codex, goose and Gemini CLI.
          </p>
        </div>
      ) : (
        <div className="space-y-4" data-sw-settings-backend="openai-compatible">
          <Field
            label="Base URL"
            htmlFor="sw-agent-url"
            problem={urlProblem}
            hint="The chat completions endpoint without /chat/completions, such as https://api.deepseek.com or https://api.openai.com/v1."
          >
            <Input
              id="sw-agent-url"
              size={size}
              value={form.baseUrl}
              onChange={set('baseUrl')}
              placeholder={placeholder('baseUrl', 'https://api.deepseek.com')}
              inputMode="url"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              disabled={view.env.baseUrl || locked}
              aria-invalid={urlProblem ? true : undefined}
              aria-describedby={urlProblem ? 'sw-agent-url-problem' : undefined}
              data-sw-settings-field="baseUrl"
            />
            {view.env.baseUrl ? <Override>SHAPEWALL_AGENT_BASE_URL is set in the environment and wins over this field.</Override> : null}
          </Field>
          <Field label="Model" htmlFor="sw-agent-model">
            <Input
              id="sw-agent-model"
              size={size}
              value={form.model}
              onChange={set('model')}
              placeholder={placeholder('model', 'deepseek-chat')}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              disabled={view.env.model || locked}
              data-sw-settings-field="model"
            />
            {view.env.model ? <Override>SHAPEWALL_AGENT_MODEL is set in the environment and wins over this field.</Override> : null}
          </Field>
          <Field
            label="API key variable"
            htmlFor="sw-agent-keyvar"
            problem={keyVarError}
            hint="The name of the environment variable that holds the key. Not the key itself."
          >
            <div className="flex items-center gap-2">
              <Input
                id="sw-agent-keyvar"
                size={size}
                value={form.apiKeyEnv}
                onChange={(event) => set('apiKeyEnv')(event.target.value.toUpperCase())}
                placeholder={config.apiKeyEnv || view.defaultKeyVar}
                spellCheck={false}
                autoCapitalize="characters"
                autoComplete="off"
                disabled={locked}
                className="font-mono"
                aria-invalid={keyVarError ? true : undefined}
                aria-describedby={keyVarError ? 'sw-agent-keyvar-problem' : undefined}
                data-sw-settings-field="apiKeyEnv"
              />
              {keyless ? null : (
                <Badge tone={keySet ? 'ok' : 'warn'} data-sw-settings-key={keySet ? 'set' : 'missing'}>
                  {keySet ? 'Set' : 'Not set'}
                </Badge>
              )}
            </div>
          </Field>

          <div className="space-y-1" data-sw-settings-host={host || 'none'}>
            <p className="flex items-center gap-1.5 text-xs font-medium text-fg">
              <Plug size={13} aria-hidden="true" /> Where the key goes
            </p>
            <p className="text-xs text-muted">
              {host ? (
                keySet ? (
                  <>
                    Each chat request sends the key in <code className="font-mono">{keyVar}</code> to{' '}
                    <span className="font-medium text-fg" data-sw-settings-key-host="true">
                      {host}
                    </span>
                    , and nowhere else.
                  </>
                ) : keyless ? (
                  <>
                    Requests go to <span className="font-medium text-fg">{host}</span>, without a key.
                  </>
                ) : (
                  <>
                    Requests go to <span className="font-medium text-fg">{host}</span>, without a key until{' '}
                    <code className="font-mono">{keyVar}</code> is set.
                  </>
                )
              ) : (
                'Set a base URL to see where requests go.'
              )}
            </p>
          </div>

          {keyless ? (
            <p className="text-xs text-muted" data-sw-settings-key-notice="none">
              No API key needed for a local server like Ollama. If yours wants one, name its variable above.
            </p>
          ) : (
            <div className="space-y-2 rounded-md border border-line p-3" data-sw-settings-key-notice="true">
              <p className="flex items-center gap-1.5 text-xs font-medium text-fg">
                <KeyRound size={13} aria-hidden="true" /> Keys stay in the environment
              </p>
              <p className="text-xs text-muted">
                Shapewall never asks for your API key, saves it or shows it. Set it in the terminal that runs{' '}
                <code className="font-mono">shapewall serve</code>, then restart it:
              </p>
              <CopyLine text={`export ${keyVar}="paste-your-key-here"`} label="shell" touch={touch} />
              <CopyLine text={`$env:${keyVar} = "paste-your-key-here"`} label="PowerShell" touch={touch} />
            </div>
          )}

          {form.keyHosts.length ? (
            <div className="space-y-1.5" data-sw-settings-key-hosts="true">
              <p className="text-xs font-medium text-fg">Hosts you allowed the key to go to</p>
              <div className="flex flex-wrap gap-1.5">
                {form.keyHosts.map((item) => (
                  <span
                    key={`${item.apiKeyEnv}@${item.host}`}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-0.5 pr-0.5 pl-2 text-xs"
                    data-sw-settings-key-host-item={item.host}
                  >
                    {item.host} <span className="font-mono text-faint">{item.apiKeyEnv}</span>
                    <Button
                      variant="ghost"
                      size={touch ? 'icon' : 'icon-xs'}
                      disabled={locked}
                      onClick={() => setForm((current) => ({ ...current, keyHosts: current.keyHosts.filter((value) => value !== item) }))}
                      aria-label={`Stop sending ${item.apiKeyEnv} to ${item.host}`}
                    >
                      <X size={12} aria-hidden="true" />
                    </Button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      <div className="space-y-1" data-sw-settings-vision={form.vision === null ? 'auto' : String(form.vision)}>
        <Toggle
          size={size}
          pressed={form.vision ?? (acp ? effective.vision !== false : true)}
          disabled={locked}
          onPressedChange={(pressed) => {
            setForm((current) => ({ ...current, vision: pressed }))
            setSavedNote(false)
          }}
          data-sw-settings-field="vision"
        >
          {(form.vision ?? (acp ? effective.vision !== false : true)) ? <Check size={13} aria-hidden="true" /> : null}
          This model takes images
        </Toggle>
        <p className="text-xs text-muted">
          {form.vision === false
            ? 'Images are not sent; the chat says so when one is attached.'
            : acp && form.vision === null
              ? 'The agent says itself whether it takes images. Test connection checks it.'
              : 'Turn off for a text-only model (many local models): images are then left out instead of failing.'}
        </p>
      </div>

      <Field label="Name in the chat panel (optional)" htmlFor="sw-agent-label">
        <Input
          id="sw-agent-label"
          size={size}
          value={form.label}
          onChange={set('label')}
          placeholder={config.label || (acp ? 'the agent’s name' : 'the model name')}
          maxLength={60}
          disabled={locked}
          data-sw-settings-field="label"
        />
      </Field>

      <p className="text-xs text-faint" data-sw-settings-file="true">
        Saved for this project in <code className="font-mono break-all">{view.file || 'your config folder'}</code>, outside the repo, never
        in shapewall.config.json. The environment and <code className="font-mono">--agent-acp</code> win over these settings; they win over
        the config.
      </p>

      {error ? (
        <p className="text-xs text-bad" role="alert" data-sw-settings-error="save">
          {error}
        </p>
      ) : null}
      <TestResult result={result} />

      <div className={cn('flex flex-wrap items-center gap-2', touch && 'flex-col-reverse items-stretch')}>
        <Button size={size} onClick={test} disabled={testing || saving || dirty} data-sw-settings-test="true">
          {testing ? <Spinner /> : <Plug size={14} aria-hidden="true" />} {testing ? 'Testing...' : 'Test connection'}
        </Button>
        {dirty ? <span className="text-xs text-muted">Save to test these settings.</span> : null}
        {savedNote && !dirty ? (
          <span className="text-xs text-muted" role="status" data-sw-settings-saved="true">
            Saved. Chat uses it now.
          </span>
        ) : null}
        {dirty ? (
          <Button
            size={size}
            variant="ghost"
            className={cn(!touch && 'ml-auto')}
            onClick={discard}
            disabled={saving}
            data-sw-settings-discard="true"
          >
            Discard changes
          </Button>
        ) : null}
        <Button
          size={size}
          variant="default"
          className={cn(!touch && !dirty && 'ml-auto')}
          onClick={() => save(null)}
          disabled={saving || !dirty || Boolean(keyVarError) || Boolean(urlProblem)}
          data-sw-settings-save="true"
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>

      <ConfirmDialog
        items={confirm?.items || null}
        keyVar={keyVar}
        busy={saving}
        touch={touch}
        onCancel={() => setConfirm(null)}
        onConfirm={() => save(confirm?.hash || null)}
      />
    </div>
  )
}

// The board's general Settings: the agents are managed in Workspace
// settings (console/LocalConsole.jsx, the Agents card), so only a summary
// and the way there.
export const AGENTS_HREF = '/console?section=settings#agents'
function AgentsLink({ view, touch }) {
  const connected = view.profiles || []
  const current = connected.find((item) => item.default)
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3" data-sw-agents-link>
      <Bot size={16} className="shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-xs">
        <p className="text-sm font-semibold text-fg">Agents</p>
        <p className="text-muted">
          {connected.length
            ? `${connected.map((item) => item.label).join(', ')} connected${current ? `. New chats and fixes use ${current.label}` : ''}.`
            : 'No agent connected yet.'}{' '}
          Connect, remove and choose the default in Workspace settings.
        </p>
      </div>
      <Button asChild size={touch ? 'touch' : 'sm'}>
        <a href={AGENTS_HREF} data-sw-agents-open>
          Manage agents
        </a>
      </Button>
    </section>
  )
}

// Settings, with Agent as its (first) tab.
export function SettingsDialog({ open, onClose, onSaved, touch, buzz = false }) {
  // Unsaved edits: only the dialog's own close button closes it, not a stray click outside or Escape.
  const [dirty, setDirty] = useState(false)
  return (
    <Dialog open={open} onClose={onClose} title="Settings" size="md" sticky={dirty}>
      <Tabs defaultValue="agent" className="p-5">
        <TabsList className="mb-4 max-w-40" aria-label="Settings">
          <TabsTrigger value="agent" large={touch} data-sw-settings-tab="agent">
            Agent
          </TabsTrigger>
        </TabsList>
        <TabsContent value="agent">
          {open ? <AgentSettings onSaved={onSaved} touch={touch} buzz={buzz} onDirtyChange={setDirty} /> : null}
        </TabsContent>
      </Tabs>
    </Dialog>
  )
}
