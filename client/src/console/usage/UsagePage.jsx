// Usage: what the workspace's agents did. Two views of one filter: an
// overview (tiles against the period before, usage over time, breakdowns,
// outcomes, approvals, turn duration, the top lists and budgets) and Turns
// (every turn in a grid, with a drawer for one).
//
// Owners and admins see the whole workspace; a member sees their own turns
// and the agents they connected. The server decides that for every request;
// this page only says which of the two it is showing.

import { useCallback, useMemo, useState } from 'react'
import { ArrowUpRight, BarChart3, Download, Gauge, Printer, Rows3, Rows4 } from 'lucide-react'
import { useQueries } from '@tanstack/react-query'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  ToggleGroup,
} from '../../components/ui'
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
import { Card, CardHeader, LoadError, PageHeader } from '../components'
import { api, download, wsUrl } from '../lib/api'
import { Link } from '../lib/router'
import { useAction, useToast } from '../state'
import { useWorkspace } from '../pages/workspace'
import { ApprovalsChart, BreakdownChart, LatencyChart, OutcomesChart, TimeChart } from './charts'
import { setSearch, useUsageFilter, useWs, useWsPages } from './data'
import { FilterBar, ViewsMenu } from './filters'
import { bucketRange, defaultBucket, formatCost, formatCount, formatDuration, formatTime, percent, shortDate } from './format'
import { ColumnChooser, DataGrid, readLayout, writeLayout } from './grid'
import { OutcomeChip, StatTile, Unreported, orUnreported } from './pieces'
import { TurnDrawer } from './TurnDrawer'

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
const SMALL_SELECT = 'h-8 w-auto min-w-0 gap-1 px-2 text-xs'

