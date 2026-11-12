// Usage: what the workspace's agents did. Two views of one filter: an
// overview and Turns (every turn in a grid, with a drawer for one). The
// overview is a dashboard of widgets (tiles against the period before,
// usage over time, breakdowns, outcomes, approvals, turn duration, the top
// lists and budgets) that each person arranges for themselves: Dashboard.jsx
// draws it, layout-state.js saves it, src/hosted/usage-layout.js is its model.
//
// Owners and admins see the whole workspace; a member sees their own turns
// and the agents they connected. The server decides that for every request;
// this page only says which of the two it is showing.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, BarChart3, Download, GitCompareArrows, LayoutDashboard, Printer, Rows3, Rows4 } from 'lucide-react'
import { useQueries } from '@tanstack/react-query'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Spinner,
  ToggleGroup,
} from '../../components/ui'
import { DEMO } from '../../lib/demo'
import { cn } from '../../lib/utils'
import {
  DIMENSION_LABEL,
  KIND_LABEL,
  METRIC_LABEL,
  OUTCOME_GROUP_LABEL,
  USAGE_BUCKETS,
  USAGE_DIMENSIONS,
  USAGE_METRICS,
} from '../../../../src/hosted/usage-shape.js'
import { Card, LoadError, PageHeader } from '../components'
import { api, download, wsUrl } from '../lib/api'
import { Link } from '../lib/router'
import { useAction, useToast } from '../state'
import { useWorkspace } from '../pages/workspace'
import { BreakdownChart, OutcomesChart, TimeChart } from './charts'
import { Dashboard, EditLayoutButton } from './Dashboard'
import { setSearch, useUsageFilter, useWs, useWsPages } from './data'
import { FilterBar, ViewsMenu } from './filters'
import { bucketRange, change, defaultBucket, formatCost, formatCount, formatDuration, formatTime, shortDate } from './format'
import { ColumnChooser, DataGrid, readLayout, writeLayout } from './grid'
import { DemoNote, OutcomeChip, StatTile, Unreported, orUnreported } from './pieces'
import { useDashboardLayout } from './layout-state'
import { TurnDrawer } from './TurnDrawer'
import { Picker } from './widgets'

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
export function UsagePage() {
  const { workspaceId, data, isAdmin } = useWorkspace()
  const filter = useUsageFilter()
  const { get, set, query, period, search } = filter
  const tab = pick(get('tab'), ['overview', 'turns'], 'overview')
  const options = useWs(workspaceId, '/usage/options', { keep: false })
  const exporter = useAction()
  const toast = useToast()
  const own = options.data?.scope === 'own'
  // The dashboard's layout: this person's own, the workspace's, or the one a shared view carries (?view=).
  const board = useDashboardLayout(workspaceId, { viewId: get('view') || null })
  const [editing, setEditing] = useState(false)
  const arranging = editing && tab === 'overview' && !board.preview
  useEffect(() => {
    // A link to a view whose layout is gone: the filters still hold, the dashboard is the reader's own.
    if (board.previewMissing) {
      set({ view: null })
      toast('That view no longer carries a layout. This is your own.', 'bad')
    }
  }, [board.previewMissing, set, toast])
  const exportAs = (format) =>
    exporter.run(async () => {
      const file = await download('GET', wsUrl(workspaceId, `/usage/export?${query}&format=${format}`), undefined, `usage.${format}`)
      toast(`Saved ${file.name}`)
    })

  return (
    <div data-sw-usage={tab} data-sw-usage-report>
      <PageHeader
        title="Usage"
        description={
          own
            ? 'Your own agent turns, and every turn of an agent you connected. Numbers are what each agent reported.'
            : 'Every agent turn in this workspace: who asked, which agent, how it ended, and the numbers each agent reported.'
        }
        actions={
          <span className="flex flex-wrap items-center gap-2 print:hidden">
            {tab === 'overview' ? (
              <EditLayoutButton
                editing={arranging}
                onEditing={setEditing}
                disabled={!board.ready || Boolean(board.preview)}
                why={board.preview ? 'Choose "Use this layout" or "Back to my layout" first' : null}
              />
            ) : null}
            <Button size="touch" variant="secondary" className="lg:h-9" onClick={() => window.print()} data-sw-usage-print>
              <Printer size={15} aria-hidden="true" /> Print
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="touch" variant="secondary" className="lg:h-9" disabled={exporter.busy} data-sw-usage-export>
                  {exporter.busy ? <Spinner /> : <Download size={15} aria-hidden="true" />} Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => exportAs('csv')} data-sw-usage-export-csv>
                  The turns of this filter, as CSV
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportAs('json')} data-sw-usage-export-json>
                  The turns of this filter, as JSON
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        }
      />
      <DemoNote testId="usage">
        This is a demo with made-up numbers: about sixty days of a pretend team&apos;s agent turns. Ask the agent on the board, or run a
        fix, and your turn is added here. Exports are made in this browser; Reset puts everything back.
      </DemoNote>
      {DEMO && tab === 'overview' && !arranging && !board.preview ? (
        <p
          className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-accent/40 bg-accent/8 px-3 py-2 text-xs text-fg print:hidden"
          data-sw-demo-try="layout"
        >
          <LayoutDashboard size={14} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-[1_1_14rem]">
            <strong className="font-semibold">Try this:</strong> make the dashboard yours. Drag a chart to a new place, resize it from its
            corner, hide a tile, or put two charts side by side. Reset puts it back.
          </span>
          <Button size="xs" variant="soft" onClick={() => setEditing(true)} disabled={!board.ready} data-sw-demo-try-edit>
            Edit layout
          </Button>
        </p>
      ) : null}
      {exporter.error ? (
        <p className="mb-3 text-sm text-bad" role="alert">
          {exporter.error}
        </p>
      ) : null}
      {/* Only on paper: what the report covers. */}
      <p className="mb-3 hidden text-sm text-fg print:block">
        {data.workspace.name} · {period.label} ({shortDate(period.from)} to {shortDate(new Date(period.to.getTime() - 1))}) · printed{' '}
        {shortDate(new Date())}
        {filter.active.length ? ` · filtered by ${filter.active.join(', ')}` : ''}
      </p>
      <FilterBar filter={filter} options={options.data?.options}>
        <ViewsMenu
          workspaceId={workspaceId}
          page="usage"
          search={search}
          layout={tab === 'overview' ? board.layout : null}
          onOpen={(saved) => {
            setEditing(false)
            setSearch(new URLSearchParams(saved), { push: true })
          }}
        />
      </FilterBar>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <ToggleGroup
          label="View"
          value={tab}
          onChange={(next) => set({ tab: next === 'overview' ? null : next, row: null }, { push: true })}
          options={[
            { id: 'overview', label: 'Overview' },
            { id: 'turns', label: 'Turns' },
          ]}
        />
        {options.data ? (
          <p className="text-xs text-muted">
            Usage records are kept for {options.data.retentionDays} days.{' '}
            <Link to={`/w/${workspaceId}/activity`} className="font-medium text-accent underline-offset-2 hover:underline">
              {isAdmin ? 'People’s activity' : 'Your activity'}
            </Link>
          </p>
        ) : null}
      </div>
      {tab === 'turns' ? (
        <Turns filter={filter} />
      ) : board.error && !board.ready ? (
        <LoadError error={board.error} onRetry={board.refetch} />
      ) : board.ready ? (
        <Dashboard filter={filter} isAdmin={isAdmin} board={board} editing={arranging} onEditing={setEditing} />
      ) : (
        <p className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted" role="status" data-sw-layout-loading>
          <Spinner /> Loading the dashboard
        </p>
      )}
      {get('row') ? <TurnDrawer id={get('row')} onClose={() => set({ row: null })} /> : null}
    </div>
  )
}

