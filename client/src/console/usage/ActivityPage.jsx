// Activity: what people did, read from the audit log (which stays the
// security record). Who signed in, who changed which setting and from what
// to what, who connected, approved, revoked or reconfigured which agent, who
// answered which approval card, who exported what, which token was made or
// revoked. Admins and owners read everyone's; anyone else their own.
//
//   /w/:ws/activity              the log, with filters, saved views, export
//   /w/:ws/activity?tab=review   the access review (admins and owners)
//   /w/:ws/activity/us_...       one person: who they are here, what they
//                                made, their devices, their agent usage and
//                                their activity
//   /w/:ws/activity/ag_...       one agent: what it is, its usage, its activity
//
// Usage is the record of agent turns; the two link to each other.

import { useMemo, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Download,
  Globe,
  KeyRound,
  Laptop,
  Search,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  ToggleGroup,
} from '../../components/ui'
import { DEMO } from '../../lib/demo'
import { cn } from '../../lib/utils'
import { ACTION_GROUP_IDS, ACTION_GROUP_LABEL } from '../../../../src/hosted/usage-shape.js'
import { Card, CardHeader, LoadError, Loading, PageHeader, RoleBadge, Time } from '../components'
import { download, wsUrl } from '../lib/api'
import { ACCESS_LABEL, AGENT_AUDIENCE_LABEL, ROLE_LABEL, describeAudit, formatDate, formatDateTime } from '../lib/format'
import { Link } from '../lib/router'
import { useAction, useToast } from '../state'
import { useWorkspace } from '../pages/workspace'
import { setSearch, useAddress, useUsageFilter, useWs, useWsPages } from './data'
import { PeriodPicker, ViewsMenu } from './filters'
import { formatCount, formatTime, periodOf } from './format'
import { ColumnChooser, DataGrid, readLayout, writeLayout } from './grid'
import { DemoNote, Drawer, Fact, Facts } from './pieces'
import { Overview } from './UsagePage'

const ALL = '__all__'
const linkClass = 'font-medium text-accent underline-offset-2 hover:underline'
const SOURCE_ICON = { person: UserRound, token: Bot, guest: Globe, system: ServerCog }
const SOURCE_LABEL = { person: 'A person', token: 'An API token', guest: 'A share link guest', system: 'The server' }
const dash = <span className="text-faint">{'–'}</span>

// The filters of the log, from the address, as API parameters.
function useActivityFilter(fixed = {}) {
  const address = useAddress()
  const { params } = address
  const range = params.get('range') || 'any'
  const period = useMemo(
    () => (range === 'any' ? null : periodOf({ range, from: params.get('from'), to: params.get('to') })),
    [params, range],
  )
  const query = useMemo(() => {
    const out = new URLSearchParams()
    for (const key of ['person', 'agent', 'project', 'group', 'source', 'q']) {
      const value = fixed[key] ?? params.get(key)
      if (value) out.set(key, value)
    }
    if (params.get('sensitive') === '1') out.set('sensitive', '1')
    if (period) {
      out.set('from', period.from.toISOString())
      out.set('to', period.to.toISOString())
    }
    return out.toString()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, period, fixed.person, fixed.agent])
  const active = ['person', 'agent', 'project', 'group', 'source', 'q', 'sensitive'].filter((key) => params.get(key) && !fixed[key])
  if (range !== 'any') active.push('range')
  return { ...address, period, range, query, active }
}

function Actor({ entry }) {
  const Icon = SOURCE_ICON[entry.source] || ServerCog
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon size={13} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="truncate">
        {entry.actor.label}
        {entry.actor.type === 'token' ? <span className="text-muted"> (token)</span> : null}
        {entry.actor.type === 'guest' && entry.actor.named ? <span className="text-muted"> (guest)</span> : null}
      </span>
    </span>
  )
}
function Change({ change }) {
  if (!change) return dash
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" data-sw-change>
      <span className="truncate text-muted line-through decoration-line-strong">{change.before || 'none'}</span>
      <span className="text-faint" aria-label="changed to">
        {'→'}
      </span>
      <span className="truncate font-medium text-fg">{change.after || 'none'}</span>
    </span>
  )
}