function Picker({ label, value, onChange, options, testId }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={SMALL_SELECT} aria-label={label} data-sw-pick={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([id, text]) => (
          <SelectItem key={id} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function UsagePage() {
  const { workspaceId, data, isAdmin } = useWorkspace()
  const filter = useUsageFilter()
  const { get, set, query, period, search } = filter
  const tab = pick(get('tab'), ['overview', 'turns'], 'overview')
  const options = useWs(workspaceId, '/usage/options', { keep: false })
  const exporter = useAction()
  const toast = useToast()
  const own = options.data?.scope === 'own'
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
          onOpen={(saved) => setSearch(new URLSearchParams(saved), { push: true })}
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
      {tab === 'turns' ? <Turns filter={filter} /> : <Overview filter={filter} isAdmin={isAdmin} />}
      {get('row') ? <TurnDrawer id={get('row')} onClose={() => set({ row: null })} /> : null}
    </div>
  )
}

// ---- Overview ----

export function Overview({ filter, isAdmin, compact = false, extraQuery = '' }) {
  const { workspaceId } = useWorkspace()
  const { get, set, list, period } = filter
  const query = `${filter.query}${extraQuery}`
  const metric = pick(get('metric'), USAGE_METRICS, 'calls')
  const by = pick(get('by'), [...USAGE_DIMENSIONS, 'none'], compact ? 'kind' : 'agent')
  const bucket = pick(get('bucket'), USAGE_BUCKETS, defaultBucket(period))
  const breakdownBy = pick(get('bd'), USAGE_DIMENSIONS, compact ? 'project' : 'project')

  const summary = useWs(workspaceId, `/usage/summary?${query}`)
  const series = useWs(workspaceId, `/usage/series?${query}&bucket=${bucket}&groupBy=${by}&metric=${metric}`)
  const plain = useWs(workspaceId, `/usage/series?${query}&bucket=${bucket}&groupBy=none&metric=calls`)
  const breakdown = useWs(workspaceId, `/usage/breakdown?${query}&groupBy=${breakdownBy}`)
  const latency = useWs(workspaceId, `/usage/latency?${query}&bucket=${bucket}`)
  const top = useWs(workspaceId, `/usage/top?${query}`, { enabled: !compact })
  const budgets = useWs(workspaceId, '/usage/budgets', { enabled: isAdmin && !compact, keep: false })

  // A press on a mark or a legend entry narrows the whole page to it (again: undoes it).
  const toggle = useCallback(
    (dimension) => (key) => {
      const value = key === '' ? '~' : key
      const current = list(dimension)
      set({ [dimension]: current.length === 1 && current[0] === value ? [] : [value] }, { push: true })
    },
    [list, set],
  )
  const useRange = (first, last) =>
    set({ range: 'custom', from: bucketRange(first, bucket).from, to: bucketRange(last, bucket).to }, { push: true })
  const now = summary.data?.current
  const before = summary.data?.previous
  const trendOf = (key) => {
    if (!plain.data) return null
    const found = new Map(plain.data.points.map((point) => [point.bucket, point]))
    return plain.data.buckets.map((id) =>
      found.get(id) ? (key === 'calls' ? found.get(id).calls : found.get(id)[key]) : key === 'calls' ? 0 : null,
    )
  }
  const loading = summary.isLoading
  if (summary.error && !summary.data)
    return (
      <div data-sw-usage-error>
        <LoadError error={summary.error} onRetry={summary.refetch} />
      </div>
    )
  // Nothing at all in the period: one clear empty state, not six empty charts.
  if (now && now.calls === 0 && !compact)
    return (
      <Card data-sw-usage-empty>
        <EmptyState icon={BarChart3} size="lg" title="No agent turns in this period">
          {filter.active.length
            ? 'Nothing matches these filters. Clear one, or choose a longer period.'
            : 'When someone chats with a connected agent, or an agent takes a comment, each turn shows up here: who asked, how it ended, and what the agent reported.'}
        </EmptyState>
      </Card>
    )
  const reportedNote = (key) =>
    now && now.calls
      ? now.reported[key] === now.calls
        ? null
        : `${formatCount(now.reported[key])} of ${formatCount(now.calls)} turns reported`
      : null

  return (
    <div className="space-y-4" data-sw-usage-overview>
      <div
        className={cn('grid gap-3', compact ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 lg:grid-cols-3 min-[1760px]:grid-cols-6')}
        data-sw-usage-tiles
      >
        <StatTile
          testId="calls"
          label="Turns"
          loading={loading}
          value={formatCount(now?.calls ?? 0)}
          current={now?.calls}
          previous={before?.calls}
          trend={trendOf('calls')}
        />
        <StatTile
          testId="tokens"
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
          label="Agent time"
          loading={loading}
          value={formatDuration(now?.duration)}
          current={now?.duration}
          previous={before?.duration}
          hint={now?.latency?.turns ? `Median ${formatDuration(now.latency.p50)} · 95th ${formatDuration(now.latency.p95)}` : null}
        />
        <StatTile
          testId="cost"
          label="Reported cost"
          loading={loading}
          value={now?.cost === null ? 'Not reported' : formatCost(now?.cost)}
          current={now?.cost}
          previous={before?.cost}
          hint={now?.cost === null ? null : reportedNote('cost')}
          note={now?.cost === null ? 'No agent reported a cost' : undefined}
        />
        {compact ? null : (
          <>
            <StatTile
              testId="fixes"
              label="Fixes ready"
              loading={loading}
              value={now?.fixes ? `${formatCount(now.fixesDone)} of ${formatCount(now.fixes)}` : '0'}
              current={now?.fixes ? now.fixesDone / now.fixes : null}
              previous={before?.fixes ? before.fixesDone / before.fixes : null}
              better="up"
              hint={now?.fixes ? `${percent(now.fixesDone, now.fixes)} ended with a fix or an answer` : 'No fix was asked for'}
            />
            <StatTile
              testId="failed"
              label="Failed or stopped"
              loading={loading}
              value={now ? percent(now.outcomes.failed + now.outcomes.stopped, now.calls) : ''}
              current={now?.calls ? (now.outcomes.failed + now.outcomes.stopped) / now.calls : null}
              previous={before?.calls ? (before.outcomes.failed + before.outcomes.stopped) / before.calls : null}
              better="down"
              hint={now ? `${formatCount(now.outcomes.failed)} failed · ${formatCount(now.outcomes.stopped)} stopped` : null}
            />
          </>
        )}
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
        {compact ? null : (
          <>
            <ApprovalsChart data={plain.data} bucket={bucket} state={plain} />
            <LatencyChart data={latency.data} bucket={bucket} state={latency} />
          </>
        )}
      </div>

      {compact ? null : <TopLists top={top} workspaceId={workspaceId} filter={filter} isAdmin={isAdmin} />}
      {isAdmin && !compact ? <Budgets state={budgets} workspaceId={workspaceId} /> : null}
    </div>
  )
}

function TopLists({ top, workspaceId, filter, isAdmin }) {
  const data = top.data
  const open = (changes) => filter.set({ tab: 'turns', ...changes }, { push: true })
  const lists = [
    {
      id: 'agents',
      title: 'Busiest agents',
      empty: 'No agent took a turn.',
      rows: (data?.agents || []).map((item) => ({
        key: item.key,
        label: item.label,
        hint: item.machine,
        value: `${formatCount(item.calls)} turns`,
        to: isAdmin && item.key ? `/w/${workspaceId}/activity/${item.key}` : null,
        onClick: () => open({ agent: [item.key || '~'] }),
      })),
    },
    {
      id: 'threads',
      title: 'Threads that used the most tokens',
      empty: 'No agent reported tokens.',
      rows: (data?.threads || []).map((item, index) => ({
        key: index,
        label:
          item.thread.kind === 'comment'
            ? `Comment #${item.commentNumber}`
            : item.thread.kind === 'chat'
              ? 'A private chat'
              : 'The board’s chat',
        hint: `${item.project.name} · ${item.boardId}`,
        value: `${formatCount(item.tokens)} tokens`,
        onClick: item.thread.id ? () => open({ q: item.thread.id, project: [item.project.id] }) : null,
      })),
    },
    {
      id: 'slowest',
      title: 'Slowest turns',
      empty: 'No turn has finished.',
      rows: (data?.slowest || []).map((item) => ({
        key: item.id,
        label: `${KIND_LABEL[item.kind] || item.kind} by ${item.agent?.name || 'no agent'}`,
        hint: `${item.project.name} · ${formatTime(item.startedAt)}`,
        value: formatDuration(item.durationMs),
        onClick: () => filter.set({ row: item.id }),
      })),
    },
    {
      id: 'denied',
      title: 'Most denied approvals',
      empty: 'No approval was denied.',
      rows: (data?.denied || []).map((item) => ({
        key: item.key,
        label: item.label,
        hint: `${formatCount(item.asked)} asked`,
        value: `${formatCount(item.denied)} denied`,
        onClick: () => open({ agent: [item.key || '~'], kind: ['fix', 'push'] }),
      })),
    },
  ]
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" data-sw-usage-top>
      {lists.map((item) => (
        <Card key={item.id} className="min-w-0" data-sw-top={item.id}>
          <h2 className="border-b border-line px-4 py-2.5 text-ui font-semibold text-fg">{item.title}</h2>
          {top.isLoading ? (
            <p className="px-4 py-6 text-center text-xs text-muted" role="status">
              Loading
            </p>
          ) : item.rows.length ? (
            <ol className="py-1">
              {item.rows.map((row, index) => (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={row.onClick || undefined}
                    disabled={!row.onClick}
                    className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left outline-none enabled:hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="tabular w-3 shrink-0 text-xs text-faint">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-fg">{row.label}</span>
                      {row.hint ? <span className="block truncate text-caption text-muted">{row.hint}</span> : null}
                    </span>
                    <span className="tabular shrink-0 text-xs text-fg">{row.value}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-4 py-6 text-center text-xs text-muted">{item.empty}</p>
          )}
        </Card>
      ))}
    </div>
  )
}

// Each project's daily budgets from its agent policy, with today's use.
function Budgets({ state, workspaceId }) {
  const projects = state.data?.projects || []
  if (state.isLoading || !projects.length) return null
  return (
    <Card data-sw-usage-budgets>
      <CardHeader
        icon={Gauge}
        title="Budgets today"
        description="Each project's agent policy caps chat turns and fixes per day (the day is UTC). A forecast shows once enough of the day has passed."
      />
      <ul className="divide-y divide-line">
        {projects.map(({ project, budgets }) => (
          <li
            key={project.id}
            className="grid gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,12rem)_repeat(2,minmax(0,1fr))] sm:px-5"
            data-sw-budget={project.name}
          >
            <Link
              to={`/w/${workspaceId}/projects/${project.id}`}
              className="truncate text-sm font-medium text-fg underline-offset-2 hover:underline"
            >
              {project.name}
            </Link>
            {budgets.map((budget) => {
              const share = budget.limit ? Math.min(1, budget.used / budget.limit) : 0
              const over = budget.limit > 0 && budget.used >= budget.limit
              const near = !over && share >= 0.8
              const willPass = budget.forecast !== null && budget.limit > 0 && budget.forecast > budget.limit && !over
              return (
                <div key={budget.id} className="min-w-0">
                  <p className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate text-muted">{budget.label}</span>
                    <span className="tabular shrink-0 font-medium text-fg">
                      {formatCount(budget.used, { exact: true })} of{' '}
                      {budget.limit ? formatCount(budget.limit, { exact: true }) : 'none allowed'}
                    </span>
                  </p>
                  <div
                    className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2"
                    role="meter"
                    aria-label={`${budget.label} for ${project.name}`}
                    aria-valuemin={0}
                    aria-valuemax={budget.limit || 0}
                    aria-valuenow={budget.used}
                  >
                    <div
                      className={cn('h-full rounded-full', over ? 'bg-bad' : near ? 'bg-warn' : 'bg-accent')}
                      style={{ width: `${share * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 truncate text-caption text-muted">
                    {over ? 'Used up for today. ' : near ? 'Nearly used up. ' : ''}
                    {budget.forecast !== null
                      ? `On course for ${formatCount(budget.forecast)} by the end of the day${willPass ? ', over the budget' : ''}. `
                      : ''}
                    Daily average last week: {budget.average}.
                  </p>
                </div>
              )
            })}
          </li>
        ))}
      </ul>
    </Card>
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
    subtotal: (group) => (group.tokens === null ? 'Not reported' : formatCount(group.tokens)),
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
    subtotal: (group) => (group.cost === null ? 'Not reported' : formatCost(group.cost)),
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
  const layout = useMemo(
    () =>
      readLayout(USAGE_COLUMNS, {
        cols: get('cols') || null,
        pin: filter.params.has('pin') ? (get('pin') === 'none' ? '' : get('pin')) : null,
        defaults: USAGE_DEFAULTS,
      }),
    [get, filter.params],
  )
  const setLayout = (next) => set(writeLayout(next, USAGE_DEFAULTS))
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
      out.push({
        type: 'group',
        group: { ...group, label },
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
  }, [groupBy, pages.data, groups.data, open, groupStamp])
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
          <ColumnChooser columns={USAGE_COLUMNS} layout={layout} onLayout={setLayout} onReset={() => set({ cols: null, pin: null })} />
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
          columns={USAGE_COLUMNS}
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
