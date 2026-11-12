// /device: approving a `shapewall login` from a terminal. You type the code
// the terminal shows, pick the project the new token is for and what it may
// do; the terminal picks up the token itself (it is never shown here).
//
// The same page approves `shapewall agent connect`: the terminal then says
// which coding agent it will run, and the approver names the agent, picks
// its icon, its project and who may use it. What its token may do is fixed.

import { useState } from 'react'
import { CheckCircle2, Terminal, XCircle } from 'lucide-react'
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner } from '../../components/ui'
import { Card, CheckToggle, Field, FormError, Notice, PageHeader } from '../components'
import { DEMO } from '../../lib/demo'
import { agentAsks, agentAsksDone } from '../lib/agent-asks'
import { api, serverOrigin } from '../lib/api'
import { SCOPES, formatDateTime } from '../lib/format'
import { Link } from '../lib/router'
import { IconPicker, NameField, nameProblem } from '../../settings/AgentIdentity'
import { logoForAgent } from '../../../../src/agent/agent-logos.js'
import { useAction } from '../state'

const EXPIRY = [
  ['30', '30 days', 30],
  ['90', '90 days', 90],
  ['never', 'No expiry', null],
]
const CODE_RE = /^[A-Z]{4}-?[A-Z]{4}$/
// What `shapewall agent connect` says it runs, in words.
const AGENT_KIND = { claude: 'Claude Code', codex: 'Codex', goose: 'goose', gemini: 'Gemini CLI', custom: 'A coding agent' }
// Who may use a new agent. The first is the default: least privilege.
const AGENT_AUDIENCE = [
  ['owner', 'Only me', 'You can share it later, on the Agents page.'],
  ['trusted', "Everyone this project's agent policy trusts", 'The team case: whoever may send work to an agent here may use this one.'],
]

// How long ago the terminal started the login ("just now", "3 minutes ago").
function ageLabel(seconds) {
  const value = Number(seconds) || 0
  if (value < 45) return 'just now'
  const minutes = Math.max(1, Math.round(value / 60))
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
}