// ---- A person's or an agent's page: a short, fixed overview ----

// Four tiles, usage over time, a breakdown and how turns ended, for the
// Activity pages of one person or one agent (`extraQuery` narrows every
// query to them). Not a dashboard: nothing here is arranged or saved, and
// its switches live in the address.
export function Overview({ filter, extraQuery = '' }) {
  const { workspaceId } = useWorkspace()
  const { get, set, list, period } = filter
  const query = `${filter.query}${extraQuery}`
  const metric = pick(get('metric'), USAGE_METRICS, 'calls')
  const by = pick(get('by'), [...USAGE_DIMENSIONS, 'none'], 'kind')
  const bucket = pick(get('bucket'), USAGE_BUCKETS, defaultBucket(period))
  const breakdownBy = pick(get('bd'), USAGE_DIMENSIONS, 'project')

  const summary = useWs(workspaceId, `/usage/summary?${query}`)
  const series = useWs(workspaceId, `/usage/series?${query}&bucket=${bucket}&groupBy=${by}&metric=${metric}`)
  const plain = useWs(workspaceId, `/usage/series?${query}&bucket=${bucket}&groupBy=none&metric=calls`)
  const breakdown = useWs(workspaceId, `/usage/breakdown?${query}&groupBy=${breakdownBy}`)

  // A press on a mark or a legend entry narrows the whole page to it (again: undoes it).
  const toggle = useCallback(
    (dimension) => (key) => {
      const value = key === '' ? '~' : key
      // From the address as it is when the press lands, not as it was drawn.
      set({ [dimension]: (current) => (current.length === 1 && current[0] === value ? [] : [value]) }, { push: true })
    },
    [set],
  )
  const useRange = (first, last) =>
    set({ range: 'custom', from: bucketRange(first, bucket).from, to: bucketRange(last, bucket).to }, { push: true })
  const now = summary.data?.current
  const before = summary.data?.previous
  const loading = summary.isLoading
  if (summary.error && !summary.data)
    return (
      <div data-sw-usage-error>
        <LoadError error={summary.error} onRetry={summary.refetch} />
      </div>
    )
  const compare = period.compare
  const reportedNote = (key) =>
    now && now.calls
      ? now.reported[key] === now.calls
        ? null
        : `${formatCount(now.reported[key])} of ${formatCount(now.calls)} turns reported`
      : null

  return (
    <div className="space-y-4" data-sw-usage-overview>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-sw-usage-tiles>
        <StatTile
          testId="calls"
          compare={compare}
          label="Turns"
          loading={loading}
          value={formatCount(now?.calls ?? 0)}
          current={now?.calls}
          previous={before?.calls}
          trend={plain.data ? plain.data.buckets.map((id) => plain.data.points.find((point) => point.bucket === id)?.calls ?? 0) : null}
        />
        <StatTile
          testId="tokens"
          compare={compare}
          label="Tokens"
          loading={loading}
          value={now?.tokens === null ? 'Not reported' : formatCount(now?.tokens)}
          current={now?.tokens}
          previous={before?.tokens}
          hint={now?.tokens === null ? null : (reportedNote('tokens') ?? `${formatCount(now?.input)} in · ${formatCount(now?.output)} out`)}
          note={now?.tokens === null ? 'No agent reported tokens' : undefined}
        />
        <StatTile
          testId="duration"
          compare={compare}
          label="Agent time"
          loading={loading}
          value={formatDuration(now?.duration)}
          current={now?.duration}
          previous={before?.duration}
          hint={now?.latency?.turns ? `Median ${formatDuration(now.latency.p50)} · 95th ${formatDuration(now.latency.p95)}` : null}
        />
        <StatTile
          testId="cost"
          compare={compare}
          label="Reported cost"
          loading={loading}
          value={now?.cost === null ? 'Not reported' : formatCost(now?.cost)}
          current={now?.cost}
          previous={before?.cost}
          hint={now?.cost === null ? null : reportedNote('cost')}
          note={now?.cost === null ? 'No agent reported a cost' : undefined}
        />
      </div>

      <TimeChart
        data={series.data}
        metric={metric}
        bucket={bucket}
        dimension={series.data?.groupBy ?? by}
        state={series}
        onPick={by === 'none' ? null : toggle(by)}
        pressed={by === 'none' ? [] : list(by).map((key) => (key === '~' ? '' : key))}
        onRange={useRange}
        controls={
          <>
            <Picker
              label="Measure"
              testId="metric"
              value={metric}
              onChange={(next) => set({ metric: next === 'calls' ? null : next })}
              options={USAGE_METRICS.map((id) => [id, METRIC_LABEL[id]])}
            />
            <Picker
              label="Split by"
              testId="by"
              value={by}
              onChange={(next) => set({ by: next })}
              options={[...USAGE_DIMENSIONS.map((id) => [id, `By ${DIMENSION_LABEL[id].toLowerCase()}`]), ['none', 'No split']]}
            />
            <ToggleGroup
              label="Bucket"
              value={bucket}
              onChange={(next) => set({ bucket: next })}
              options={USAGE_BUCKETS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }))}
            />
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <BreakdownChart
          groups={breakdown.data?.groups}
          metric={metric}
          dimension={breakdownBy}
          title={DIMENSION_LABEL[breakdownBy]}
          state={breakdown}
          onPick={toggle(breakdownBy)}
          pressed={list(breakdownBy).map((key) => (key === '~' ? '' : key))}
          controls={
            <Picker
              label="Break down by"
              testId="bd"
              value={breakdownBy}
              onChange={(next) => set({ bd: next })}
              options={USAGE_DIMENSIONS.map((id) => [id, `By ${DIMENSION_LABEL[id].toLowerCase()}`])}
            />
          }
        />
        <OutcomesChart data={plain.data} bucket={bucket} state={plain} onPick={toggle('outcome')} pressed={list('outcome')} />
      </div>
    </div>
  )
}