const ACTIVITY_COLUMNS = [
  { id: 'at', header: 'When', width: 146, always: true, cell: (entry) => formatTime(entry.at) },
  { id: 'who', header: 'Who', width: 150, cell: (entry) => <Actor entry={entry} /> },
  {
    id: 'what',
    header: 'What',
    width: 350,
    cell: (entry) => (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {entry.sensitive ? <ShieldAlert size={13} className="shrink-0 text-warn" aria-label="A security-relevant change" /> : null}
        <span className="truncate first-letter:uppercase">{describeAudit(entry)}</span>
        {entry.tailnetSession ? (
          <span
            className="shrink-0 rounded border border-line px-1 text-[10px] text-muted"
            title="Done in a session their tailnet signed in"
            data-sw-activity-tailnet
          >
            tailnet
          </span>
        ) : null}
      </span>
    ),
  },
  { id: 'change', header: 'Before and after', width: 200, cell: (entry) => <Change change={entry.change} /> },
  { id: 'group', header: 'Kind', width: 160, cell: (entry) => ACTION_GROUP_LABEL[entry.group] || 'Other' },
  { id: 'agent', header: 'Agent', width: 136, cell: (entry) => entry.agent?.name || dash },
  { id: 'project', header: 'Project', width: 150, cell: (entry) => entry.project?.name || dash },
  { id: 'source', header: 'Through', width: 150, cell: (entry) => SOURCE_LABEL[entry.source] || dash },
  { id: 'ip', header: 'Address', width: 116, cell: (entry) => entry.ip || dash },
  { id: 'device', header: 'Device', width: 160, cell: (entry) => entry.device || dash },
  {
    id: 'action',
    header: 'Action name',
    width: 220,
    cell: (entry) => <code className="font-mono text-[11px] text-muted">{entry.action}</code>,
  },
]
const ACTIVITY_DEFAULTS = { shown: ['at', 'who', 'what', 'change', 'agent', 'ip'], pinned: ['at'] }

function EntryCard({ entry }) {
  return (
    <span className="block" data-sw-activity-card>
      <span className="block text-sm text-fg">
        <span className="font-medium">{entry.actor.label}</span> {describeAudit(entry)}
      </span>
      {entry.change ? (
        <span className="mt-0.5 block text-xs">
          <Change change={entry.change} />
        </span>
      ) : null}
      <span className="mt-0.5 block truncate text-xs text-muted">
        {formatTime(entry.at)}
        {entry.ip ? ` · ${entry.ip}` : ''}
      </span>
    </span>
  )
}

function EntryDrawer({ entry, onClose, workspaceId, isAdmin }) {
  if (!entry) return null
  return (
    <Drawer
      open
      onClose={onClose}
      title={ACTION_GROUP_LABEL[entry.group] || 'Activity'}
      description={formatDateTime(entry.at)}
      testId="activity"
    >
      <div data-sw-activity-entry={entry.id}>
        <p className="border-b border-line px-5 py-3.5 text-sm text-fg">
          <span className="font-medium">{entry.actor.label}</span> {describeAudit(entry)}
        </p>
        {entry.change ? (
          <Facts title="What changed">
            <Fact label="Before">{entry.change.before || 'none'}</Fact>
            <Fact label="After">
              <span className="font-medium">{entry.change.after || 'none'}</span>
            </Fact>
          </Facts>
        ) : null}
        <Facts title="Who, when and from where">
          <Fact label="Who">
            {entry.actor.type === 'user' && isAdmin ? (
              <Link to={`/w/${workspaceId}/activity/${entry.actor.id}`} className={linkClass}>
                {entry.actor.label}
              </Link>
            ) : (
              entry.actor.label
            )}
            {entry.actor.handle ? <span className="text-muted"> @{entry.actor.handle}</span> : null}
          </Fact>
          <Fact label="Through">{SOURCE_LABEL[entry.source]}</Fact>
          <Fact label="When">{formatTime(entry.at)}</Fact>
          <Fact label="Address">{entry.ip || <span className="text-muted">Not recorded</span>}</Fact>
          {entry.device ? <Fact label="Device">{entry.device}</Fact> : null}
          <Fact label="Belongs to">{entry.scope === 'account' ? 'The person’s account (sign-in)' : 'This workspace'}</Fact>
        </Facts>
        <Facts title="About">
          <Fact label="Action">
            <code className="font-mono text-xs">{entry.action}</code>
          </Fact>
          {entry.agent ? (
            <Fact label="Agent">
              {isAdmin ? (
                <Link to={`/w/${workspaceId}/activity/${entry.agent.id}`} className={linkClass}>
                  {entry.agent.name}
                </Link>
              ) : (
                entry.agent.name
              )}
            </Fact>
          ) : null}
          {entry.project ? <Fact label="Project">{entry.project.name}</Fact> : null}
          {entry.target ? (
            <Fact label="Target">{entry.targetLabel || <code className="font-mono text-xs break-all">{entry.target}</code>}</Fact>
          ) : null}
        </Facts>
        {Object.keys(entry.detail).length ? (
          <section className="px-5 py-3.5">
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">As recorded</h3>
            <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap text-fg">
              {JSON.stringify(entry.detail, null, 2)}
            </pre>
            <p className="mt-1.5 text-caption text-muted">Names, ids and settings. The log never holds comment text, prompts or answers.</p>
          </section>
        ) : null}
        {entry.agent && isAdmin ? (
          <p className="border-t border-line px-5 py-3 text-sm">
            <Link
              to={`/w/${workspaceId}/usage?agent=${entry.agent.id}&tab=turns`}
              className={cn(linkClass, 'inline-flex items-center gap-1')}
            >
              Usage of {entry.agent.name} <ArrowUpRight size={13} aria-hidden="true" />
            </Link>
          </p>
        ) : null}
      </div>
    </Drawer>
  )
}

