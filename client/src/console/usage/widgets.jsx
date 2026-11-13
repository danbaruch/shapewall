// The widgets of the Usage dashboard: what each type draws, and the options
// each one takes. A widget is one item of the layout (usage-layout.js): it
// fetches what it shows itself (two widgets asking for the same thing share
// one request), fills the place the grid gives it, and keeps its options
// with its own item, so two copies of a chart can show different things.
//
// The switches in a chart's header and the options behind its "..." button
// write the same saved options.

import { Gauge, MoreHorizontal } from 'lucide-react'
import {
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
} from '../../components/ui'
import { cn } from '../../lib/utils'
import {
  DIMENSION_LABEL,
  KIND_LABEL,
  METRIC_LABEL,
  USAGE_BUCKETS,
  USAGE_DIMENSIONS,
  USAGE_METRICS,
} from '../../../../src/hosted/usage-shape.js'
import { WIDGETS } from '../../../../src/hosted/usage-layout.js'
import { Card, Switch } from '../components'
import { Link } from '../lib/router'
import { ApprovalsChart, BreakdownChart, LatencyChart, OutcomesChart, TimeChart } from './charts'
import { useWs } from './data'
import { bucketRange, formatCost, formatCount, formatDuration, formatTime, percent } from './format'
import { StatTile } from './pieces'

const SMALL_SELECT = 'h-8 w-auto min-w-0 gap-1 px-2 text-xs'

