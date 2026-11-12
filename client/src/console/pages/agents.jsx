// Agents on a team server.
//
// - /w/:ws/agents (AgentsOverview): every agent of the workspace in one
//   table: the project it serves, its state, when it was last seen, who may
//   send it work and who connected it, each with a link to manage it.
// - /w/:ws/agents/:pid (ProjectAgentsPage): one project's agents. Rename,
//   icon and tint (the editor the local Agents page uses), the default
//   agent, the audience, the approval rule, revoke, and how to connect one.
//
// An agent is a project API token that may take work (the claim scope),
// with a face and rules (src/hosted/agents.js). The server checks every
// change; these pages only hide what it would refuse. Admins and owners.

import { useEffect, useId, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Bot, Check, Laptop, Pencil, Plug, Plus, ShieldCheck, Star, Users } from 'lucide-react'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '../../components/ui'
import { cn } from '../../lib/utils'
import { AgentFace } from '../../chat/agentIcons'
import { IconPicker, NameField, nameProblem } from '../../settings/AgentIdentity'
import {
  Card,
  CardHeader,
  CheckToggle,
  ConfirmDialog,
  CopyField,
  Field,
  FormError,
  LoadError,
  Loading,
  Notice,
  PageHeader,
  Time,
} from '../components'
import { api, serverOrigin, wsUrl } from '../lib/api'
import { ROLE_LABEL, formatDateTime } from '../lib/format'
import { Link } from '../lib/router'
import { canChangeApprovalRoles, canChangeApprovalRule } from '../../../../src/hosted/permissions.js'
import { useAction, useLoad, useToast } from '../state'
import { CreateToken } from './tokens'
import { useWorkspace } from './workspace'

const DOCS_URL = 'https://shapewall.com/docs/hosted#agents-on-a-hosted-board'
const STATE_LABEL = { online: 'Online', busy: 'Working', offline: 'Offline', revoked: 'Revoked' }
const STATE_TONE = { online: 'ok', busy: 'accent', offline: 'neutral', revoked: 'neutral' }
const KIND_LABEL = {
  watcher: 'Watcher (shapewall watch)',
  claude: 'Claude Code',
  codex: 'Codex',
  goose: 'goose',
  gemini: 'Gemini CLI',
  custom: 'Another program',
}
const AUDIENCE_CHOICES = [
  ['owner', 'Only the person who connected it', 'The default for a new agent.'],
  ['members', 'Named members', 'The person who connected it, and the people you choose.'],
  ['trusted', "Everyone this project's agent policy trusts", 'The team case: whoever may send work to an agent here may use this one.'],
]
// The scopes an agent needs to take comments and answer them.
const AGENT_SCOPES = ['read', 'reply', 'status', 'claim']

// ---- Edits from the board: the mode, in words ---------------------------------
//
// `agent.approval` (src/hosted/agents.js consoleView): `mode` is what is in
// effect ('none': reads and answers, 'ask': each edit allowed by a person,
// 'auto': allowed without asking); `machine` is what the agent's own machine
// allows, the ceiling for everything set here; `rules` says, per kind,
// whether a request is asked or allowed.

const modeOf = (agent) => agent?.approval?.mode || 'none'
const LINK_MODE = {
  none: 'reads and answers only (no edits, no commands)',
  ask: 'makes fixes on a branch, each edit allowed by a person',
  auto: 'makes fixes on a branch, allowed without asking',
}
export const MODE_TITLE = {
  none: 'Reads and answers',
  ask: 'Edits on a branch, asking every time',
  auto: 'Edits on a branch, allowed without asking',
}
// What "without asking" covers: "edits", "the listed commands", or both.
const kindsWords = (kinds) => {
  const words = [kinds.includes('edits') ? 'edits' : null, kinds.includes('commands') ? 'the listed commands' : null].filter(Boolean)
  return words.join(' and ')
}
const autoKinds = (agent) => ['edits', 'commands'].filter((kind) => agent?.approval?.rules?.[kind] === 'auto')
// Who answers its requests on the board.
const answerers = (agent) =>
  agent?.approval?.machine?.approvals === 'owner'
    ? `Only ${agent.createdBy ? personName(agent.createdBy) : 'the person who connected it'} answers`
    : `${ROLE_LABEL[agent?.approval?.answerRole || 'admin']}s and up answer`
// The command that lets an agent's machine allow things without asking.
export const AUTO_COMMAND = 'shapewall agent connect --approvals owner --auto edits'
// Why "Allow without asking" cannot be chosen (null: it can).
function autoBlocked(agent) {
  if (!agent || agent.approval.autoAvailable) return null
  if (!agent.link?.connected)
    return 'This agent takes comments on its own and asks before each command. Nothing here can go without asking.'
  if (agent.approval.machine.approvals === 'none')
    return `${agent.name}'s machine takes no approvals from the board, so there is nothing to allow. This is switched on on the agent's machine, never from here.`
  return `${agent.name}'s machine did not say anything may go without asking. This is switched on on the agent's machine, never from here.`
}