// The log itself. `fixed`: a person or an agent the page is about.
export function ActivityLog({ fixed = {}, embedded = false }) {
  const { workspaceId, isAdmin } = useWorkspace()
  const filter = useActivityFilter(fixed)
  const { get, set, query, search } = filter
  const filters = useWs(workspaceId, '/activity/filters', { keep: false, enabled: !embedded })
  const pages = useWsPages(workspaceId, (before) => `/activity?${query}&limit=100${before ? `&before=${before}` : ''}`, {
    next: (page) => page.next,
  })
  const entries = useMemo(() => (pages.data?.pages || []).flatMap((page) => page.entries), [pages.data])
  const items = useMemo(() => entries.map((row) => ({ type: 'row', row })), [entries])
  const [openId, setOpenId] = useState(null)
  const [text, setText] = useState(get('q'))
  const exporter = useAction()
  const toast = useToast()
  const layout = useMemo(
    () =>
      readLayout(ACTIVITY_COLUMNS, {
        cols: get('cols') || null,
        pin: filter.params.has('pin') ? (get('pin') === 'none' ? '' : get('pin')) : null,
        widths: get('w') || null,
        defaults: ACTIVITY_DEFAULTS,
      }),
    [get, filter.params],
  )
  const setLayout = (next) => set(writeLayout(next, ACTIVITY_DEFAULTS))
  const exportCsv = () =>
    exporter.run(async () => {
      const file = await download('GET', wsUrl(workspaceId, `/activity/export?${query}`), undefined, 'activity.csv')
      toast(`Saved ${file.name}`)
    })
  const choose = (key, label, options, testId) => (
    <Select value={get(key) || ALL} onValueChange={(value) => set({ [key]: value === ALL ? null : value }, { push: true })}>
      <SelectTrigger
        className={cn('h-9 w-full min-w-0 text-xs font-medium sm:w-auto', get(key) && 'border-accent/50 bg-accent/10')}
        aria-label={label}
        data-sw-activity-filter={testId || key}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{label}</SelectItem>
        {options.map(([value, name]) => (
          <SelectItem key={value} value={value}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
  const fakePeriod = filter.period || {
    range: 'any',
    from: new Date(Date.now() - 30 * 86_400_000),
    to: new Date(Date.now() + 86_400_000),
    label: 'Any time',
  }
  const open = entries.find((entry) => entry.id === openId)
  return (
    <div data-sw-activity-log>
      <div className="mb-3 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center print:hidden" data-sw-activity-filters>
        <span className="col-span-2 flex items-center gap-1.5 sm:col-span-1">
          <PeriodPicker
            period={fakePeriod}
            onChange={(changes) => set({ range: changes.range || '30d', from: changes.from, to: changes.to }, { push: true })}
          />
          {filter.range !== 'any' ? (
            <Button size="sm" variant="ghost" className="h-9" onClick={() => set({ range: null, from: null, to: null }, { push: true })}>
              Any time
            </Button>
          ) : null}
        </span>
        {isAdmin && !fixed.person && !embedded
          ? choose(
              'person',
              'Everyone',
              (filters.data?.people || []).map((item) => [item.id, item.name]),
            )
          : null}
        {choose(
          'group',
          'Every kind of action',
          ACTION_GROUP_IDS.map((id) => [id, ACTION_GROUP_LABEL[id]]),
        )}
        {isAdmin && !fixed.agent && !embedded
          ? choose(
              'agent',
              'Any agent',
              (filters.data?.agents || []).map((item) => [item.id, item.name]),
            )
          : null}
        {isAdmin && !embedded
          ? choose(
              'project',
              'Any project',
              (filters.data?.projects || []).map((item) => [item.id, item.name]),
            )
          : null}
        {isAdmin && !embedded ? choose('source', 'Through anything', Object.entries(SOURCE_LABEL)) : null}
        <button
          type="button"
          aria-pressed={get('sensitive') === '1'}
          onClick={() => set({ sensitive: (current) => (current.includes('1') ? null : '1') }, { push: true })}
          className={cn(
            'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-accent',
            get('sensitive') === '1' ? 'border-accent/50 bg-accent/10 text-fg' : 'border-line bg-surface text-fg hover:bg-surface-2',
          )}
          data-sw-activity-sensitive
        >
          <ShieldAlert size={14} className="text-warn" aria-hidden="true" /> Worth a look
        </button>
        <form
          className="col-span-2 sm:col-span-1"
          onSubmit={(event) => {
            event.preventDefault()
            set({ q: text.trim() || null }, { push: true })
          }}
        >
          <Input
            icon={Search}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search names and details"
            aria-label="Search the activity"
            maxLength={100}
            className="h-9"
            wrapperClassName="w-full sm:w-52"
            data-sw-activity-search
          />
        </form>
        {embedded ? null : (
          <span className="col-span-2 flex items-center gap-1.5 sm:ml-auto">
            <ViewsMenu
              workspaceId={workspaceId}
              page="activity"
              search={search}
              onOpen={(saved) => setSearch(new URLSearchParams(saved), { push: true })}
            />
            <span className="hidden sm:inline-flex">
              <ColumnChooser
                columns={ACTIVITY_COLUMNS}
                layout={layout}
                onLayout={setLayout}
                onReset={() => set({ cols: null, pin: null, w: null })}
              />
            </span>
            <Button size="sm" variant="secondary" className="h-9" onClick={exportCsv} disabled={exporter.busy} data-sw-activity-export>
              {exporter.busy ? <Spinner /> : <Download size={14} aria-hidden="true" />} Export CSV
            </Button>
          </span>
        )}
      </div>
      {exporter.error ? (
        <p className="mb-2 text-sm text-bad" role="alert">
          {exporter.error}
        </p>
      ) : null}
      {pages.data?.pages[0]?.searchedFrom ? (
        <p className="mb-2 text-xs text-muted" data-sw-activity-search-bound>
          Searching the last 90 days. Choose a period to search further back.
        </p>
      ) : null}
      {!embedded && filters.data ? (
        <p className="mb-2 text-xs text-muted" data-sw-activity-accounts={filters.data.accounts}>
          {filters.data.accounts === 'members'
            ? 'Sign-ins, passkeys and devices of this workspace\u2019s members are shown here, to owners: this server\u2019s operator switched that on.'
            : isAdmin
              ? 'Sign-ins and passkeys belong to each person and are not shown here. Everyone sees their own on their own page.'
              : 'This is your own activity here, with your sign-ins.'}
        </p>
      ) : null}
      <Card>
        {pages.error && !pages.data ? (
          <div className="p-4">
            <LoadError error={pages.error} onRetry={pages.refetch} />
          </div>
        ) : pages.isLoading ? (
          <Loading label="Loading the activity" rows={5} />
        ) : !items.length ? (
          <EmptyState
            icon={Activity}
            title={filter.active.length ? 'Nothing matches these filters' : 'No activity yet'}
            data-sw-activity-empty
          >
            {filter.active.length
              ? 'Clear a filter or choose a longer period.'
              : 'Sign-ins, settings, agents, approvals, tokens and exports show up here as they happen.'}
          </EmptyState>
        ) : (
          <DataGrid
            label="Activity"
            columns={ACTIVITY_COLUMNS}
            items={items}
            rowKey={(entry) => entry.id}
            layout={layout}
            onLayout={setLayout}
            onOpen={(entry) => setOpenId(entry.id)}
            openId={openId}
            hasMore={Boolean(pages.hasNextPage)}
            loadingMore={pages.isFetchingNextPage}
            onMore={() => pages.fetchNextPage()}
            busy={pages.isPlaceholderData && pages.isFetching}
            card={(entry) => <EntryCard entry={entry} />}
            footer={
              <p className="border-t border-line px-4 py-2 text-caption text-muted">
                {formatCount(entries.length, { exact: true })} {entries.length === 1 ? 'entry' : 'entries'} loaded
                {pages.hasNextPage ? '; older ones load as you scroll' : ''}. Newest first.
              </p>
            }
          />
        )}
      </Card>
      <EntryDrawer entry={open} onClose={() => setOpenId(null)} workspaceId={workspaceId} isAdmin={isAdmin} />
    </div>
  )
}

export function ActivityPage() {
  const { workspaceId, isAdmin } = useWorkspace()
  const { get, set } = useAddress()
  const tab = isAdmin && get('tab') === 'review' ? 'review' : 'log'
  return (
    <div data-sw-activity={tab}>
      <PageHeader
        title="Activity"
        description={
          isAdmin
            ? 'What people did here: sign-ins, settings with before and after, agents, approvals, tokens and exports. Read from the audit log.'
            : 'Your own activity in this workspace: your sign-ins, what you changed and what you exported. Admins and owners see everyone’s.'
        }
        actions={
          <Link to={`/w/${workspaceId}/usage`} className={cn(linkClass, 'inline-flex items-center gap-1 text-sm')}>
            Agent usage <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        }
      />
      <DemoNote testId="activity">
        This is a demo with a made-up history: the sign-ins, settings, agents and approvals of a pretend team. What you do in the demo is
        added on top; Reset puts everything back.
      </DemoNote>
      {isAdmin ? (
        <div className="mb-4 flex print:hidden">
          <ToggleGroup
            label="View"
            value={tab}
            onChange={(next) => set({ tab: next === 'log' ? null : next }, { push: true })}
            options={[
              { id: 'log', label: 'Activity' },
              { id: 'review', label: 'Access review' },
            ]}
          />
        </div>
      ) : null}
      {tab === 'review' ? <AccessReview /> : <ActivityLog />}
    </div>
  )
}

// ---- One person ----

function Back({ workspaceId }) {
  return (
    <Link
      to={`/w/${workspaceId}/activity`}
      className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-muted hover:text-fg print:hidden"
    >
      <ArrowLeft size={14} aria-hidden="true" /> Activity
    </Link>
  )
}
const NotThere = ({ workspaceId, what }) => (
  <>
    <Back workspaceId={workspaceId} />
    <Card data-sw-subject-missing>
      <EmptyState icon={UserRound} size="lg" title={`${what} not found`}>
        It is not in this workspace, or this page is not yours to see.
      </EmptyState>
    </Card>
  </>
)

export function PersonPage({ userId }) {
  const { workspaceId, isAdmin, data } = useWorkspace()
  const state = useWs(workspaceId, `/people/${userId}`, { keep: false })
  const filter = useUsageFilter()
  if (state.isLoading) return <Loading label="Loading the person" rows={4} />
  if (state.error)
    return state.error.status === 404 ? (
      <NotThere workspaceId={workspaceId} what="Person" />
    ) : (
      <LoadError error={state.error} onRetry={state.refetch} />
    )
  const person = state.data.person
  const self = person.userId === data.me.userId
  return (
    <div data-sw-person={person.handle}>
      {isAdmin ? <Back workspaceId={workspaceId} /> : null}
      <PageHeader
        title={person.displayName}
        badge={<RoleBadge role={person.role} />}
        description={`@${person.handle} · joined ${formatDate(person.joinedAt)}${person.roleChanged?.from ? ` · ${ROLE_LABEL[person.roleChanged.from] || person.roleChanged.from} until ${formatDate(person.roleChanged.at)}` : ''}`}
      />
      <DemoNote testId="person">This is a demo: {person.displayName} is made up, and so are these numbers.</DemoNote>
      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader icon={ShieldCheck} title="What they can reach" />
          <Facts>
            <Fact label="Role">{ROLE_LABEL[person.role]}</Fact>
            <Fact label="On every project">{ACCESS_LABEL[person.access]}</Fact>
            <Fact label="Projects">{person.projects.length ? person.projects.map((project) => project.name).join(', ') : 'None yet'}</Fact>
            <Fact label="Last active">
              <Time value={person.lastActiveAt} />
            </Fact>
            <Fact label="Comments">
              {formatCount(person.counts.comments.count)}
              {person.counts.comments.lastAt ? (
                <span className="text-muted"> · last {formatDate(person.counts.comments.lastAt)}</span>
              ) : null}
            </Fact>
            <Fact label="Chat messages">{formatCount(person.counts.chatMessages.count)}</Fact>
            <Fact label="Approvals answered">{formatCount(person.counts.approvalsAnswered.count)}</Fact>
          </Facts>
        </Card>
        <Card>
          <CardHeader
            icon={KeyRound}
            title="What they made"
            description="Tokens and agents work only while their maker is an admin or owner here."
          />
          <ul className="divide-y divide-line text-sm" data-sw-person-made>
            {person.agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2 px-4 py-2 sm:px-5">
                <Bot size={14} className="shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {isAdmin ? (
                    <Link to={`/w/${workspaceId}/activity/${agent.id}`} className={cn(linkClass, 'block truncate')}>
                      {agent.name}
                    </Link>
                  ) : (
                    <span className="block truncate text-fg">{agent.name}</span>
                  )}
                  <span className="block truncate text-caption text-muted">
                    Agent on {agent.projectName}
                    {agent.machine ? ` · ${agent.machine}` : ''}
                  </span>
                </span>
                {agent.revoked ? <Badge tone="neutral">Revoked</Badge> : null}
              </li>
            ))}
            {person.tokens
              .filter((token) => !token.scopes.includes('claim'))
              .map((token) => (
                <li key={token.id} className="flex items-center gap-2 px-4 py-2 sm:px-5">
                  <KeyRound size={14} className="shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-fg">{token.name}</span>
                    <span className="block truncate text-caption text-muted">
                      Token on {token.projectName} · {token.scopes.join(', ')}
                    </span>
                  </span>
                  {token.status !== 'active' ? <Badge tone="neutral">{token.status}</Badge> : null}
                </li>
              ))}
            {!person.agents.length && !person.tokens.length ? (
              <li className="px-5 py-6 text-center text-xs text-muted">No tokens or agents.</li>
            ) : null}
          </ul>
          {person.shares ? <p className="border-t border-line px-5 py-2 text-xs text-muted">{person.shares} open share links.</p> : null}
        </Card>
        <Card>
          <CardHeader icon={Laptop} title="Signed in on" description="Devices with a live session, by when each was last seen." />
          <ul className="divide-y divide-line text-sm" data-sw-person-devices>
            {(person.sessions || []).map((session, index) => (
              <li key={index} className="px-4 py-2 sm:px-5">
                <span className="block truncate text-fg">{session.device || 'An unknown device'}</span>
                <span className="block text-caption text-muted">
                  Last seen <Time value={session.lastSeenAt} /> · signed in {formatDate(session.createdAt)}
                  {session.via === 'recovery' ? ' with a recovery code' : ''}
                </span>
              </li>
            ))}
            {person.sessions === null ? (
              <li className="px-5 py-6 text-center text-xs text-muted" data-sw-person-devices-private>
                Where someone is signed in is theirs to see: it covers every workspace they are in.
              </li>
            ) : !person.sessions.length ? (
              <li className="px-5 py-6 text-center text-xs text-muted">Not signed in anywhere.</li>
            ) : null}
          </ul>
        </Card>
      </div>
      <SubjectUsage
        title={self ? 'Your agent usage' : `${person.displayName}'s agent usage`}
        filter={filter}
        extra={`&person=${person.userId}`}
        to={`/w/${workspaceId}/usage?person=${person.userId}`}
      />
      <h2 className="mt-6 mb-3 text-heading font-semibold text-fg">{self ? 'Your activity' : `${person.displayName}'s activity`}</h2>
      <ActivityLog fixed={{ person: person.userId }} embedded />
    </div>
  )
}