export function DevicePage() {
  const [code, setCode] = useState('')
  const [found, setFound] = useState(null) // { login, workspaces, scopes }
  const [workspaceId, setWorkspaceId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [scopes, setScopes] = useState(['read', 'reply', 'status', 'resolve', 'push'])
  const [expiry, setExpiry] = useState('90')
  const [done, setDone] = useState(null) // { approved, workspace, project }
  // An agent connection: how it will look and who may use it.
  const [look, setLook] = useState({ name: '', icon: null, tint: null, png: null })
  const [audience, setAudience] = useState('owner')
  // Approve was held back because the sign-in is not fresh, and the passkey
  // check that follows was closed: said on the page, so the button never
  // looks as if it did nothing.
  const [needsPasskey, setNeedsPasskey] = useState(false)
  const lookup = useAction()
  const decide = useAction()

  const find = (event) => {
    event.preventDefault()
    lookup.run(async () => {
      const data = await api.post('/api/device/lookup', { code })
      const first = data.workspaces.find((item) => item.projects.length) || data.workspaces[0]
      setFound(data)
      setLook({ name: data.login.agent?.name || '', icon: null, tint: null, png: null })
      setAudience('owner')
      setScopes((list) => list.filter((id) => id !== 'import'))
      setWorkspaceId(first?.id || '')
      setProjectId(first?.projects[0]?.id || '')
    })
  }
  const workspace = found?.workspaces.find((item) => item.id === workspaceId)
  const agentLogin = found?.login.purpose === 'agent'
  const agentKind = AGENT_KIND[found?.login.agent?.kind] || AGENT_KIND.custom
  const lookProblem = agentLogin ? nameProblem(look.name) : null
  // What the machine said it takes from the board (its --approvals, --auto, --base).
  const asked = agentAsks(found?.login.agent?.asks)
  const pickWorkspace = (id) => {
    setWorkspaceId(id)
    setProjectId(found.workspaces.find((item) => item.id === id)?.projects[0]?.id || '')
  }
  const toggle = (scope) => setScopes((list) => (list.includes(scope) ? list.filter((item) => item !== scope) : [...list, scope]))
  const approve = () =>
    decide.run(async () => {
      const days = EXPIRY.find(([id]) => id === expiry)[2]
      try {
        const result = await api.post('/api/device/approve', {
          code,
          workspaceId,
          ...(projectId === '__create' ? { newProjectName } : { projectId }),
          // An agent's scopes are fixed by the server; its look and audience are chosen here.
          ...(agentLogin ? { agent: { name: look.name.trim() || agentKind, icon: look.icon, tint: look.tint, audience } } : { scopes }),
          ...(days ? { expiresInDays: days } : {}),
        })
        setNeedsPasskey(false)
        setDone({ approved: true, ...result })
      } catch (failure) {
        // The passkey dialog opens next (useAction); if it is closed, this
        // note stays. Any other refusal shows its message below.
        setNeedsPasskey(failure?.code === 'reauth_required')
        throw failure
      }
    })
  const deny = () =>
    decide.run(async () => {
      await api.post('/api/device/deny', { code })
      setDone({ approved: false })
    })
  const restart = () => {
    setFound(null)
    setDone(null)
    setNeedsPasskey(false)
    setCode('')
  }

  return (
    <>
      <PageHeader
        title={agentLogin ? 'Connect an agent' : 'Sign in a terminal'}
        description={
          agentLogin
            ? 'Approve a coding agent that a machine with your code wants to connect.'
            : 'Approve a shapewall login, or an agent connection, running on your computer.'
        }
      />
      <Card className="max-w-xl p-5 sm:p-6" data-sw-device>
        {DEMO ? (
          <Notice tone="info" title="Not in the demo" data-sw-device-demo>
            Signing in a terminal needs a real Shapewall server: there, the terminal shows a code, you type it here and pick what its token
            may do.
          </Notice>
        ) : done ? (
          <div className="space-y-4" data-sw-device-done={done.approved ? 'approved' : 'denied'}>
            <span
              className={
                done.approved
                  ? 'inline-flex h-11 w-11 items-center justify-center rounded-xl bg-ok/10 text-ok'
                  : 'inline-flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-muted'
              }
            >
              {done.approved ? <CheckCircle2 size={20} aria-hidden="true" /> : <XCircle size={20} aria-hidden="true" />}
            </span>
            {done.approved ? (
              <>
                <h2 className="text-lg font-semibold text-fg">
                  {done.agent ? `${done.info?.name || 'The agent'} is connected` : 'Approved'}
                </h2>
                {done.agent ? (
                  <p className="text-sm text-muted" data-sw-device-agent-done>
                    It serves {done.project.name} in {done.workspace.name}, and shows as online on the board once the terminal says it is
                    connected. {agentAsksDone(found?.login.agent?.asks)} Rename it, change who may use it, or revoke it on the project's
                    Agents page.
                  </p>
                ) : (
                  <p className="text-sm text-muted">
                    The terminal now has a token for {done.project.name} in {done.workspace.name}. Go back to it: it says when it is ready.
                    You can revoke the token any time on the project's API tokens page.
                  </p>
                )}
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-fg">Login denied</h2>
                <p className="text-sm text-muted">
                  The terminal gets no token. Run {agentLogin ? 'shapewall agent connect' : 'shapewall login'} again if that was a mistake.
                </p>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              {done.approved ? (
                <Button asChild size="touch" variant="secondary" className="lg:h-10">
                  {done.agent ? (
                    <Link to={`/w/${done.workspace.id}/agents/${done.project.id}`}>Agents of {done.project.name}</Link>
                  ) : (
                    <Link to={`/w/${done.workspace.id}/projects/${done.project.id}`}>Open {done.project.name}</Link>
                  )}
                </Button>
              ) : null}
              <Button size="touch" variant="ghost" onClick={restart} className="lg:h-10">
                Approve another
              </Button>
            </div>
          </div>
        ) : !found ? (
          <form onSubmit={find} className="space-y-4">
            <div className="space-y-3 text-sm text-muted" data-sw-device-howto>
              <p className="flex items-start gap-2">
                <Terminal size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>Run one of these in a terminal, then type the code it shows.</span>
              </p>
              {[
                ['To connect a coding agent', `shapewall agent connect --remote ${serverOrigin()}`],
                ['For a token (push, comments, watch)', `shapewall login --remote ${serverOrigin()}`],
              ].map(([label, command]) => (
                <div key={command} className="min-w-0">
                  <p className="mb-1 text-[13px] font-medium text-fg">{label}</p>
                  <pre
                    className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg sm:whitespace-pre border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] leading-5 text-fg"
                    tabIndex={0}
                    data-sw-device-command
                  >
                    <code>{command}</code>
                  </pre>
                </div>
              ))}
            </div>
            <Field label="Code from the terminal">
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  value={code}
                  onChange={(event) =>
                    setCode(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z-]/g, '')
                        .slice(0, 9),
                    )
                  }
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="ABCD-EFGH"
                  className="font-mono tracking-widest sm:w-56"
                  data-sw-device-code
                />
              )}
            </Field>
            <FormError error={lookup.error} />
            <Button type="submit" size="touch" variant="default" disabled={lookup.busy || !CODE_RE.test(code)} data-sw-device-lookup>
              {lookup.busy ? <Spinner /> : null} Continue
            </Button>
          </form>
        ) : (
          <div className="space-y-5">
            <Notice tone="warn" title={`Code ${found.login.code}`}>
              Approve only if you started this {agentLogin ? 'connection' : 'login'} yourself, just now, and the terminal shows the same
              code. It expires {formatDateTime(found.login.expiresAt)}.
            </Notice>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm" data-sw-device-details>
              <dt className="text-muted">Computer name</dt>
              <dd className="min-w-0 break-words text-fg">
                {found.login.name} <span className="text-muted">(reported by the terminal, not checked)</span>
              </dd>
              {agentLogin ? (
                <>
                  <dt className="text-muted">Runs</dt>
                  <dd className="min-w-0 break-words text-fg" data-sw-device-agent-kind={found.login.agent?.kind || 'custom'}>
                    {agentKind} <span className="text-muted">(reported by the terminal, not checked)</span>
                  </dd>
                </>
              ) : null}
              <dt className="text-muted">Requested from</dt>
              <dd className="min-w-0 break-all font-mono text-fg" data-sw-device-ip>
                {found.login.ip || 'unknown address'}
              </dd>
              <dt className="text-muted">Started</dt>
              <dd className="text-fg">{ageLabel(found.login.ageSeconds)}</dd>
            </dl>
            {found.login.ip && !found.login.sameIp ? (
              <Notice tone="bad" title="This login came from a different address than yours" data-sw-device-ip-warning>
                The terminal asked from {found.login.ip}; you are on {found.login.approverIp || 'an unknown address'}. That is normal for a
                server, a VPN or another network, but if you did not start this login on such a machine, someone may be trying to get a
                token through you: deny it.
              </Notice>
            ) : null}
            {!found.workspaces.length ? (
              <Notice tone="bad" title="No project you can make tokens for">
                Making a token needs the admin role in a workspace. Ask an admin of yours.
              </Notice>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Workspace">
                    {(props) => (
                      <Select value={workspaceId} onValueChange={pickWorkspace}>
                        <SelectTrigger size="touch" className="w-full" {...props} data-sw-device-workspace>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {found.workspaces.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                  <Field label="Project">
                    {(props) =>
                      workspace?.projects.length || found.login.purpose === 'import' ? (
                        <Select value={projectId} onValueChange={setProjectId}>
                          <SelectTrigger size="touch" className="w-full" {...props} data-sw-device-project>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {found.login.purpose === 'import' ? <SelectItem value="__create">Create a project</SelectItem> : null}
                            {workspace.projects.map((item) => (
                              <SelectItem key={item.id} value={item.id}>
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="py-2 text-sm text-muted">No projects here yet: make one first.</p>
                      )
                    }
                  </Field>
                </div>
                {projectId === '__create' ? (
                  <Field label="New project name">
                    {(props) => (
                      <Input
                        {...props}
                        size="touch"
                        value={newProjectName}
                        maxLength={80}
                        onChange={(event) => setNewProjectName(event.target.value)}
                        data-sw-device-new-project
                      />
                    )}
                  </Field>
                ) : null}
                {found.login.purpose === 'import' ? (
                  <Notice tone="warn" title="Moving a local project">
                    This login moves a project from a computer to this server. Its comment history comes along as plain text, and the
                    permission to import turns itself off when the move is done.
                  </Notice>
                ) : null}
                {agentLogin ? (
                  <div className="space-y-4" data-sw-device-agent>
                    <NameField
                      id="device-agent-name"
                      value={look}
                      onChange={setLook}
                      builtIn={agentKind}
                      touch
                      problem={lookProblem}
                      hint="What people call it on the board and in its replies. You can rename it later."
                    />
                    <IconPicker
                      value={look}
                      onChange={setLook}
                      label={look.name || agentKind}
                      logo={logoForAgent(found.login.agent?.kind)}
                      upload={false}
                    />
                    <fieldset>
                      <legend className="mb-1.5 block text-[13px] font-medium text-fg">Who may use it</legend>
                      <div className="grid gap-2">
                        {AGENT_AUDIENCE.map(([id, label, hint]) => (
                          <label
                            key={id}
                            className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/5"
                          >
                            <input
                              type="radio"
                              name="device-agent-audience"
                              className="mt-1 accent-[var(--accent)]"
                              checked={audience === id}
                              onChange={() => setAudience(id)}
                              data-sw-device-agent-audience={id}
                            />
                            <span>
                              <span className="block font-medium text-fg">{label}</span>
                              <span className="block text-xs text-muted">{hint}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <Notice
                      tone={asked.mode === 'edits' ? 'warn' : 'info'}
                      title={asked.mode === 'edits' ? 'This machine asked to edit files' : 'What this agent does'}
                      data-sw-device-agent-asks={asked.mode}
                      data-sw-device-agent-auto={found.login.agent?.asks?.auto ? 'true' : undefined}
                    >
                      <p className="text-xs">
                        {asked.mode === 'unknown'
                          ? 'Not reported by the terminal'
                          : 'Reported by the terminal, and enforced on that machine'}
                      </p>
                      <ul className="mt-1.5 list-disc space-y-1 pl-4">
                        {asked.lines.map((line) => (
                          <li key={line} className="break-words">
                            {line}
                          </li>
                        ))}
                      </ul>
                    </Notice>
                  </div>
                ) : null}
                <fieldset className={agentLogin ? 'hidden' : undefined}>
                  <legend className="mb-1.5 block text-[13px] font-medium text-fg">What the token can do</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {SCOPES.filter(([id]) => id !== 'import').map(([id, label, hint]) => (
                      <CheckToggle key={id} checked={scopes.includes(id)} onChange={() => toggle(id)} id={`device-scope-${id}`}>
                        <span>
                          <span className="block font-medium">{label}</span>
                          <span className="block text-xs text-muted">{hint}</span>
                        </span>
                      </CheckToggle>
                    ))}
                  </div>
                  {found.login.purpose === 'import' ? (
                    <div className="mt-2">
                      <CheckToggle checked={scopes.includes('import')} onChange={() => toggle('import')} id="device-scope-import">
                        <span>
                          <span className="block font-medium">Import local comments once</span>
                          <span className="block text-xs text-muted">
                            Off unless you turn it on. It is removed when the move is done, and imported comments never start an agent.
                          </span>
                        </span>
                      </CheckToggle>
                    </div>
                  ) : null}
                </fieldset>
                <Field label="Expires">
                  {(props) => (
                    <Select value={expiry} onValueChange={setExpiry}>
                      <SelectTrigger size="touch" className="w-full sm:w-56" {...props} data-sw-device-expiry>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EXPIRY.map(([id, label]) => (
                          <SelectItem key={id} value={id}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </>
            )}
            {needsPasskey && !decide.busy && !decide.error ? (
              <Notice tone="warn" title="Not approved yet: confirm with your passkey" data-sw-device-reauth-note>
                Approving a login needs a fresh passkey check (once every 10 minutes). Press Approve again and use your passkey when asked.
              </Notice>
            ) : null}
            <FormError error={decide.error} />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button size="touch" variant="ghost" onClick={deny} disabled={decide.busy} className="lg:h-10" data-sw-device-deny>
                Deny
              </Button>
              <Button
                size="touch"
                variant="default"
                onClick={approve}
                disabled={
                  decide.busy ||
                  !projectId ||
                  (agentLogin ? Boolean(lookProblem) : !scopes.length) ||
                  (projectId === '__create' && !newProjectName.trim())
                }
                className="lg:h-10"
                data-sw-device-approve
              >
                {decide.busy ? <Spinner /> : null} {agentLogin ? 'Connect the agent' : 'Approve'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  )
}