export function Picker({ label, value, onChange, options, testId, className }) {
  return (
    <Select value={String(value)} onValueChange={onChange}>
      <SelectTrigger className={cn(SMALL_SELECT, className)} aria-label={label} data-sw-pick={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([id, text]) => (
          <SelectItem key={id} value={String(id)}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---- Options ----

const byDimension = (id) => [id, `By ${DIMENSION_LABEL[id].toLowerCase()}`]
const VIEW_CHOICE = {
  key: 'view',
  label: 'Show as',
  choices: [
    ['chart', 'Chart'],
    ['table', 'Table'],
  ],
}
const TILE_OPTIONS = [
  { key: 'spark', label: 'Trend line' },
  { key: 'compare', label: 'Change against the period before' },
]
const LIST_OPTIONS = [{ key: 'rows', label: 'Rows', choices: [3, 5, 10].map((count) => [count, `Top ${count}`]), number: true }]
// What the options of each widget type are called, in the order shown.
// A row with `choices` is one of a few; with `set`, any of a few; else on or off.
const OPTION_UI = {
  time: [
    { key: 'metric', label: 'Measure', choices: USAGE_METRICS.map((id) => [id, METRIC_LABEL[id]]) },
    { key: 'by', label: 'Split by', choices: [...USAGE_DIMENSIONS.map(byDimension), ['none', 'No split']] },
    {
      key: 'bucket',
      label: 'Bucket',
      choices: [['auto', 'Automatic'], ...USAGE_BUCKETS.map((id) => [id, id[0].toUpperCase() + id.slice(1)])],
    },
    {
      key: 'style',
      label: 'Draw as',
      choices: [
        ['stacked', 'Stacked bars'],
        ['grouped', 'Grouped bars'],
        ['lines', 'Lines'],
      ],
    },
    { key: 'legend', label: 'Legend' },
    { key: 'brush', label: 'Zoom brush' },
    VIEW_CHOICE,
  ],
  breakdown: [
    { key: 'by', label: 'Break down by', choices: USAGE_DIMENSIONS.map(byDimension) },
    {
      key: 'metric',
      label: 'Measure',
      choices: [['chart', 'Same as the chart over time'], ...USAGE_METRICS.map((id) => [id, METRIC_LABEL[id]])],
    },
    { key: 'rows', label: 'Rows', choices: [5, 8, 12, 20].map((count) => [count, `Top ${count}`]), number: true },
    { key: 'share', label: 'Share of the total' },
    VIEW_CHOICE,
  ],
  outcomes: [
    {
      key: 'mode',
      label: 'Measure',
      choices: [
        ['share', 'Share of turns'],
        ['counts', 'Number of turns'],
      ],
    },
    VIEW_CHOICE,
  ],
  approvals: [
    {
      key: 'mode',
      label: 'Bars',
      choices: [
        ['stacked', 'Stacked'],
        ['separate', 'Side by side'],
      ],
    },
    VIEW_CHOICE,
  ],
  latency: [
    {
      key: 'percentiles',
      label: 'Lines',
      set: [
        ['p50', 'Median'],
        ['p90', '90th'],
        ['p95', '95th'],
        ['p99', '99th'],
      ],
    },
    { key: 'log', label: 'Logarithmic scale' },
    VIEW_CHOICE,
  ],
  top_agents: LIST_OPTIONS,
  top_threads: LIST_OPTIONS,
  top_slowest: LIST_OPTIONS,
  top_denied: LIST_OPTIONS,
}
export const optionRows = (type) =>
  (OPTION_UI[type] || (WIDGETS[type].group === 'tile' ? TILE_OPTIONS : [])).filter((row) => Object.hasOwn(WIDGETS[type].options, row.key))

// A widget's options: a small panel behind one button. A change is saved at
// once; the panel stays open, so several can be set in a row.
export function WidgetOptions({ item, options, onChange, title, className }) {
  const rows = optionRows(item.type)
  if (!rows.length) return null
  return (
    <Popover history={false}>
      <PopoverTrigger asChild>
        <IconButton
          label={`Options for ${title}`}
          size="icon-xs"
          className={cn('print:hidden', className)}
          data-sw-widget-options={item.id}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3" data-sw-widget-options-panel={item.id}>
        <p className="mb-2 text-xs font-semibold text-fg">{title}</p>
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.key} className="flex min-h-8 items-center justify-between gap-3" data-sw-widget-option={row.key}>
              <span className="text-xs text-muted" id={`option-${item.id}-${row.key}`}>
                {row.label}
              </span>
              {row.choices ? (
                row.choices.length <= 2 ? (
                  <ToggleGroup
                    label={row.label}
                    value={String(options[row.key])}
                    onChange={(next) => onChange({ [row.key]: next })}
                    options={row.choices.map(([id, label]) => ({ id: String(id), label }))}
                  />
                ) : (
                  <Picker
                    label={row.label}
                    testId={`option-${row.key}`}
                    value={options[row.key]}
                    onChange={(next) => onChange({ [row.key]: row.number ? Number(next) : next })}
                    options={row.choices}
                  />
                )
              ) : row.set ? (
                <span
                  className="flex flex-wrap justify-end gap-x-2.5 gap-y-1"
                  role="group"
                  aria-labelledby={`option-${item.id}-${row.key}`}
                >
                  {row.set.map(([id, label]) => {
                    const on = options[row.key].includes(id)
                    return (
                      <label key={id} className="inline-flex cursor-pointer items-center gap-1 text-xs text-fg">
                        <input
                          type="checkbox"
                          checked={on}
                          // The last one stays: a chart with no line is not a chart.
                          disabled={on && options[row.key].length === 1}
                          onChange={() =>
                            onChange({ [row.key]: on ? options[row.key].filter((key) => key !== id) : [...options[row.key], id] })
                          }
                          className="h-4 w-4 accent-[var(--accent)]"
                          data-sw-widget-option-item={id}
                        />
                        {label}
                      </label>
                    )
                  })}
                </span>
              ) : (
                <Switch checked={Boolean(options[row.key])} onChange={(next) => onChange({ [row.key]: next })} label={row.label} />
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

// ---- Tiles ----

const TILE_ID = {
  tile_calls: 'calls',
  tile_tokens: 'tokens',
  tile_duration: 'duration',
  tile_cost: 'cost',
  tile_fixes: 'fixes',
  tile_failed: 'failed',
}
function tileOf(type, { now, before, trendOf }) {
  const reportedNote = (key) =>
    now && now.calls
      ? now.reported[key] === now.calls
        ? null
        : `${formatCount(now.reported[key])} of ${formatCount(now.calls)} turns reported`
      : null
  switch (type) {
    case 'tile_calls':
      return { value: formatCount(now?.calls ?? 0), current: now?.calls, previous: before?.calls, trend: trendOf('calls') }
    case 'tile_tokens':
      return {
        value: now?.tokens === null ? 'Not reported' : formatCount(now?.tokens),
        current: now?.tokens,
        previous: before?.tokens,
        hint: now?.tokens === null ? null : (reportedNote('tokens') ?? `${formatCount(now?.input)} in · ${formatCount(now?.output)} out`),
        note: now?.tokens === null ? 'No agent reported tokens' : undefined,
        trend: trendOf('tokens'),
      }
    case 'tile_duration':
      return {
        value: formatDuration(now?.duration),
        current: now?.duration,
        previous: before?.duration,
        hint: now?.latency?.turns ? `Median ${formatDuration(now.latency.p50)} · 95th ${formatDuration(now.latency.p95)}` : null,
        trend: trendOf('duration'),
      }
    case 'tile_cost':
      return {
        value: now?.cost === null ? 'Not reported' : formatCost(now?.cost),
        current: now?.cost,
        previous: before?.cost,
        hint: now?.cost === null ? null : reportedNote('cost'),
        note: now?.cost === null ? 'No agent reported a cost' : undefined,
        trend: trendOf('cost'),
      }
    case 'tile_fixes':
      return {
        value: now?.fixes ? `${formatCount(now.fixesDone)} of ${formatCount(now.fixes)}` : '0',
        current: now?.fixes ? now.fixesDone / now.fixes : null,
        previous: before?.fixes ? before.fixesDone / before.fixes : null,
        better: 'up',
        hint: now?.fixes ? `${percent(now.fixesDone, now.fixes)} ended with a fix or an answer` : 'No fix was asked for',
      }
    default:
      return {
        value: now ? percent(now.outcomes.failed + now.outcomes.stopped, now.calls) : '',
        current: now?.calls ? (now.outcomes.failed + now.outcomes.stopped) / now.calls : null,
        previous: before?.calls ? (before.outcomes.failed + before.outcomes.stopped) / before.calls : null,
        better: 'down',
        hint: now ? `${formatCount(now.outcomes.failed)} failed · ${formatCount(now.outcomes.stopped)} stopped` : null,
        trend: trendOf('failed'),
      }
  }
}

function TileWidget({ item, options, ctx, menu }) {
  const summary = useWs(ctx.workspaceId, `/usage/summary?${ctx.query}`)
  // The trend line: the same buckets as the page's charts. Asked for only when it shows.
  const wanted = Boolean(options.spark)
  const plain = useWs(ctx.workspaceId, `/usage/series?${ctx.query}&bucket=${ctx.bucket}&groupBy=none&metric=calls`, { enabled: wanted })
  const trendOf = (key) => {
    if (!wanted || !plain.data) return null
    const found = new Map(plain.data.points.map((point) => [point.bucket, point]))
    return plain.data.buckets.map((id) => {
      const point = found.get(id)
      if (key === 'calls') return point ? point.calls : 0
      if (key === 'failed') return point?.calls ? ((point.outcomes?.failed || 0) + (point.outcomes?.stopped || 0)) / point.calls : null
      return point ? (point[key] ?? null) : null
    })
  }
  const tile = tileOf(item.type, { now: summary.data?.current, before: summary.data?.previous, trendOf })
  return (
    <StatTile
      testId={TILE_ID[item.type]}
      compare={ctx.period.compare}
      label={WIDGETS[item.type].title}
      loading={summary.isLoading}
      fill
      menu={menu}
      spark={wanted}
      showCompare={options.compare}
      {...tile}
    />
  )
}

// ---- Charts ----

function TimeWidget({ options, setOptions, ctx, menu }) {
  const { metric, by } = options
  const bucket = options.bucket === 'auto' ? ctx.autoBucket : options.bucket
  const series = useWs(ctx.workspaceId, `/usage/series?${ctx.query}&bucket=${bucket}&groupBy=${by}&metric=${metric}`)
  return (
    <TimeChart
      data={series.data}
      metric={metric}
      bucket={bucket}
      dimension={series.data?.groupBy ?? by}
      state={series}
      onPick={by === 'none' ? null : ctx.toggle(by)}
      pressed={by === 'none' ? [] : ctx.filter.list(by).map((key) => (key === '~' ? '' : key))}
      onRange={(first, last) =>
        ctx.filter.set({ range: 'custom', from: bucketRange(first, bucket).from, to: bucketRange(last, bucket).to }, { push: true })
      }
      style={options.style}
      showLegend={options.legend}
      showBrush={options.brush}
      fill
      menu={menu}
      view={options.view}
      onView={(view) => setOptions({ view })}
      controls={
        <>
          <Picker
            label="Measure"
            testId="metric"
            value={metric}
            onChange={(next) => setOptions({ metric: next })}
            options={USAGE_METRICS.map((id) => [id, METRIC_LABEL[id]])}
          />
          <Picker
            label="Split by"
            testId="by"
            value={by}
            onChange={(next) => setOptions({ by: next })}
            options={[...USAGE_DIMENSIONS.map(byDimension), ['none', 'No split']]}
          />
          <ToggleGroup
            label="Bucket"
            value={bucket}
            onChange={(next) => setOptions({ bucket: next })}
            options={USAGE_BUCKETS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }))}
          />
        </>
      }
    />
  )
}

function BreakdownWidget({ options, setOptions, ctx, menu }) {
  const by = options.by
  const metric = options.metric === 'chart' ? ctx.metric : options.metric
  const breakdown = useWs(ctx.workspaceId, `/usage/breakdown?${ctx.query}&groupBy=${by}`)
  return (
    <BreakdownChart
      groups={breakdown.data?.groups}
      metric={metric}
      dimension={by}
      title={DIMENSION_LABEL[by]}
      state={breakdown}
      onPick={ctx.toggle(by)}
      pressed={ctx.filter.list(by).map((key) => (key === '~' ? '' : key))}
      rows={options.rows}
      showShare={options.share}
      fill
      menu={menu}
      view={options.view}
      onView={(view) => setOptions({ view })}
      controls={
        <Picker
          label="Break down by"
          testId="bd"
          value={by}
          onChange={(next) => setOptions({ by: next })}
          options={USAGE_DIMENSIONS.map(byDimension)}
        />
      }
    />
  )
}

// The series the outcomes and approvals charts (and the tiles' trend lines) read: one per bucket, not split.
const usePlain = (ctx) => useWs(ctx.workspaceId, `/usage/series?${ctx.query}&bucket=${ctx.bucket}&groupBy=none&metric=calls`)

function OutcomesWidget({ options, setOptions, ctx, menu }) {
  const plain = usePlain(ctx)
  return (
    <OutcomesChart
      data={plain.data}
      bucket={ctx.bucket}
      state={plain}
      onPick={ctx.toggle('outcome')}
      pressed={ctx.filter.list('outcome')}
      mode={options.mode}
      fill
      menu={menu}
      view={options.view}
      onView={(view) => setOptions({ view })}
    />
  )
}
function ApprovalsWidget({ options, setOptions, ctx, menu }) {
  const plain = usePlain(ctx)
  return (
    <ApprovalsChart
      data={plain.data}
      bucket={ctx.bucket}
      state={plain}
      mode={options.mode}
      fill
      menu={menu}
      view={options.view}
      onView={(view) => setOptions({ view })}
    />
  )
}
function LatencyWidget({ options, setOptions, ctx, menu }) {
  const latency = useWs(ctx.workspaceId, `/usage/latency?${ctx.query}&bucket=${ctx.bucket}`)
  return (
    <LatencyChart
      data={latency.data}
      bucket={ctx.bucket}
      state={latency}
      percentiles={options.percentiles}
      log={options.log}
      fill
      menu={menu}
      view={options.view}
      onView={(view) => setOptions({ view })}
    />
  )
}

// ---- Top lists ----

const TOP_ID = { top_agents: 'agents', top_threads: 'threads', top_slowest: 'slowest', top_denied: 'denied' }
const TOP_EMPTY = {
  agents: 'No agent took a turn.',
  threads: 'No agent reported tokens.',
  slowest: 'No turn has finished.',
  denied: 'No approval was denied.',
}
function topRows(id, data, { workspaceId, filter, isAdmin }) {
  const open = (changes) => filter.set({ tab: 'turns', ...changes }, { push: true })
  if (id === 'agents')
    return (data?.agents || []).map((item) => ({
      key: item.key,
      label: item.label,
      hint: item.machine,
      value: `${formatCount(item.calls)} turns`,
      to: isAdmin && item.key ? `/w/${workspaceId}/activity/${item.key}` : null,
      onClick: () => open({ agent: [item.key || '~'] }),
    }))
  if (id === 'threads')
    return (data?.threads || []).map((item, index) => ({
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
    }))
  if (id === 'slowest')
    return (data?.slowest || []).map((item) => ({
      key: item.id,
      label: `${KIND_LABEL[item.kind] || item.kind} by ${item.agent?.name || 'no agent'}`,
      hint: `${item.project.name} · ${formatTime(item.startedAt)}`,
      value: formatDuration(item.durationMs),
      onClick: () => filter.set({ row: item.id }),
    }))
  return (data?.denied || []).map((item) => ({
    key: item.key,
    label: item.label,
    hint: `${formatCount(item.asked)} asked`,
    value: `${formatCount(item.denied)} denied`,
    onClick: () => open({ agent: [item.key || '~'], kind: ['fix', 'push'] }),
  }))
}

function TopWidget({ item, options, ctx, menu }) {
  const id = TOP_ID[item.type]
  // Five is what the server sends unless asked: the four lists then share one request.
  const top = useWs(ctx.workspaceId, `/usage/top?${ctx.query}${options.rows === 5 ? '' : `&limit=${options.rows}`}`)
  const rows = topRows(id, top.data, ctx).slice(0, options.rows)
  const title = WIDGETS[item.type].title
  return (
    <Card className="flex h-full min-w-0 flex-col overflow-hidden" data-sw-top={id}>
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-line py-1.5 pr-2 pl-4" data-sw-top-head>
        <h2 className="truncate py-1 text-ui font-semibold text-fg" title={title}>
          {title}
        </h2>
        {menu}
      </div>
      {top.isLoading ? (
        <p className="px-4 py-6 text-center text-xs text-muted" role="status">
          Loading
        </p>
      ) : rows.length ? (
        <ol className="min-h-0 flex-1 overflow-y-auto py-1" data-sw-top-rows={rows.length}>
          {rows.map((row, index) => (
            <li key={row.key}>
              <button
                type="button"
                onClick={row.onClick || undefined}
                disabled={!row.onClick}
                className="flex w-full items-center gap-2.5 px-4 py-1 text-left outline-none enabled:hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <span className="tabular w-4 shrink-0 text-xs text-faint">{index + 1}</span>
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
        <p className="px-4 py-6 text-center text-xs text-muted">{TOP_EMPTY[id]}</p>
      )}
    </Card>
  )
}

// ---- Budgets ----

// Each project's daily budgets from its agent policy, with today's use.
function BudgetsWidget({ ctx }) {
  const state = useWs(ctx.workspaceId, '/usage/budgets', { keep: false })
  const projects = state.data?.projects || []
  return (
    <Card className="flex h-full min-w-0 flex-col overflow-hidden" data-sw-usage-budgets>
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3 sm:px-5" data-sw-budgets-head>
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <Gauge size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-title font-semibold text-fg">Budgets today</h2>
          <p
            className="mt-0.5 truncate text-ui text-muted"
            title="Each project's agent policy caps chat turns and fixes per day (the day is UTC). A forecast shows once enough of the day has passed."
          >
            Each project&apos;s agent policy caps chat turns and fixes per day (the day is UTC). A forecast shows once enough of the day has
            passed.
          </p>
        </div>
      </div>
      {state.isLoading ? (
        <p className="px-4 py-6 text-center text-xs text-muted" role="status">
          Loading
        </p>
      ) : projects.length ? (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {projects.map(({ project, budgets }) => (
            <li
              key={project.id}
              className="grid gap-x-6 gap-y-2 px-4 py-2 sm:grid-cols-[minmax(0,12rem)_repeat(2,minmax(0,1fr))] sm:px-5"
              data-sw-budget={project.name}
            >
              <Link
                to={`/w/${ctx.workspaceId}/projects/${project.id}`}
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
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted">No project has an agent policy with a budget yet.</p>
      )}
    </Card>
  )
}

const BODY = {
  time: TimeWidget,
  breakdown: BreakdownWidget,
  outcomes: OutcomesWidget,
  approvals: ApprovalsWidget,
  latency: LatencyWidget,
  budgets: BudgetsWidget,
}
// One widget, drawn. `options`: the item's saved options with whatever an
// older link's address still says on top (Dashboard.jsx).
export function Widget({ item, options, setOptions, ctx, menu }) {
  const group = WIDGETS[item.type].group
  const Body = group === 'tile' ? TileWidget : group === 'list' ? TopWidget : BODY[item.type]
  return <Body item={item} options={options} setOptions={setOptions} ctx={ctx} menu={menu} />
}