function SubjectUsage({ title, filter, extra, to }) {
  return (
    <section data-sw-subject-usage>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading font-semibold text-fg">{title}</h2>
        <span className="flex items-center gap-2 print:hidden">
          <PeriodPicker period={filter.period} onChange={(changes) => filter.set(changes, { push: true })} />
          <Link to={to} className={cn(linkClass, 'inline-flex items-center gap-1 text-sm')}>
            Open in Usage <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </span>
      </div>
      <Overview filter={filter} isAdmin={false} compact extraQuery={extra} />
    </section>
  )
}

// ---- One agent ----

export function AgentPage({ agentId }) {
  const { workspaceId, isAdmin } = useWorkspace()
  const state = useWs(workspaceId, `/agents/${agentId}/profile`, { keep: false, enabled: isAdmin })
  const filter = useUsageFilter()
  if (!isAdmin) return <NotThere workspaceId={workspaceId} what="Agent" />
  if (state.isLoading) return <Loading label="Loading the agent" rows={4} />
  if (state.error)
    return state.error.status === 404 ? (
      <NotThere workspaceId={workspaceId} what="Agent" />
    ) : (
      <LoadError error={state.error} onRetry={state.refetch} />
    )
  const agent = state.data.agent
  const stateLabel = { online: 'Online', busy: 'Working', offline: 'Offline', revoked: 'Revoked' }[agent.state] || agent.state
  return (
    <div data-sw-agent-page={agent.name}>
      <Back workspaceId={workspaceId} />
      <PageHeader
        title={agent.name}
        badge={<Badge tone={agent.state === 'revoked' ? 'bad' : agent.state === 'offline' ? 'neutral' : 'ok'}>{stateLabel}</Badge>}
        description={`An agent of ${agent.projectName}${agent.machine ? `, on ${agent.machine}` : ''}.`}
        actions={
          // The demo has no Agents page per project: every agent is on its API tokens page, by its token.
          <Link
            to={DEMO ? `/w/${workspaceId}/tokens` : `/w/${workspaceId}/agents/${agent.projectId}`}
            className={cn(linkClass, 'inline-flex items-center gap-1 text-sm')}
            data-sw-agent-settings
          >
            {DEMO ? 'Its token' : 'Its settings'} <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        }
      />
      <DemoNote testId="agent">This is a demo: the machine, the models and the numbers of {agent.name} are made up.</DemoNote>
      <Card className="mb-5">
        <Facts>
          <Fact label="Connected by">
            {agent.createdBy ? (
              <Link to={`/w/${workspaceId}/activity/${agent.createdBy.userId}`} className={linkClass}>
                {agent.createdBy.displayName || 'Former member'}
              </Link>
            ) : (
              'Nobody on record'
            )}
            <span className="text-muted"> on {formatDate(agent.createdAt)}</span>
          </Fact>
          <Fact label="Who may use it">{agent.audience.text || AGENT_AUDIENCE_LABEL[agent.audience.kind]}</Fact>
          <Fact label="Edits and commands">
            {agent.approval.effectiveRule === 'auto' ? 'Allowed without asking, where its machine says so' : 'Always wait for a person'}
          </Fact>
          <Fact label="Machine">{agent.machine || <span className="text-muted">Not known</span>}</Fact>
          <Fact label="Last seen">
            <Time value={agent.lastSeenAt} />
          </Fact>
          <Fact label="Token">
            <code className="font-mono text-xs">{agent.token.prefix}…</code> · {agent.token.scopes.join(', ')}
            {agent.token.revokedAt ? <span className="text-bad"> · revoked {formatDate(agent.token.revokedAt)}</span> : null}
          </Fact>
        </Facts>
      </Card>
      <SubjectUsage
        title={`Usage of ${agent.name}`}
        filter={filter}
        extra={`&agent=${agent.id}`}
        to={`/w/${workspaceId}/usage?agent=${agent.id}`}
      />
      <h2 className="mt-6 mb-3 text-heading font-semibold text-fg">Activity about {agent.name}</h2>
      <ActivityLog fixed={{ agent: agent.id }} embedded />
    </div>
  )
}

