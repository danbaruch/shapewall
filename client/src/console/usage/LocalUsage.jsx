// Usage on a local board (Console > Usage): the turns agents ran on this
// computer, from the usage log (src/agent/usage-log.js). The same tiles and
// charts as the hosted Usage page, over one simple answer: totals against
// the days before, turns by day and agent, how they ended, and the newest
// turns in a table. Only the owner's devices read it.

import { useState } from 'react'
import { BarChart3, Lock } from 'lucide-react'
import { EmptyState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, ToggleGroup } from '../../components/ui'
import { useResource } from '../../lib/hooks'
import { KIND_LABEL, METRIC_LABEL, USAGE_METRICS } from '../../../../src/hosted/usage-shape.js'
import { Card, LoadError, Loading, PageHeader } from '../components'
import { OutcomesChart, TimeChart } from './charts'
import { formatCost, formatCount, formatDuration, formatTime } from './format'
import { OutcomeChip, StatTile, Unreported, orUnreported } from './pieces'
import './usage.css'

const state = (resource) => ({
  isLoading: resource.loading && !resource.data,
  error: null,
  isFetching: resource.loading,
  isPlaceholderData: Boolean(resource.data),
  refetch: resource.refetch,
})

export default function LocalUsage() {
  const [days, setDays] = useState('30')
  const [metric, setMetric] = useState('calls')
  const usage = useResource(`/api/agent/usage?days=${days}`)
  const data = usage.data
  const now = data?.summary.current
  const before = data?.summary.previous
  const header = (
    <PageHeader
      title="Usage"
      description="The turns agents ran on this computer: how many, how long, how they ended, and the numbers each agent reported. Never the questions or the answers."
      actions={
        <ToggleGroup
          label="Period"
          value={days}
          onChange={setDays}
          options={[
            { id: '7', label: '7 days' },
            { id: '30', label: '30 days' },
            { id: '90', label: '90 days' },
          ]}
        />
      }
    />
  )
  if (usage.error && !data)
    return (
      <div data-sw-local-usage="error">
        {header}
        {usage.error.code === 'feedback_needs_owner' ? (
          <Card>
            <EmptyState icon={Lock} size="lg" title="Usage is for the owner">
              It says who used which agent on this computer. Open the private link from the terminal, or use a paired device.
            </EmptyState>
          </Card>
        ) : (
          <LoadError error={usage.error} onRetry={usage.refetch} />
        )}
      </div>
    )
  if (!data) return <Loading label="Loading usage" rows={4} />
  if (!now.calls && !before.calls)
    return (
      <div data-sw-local-usage="empty">
        {header}
        <Card>
          <EmptyState icon={BarChart3} size="lg" title="No agent turns yet">
            Chat with an agent on a board, or use Fix with agent on a comment. Each turn shows up here from then on.
          </EmptyState>
        </Card>
      </div>
    )
  const trend = data.plain.buckets.map((bucket) => data.plain.points.find((point) => point.bucket === bucket)?.calls ?? 0)
  return (
    <div className="space-y-4" data-sw-local-usage="ready">
      {header}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-sw-usage-tiles>
        <StatTile testId="calls" label="Turns" value={formatCount(now.calls)} current={now.calls} previous={before.calls} trend={trend} />
        <StatTile
          testId="tokens"
          label="Tokens"
          value={now.tokens === null ? 'Not reported' : formatCount(now.tokens)}
          current={now.tokens}
          previous={before.tokens}
          hint={now.tokens === null ? null : `${formatCount(now.reported.tokens)} of ${formatCount(now.calls)} turns reported`}
          note={now.tokens === null ? 'No agent reported tokens' : undefined}
        />
        <StatTile
          testId="duration"
          label="Agent time"
          value={formatDuration(now.duration)}
          current={now.duration}
          previous={before.duration}
          hint={now.latency.turns ? `Median ${formatDuration(now.latency.p50)} · 95th ${formatDuration(now.latency.p95)}` : null}
        />
        <StatTile
          testId="cost"
          label="Reported cost"
          value={now.cost === null ? 'Not reported' : formatCost(now.cost)}
          current={now.cost}
          previous={before.cost}
          note={now.cost === null ? 'No agent reported a cost' : undefined}
        />
      </div>
      <TimeChart
        data={data.series}
        metric={metric}
        bucket="day"
        dimension="agent"
        state={state(usage)}
        controls={
          <Select value={metric} onValueChange={setMetric}>
            <SelectTrigger className="h-8 w-auto min-w-0 gap-1 px-2 text-xs" aria-label="Measure" data-sw-pick="metric">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USAGE_METRICS.map((id) => (
                <SelectItem key={id} value={id}>
                  {METRIC_LABEL[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <OutcomesChart data={data.plain} bucket="day" state={state(usage)} />
      <Card data-sw-local-usage-table>
        <h2 className="border-b border-line px-4 py-3 text-title font-semibold text-fg sm:px-5">
          The newest turns
          <span className="ml-2 text-xs font-normal text-muted">
            {formatCount(data.rows.length, { exact: true })} of {formatCount(data.total, { exact: true })}
          </span>
        </h2>
        {/* A table from the sm breakpoint; a list of cards on a phone. */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[760px] border-collapse text-xs">
            <thead>
              <tr>
                {['When', 'Kind', 'Agent', 'Asked by', 'Outcome', 'Model', 'Duration', 'Tokens', 'Cost', 'Steps'].map((label, index) => (
                  <th
                    key={label}
                    scope="col"
                    className={`border-b border-line px-3 py-2 font-medium whitespace-nowrap text-muted ${index > 5 ? 'text-right' : 'text-left'} first:pl-5 last:pr-5`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} className="border-b border-line/60 last:border-0" data-sw-local-usage-row={row.id}>
                  <th scope="row" className="py-2 pr-3 pl-5 text-left font-normal whitespace-nowrap text-fg">
                    {formatTime(row.startedAt)}
                  </th>
                  <td className="px-3 py-2 text-fg">{KIND_LABEL[row.kind] || row.kind}</td>
                  <td className="max-w-[10rem] truncate px-3 py-2 text-fg">{row.agent?.name}</td>
                  <td className="px-3 py-2 text-fg">{row.askedBy === 'owner' ? 'You (owner)' : 'A viewer'}</td>
                  <td className="px-3 py-2 text-fg">
                    <OutcomeChip outcome={row.outcome} />
                  </td>
                  <td className="max-w-[10rem] truncate px-3 py-2 text-fg">{row.model || <Unreported what="Model" />}</td>
                  <td className="tabular px-3 py-2 text-right text-fg">{formatDuration(row.durationMs)}</td>
                  <td className="tabular px-3 py-2 text-right text-fg">
                    {orUnreported(row.totalTokens, (value) => formatCount(value, { exact: true }), 'Tokens')}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-fg">{orUnreported(row.costMicros, formatCost, 'Cost')}</td>
                  <td className="tabular py-2 pr-5 pl-3 text-right text-fg">{formatCount(row.steps ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="divide-y divide-line sm:hidden">
          {data.rows.map((row) => (
            <li key={row.id} className="px-4 py-3">
              <p className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-fg">
                  {KIND_LABEL[row.kind] || row.kind} · {row.agent?.name}
                </span>
                <span className="tabular shrink-0 text-xs text-muted">{formatDuration(row.durationMs)}</span>
              </p>
              <p className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted">
                <OutcomeChip outcome={row.outcome} className="text-fg" />
                <span className="tabular shrink-0">
                  {row.totalTokens === null ? 'Tokens not reported' : `${formatCount(row.totalTokens)} tokens`}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-muted">{formatTime(row.startedAt)}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