// ---- Turns: the grid ----

const dash = <span className="text-faint">{'–'}</span>
const USAGE_COLUMNS = [
  { id: 'started', header: 'When', width: 146, sort: 'started', always: true, cell: (row) => formatTime(row.startedAt) },
  { id: 'kind', header: 'Kind', width: 128, cell: (row) => KIND_LABEL[row.kind] || row.kind },
  {
    id: 'agent',
    header: 'Agent',
    width: 146,
    cell: (row) => (row.agent ? row.agent.name : dash),
  },
  { id: 'machine', header: 'Machine', width: 130, cell: (row) => row.agent?.machine || dash },
  { id: 'project', header: 'Project', width: 128, cell: (row) => row.project.name },
  { id: 'person', header: 'Asked by', width: 104, cell: (row) => row.person?.name || <span className="text-muted">Nobody</span> },
  { id: 'outcome', header: 'Outcome', width: 138, cell: (row) => <OutcomeChip outcome={row.outcome} /> },
  { id: 'model', header: 'Model', width: 140, cell: (row) => row.model || <Unreported what="Model" /> },
  { id: 'effort', header: 'Effort', width: 84, cell: (row) => row.effort || dash },
  {
    id: 'duration',
    header: 'Duration',
    width: 104,
    align: 'right',
    sort: 'duration',
    cell: (row) => (row.durationMs === null ? <span className="text-muted">Running</span> : formatDuration(row.durationMs)),
    subtotal: (group) => formatDuration(group.duration),
  },
  {
    id: 'tokens',
    header: 'Tokens',
    title: 'Tokens (input plus output)',
    width: 88,
    align: 'right',
    sort: 'tokens',
    cell: (row) => orUnreported(row.totalTokens, (value) => formatCount(value, { exact: true }), 'Tokens'),
    subtotal: (group) => (group.tokens === null ? <Unreported what="Tokens" /> : formatCount(group.tokens)),
  },
  {
    id: 'input',
    header: 'Input',
    title: 'Input tokens',
    width: 96,
    align: 'right',
    sort: 'input',
    cell: (row) => orUnreported(row.inputTokens, (value) => formatCount(value, { exact: true }), 'Input tokens'),
    subtotal: (group) => (group.input === null ? '' : formatCount(group.input)),
  },
  {
    id: 'output',
    header: 'Output',
    title: 'Output tokens',
    width: 96,
    align: 'right',
    sort: 'output',
    cell: (row) => orUnreported(row.outputTokens, (value) => formatCount(value, { exact: true }), 'Output tokens'),
    subtotal: (group) => (group.output === null ? '' : formatCount(group.output)),
  },
  {
    id: 'cached',
    header: 'Cached',
    title: 'Cached tokens',
    width: 96,
    align: 'right',
    sort: 'cached',
    cell: (row) => orUnreported(row.cachedTokens, (value) => formatCount(value, { exact: true }), 'Cached tokens'),
    subtotal: (group) => (group.cached === null ? '' : formatCount(group.cached)),
  },
  {
    id: 'cost',
    header: 'Cost',
    title: 'Reported cost',
    width: 92,
    align: 'right',
    sort: 'cost',
    cell: (row) => orUnreported(row.costMicros, formatCost, 'Cost'),
    subtotal: (group) => (group.cost === null ? <Unreported what="Cost" /> : formatCost(group.cost)),
  },
  {
    id: 'steps',
    header: 'Steps',
    title: 'Steps (tool calls)',
    width: 84,
    align: 'right',
    sort: 'steps',
    cell: (row) => (row.steps === null ? dash : formatCount(row.steps)),
    subtotal: (group) => (group.steps === null ? '' : formatCount(group.steps)),
  },
  {
    id: 'approvals',
    header: 'Approvals',
    width: 150,
    cell: (row) =>
      row.approvals.asked ? (
        <span>
          {row.approvals.allowed} allowed{row.approvals.denied ? `, ${row.approvals.denied} denied` : ''}
        </span>
      ) : (
        dash
      ),
  },
  {
    id: 'where',
    header: 'Where',
    width: 150,
    cell: (row) => (row.commentNumber ? `${row.boardId} #${row.commentNumber}` : row.boardId || dash),
  },
  { id: 'id', header: 'Turn id', width: 232, cell: (row) => <code className="font-mono text-[11px] text-muted">{row.id}</code> },
]
// Two more columns for grouped rows, when "Compare" is on: the group's turns in the period before, and the change.
const COMPARE_IDS = ['before', 'change']
const COMPARED_COLUMNS = [
  ...USAGE_COLUMNS,
  {
    id: 'before',
    header: 'Before',
    title: 'Turns in the period before',
    width: 116,
    align: 'right',
    cell: () => '',
    subtotal: (group) => (group.before ? formatCount(group.before.calls) : ''),
  },
  {
    id: 'change',
    header: 'Change',
    title: 'Change in turns against the period before',
    width: 96,
    align: 'right',
    cell: () => '',
    subtotal: (group) => {
      if (!group.before) return ''
      const delta = change(group.calls, group.before.calls)
      return delta ? delta.text : group.before.calls ? '' : 'New'
    },
  },
]
// They sit right after the columns the group row labels (before the first subtotal), whatever else is shown.
const withCompare = (layout, comparing) => {
  if (!comparing) return layout
  const order = layout.order.filter((id) => !COMPARE_IDS.includes(id))
  const hidden = layout.hidden.filter((id) => !COMPARE_IDS.includes(id))
  const first = order.findIndex(
    (id, index) => index > 0 && !hidden.includes(id) && USAGE_COLUMNS.find((column) => column.id === id)?.subtotal,
  )
  order.splice(first < 0 ? order.length - hidden.length : first, 0, ...COMPARE_IDS)
  return { ...layout, order, hidden }
}
const USAGE_DEFAULTS = {
  shown: ['started', 'kind', 'agent', 'project', 'person', 'outcome', 'duration', 'tokens', 'cost'],
  pinned: ['started'],
}
const GROUP_PAGE = 100