// ---- The access review ----

function ReviewTable({ title, icon, description, columns, rows, empty, manage, testId }) {
  return (
    <Card data-sw-review={testId}>
      <CardHeader icon={icon} title={`${title} (${rows.length})`} description={description} actions={manage} />
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.label}
                    scope="col"
                    className="border-b border-line px-4 py-2 text-left text-xs font-medium whitespace-nowrap text-muted first:sm:pl-5"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id || row.userId}
                  className="border-b border-line/60 last:border-0"
                  data-sw-review-row={row.name || row.displayName || row.id}
                >
                  {columns.map((column, index) =>
                    index ? (
                      <td key={column.label} className="max-w-[16rem] truncate px-4 py-2 text-fg">
                        {column.cell(row)}
                      </td>
                    ) : (
                      <th key={column.label} scope="row" className="max-w-[16rem] truncate px-4 py-2 text-left font-medium text-fg sm:pl-5">
                        {column.cell(row)}
                        {row.stale ? (
                          <Badge tone="warn" className="ml-2 align-middle" data-sw-stale>
                            Unused
                          </Badge>
                        ) : null}
                      </th>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-5 py-6 text-center text-xs text-muted">{empty}</p>
      )}
    </Card>
  )
}

function AccessReview() {
  const { workspaceId } = useWorkspace()
  const state = useWs(workspaceId, '/access-review', { keep: false })
  const exporter = useAction()
  const toast = useToast()
  if (state.isLoading) return <Loading label="Loading the access review" rows={5} />
  if (state.error) return <LoadError error={state.error} onRetry={state.refetch} />
  const data = state.data
  const maker = (row) => row.createdBy?.displayName || (row.createdBy ? 'Former member' : dash)
  const when = (value) => (value ? formatDate(value) : <span className="text-muted">Never</span>)
  const stale = [data.people, data.tokens, data.agents, data.shares].flat().filter((item) => item.stale).length
  const manage = (to, label) => (
    <Link to={`/w/${workspaceId}/${to}`} className={cn(linkClass, 'text-xs')}>
      {label}
    </Link>
  )
  return (
    <div className="space-y-4" data-sw-access-review>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">
          Every way into this workspace, with who made it and when it was last used.{' '}
          {stale ? (
            <span className="text-fg">
              {stale} {stale === 1 ? 'has' : 'have'} not been used for {data.staleDays} days.
            </span>
          ) : (
            `Nothing has gone unused for ${data.staleDays} days.`
          )}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="h-9 print:hidden"
          disabled={exporter.busy}
          onClick={() =>
            exporter.run(async () => {
              const file = await download('GET', wsUrl(workspaceId, '/access-review/export'), undefined, 'access-review.csv')
              toast(`Saved ${file.name}`)
            })
          }
          data-sw-review-export
        >
          {exporter.busy ? <Spinner /> : <Download size={14} aria-hidden="true" />} Export CSV
        </Button>
      </div>
      <ReviewTable
        testId="people"
        title="People"
        icon={UserRound}
        description="A person's role applies to every project."
        manage={manage('members', 'Manage members')}
        rows={data.people}
        columns={[
          {
            label: 'Person',
            cell: (row) => (
              <Link to={`/w/${workspaceId}/activity/${row.userId}`} className={linkClass}>
                {row.displayName}
              </Link>
            ),
          },
          { label: 'Role', cell: (row) => ROLE_LABEL[row.role] },
          { label: 'Reaches', cell: (row) => `${row.reaches} (${ACCESS_LABEL[row.access].toLowerCase()})` },
          { label: 'Joined', cell: (row) => when(row.joinedAt) },
          { label: 'Last active', cell: (row) => when(row.lastActiveAt) },
        ]}
      />
      <ReviewTable
        testId="agents"
        title="Agents"
        icon={Bot}
        description="Each agent serves one project, with its own token."
        manage={DEMO ? manage('tokens', 'Their tokens') : manage('agents', 'Manage agents')}
        rows={data.agents}
        empty="No agent is connected."
        columns={[
          {
            label: 'Agent',
            cell: (row) => (
              <Link to={`/w/${workspaceId}/activity/${row.id}`} className={linkClass}>
                {row.name}
              </Link>
            ),
          },
          { label: 'Project', cell: (row) => row.projectName },
          { label: 'Machine', cell: (row) => row.machine || dash },
          { label: 'Who may send it work', cell: (row) => row.audienceLabel || dash },
          { label: 'Approvals', cell: (row) => (row.approvalRule === 'auto' ? 'Without asking' : 'Always ask') },
          { label: 'Connected by', cell: maker },
          { label: 'Last seen', cell: (row) => when(row.lastSeenAt) },
        ]}
      />
      <ReviewTable
        testId="tokens"
        title="API tokens"
        icon={KeyRound}
        description="Each token reaches one project with the scopes listed. Agents' tokens are among them."
        manage={manage('tokens', 'Manage tokens')}
        rows={data.tokens}
        empty="No API token."
        columns={[
          { label: 'Token', cell: (row) => row.name },
          { label: 'Project', cell: (row) => row.projectName },
          { label: 'Scopes', cell: (row) => row.scopes.join(', ') },
          { label: 'Made by', cell: maker },
          { label: 'Made', cell: (row) => when(row.createdAt) },
          { label: 'Last used', cell: (row) => when(row.lastUsedAt) },
          { label: 'Expires', cell: (row) => (row.expiresAt ? formatDate(row.expiresAt) : <span className="text-muted">Never</span>) },
        ]}
      />
      <ReviewTable
        testId="shares"
        title="Share links"
        icon={Globe}
        description="Links that let people outside the workspace see, or comment on, one project."
        manage={manage('access', 'Manage share links')}
        rows={data.shares}
        empty="No share link is open."
        columns={[
          { label: 'Link', cell: (row) => row.name },
          { label: 'Project', cell: (row) => row.projectName },
          { label: 'Lets guests', cell: (row) => `${row.mode === 'comment' ? 'Comment' : 'View'}${row.passcode ? ' (passcode)' : ''}` },
          { label: 'Made by', cell: maker },
          { label: 'Opened', cell: (row) => `${row.opens} ${row.opens === 1 ? 'time' : 'times'}` },
          { label: 'Last used', cell: (row) => when(row.lastUsedAt) },
          { label: 'Expires', cell: (row) => formatDate(row.expiresAt) },
        ]}
      />
      {data.publicProjects.length ? (
        <ReviewTable
          testId="public"
          title="Public projects"
          icon={Globe}
          description="Anyone with the address can see these."
          rows={data.publicProjects}
          columns={[
            { label: 'Project', cell: (row) => row.name },
            { label: 'Public since', cell: (row) => when(row.publicAt) },
          ]}
        />
      ) : null}
      {data.invites.length ? (
        <ReviewTable
          testId="invites"
          title="Open invites"
          icon={UserRound}
          description="Links that let someone join until they expire."
          manage={manage('invites', 'Manage invites')}
          rows={data.invites}
          columns={[
            { label: 'For', cell: (row) => row.note || 'An invite link' },
            { label: 'Joins as', cell: (row) => ROLE_LABEL[row.role] },
            { label: 'Made by', cell: maker },
            { label: 'Expires', cell: (row) => formatDate(row.expiresAt) },
          ]}
        />
      ) : null}
    </div>
  )
}