// What the agent's machine allows, as facts: set there, shown here.
function MachineFacts({ agent }) {
  const machine = agent.approval.machine
  const rows = [
    [
      'Approvals from the board',
      machine.approvals === 'none'
        ? 'None. It reads and answers only.'
        : machine.approvals === 'owner'
          ? `Only ${agent.createdBy ? personName(agent.createdBy) : 'the person who connected it'} may answer.`
          : 'Admins of this project may answer.',
      'approvals',
      machine.approvals,
    ],
    [
      'Commands it may ask to run',
      machine.commands.length ? null : machine.approvals === 'none' ? 'None.' : 'None. It only asks to edit files.',
      'commands',
      String(machine.commands.length),
    ],
    [
      'May go without asking',
      machine.auto.length ? `${kindsWords(machine.auto).replace(/^./, (c) => c.toUpperCase())}, when the rule below says so.` : 'Nothing.',
      'auto',
      machine.auto.join(',') || 'none',
    ],
  ]
  return (
    <section className="rounded-lg border border-line bg-surface-2/50 p-3" data-sw-agent-machine={machine.approvals}>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg">
        <Laptop size={13} aria-hidden="true" /> Set on the agent's machine
      </h3>
      <dl className="mt-2 space-y-2 text-xs">
        {rows.map(([label, text, hook, value]) => (
          <div key={hook} className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[11rem_1fr]" data-sw-agent-machine-fact={hook} data-value={value}>
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 text-fg">
              {text}
              {hook === 'commands' && machine.commands.length ? (
                <ul className="flex flex-wrap gap-1">
                  {machine.commands.map((command) => (
                    <li key={command} className="max-w-full">
                      <code className="block truncate rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px]">
                        {command}
                      </code>
                    </li>
                  ))}
                </ul>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted">
        These are read from the machine each time it connects. Change them there with{' '}
        <code className="font-mono">shapewall agent connect</code>; nothing on this page can widen them.
      </p>
    </section>
  )
}

// A connected agent (`shapewall agent connect`): what it said it can do,
// and since when its link is open.
function LinkLine({ agent }) {
  const link = agent.link
  if (!link?.connected) return null
  return (
    <p className="mt-0.5 text-xs text-muted" data-sw-agent-link={link.connectedAt ? 'open' : 'closed'}>
      <span className="text-fg">Connected agent.</span> {link.chats ? 'Chats on the board' : 'No chat'}, {LINK_MODE[modeOf(agent)]}
      {link.connectedAt ? (
        <>
          {' '}
          · connected since <time dateTime={link.connectedAt}>{formatDateTime(link.connectedAt)}</time>
        </>
      ) : (
        ' · link closed'
      )}
      {link.version ? ` · Shapewall ${link.version}` : ''}
      {link.policy?.audience === 'owner' ? ' · its machine takes questions from its connector only' : ''}
    </p>
  )
}

const personName = (person) => person?.displayName || (person?.handle ? `@${person.handle}` : 'someone who left')

export function StateBadge({ agent }) {
  return (
    <Badge tone={STATE_TONE[agent.state] || 'neutral'} className="px-2 py-0.5 text-[11px]" data-sw-agent-state={agent.state}>
      {STATE_LABEL[agent.state] || agent.state}
    </Badge>
  )
}

// "Seen 5 minutes ago", "Never connected".
function LastSeen({ agent }) {
  if (agent.state === 'online' || agent.state === 'busy') return <span>Listening now</span>
  return agent.lastSeenAt ? <Time value={agent.lastSeenAt} prefix="Last seen " /> : <span>Never connected</span>
}

function Face({ agent, size = 'lg' }) {
  return <AgentFace label={agent.name} icon={agent.icon} tint={agent.tint} logo={agent.logo} size={size} />
}

// ---- The workspace overview ----

export function AgentsOverview() {
  const { workspaceId, data } = useWorkspace()
  const load = useLoad(wsUrl(workspaceId, '/agents'))
  const agents = load.data?.agents || []
  const live = agents.filter((agent) => agent.state !== 'revoked')
  const served = new Set(live.map((agent) => agent.projectId))
  const without = data.projects.filter((project) => !served.has(project.id))
  return (
    <>
      <PageHeader title="Agents" description="Every agent in this workspace, the project each one serves and who may send it work." />
      <Card data-sw-agents-overview>
        {load.loading ? <Loading /> : null}
        {load.error ? (
          <div className="p-4">
            <LoadError error={load.error} onRetry={load.reload} />
          </div>
        ) : null}
        {load.data && !load.error ? (
          live.length ? (
            <div role="table" aria-label="Agents in this workspace">
              <div
                role="row"
                className="hidden gap-3 border-b border-line px-5 py-2 text-xs font-medium text-muted md:grid md:grid-cols-[1.5fr_1fr_1fr_1.4fr_1fr_auto]"
              >
                <span role="columnheader">Agent</span>
                <span role="columnheader">Project</span>
                <span role="columnheader">State</span>
                <span role="columnheader">Who may send it work</span>
                <span role="columnheader">Connected by</span>
                <span role="columnheader" className="w-20 text-right">
                  <span className="sr-only">Manage</span>
                </span>
              </div>
              <ul className="divide-y divide-line">
                {live.map((agent) => (
                  <li
                    key={agent.id}
                    role="row"
                    className="grid gap-2 px-4 py-3 text-sm sm:px-5 md:grid-cols-[1.5fr_1fr_1fr_1.4fr_1fr_auto] md:items-center md:gap-3"
                    data-sw-overview-agent={agent.name}
                    data-sw-overview-project={agent.projectName}
                  >
                    <div role="cell" className="flex min-w-0 items-center gap-2.5">
                      <Face agent={agent} size="md" />
                      <div className="min-w-0">
                        <p className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-fg">{agent.name}</span>
                          {agent.isDefault ? (
                            <Badge tone="neutral" className="shrink-0 px-1.5 py-0.5 text-[10.5px]">
                              Default
                            </Badge>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted" data-sw-overview-kind={agent.kind}>
                          {KIND_LABEL[agent.kind] || agent.kind}
                          {agent.machine ? ` on ${agent.machine}` : ''}
                          {agent.link?.connected ? (agent.link.chats ? ' · chats' : '') : ''}
                        </p>
                      </div>
                    </div>
                    <div role="cell" className="min-w-0 truncate text-fg">
                      <span className="mr-1 text-xs text-muted md:hidden">Project:</span>
                      {agent.projectName}
                    </div>
                    <div role="cell" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted md:block">
                      <StateBadge agent={agent} />
                      <p className="md:mt-0.5">
                        {agent.link?.connectedAt ? (
                          <span data-sw-overview-connected>
                            since <time dateTime={agent.link.connectedAt}>{formatDateTime(agent.link.connectedAt)}</time>
                          </span>
                        ) : (
                          <LastSeen agent={agent} />
                        )}
                      </p>
                    </div>
                    <div role="cell" className="min-w-0 text-xs text-muted" data-sw-overview-audience={agent.audience.kind}>
                      <span className="mr-1 md:hidden">Takes work from:</span>
                      <span className="text-fg">{agent.audience.text}</span>
                    </div>
                    <div role="cell" className="min-w-0 truncate text-xs text-muted">
                      <span className="mr-1 md:hidden">Connected by</span>
                      {personName(agent.createdBy)}
                    </div>
                    <div role="cell" className="md:w-20 md:text-right">
                      <Link
                        to={`/w/${workspaceId}/agents/${agent.projectId}`}
                        className="inline-flex h-11 items-center gap-1 text-sm font-medium text-accent underline-offset-2 hover:underline lg:h-auto"
                        aria-label={`Manage ${agent.name} in ${agent.projectName}`}
                        data-sw-overview-manage={agent.name}
                      >
                        Manage
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState icon={Bot} title="No agents yet">
              {data.projects.length
                ? 'Open a project below to connect a machine that has its code.'
                : 'Create a project first, then connect a machine that has its code.'}
            </EmptyState>
          )
        ) : null}
      </Card>
      {load.data && without.length ? (
        <Card className="mt-5" data-sw-agents-without>
          <CardHeader
            icon={Plug}
            title="Projects without an agent"
            description="Comments sent to an agent in these projects wait until one is connected."
          />
          <ul className="divide-y divide-line">
            {without.map((project) => (
              <li key={project.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{project.name}</span>
                <Link
                  to={`/w/${workspaceId}/agents/${project.id}`}
                  className="inline-flex h-11 items-center gap-1 text-sm font-medium text-accent underline-offset-2 hover:underline lg:h-auto"
                  data-sw-overview-connect={project.name}
                >
                  Connect an agent
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  )
}

// ---- One project's agents ----

export function ProjectAgentsPage({ projectId }) {
  const { workspaceId, data, role } = useWorkspace()
  const project = data.projects.find((item) => item.id === projectId)
  const url = wsUrl(workspaceId, `/projects/${projectId}/agents`)
  const load = useLoad(project ? url : null)
  const toast = useToast()
  const [editing, setEditing] = useState(null)
  const [audience, setAudience] = useState(null)
  const [approval, setApproval] = useState(null)
  const [revoking, setRevoking] = useState(null)
  const [tokenOpen, setTokenOpen] = useState(false)
  const makeDefault = useAction()
  const revoke = useAction()
  // An agent goes online or offline without anyone clicking here.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load.reload()
    }, 20000)
    return () => window.clearInterval(timer)
  }, [load.reload]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-lg font-semibold text-fg">Project not found</h1>
        <Link
          to={`/w/${workspaceId}/agents`}
          className="mt-3 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline"
        >
          Back to agents
        </Link>
      </Card>
    )
  }
  const agents = load.data?.agents || []
  const live = agents.filter((agent) => agent.state !== 'revoked')
  const revoked = agents.filter((agent) => agent.state === 'revoked')
  const setDefault = (agent) =>
    makeDefault.run(async () => {
      await api.put(wsUrl(workspaceId, `/projects/${projectId}/default-agent`), { agentId: agent ? agent.id : null })
      toast(agent ? `${agent.name} is the default agent` : 'No default agent: any agent takes new comments')
      await load.reload()
    })
  const base = (agent) => wsUrl(workspaceId, `/projects/${projectId}/agents/${agent.id}`)
  return (
    <>
      <Link
        to={`/w/${workspaceId}/agents`}
        className="mb-3 inline-flex h-11 items-center gap-1.5 rounded-md text-sm text-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent lg:h-8"
      >
        <ArrowLeft size={15} aria-hidden="true" /> All agents
      </Link>
      <PageHeader
        title={`Agents of ${project.name}`}
        description="The coding agents of this project: the ones members chat with on the board, and the ones that pick up comments. Each runs where the code is; this server never runs an agent."
        actions={
          <Button asChild size="touch" className="lg:h-9">
            <Link to={`/w/${workspaceId}/projects/${projectId}`}>Project page</Link>
          </Button>
        }
      />
      <div className="grid gap-5">
        <Card data-sw-project-agents>
          <CardHeader
            icon={Bot}
            title="Agents"
            description="The default agent is the one Send to agent names, and where a trusted member's new comment goes. Without one, any agent takes it."
          />
          {load.loading ? <Loading /> : null}
          {load.error ? (
            <div className="p-4">
              <LoadError error={load.error} onRetry={load.reload} />
            </div>
          ) : null}
          {load.data && !load.error ? (
            live.length ? (
              <ul className="divide-y divide-line">
                {live.map((agent) => (
                  <li key={agent.id} className="space-y-3 px-4 py-4 sm:px-5" data-sw-agent-row={agent.name} data-sw-agent-id={agent.id}>
                    <div className="flex flex-wrap items-start gap-3">
                      <Face agent={agent} />
                      <div className="min-w-0 flex-[1_1_14rem]">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-fg">{agent.name}</span>
                          <StateBadge agent={agent} />
                          {agent.isDefault ? (
                            <Badge tone="accent" className="px-2 py-0.5 text-[11px]" data-sw-agent-default>
                              <Star size={10} aria-hidden="true" /> Default
                            </Badge>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {KIND_LABEL[agent.kind] || agent.kind}
                          {agent.machine ? ` on ${agent.machine}` : ''} · <LastSeen agent={agent} /> · connected by{' '}
                          {personName(agent.createdBy)}
                        </p>
                        <LinkLine agent={agent} />
                        {agent.counts.working || agent.counts.queued ? (
                          <p className="mt-0.5 text-xs text-muted" data-sw-agent-counts>
                            {[
                              agent.counts.working ? `working on ${agent.counts.working}` : null,
                              agent.counts.queued ? `${agent.counts.queued} waiting for it` : null,
                            ]
                              .filter(Boolean)
                              .join(', ')}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="touch" className="lg:h-8" onClick={() => setEditing(agent)} data-sw-agent-edit={agent.name}>
                          <Pencil size={13} aria-hidden="true" /> Edit
                        </Button>
                        {agent.isDefault ? (
                          <Button
                            size="touch"
                            className="lg:h-8"
                            disabled={makeDefault.busy}
                            onClick={() => setDefault(null)}
                            data-sw-agent-undefault={agent.name}
                          >
                            Not the default
                          </Button>
                        ) : (
                          <Button
                            size="touch"
                            className="lg:h-8"
                            disabled={makeDefault.busy}
                            onClick={() => setDefault(agent)}
                            data-sw-agent-make-default={agent.name}
                          >
                            <Star size={13} aria-hidden="true" /> Make default
                          </Button>
                        )}
                        <Button
                          size="touch"
                          variant="danger"
                          className="lg:h-8"
                          onClick={() => {
                            revoke.setError(null)
                            setRevoking(agent)
                          }}
                          data-sw-agent-revoke={agent.name}
                        >
                          Revoke
                        </Button>
                      </div>
                    </div>
                    <dl className="grid gap-2 text-xs sm:grid-cols-2">
                      <div className="rounded-lg border border-line bg-surface-2/50 p-3" data-sw-agent-audience={agent.audience.kind}>
                        <dt className="flex items-center gap-1.5 font-medium text-fg">
                          <Users size={13} aria-hidden="true" /> {agent.link?.connected ? 'Who may use it' : 'Who may send it work'}
                        </dt>
                        <dd className="mt-1 text-muted">
                          <span className="text-fg">{agent.audience.text}.</span>{' '}
                          {agent.audience.inherited
                            ? 'Kept from before 0.4.0, when the agent policy alone decided, so nothing changed on upgrade. New agents start with only the person who connected them.'
                            : agent.audience.kind === 'trusted'
                              ? ''
                              : "They must also be trusted by this project's agent policy (on the project page)."}
                        </dd>
                        <dd className="mt-2">
                          <Button
                            size="touch"
                            className="lg:h-8"
                            onClick={() => setAudience(agent)}
                            data-sw-agent-audience-edit={agent.name}
                          >
                            Change
                          </Button>
                        </dd>
                      </div>
                      <div
                        className="rounded-lg border border-line bg-surface-2/50 p-3"
                        data-sw-agent-approval={agent.approval.effectiveRule}
                      >
                        <dt className="flex items-center gap-1.5 font-medium text-fg">
                          <ShieldCheck size={13} aria-hidden="true" /> Approvals
                        </dt>
                        <dd className="mt-1 text-muted" data-sw-agent-mode={agent.link?.connected ? modeOf(agent) : 'watch'}>
                          {!agent.link?.connected ? (
                            <>
                              <span className="text-fg">Ask every time.</span> It asks before each command it runs for a comment.{' '}
                              {ROLE_LABEL[agent.approval.answerRole]}s and up answer; {ROLE_LABEL[agent.approval.changeRole].toLowerCase()}s
                              and up change this rule.
                            </>
                          ) : modeOf(agent) === 'none' ? (
                            <>
                              <span className="text-fg">{MODE_TITLE.none}.</span> Nothing to approve: its machine takes no edits or commands
                              from the board. That is switched on on the machine itself.
                            </>
                          ) : modeOf(agent) === 'auto' ? (
                            <>
                              <span className="text-fg">{MODE_TITLE.auto}.</span> Applies to {kindsWords(autoKinds(agent))}. Anything else
                              waits for an answer on the board.
                            </>
                          ) : (
                            <>
                              <span className="text-fg">{MODE_TITLE.ask}.</span> {answerers(agent)}, each time with a passkey check.
                            </>
                          )}
                        </dd>
                        <dd className="mt-2">
                          <Button
                            size="touch"
                            className="lg:h-8"
                            onClick={() => setApproval(agent)}
                            data-sw-agent-approval-edit={agent.name}
                          >
                            Change
                          </Button>
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={Bot} title="No agent is connected to this project">
                Comments sent to an agent wait here until one is. Connect one below.
              </EmptyState>
            )
          ) : null}
          <div className="px-4 pb-3 sm:px-5">
            <FormError error={makeDefault.error} />
          </div>
        </Card>

        <ConnectCard project={project} onNewToken={() => setTokenOpen(true)} />

        {revoked.length ? (
          <Card data-sw-agents-revoked>
            <CardHeader icon={Bot} title="Revoked" description="These no longer work. Their replies on threads keep their names." />
            <ul className="divide-y divide-line">
              {revoked.map((agent) => (
                <li key={agent.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm text-muted sm:px-5">
                  <Face agent={agent} size="md" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <span className="text-xs">
                    <LastSeen agent={agent} />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>

      <EditAgentDialog
        agent={editing}
        kinds={load.data?.options?.kinds || Object.keys(KIND_LABEL)}
        url={editing ? base(editing) : null}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          toast('Agent saved')
          await load.reload()
        }}
      />
      <AudienceDialog
        agent={audience}
        members={load.data?.members || []}
        url={audience ? `${base(audience)}/audience` : null}
        onClose={() => setAudience(null)}
        onSaved={async () => {
          toast('Audience saved')
          await load.reload()
        }}
      />
      <ApprovalDialog
        agent={approval}
        role={role}
        url={approval ? `${base(approval)}/approval` : null}
        onClose={() => setApproval(null)}
        onSaved={async () => {
          toast('Approval settings saved')
          await load.reload()
        }}
      />
      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name}?`}
        confirmLabel="Revoke agent"
        tone="danger"
        busy={revoke.busy}
        error={revoke.error}
        onConfirm={() =>
          revoke.run(async () => {
            await api.delete(base(revoking))
            setRevoking(null)
            toast('Agent revoked')
            await load.reload()
          })
        }
      >
        <p>
          Its token stops working at once, so the machine that uses it stops picking up comments. What it was working on and what waited for
          it go to any agent. This cannot be undone: connect it again with a new token.
        </p>
      </ConfirmDialog>
      <CreateToken
        open={tokenOpen}
        onClose={() => setTokenOpen(false)}
        projects={data.projects}
        projectId={projectId}
        defaultScopes={AGENT_SCOPES}
        onCreated={load.reload}
      />
    </>
  )
}

// How to connect a machine, with this server's address filled in.
function ConnectCard({ project, onNewToken }) {
  const origin = serverOrigin()
  const step = 'flex gap-3'
  const number =
    'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-fg'
  return (
    <Card data-sw-connect-agent>
      <CardHeader
        icon={Plug}
        title="Connect an agent"
        description={`On a machine that has the code of ${project.name}. The agent runs there; this server only passes messages.`}
        actions={
          <Button size="touch" variant="secondary" className="lg:h-9" onClick={onNewToken} data-sw-connect-agent-token>
            <Plus size={16} aria-hidden="true" /> New agent token
          </Button>
        }
      />
      <div className="space-y-2 border-b border-line px-4 py-4 text-sm text-muted sm:px-5" data-sw-connect-agent-chat>
        <p className="font-medium text-fg">Chat with your coding agent on the board</p>
        <p>
          Run this in the project's folder, on the machine that has Claude Code, Codex or goose. It shows a code; approve it on{' '}
          <Link to="/device" className="font-medium text-accent underline-offset-2 hover:underline">
            the approval page
          </Link>
          , where you name the agent and choose who may use it.
        </p>
        <CopyField value={`shapewall agent connect --remote ${origin}`} testId="connect-agent" />
        <p className="text-xs">
          Members then chat with it from the board's Agents panel. It reads the project and answers; it does not change files or run
          commands. Leave it running (or run it as a service); Ctrl+C disconnects it.
        </p>
      </div>
      <p className="px-4 pt-4 text-sm font-medium text-fg sm:px-5">An agent that fixes comments</p>
      <ol className="space-y-4 px-4 py-4 text-sm text-muted sm:px-5">
        <li className={step}>
          <span className={number}>1</span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-fg">Sign the machine in, in the project's folder.</p>
            <CopyField value={`shapewall login --remote ${origin}`} testId="connect-login" />
            <p className="text-xs">
              Approve the code it shows, choose this project and tick <strong className="font-medium text-fg">Take agent work</strong>. Or
              make a token here with New agent token and set it as SHAPEWALL_TOKEN on that machine.
            </p>
          </div>
        </li>
        <li className={step}>
          <span className={number}>2</span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-fg">Start watching, with the command that runs your coding agent.</p>
            <CopyField value={`shapewall watch --remote ${origin} --exec "<your agent command>"`} testId="connect-watch" />
            <p className="text-xs">It runs your command once for each comment sent to it. Leave it running; Ctrl+C stops it.</p>
          </div>
        </li>
        <li className={step}>
          <span className={number}>3</span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-fg">It appears above as online.</p>
            <p className="text-xs">
              Give it a name and an icon, and choose who may send it work: a new agent only takes comments from the person who connected it.
            </p>
          </div>
        </li>
      </ol>
      <p className="border-t border-line px-4 py-3 text-xs text-muted sm:px-5">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline"
          data-sw-connect-agent-docs
        >
          Agents on a hosted board <ArrowUpRight size={12} aria-hidden="true" />
        </a>{' '}
        has recipes for Claude Code, Codex and goose, and how to run it as a service.
      </p>
    </Card>
  )
}

// ---- Dialogs ----

// Name, icon, tint and what runs behind it. The fields are the local Agents
// page's (settings/AgentIdentity.jsx); pictures are not uploaded here.
function EditAgentDialog({ agent, kinds, url, onClose, onSaved }) {
  const id = useId()
  const [value, setValue] = useState({ name: '', icon: null, tint: null, png: null })
  const [kind, setKind] = useState('watcher')
  const save = useAction()
  useEffect(() => {
    if (!agent) return
    setValue({ name: agent.name, icon: agent.icon || null, tint: agent.tint || null, png: null })
    setKind(agent.kind)
    save.setError(null)
  }, [agent]) // eslint-disable-line react-hooks/exhaustive-deps
  const name = value.name.trim()
  const problem = nameProblem(value.name) || (agent && !name ? 'Give it a name.' : null)
  // The product mark the chosen kind shows by default.
  const logo = { claude: 'claude', codex: 'openai', goose: 'goose', gemini: 'gemini' }[kind] || null
  const change = agent
    ? {
        ...(name !== agent.name ? { name } : {}),
        ...(value.icon !== (agent.icon || null) ? { icon: value.icon } : {}),
        ...(value.tint !== (agent.tint || null) ? { tint: value.tint } : {}),
        ...(kind !== agent.kind ? { kind } : {}),
      }
    : {}
  const changed = Object.keys(change).length > 0
  const submit = () =>
    save.run(async () => {
      await api.patch(url, change)
      await onSaved()
      onClose()
    })
  return (
    <Dialog
      open={Boolean(agent)}
      onClose={() => (save.busy ? null : onClose())}
      title="Edit agent"
      description="How it is shown on boards. Its replies are signed with this name from now on; what it already wrote keeps the old one."
      wrapDescription
      size="md"
      footer={
        <>
          <Button size="touch" className="lg:h-9" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button
            size="touch"
            variant="default"
            className="lg:h-9"
            onClick={submit}
            disabled={save.busy || !changed || Boolean(problem)}
            data-sw-agent-edit-save
          >
            {save.busy ? <Spinner /> : null} Save
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5" data-sw-agent-edit-dialog>
        <NameField
          id={`${id}-name`}
          value={value}
          onChange={setValue}
          touch
          problem={problem}
          disabled={save.busy}
          hint="Shown on boards, in Send to agent and on its replies."
        />
        <Field label="What runs behind it" hint="Only changes the default icon: a known program shows its mark.">
          {(field) => (
            <Select value={kind} onValueChange={setKind} disabled={save.busy}>
              <SelectTrigger {...field} size="touch" className="w-full lg:h-9" data-sw-agent-kind>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((item) => (
                  <SelectItem key={item} value={item} data-sw-agent-kind-option={item}>
                    {KIND_LABEL[item] || item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <IconPicker
          value={value}
          onChange={setValue}
          label={name || agent?.name || 'Agent'}
          logo={logo}
          upload={false}
          disabled={save.busy}
        />
        <FormError error={save.error} />
      </div>
    </Dialog>
  )
}

// Who may send the agent work. Saving asks for a passkey check.
function AudienceDialog({ agent, members, url, onClose, onSaved }) {
  const [kind, setKind] = useState('owner')
  const [users, setUsers] = useState([])
  const save = useAction()
  useEffect(() => {
    if (!agent) return
    setKind(agent.audience.kind)
    setUsers(agent.audience.users.map((user) => user.userId))
    save.setError(null)
  }, [agent]) // eslint-disable-line react-hooks/exhaustive-deps
  const owner = agent?.createdBy?.userId || null
  const others = members.filter((member) => member.userId !== owner)
  const toggle = (userId) => setUsers((list) => (list.includes(userId) ? list.filter((item) => item !== userId) : [...list, userId]))
  const submit = () =>
    save.run(async () => {
      await api.put(url, { audience: kind, users: kind === 'members' ? users : [] })
      await onSaved()
      onClose()
    })
  return (
    <Dialog
      open={Boolean(agent)}
      onClose={() => (save.busy ? null : onClose())}
      title={`Who may send work to ${agent?.name || 'this agent'}`}
      description="Work sent to an agent runs on the machine of the person who connected it. Saving asks for your passkey."
      wrapDescription
      size="md"
      footer={
        <>
          <Button size="touch" className="lg:h-9" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button size="touch" variant="default" className="lg:h-9" onClick={submit} disabled={save.busy} data-sw-agent-audience-save>
            {save.busy ? <Spinner /> : null} Save
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5" data-sw-agent-audience-dialog>
        <div role="radiogroup" aria-label="Audience" className="space-y-2">
          {AUDIENCE_CHOICES.map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => setKind(value)}
              disabled={save.busy}
              className={`flex min-h-11 w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm outline-none focus-visible:outline-2 focus-visible:outline-accent ${
                kind === value ? 'border-accent/50 bg-accent/10' : 'border-line hover:bg-surface-2'
              }`}
              data-sw-agent-audience-option={value}
            >
              <span
                className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  kind === value ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface'
                }`}
                aria-hidden="true"
              >
                {kind === value ? <Check size={11} /> : null}
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-fg">
                  {value === 'owner' && agent?.createdBy ? `Only ${personName(agent.createdBy)}` : label}
                </span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </button>
          ))}
        </div>
        {kind === 'members' ? (
          <fieldset data-sw-agent-audience-members>
            <legend className="mb-1.5 block text-ui font-medium text-fg">Members</legend>
            {others.length ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {others.map((member) => (
                  <CheckToggle key={member.userId} checked={users.includes(member.userId)} onChange={() => toggle(member.userId)}>
                    <span className="min-w-0" data-sw-agent-audience-member={member.handle}>
                      <span className="block truncate">{member.displayName}</span>
                      <span className="block truncate text-xs text-muted">
                        @{member.handle} · {ROLE_LABEL[member.role]}
                        {member.trusted ? '' : ' · not trusted by the agent policy'}
                      </span>
                    </span>
                  </CheckToggle>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Nobody else in this workspace can comment yet. Invite a member first.</p>
            )}
          </fieldset>
        ) : null}
        <Notice>
          An audience only narrows who may use this agent. The project's agent policy still decides who may send work to an agent at all,
          and the machine that runs the agent has the last word. It also decides whose replies the agent reads. A comment the agent is
          already working on stays with it until it is done.
        </Notice>
        <FormError error={save.error} />
      </div>
    </Dialog>
  )
}

// The approval rule and who decides it. The agent's own machine has the
// last word: what it allows is shown as facts, and "Allow without asking"
// can be chosen only when the machine itself said something may go without
// asking.
function RuleOption({ value, checked, disabled, onChoose, title, children, ...rest }) {
  return (
    <div
      role="radio"
      aria-checked={checked ? 'true' : 'false'}
      aria-disabled={disabled ? 'true' : undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : () => onChoose(value)}
      onKeyDown={
        disabled
          ? undefined
          : (event) => {
              if (event.key !== ' ' && event.key !== 'Enter') return
              event.preventDefault()
              onChoose(value)
            }
      }
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-accent',
        checked ? 'border-accent/50 bg-accent/10' : 'border-line',
        disabled ? (checked ? '' : 'bg-surface-2/40') : 'cursor-pointer hover:border-accent/50',
      )}
      data-sw-agent-approval-option={value}
      {...rest}
    >
      {checked ? (
        <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-accent bg-accent text-accent-fg">
          <Check size={11} aria-hidden="true" />
        </span>
      ) : (
        <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 rounded-full border border-line bg-surface" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <span className={cn('block font-medium', disabled && !checked ? 'text-muted' : 'text-fg')}>{title}</span>
        {children}
      </div>
    </div>
  )
}

function ApprovalDialog({ agent, role, url, onClose, onSaved }) {
  const [rule, setRule] = useState('ask')
  const [changeRole, setChangeRole] = useState('admin')
  const [answerRole, setAnswerRole] = useState('admin')
  const save = useAction()
  useEffect(() => {
    if (!agent) return
    setRule(agent.approval.effectiveRule)
    setChangeRole(agent.approval.changeRole)
    setAnswerRole(agent.approval.answerRole)
    save.setError(null)
  }, [agent]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = agent ? { approvalChangeRole: agent.approval.changeRole, approvalAnswerRole: agent.approval.answerRole } : null
  const mayRule = canChangeApprovalRule(role, current)
  const mayRoles = canChangeApprovalRoles(role)
  const blocked = autoBlocked(agent)
  const linked = Boolean(agent?.link?.connected)
  const mode = modeOf(agent)
  // Nothing to ask about: the rule is not a choice for an agent that only reads.
  const ruleOff = !mayRule || save.busy
  const ruleChanged = agent ? rule !== agent.approval.effectiveRule : false
  const changed = agent ? ruleChanged || changeRole !== agent.approval.changeRole || answerRole !== agent.approval.answerRole : false
  const submit = () =>
    save.run(async () => {
      await api.put(url, {
        ...(ruleChanged ? { rule } : {}),
        ...(changeRole !== agent.approval.changeRole ? { changeRole } : {}),
        ...(answerRole !== agent.approval.answerRole ? { answerRole } : {}),
      })
      await onSaved()
      onClose()
    })
  const roleSelect = (value, onChange, hook) => (field) => (
    <Select value={value} onValueChange={onChange} disabled={!mayRoles || save.busy}>
      <SelectTrigger {...field} size="touch" className="w-full lg:h-9" data-sw-agent-approval-role={hook}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin">Admins and owners</SelectItem>
        <SelectItem value="owner">Owners only</SelectItem>
      </SelectContent>
    </Select>
  )
  const machineAuto = agent ? kindsWords(agent.approval.machine.auto) : ''
  return (
    <Dialog
      open={Boolean(agent)}
      onClose={() => (save.busy ? null : onClose())}
      title={`Approvals for ${agent?.name || 'this agent'}`}
      description="Whether what the agent asks to do waits for a person, and who decides. Saving asks for your passkey."
      wrapDescription
      size="md"
      footer={
        <>
          <Button size="touch" className="lg:h-9" onClick={onClose} disabled={save.busy}>
            {mayRoles || mayRule ? 'Cancel' : 'Close'}
          </Button>
          {mayRoles || mayRule ? (
            <Button
              size="touch"
              variant="default"
              className="lg:h-9"
              onClick={submit}
              disabled={save.busy || !changed}
              data-sw-agent-approval-save
            >
              {save.busy ? <Spinner /> : null} Save
            </Button>
          ) : null}
        </>
      }
    >
      {agent ? (
        <div className="space-y-4 p-5" data-sw-agent-approval-dialog>
          <p className="flex items-start gap-2 text-sm" data-sw-agent-approval-mode={linked ? mode : 'watch'}>
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0">
              <span className="text-muted">Now: </span>
              <span className="font-medium text-fg">{linked ? MODE_TITLE[mode] : 'Asks before each command'}.</span>{' '}
              <span className="text-muted">
                {!linked
                  ? 'It takes comments on its own (shapewall watch) and makes its changes where it runs.'
                  : mode === 'none'
                    ? 'It makes no changes from the board.'
                    : mode === 'auto'
                      ? `A fix is made on a branch on its machine. Without asking: ${kindsWords(autoKinds(agent))}.`
                      : 'A fix is made on a branch on its machine, and each edit waits for an answer on the board.'}
              </span>
            </span>
          </p>
          {linked ? <MachineFacts agent={agent} /> : null}
          <div role="radiogroup" aria-label="Approval rule" className="space-y-2">
            <RuleOption value="ask" checked={rule === 'ask'} disabled={ruleOff} onChoose={setRule} title="Ask every time">
              <span className="block text-xs text-muted">
                {linked && mode === 'none'
                  ? 'Once its machine takes edits from the board, each one waits for a person with the role below.'
                  : agent.approval.machine.approvals === 'owner'
                    ? `Everything the agent asks to do waits for ${agent.createdBy ? personName(agent.createdBy) : 'the person who connected it'}: its machine takes answers from nobody else.`
                    : 'Everything the agent asks to do waits for a person with the role below.'}
              </span>
            </RuleOption>
            <RuleOption
              value="auto"
              checked={rule === 'auto'}
              disabled={ruleOff || Boolean(blocked)}
              onChoose={setRule}
              title={blocked ? 'Allow without asking (not available)' : 'Allow without asking'}
              {...(blocked ? { 'data-sw-agent-approval-unavailable': true } : {})}
            >
              {blocked ? (
                <>
                  <span className="block text-xs text-muted" data-sw-agent-approval-why>
                    {blocked}
                  </span>
                  {linked ? (
                    <>
                      <span className="mt-1.5 block text-xs text-muted">
                        To allow it, run this on the agent's machine, in the project's folder:
                      </span>
                      <CopyField value={AUTO_COMMAND} testId="approval-auto" className="mt-1" />
                    </>
                  ) : null}
                </>
              ) : (
                <span className="block text-xs text-muted" data-sw-agent-approval-applies>
                  Applies to {machineAuto}, as its machine allows. Anything else still waits for an answer. A fix is always made on a
                  branch.
                </span>
              )}
            </RuleOption>
          </div>
          {mayRule ? null : (
            <Notice tone="info">
              Changing this agent's approval rule needs the {ROLE_LABEL[agent.approval.changeRole || 'owner'].toLowerCase()} role.
            </Notice>
          )}
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label="Who may answer its approvals" hint="They also need a fresh passkey check for each answer.">
              {roleSelect(answerRole, setAnswerRole, 'answer')}
            </Field>
            <Field label="Who may change this rule" hint="Only an owner changes these two.">
              {roleSelect(changeRole, setChangeRole, 'change')}
            </Field>
          </div>
          <FormError error={save.error} />
        </div>
      ) : null}
    </Dialog>
  )
}

// On the project page: the project's agents in one line each, and the way in.
export function ProjectAgentsCard({ workspaceId, projectId }) {
  const load = useLoad(wsUrl(workspaceId, `/projects/${projectId}/agents`))
  const live = (load.data?.agents || []).filter((agent) => agent.state !== 'revoked')
  return (
    <Card data-sw-project-agents-card>
      <CardHeader
        icon={Bot}
        title="Agents"
        description="The machines that pick up comments sent to an agent here: who they are, who may use them, and the default."
        actions={
          <Button asChild size="touch" variant="secondary" className="lg:h-9">
            <Link to={`/w/${workspaceId}/agents/${projectId}`} data-sw-project-agents-open>
              {live.length ? 'Manage agents' : 'Connect an agent'}
            </Link>
          </Button>
        }
      />
      {load.loading ? <Loading rows={1} /> : null}
      {load.error ? (
        <div className="p-4">
          <LoadError error={load.error} onRetry={load.reload} />
        </div>
      ) : null}
      {load.data && !load.error ? (
        live.length ? (
          <ul className="divide-y divide-line">
            {live.map((agent) => (
              <li
                key={agent.id}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm sm:px-5"
                data-sw-project-agent={agent.name}
              >
                <Face agent={agent} size="md" />
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{agent.name}</span>
                {agent.isDefault ? (
                  <Badge tone="neutral" className="px-1.5 py-0.5 text-[10.5px]">
                    Default
                  </Badge>
                ) : null}
                <StateBadge agent={agent} />
                <span className="w-full text-xs text-muted sm:w-auto">{agent.audience.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-4 text-sm text-muted sm:px-5">
            No agent is connected. Comments sent to an agent wait until a machine that has the code runs shapewall watch --remote.
          </p>
        )
      ) : null}
    </Card>
  )
}