function TurnCard({ row }) {
  return (
    <span className="block" data-sw-turn-card>
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-fg">
          {KIND_LABEL[row.kind] || row.kind} · {row.agent?.name || 'No agent'}
        </span>
        <span className="tabular shrink-0 text-xs text-muted">{row.durationMs === null ? 'Running' : formatDuration(row.durationMs)}</span>
      </span>
      <span className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">
          {row.project.name} · {row.person?.name || 'Nobody'}
        </span>
        <span className="tabular shrink-0">
          {row.durationMs === null ? '' : row.totalTokens === null ? 'Tokens not reported' : `${formatCount(row.totalTokens)} tokens`}
        </span>
      </span>
      <span className="mt-1 flex items-center justify-between gap-2 text-xs text-fg">
        <OutcomeChip outcome={row.outcome} />
        <span className="shrink-0 text-muted">{formatTime(row.startedAt)}</span>
      </span>
    </span>
  )
}

function Turns({ filter }) {
  const { workspaceId } = useWorkspace()
  const { get, set, query } = filter
  const sort = {
    id: pick(get('sort'), ['started', 'duration', 'tokens', 'input', 'output', 'cached', 'cost', 'steps'], 'started'),
    dir: pick(get('dir'), ['asc', 'desc'], 'desc'),
  }
  const groupBy = pick(get('group'), USAGE_DIMENSIONS, '')
  const dense = get('dense') === '1'
  // Grouped rows can show each group's turns in the period before, and the change.
  const comparing = Boolean(groupBy) && get('cmp') === '1'
  const columns = comparing ? COMPARED_COLUMNS : USAGE_COLUMNS
  const layout = useMemo(
    () =>
      withCompare(
        readLayout(columns, {
          cols: get('cols') || null,
          pin: filter.params.has('pin') ? (get('pin') === 'none' ? '' : get('pin')) : null,
          widths: get('w') || null,
          defaults: USAGE_DEFAULTS,
        }),
        comparing,
      ),
    [get, filter.params, columns, comparing],
  )
  // The comparison columns come and go with their switch: they are not part of the saved column choice.
  const setLayout = (next) =>
    set(
      writeLayout(
        {
          ...next,
          order: next.order.filter((id) => !COMPARE_IDS.includes(id)),
          hidden: next.hidden.filter((id) => !COMPARE_IDS.includes(id)),
        },
        USAGE_DEFAULTS,
      ),
    )
  const sortQuery = `&sort=${sort.id}&dir=${sort.dir}`

  // Not grouped: pages by cursor as the grid scrolls.
  const pages = useWsPages(
    workspaceId,
    (cursor) => `/usage/rows?${query}${sortQuery}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    {
      next: (page) => page.next,
      enabled: !groupBy,
    },
  )
  // Grouped: the groups with their subtotals, and the rows of the open ones.
  const groups = useWs(workspaceId, `/usage/breakdown?${query}&groupBy=${groupBy || 'agent'}`, { enabled: Boolean(groupBy) })
  const before = useWs(workspaceId, `/usage/breakdown?${query}&groupBy=${groupBy || 'agent'}&previous=1`, { enabled: comparing })
  const [open, setOpen] = useState({})
  const openKeys = groupBy ? Object.keys(open).filter((key) => open[key] && key.startsWith(`${groupBy}:`)) : []
  const groupQueries = useQueries({
    queries: openKeys.map((id) => {
      const key = id.slice(groupBy.length + 1)
      const params = new URLSearchParams(query)
      params.set(groupBy, key === '' ? '~' : key)
      const url = wsUrl(workspaceId, `/usage/rows?${params}${sortQuery}&limit=${open[id]}`)
      return { queryKey: [url], queryFn: () => api.get(url), placeholderData: (previous) => previous }
    }),
  })

  const total = groupBy ? (groups.data?.groups || []).reduce((sum, group) => sum + group.calls, 0) : (pages.data?.pages[0]?.total ?? null)
  // What the open groups have loaded so far, as one value to depend on.
  const groupStamp = groupQueries.map((item) => `${item.dataUpdatedAt}:${item.isFetching}`).join(',')
  const items = useMemo(() => {
    if (!groupBy) return (pages.data?.pages || []).flatMap((page) => page.rows).map((row) => ({ type: 'row', row }))
    const out = []
    for (const group of groups.data?.groups || []) {
      const id = `${groupBy}:${group.key}`
      const limit = open[id]
      const label =
        groupBy === 'outcome'
          ? OUTCOME_GROUP_LABEL[group.key] || group.label
          : groupBy === 'kind'
            ? KIND_LABEL[group.key] || group.label
            : group.label
      // What the same group did in the period to compare with (nothing: it was not there).
      const earlier = comparing && before.data ? before.data.groups.find((item) => item.key === group.key) || { calls: 0 } : null
      out.push({
        type: 'group',
        group: { ...group, label, before: earlier },
        open: Boolean(limit),
        summary: `${formatCount(group.calls)} ${group.calls === 1 ? 'turn' : 'turns'}`,
      })
      if (!limit) continue
      const result = groupQueries[openKeys.indexOf(id)]
      for (const row of result?.data?.rows || []) out.push({ type: 'row', row, depth: 1 })
      if (!result?.data || result.data.next)
        out.push({
          type: 'more',
          group: { ...group, label },
          busy: !result?.data || result.isFetching,
          load:
            limit >= 500
              ? () => set({ group: null, [groupBy]: [group.key === '' ? '~' : group.key] }, { push: true })
              : () => setOpen((current) => ({ ...current, [id]: Math.min(500, limit + 200) })),
        })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBy, pages.data, groups.data, open, groupStamp, comparing, before.data])
  const toggleGroup = (key) => setOpen((current) => ({ ...current, [`${groupBy}:${key}`]: current[`${groupBy}:${key}`] ? 0 : GROUP_PAGE }))
  const state = groupBy ? groups : pages
  const loaded = items.filter((item) => item.type === 'row').length

  return (
    <Card data-sw-usage-turns>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <p className="mr-auto text-sm text-fg" role="status" data-sw-turn-count={total ?? ''}>
          {total === null ? 'Loading turns' : `${formatCount(total, { exact: true })} ${total === 1 ? 'turn' : 'turns'}`}
          {total !== null && !groupBy && loaded < total ? (
            <span className="text-muted"> · {formatCount(loaded, { exact: true })} loaded</span>
          ) : null}
        </p>
        <Picker
          label="Group the turns"
          testId="group"
          value={groupBy || 'none'}
          onChange={(next) => set({ group: next === 'none' ? null : next }, { push: true })}
          options={[['none', 'Not grouped'], ...USAGE_DIMENSIONS.map((id) => [id, `Group by ${DIMENSION_LABEL[id].toLowerCase()}`])]}
        />
        {groupBy ? (
          <button
            type="button"
            aria-pressed={comparing}
            onClick={() => set({ cmp: comparing ? null : '1' })}
            title={`Show each group's turns in ${filter.period.compare}, and the change`}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-accent',
              comparing ? 'border-accent/50 bg-accent/10 text-fg' : 'border-line bg-surface text-fg hover:bg-surface-2',
            )}
            data-sw-grid-compare={comparing ? 'on' : 'off'}
          >
            <GitCompareArrows size={14} className="text-muted" aria-hidden="true" /> Compare
          </button>
        ) : null}
        <span className="hidden items-center gap-2 sm:flex">
          <IconButton
            label={dense ? 'Roomier rows' : 'Denser rows'}
            variant="secondary"
            size="icon-sm"
            className="h-9 w-9"
            onClick={() => set({ dense: dense ? null : '1' })}
            data-sw-grid-density={dense ? 'dense' : 'roomy'}
          >
            {dense ? <Rows3 size={15} aria-hidden="true" /> : <Rows4 size={15} aria-hidden="true" />}
          </IconButton>
          <ColumnChooser
            columns={USAGE_COLUMNS}
            layout={{ ...layout, order: layout.order.filter((id) => !COMPARE_IDS.includes(id)) }}
            onLayout={setLayout}
            onReset={() => set({ cols: null, pin: null, w: null })}
          />
        </span>
      </div>
      {state.error && !state.data ? (
        <div className="p-4">
          <LoadError error={state.error} onRetry={state.refetch} />
        </div>
      ) : state.isLoading ? (
        <p className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted" role="status">
          <Spinner /> Loading turns
        </p>
      ) : !items.length ? (
        <EmptyState icon={BarChart3} title="No turns match" data-sw-turns-empty>
          Clear a filter or choose a longer period.
        </EmptyState>
      ) : (
        <DataGrid
          label="Agent turns"
          columns={columns}
          items={items}
          rowKey={(row) => row.id}
          layout={layout}
          onLayout={setLayout}
          sort={sort}
          onSort={(next) =>
            set({ sort: next.id === 'started' ? null : next.id, dir: next.dir === 'desc' ? null : next.dir }, { push: true })
          }
          dense={dense}
          onOpen={(row) => set({ row: row.id })}
          openId={get('row') || null}
          onToggleGroup={toggleGroup}
          hasMore={!groupBy && Boolean(pages.hasNextPage)}
          loadingMore={pages.isFetchingNextPage}
          onMore={() => pages.fetchNextPage()}
          busy={state.isPlaceholderData && state.isFetching}
          card={(row) => <TurnCard row={row} />}
          footer={
            <p className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-caption text-muted">
              <span>{pages.isFetchingNextPage ? 'Loading more turns' : 'Arrow keys move through the rows; Enter opens one.'}</span>
              <Link
                to={`/w/${workspaceId}/usage?${new URLSearchParams([...filter.params].filter(([key]) => !['tab', 'row'].includes(key)))}`}
                className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline"
              >
                Charts for this filter <ArrowUpRight size={12} aria-hidden="true" />
              </Link>
            </p>
          }
        />
      )}
    </Card>
  )
}
