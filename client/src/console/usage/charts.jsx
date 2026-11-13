// The charts of the Usage pages (Recharts), each inside a ChartCard that
// gives it a title, a table of the same numbers, "copy as CSV" and "copy as
// image", and designed loading, empty and error states.
//
// House rules (the dataviz guidance this project follows): one y axis per
// chart; bars start at zero; thin marks with a surface-coloured gap between
// stacked segments; a legend for two or more series, never colour alone;
// hover and keyboard focus show exact values; "not reported" is a hatch or a
// gap, never a zero; text is ink, only marks wear the series colour.
//
// On the Usage dashboard a chart is a widget (widgets.jsx): `fill` makes it
// as tall as its place on the grid, `menu` is its options button, and the
// chart or table view is whatever the widget saved. Anywhere else (a local
// board's Usage, a person's or an agent's page) a chart keeps its own height
// and its own view.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Bar, BarChart, Brush, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  BarChart3,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  ClipboardCopy,
  Image,
  LoaderCircle,
  Square,
  Table2,
  UserRound,
} from 'lucide-react'
import { Button, EmptyState, IconButton, Skeleton, ToggleGroup } from '../../components/ui'
import { cn } from '../../lib/utils'
import { METRIC_LABEL, METRIC_REPORTED, OUTCOME_GROUP_IDS, OUTCOME_GROUP_LABEL } from '../../../../src/hosted/usage-shape.js'
import { Card, LoadError } from '../components'
import { useToast } from '../state'
import {
  bucketLabel,
  durationTicks,
  formatAxis,
  formatCount,
  formatDuration,
  formatDurationTick,
  formatMetric,
  percent,
  toCsv,
} from './format'
import { useChartTheme } from './theme'

const OTHER = '__other'
export const OUTCOME_ICON = {
  completed: CircleCheck,
  needs_person: UserRound,
  failed: CircleX,
  stopped: Square,
  other: CircleDashed,
  running: LoaderCircle,
}

// A finger that lands on a chart shows the values under it at once (the
// chart itself follows a finger that moves): the touch is handed on as a
// pointer position.
function showAtTouch(event) {
  const touch = event.touches[0]
  const target = touch && document.elementFromPoint(touch.clientX, touch.clientY)
  if (!target?.closest?.('.recharts-wrapper')) return
  target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: touch.clientX, clientY: touch.clientY }))
}

// ---- The card around a chart ----

// `table`: { columns: [label], rows: [[cell]] } with the chart's exact
// numbers. `legend`: [{ label, color, hatch? }] for the image copy.
export function ChartCard({
  title,
  subtitle,
  controls,
  table,
  legend = [],
  children,
  state,
  empty,
  emptyTitle = 'Nothing in this period',
  className,
  testId,
  footer = null,
  fill = false,
  menu = null,
  view: savedView = null,
  onView = null,
  // Its switches need a wide card to sit beside the title (the chart over time).
  wideControls = false,
  // false while the dashboard's layout is edited: the widget's bar is its heading then.
  header = true,
}) {
  const [ownView, setOwnView] = useState('chart')
  const view = savedView ?? ownView
  const setView = onView ?? setOwnView
  const body = useRef(null)
  const toast = useToast()
  const theme = useChartTheme()
  const loading = state?.isLoading
  const error = state?.error
  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(toCsv([table.columns, ...table.rows]))
      toast('Copied as CSV')
    } catch {
      toast('This browser did not allow copying', 'bad')
    }
  }
  const copyImage = async () => {
    try {
      const how = await chartImage({ node: body.current, title, subtitle, legend, theme })
      toast(how === 'copied' ? 'Copied as an image' : 'Saved as an image')
    } catch {
      toast('The image could not be made', 'bad')
    }
  }
  return (
    <Card className={cn('@container/chart flex min-w-0 flex-col', fill && 'h-full overflow-hidden', className)} data-sw-chart={testId}>
      <div
        className={cn('shrink-0 flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5 sm:px-5', header ? 'flex' : 'hidden')}
        data-sw-chart-header
      >
        <div className="min-w-0 flex-[1_1_10rem]">
          <h2 className={cn('text-title font-semibold text-fg', fill && 'truncate')} title={fill ? title : undefined}>
            {title}
          </h2>
          {subtitle ? (
            <p className={cn('mt-0.5 text-xs text-muted', fill && 'truncate')} title={fill ? subtitle : undefined}>
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 print:hidden">
          {/* A narrow widget keeps its title and its options button; the switches are all in the options. */}
          <div
            className={cn(
              'flex-wrap items-center gap-1.5',
              menu !== null ? (wideControls ? 'hidden @min-[46rem]/chart:flex' : 'hidden @min-[26rem]/chart:flex') : 'flex',
            )}
            data-sw-chart-controls
          >
            {controls}
            <ToggleGroup
              label={`${title}: chart or table`}
              value={view}
              onChange={setView}
              options={[
                { id: 'chart', label: <BarChart3 size={14} aria-label="Chart" />, tooltip: 'Chart' },
                { id: 'table', label: <Table2 size={14} aria-label="Table" />, tooltip: 'Table' },
              ]}
            />
            <IconButton label="Copy as CSV" onClick={copyCsv} disabled={!table?.rows.length} data-sw-chart-csv>
              <ClipboardCopy size={15} aria-hidden="true" />
            </IconButton>
            <IconButton label="Copy as an image" onClick={copyImage} disabled={view !== 'chart' || empty || loading} data-sw-chart-image>
              <Image size={15} aria-hidden="true" />
            </IconButton>
          </div>
          {menu}
        </div>
      </div>
      <div
        ref={body}
        className={cn(
          'min-w-0 flex-1 px-2 pt-2 pb-3 transition-opacity sm:px-3',
          fill && 'flex min-h-0 flex-col',
          state?.isPlaceholderData && state?.isFetching && 'opacity-60',
        )}
        aria-busy={Boolean(state?.isFetching)}
        data-sw-fit-wait={loading ? '' : undefined}
        onTouchStart={showAtTouch}
        data-sw-chart-body
      >
        {loading ? (
          <ChartSkeleton fill={fill} />
        ) : error ? (
          <div className="p-2">
            <LoadError error={error} onRetry={state.refetch} />
          </div>
        ) : empty ? (
          <EmptyState icon={BarChart3} title={emptyTitle} data-sw-chart-empty>
            {typeof empty === 'string' ? empty : 'Try a longer period, or clear a filter.'}
          </EmptyState>
        ) : view === 'table' ? (
          <DataTable table={table} title={title} fill={fill} />
        ) : (
          children
        )}
      </div>
      {footer}
    </Card>
  )
}

// Whether the page is being printed. A browser lays a page out for paper
// without running anything in between, so a chart that follows its widget's
// height is given a fixed one the moment printing starts (before the
// snapshot is taken), and its own again afterwards.
function usePrinting() {
  const [printing, setPrinting] = useState(() => typeof window !== 'undefined' && Boolean(window.matchMedia?.('print').matches))
  useEffect(() => {
    const on = () => flushSync(() => setPrinting(true))
    const off = () => setPrinting(false)
    const media = window.matchMedia?.('print')
    const changed = (event) => (event.matches ? on() : off())
    window.addEventListener('beforeprint', on)
    window.addEventListener('afterprint', off)
    media?.addEventListener?.('change', changed)
    return () => {
      window.removeEventListener('beforeprint', on)
      window.removeEventListener('afterprint', off)
      media?.removeEventListener?.('change', changed)
    }
  }, [])
  return printing
}

// The plot of a chart. On the dashboard it takes whatever height its widget
// has left (never less than a chart can be read at); anywhere else, `height`.
// A change of size is taken up after a short pause, so dragging a widget's
// corner does not redraw the chart on every pixel. On paper every plot has
// one height, whatever its widget's.
function Plot({ fill, height, children, ...rest }) {
  const printing = usePrinting()
  if (!fill || printing)
    return (
      <div {...rest}>
        <ResponsiveContainer width="100%" height={height}>
          {children}
        </ResponsiveContainer>
      </div>
    )
  return (
    <div className="relative min-h-[96px] flex-1" data-sw-plot {...rest}>
      <div className="absolute inset-0">
        <ResponsiveContainer width="100%" height="100%" debounce={60}>
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ChartSkeleton({ fill }) {
  // Columns of a chart to come, not a spinner.
  return (
    <div className={cn('flex items-end gap-2 px-3 pb-6', fill ? 'min-h-0 flex-1' : 'h-[236px]')} role="status" data-sw-chart-loading>
      <span className="sr-only">Loading the chart</span>
      {[40, 65, 50, 80, 60, 90, 70, 45, 75, 55, 85, 62].map((height, index) => (
        <Skeleton key={index} className="flex-1 rounded-sm" style={{ height: `${height}%` }} />
      ))}
    </div>
  )
}

// The same numbers as the chart, as a table (also what a screen reader gets).
export function DataTable({ table, title, fill = false }) {
  return (
    <div
      className={cn('overflow-auto px-2', fill ? 'min-h-0 flex-1' : 'max-h-[300px]')}
      tabIndex={0}
      role="region"
      aria-label={`${title}: table`}
      data-sw-chart-table
      data-sw-fit={fill ? '' : undefined}
    >
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr>
            {table.columns.map((column, index) => (
              <th
                key={index}
                scope="col"
                className={cn('border-b border-line px-2 py-1.5 font-medium text-muted', index ? 'text-right' : 'text-left')}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index} className="border-b border-line/60 last:border-0">
              {row.map((cell, at) =>
                at ? (
                  <td key={at} className="tabular px-2 py-1.5 text-right text-fg">
                    {cell}
                  </td>
                ) : (
                  <th key={at} scope="row" className="px-2 py-1.5 text-left font-normal text-fg">
                    {cell}
                  </th>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The chart as a PNG: its SVG drawn on a canvas under its title and legend.
// Copied where the browser allows, saved as a file where it does not.
async function chartImage({ node, title, subtitle, legend, theme }) {
  const svg = node?.querySelector('svg.recharts-surface') || node?.querySelector('svg')
  if (!svg) throw new Error('no chart')
  const box = svg.getBoundingClientRect()
  const clone = svg.cloneNode(true)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', box.width)
  clone.setAttribute('height', box.height)
  clone.setAttribute('font-family', 'system-ui, -apple-system, "Segoe UI", sans-serif')
  const image = new window.Image()
  const loaded = new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = reject
  })
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`
  await loaded
  const scale = 2
  const pad = 16
  const head = 28 + (subtitle ? 18 : 0) + (legend.length ? 26 : 0)
  const canvas = document.createElement('canvas')
  canvas.width = (box.width + pad * 2) * scale
  canvas.height = (box.height + head + pad * 2) * scale
  const context = canvas.getContext('2d')
  context.scale(scale, scale)
  context.fillStyle = theme.surface
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.textBaseline = 'top'
  context.fillStyle = theme.text
  context.font = '600 15px system-ui, -apple-system, "Segoe UI", sans-serif'
  context.fillText(title, pad, pad)
  let top = pad + 24
  context.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif'
  if (subtitle) {
    context.fillStyle = theme.muted
    context.fillText(subtitle, pad, top)
    top += 18
  }
  let left = pad
  for (const item of legend) {
    const width = context.measureText(item.label).width
    if (left + width + 26 > box.width + pad) break
    context.fillStyle = item.color
    context.fillRect(left, top + 2, 10, 10)
    context.fillStyle = theme.text
    context.fillText(item.label, left + 15, top)
    left += width + 30
  }
  context.drawImage(image, pad, pad + head, box.width, box.height)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  try {
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
    return 'copied'
  } catch {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
    return 'saved'
  }
}

// ---- Shared pieces ----

// One tooltip for every chart: values lead, names follow, a short stroke of
// the series colour keys each row.
function TooltipBox({ title, rows, footer }) {
  return (
    <div
      className="pointer-events-none max-w-[260px] rounded-lg border border-line bg-surface px-3 py-2 text-xs text-fg shadow-pop"
      data-sw-chart-tooltip
    >
      <p className="mb-1 font-medium text-fg">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2">
            <span
              className="h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: row.hatch ? 'repeating-linear-gradient(90deg, currentColor 0 2px, transparent 2px 4px)' : row.color }}
              aria-hidden="true"
            />
            <span className="tabular font-semibold">{row.value}</span>
            <span className="min-w-0 truncate text-muted">{row.label}</span>
          </li>
        ))}
      </ul>
      {footer ? <p className="mt-1.5 border-t border-line pt-1.5 text-muted">{footer}</p> : null}
    </div>
  )
}

// A legend that is also a filter: a press narrows the page to that entry.
// `fill`: at most two lines of entries, the rest a scroll away (the plot keeps its room).
export function Legend({ items, onPick, pressed = [], className, fill = false }) {
  if (!items.length) return null
  return (
    <ul
      className={cn('flex flex-wrap gap-x-1 gap-y-0.5 px-2 pt-1', fill && 'max-h-[62px] min-w-0 flex-[1_1_0%] overflow-y-auto', className)}
      data-sw-chart-legend
    >
      {items.map((item) => {
        const Icon = item.icon
        const content = (
          <>
            {Icon ? (
              <Icon size={13} style={{ color: item.color }} aria-hidden="true" />
            ) : (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={
                  item.hatch
                    ? { background: `repeating-linear-gradient(45deg, ${item.color} 0 1.5px, transparent 1.5px 4px)` }
                    : { background: item.color }
                }
                aria-hidden="true"
              />
            )}
            <span className="max-w-[12rem] truncate">{item.label}</span>
            {item.value !== undefined ? <span className="tabular text-muted">{item.value}</span> : null}
            {pressed.includes(item.key) ? <Check size={12} className="text-accent" aria-hidden="true" /> : null}
          </>
        )
        return (
          <li key={item.key ?? item.label}>
            {onPick && item.key !== OTHER && !item.fixed ? (
              <button
                type="button"
                onClick={() => onPick(item.key)}
                aria-pressed={pressed.includes(item.key)}
                title={`Show only ${item.label}`}
                className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                data-sw-legend-item={item.key}
              >
                {content}
              </button>
            ) : (
              <span className="inline-flex min-h-7 items-center gap-1.5 px-1.5 text-xs text-fg">{content}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Hatch({ id, color }) {
  return (
    <defs>
      <pattern id={id} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="1.5" opacity="0.45" />
      </pattern>
    </defs>
  )
}

const axisProps = (theme) => ({
  tick: { fill: theme.muted, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: theme.axis },
})
const valueOf = (item, metric) => (metric === 'calls' ? item.calls : item[metric])

// ---- Usage over time ----

// Stacked bars, one per bucket, split by the chosen dimension. A bucket
// where turns ran but none reported the metric is hatched from top to
// bottom: unknown, not zero. Click a segment or a legend entry to filter;
// drag the brush under the chart to zoom, then keep that range for the page.
// `style`: stacked bars (the default), grouped bars (side by side) or lines.
export function TimeChart({
  data,
  metric,
  bucket,
  dimension,
  state,
  onPick,
  pressed,
  onRange,
  controls,
  style = 'stacked',
  showLegend = true,
  showBrush = true,
  fill = false,
  header = true,
  menu = null,
  view = null,
  onView = null,
}) {
  const theme = useChartTheme()
  const hatchId = `hatch-${useId().replace(/:/g, '')}`
  const [zoom, setZoom] = useState(null)
  const model = useMemo(() => {
    if (!data) return null
    const byBucket = new Map(data.buckets.map((key) => [key, { bucket: key, calls: 0, reported: 0, total: null }]))
    for (const point of data.points) {
      const row = byBucket.get(point.bucket)
      if (!row) continue
      const value = valueOf(point, metric)
      row.calls += point.calls
      row.reported +=
        metric === 'calls'
          ? point.calls
          : (point.reported?.[metric === 'cost' ? 'cost' : metric === 'duration' ? 'duration' : 'tokens'] ?? 0)
      if (value !== null && value !== undefined) {
        row[point.key] = value
        row.total = (row.total ?? 0) + value
      }
    }
    const peak = Math.max(0, ...[...byBucket.values()].map((row) => row.total || 0)) || 1
    const rows = [...byBucket.values()].map((row) => {
      const unknown = row.calls > 0 && row.total === null
      // The hatched column of an unknown bucket reaches the tallest known one.
      return { ...row, unknown, ...(unknown ? { __unknown: peak } : {}) }
    })
    return { rows, groups: data.groups, any: rows.some((row) => row.calls > 0), anyValue: rows.some((row) => row.total !== null) }
  }, [data, metric])
  const single = dimension === 'none'
  const groups = model?.groups || []
  const legend = single
    ? []
    : groups.map((group) => ({
        key: group.key,
        label: group.label,
        color: theme.colorFor(dimension, group.key),
        value: formatMetric(metric, valueOf(group.total || {}, metric)),
      }))
  const hasUnknown = Boolean(model?.rows.some((row) => row.unknown))
  if (hasUnknown) legend.push({ key: '__unknown', label: 'Not reported', color: theme.muted, hatch: true, fixed: true })
  const table = {
    columns: [
      bucket === 'month' ? 'Month' : bucket === 'week' ? 'Week of' : 'Day',
      ...(single ? [] : groups.map((group) => group.label)),
      single ? METRIC_LABEL[metric] : 'Total',
      'Turns',
    ],
    rows: (model?.rows || []).map((row) => [
      bucketLabel(row.bucket, bucket, { long: true }),
      ...(single
        ? []
        : groups.map((group) =>
            row[group.key] === undefined ? (row.unknown ? 'Not reported' : '') : formatMetric(metric, row[group.key], { exact: true }),
          )),
      row.unknown ? 'Not reported' : formatMetric(metric, row.total ?? (metric === 'calls' ? 0 : null), { exact: true }),
      formatCount(row.calls, { exact: true }),
    ]),
  }
  const rows = model?.rows || []
  const brush = showBrush && rows.length > 14
  const zoomed = brush && zoom && (zoom.startIndex > 0 || zoom.endIndex < rows.length - 1)
  const lines = style === 'lines'
  const stack = style === 'stacked' ? 'stack' : undefined
  const series = single ? [{ key: 'total', label: METRIC_LABEL[metric] }] : groups
  const few = rows.length <= 31
  const Chart = lines ? ComposedChart : BarChart
  return (
    <ChartCard
      title={`${METRIC_LABEL[metric]} over time`}
      subtitle={
        METRIC_REPORTED[metric]
          ? `As agents reported ${metric === 'cost' ? 'it' : 'them'}. Hatched: turns ran, nothing reported.`
          : metric === 'duration'
            ? 'From the question to the end of each turn, by this server’s clock.'
            : 'One turn is one answer, comment answer, fix or push.'
      }
      controls={controls}
      table={table}
      legend={legend}
      state={state}
      empty={model && !model.any}
      testId="time"
      wideControls
      fill={fill}
      header={header}
      menu={menu}
      view={view}
      onView={onView}
    >
      <Plot fill={fill} height={brush ? 276 : 248} data-sw-time-chart={metric} data-sw-time-style={style}>
        <Chart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%" accessibilityLayer>
          <Hatch id={hatchId} color={theme.muted} />
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis dataKey="bucket" tickFormatter={(key) => bucketLabel(key, bucket)} minTickGap={22} {...axisProps(theme)} />
          <YAxis
            width={46}
            allowDecimals={false}
            tickFormatter={(value) => formatAxis(metric, value)}
            {...axisProps(theme)}
            axisLine={false}
            domain={[0, model?.anyValue ? 'auto' : 1]}
            // Nothing known to measure against: no numbers on the axis.
            {...(model?.anyValue ? {} : { tick: false })}
          />
          <Tooltip
            cursor={{ fill: theme.track, opacity: 0.7 }}
            isAnimationActive={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0].payload
              const lines = single
                ? [
                    {
                      label: METRIC_LABEL[metric],
                      value: row.unknown ? 'Not reported' : formatMetric(metric, row.total ?? 0, { exact: true }),
                      color: theme.series[0],
                    },
                  ]
                : groups
                    .filter((group) => row[group.key] !== undefined)
                    .map((group) => ({
                      label: group.label,
                      value: formatMetric(metric, row[group.key], { exact: true }),
                      color: theme.colorFor(dimension, group.key),
                    }))
                    .reverse()
              if (!single && row.unknown)
                lines.push({ label: 'Not reported', value: formatCount(row.calls), color: theme.muted, hatch: true })
              const reported = METRIC_REPORTED[metric] && row.calls ? ` · ${row.reported} of ${row.calls} reported` : ''
              return (
                <TooltipBox
                  title={bucketLabel(label, bucket, { long: true })}
                  rows={lines}
                  footer={`${single || row.total === null ? '' : `Total ${formatMetric(metric, row.total, { exact: true })} · `}${formatCount(row.calls, { exact: true })} ${row.calls === 1 ? 'turn' : 'turns'}${reported}`}
                />
              )
            }}
          />
          {/* Turns ran and none reported the measure: a hatched column as tall as the plot, never a zero. */}
          {hasUnknown ? (
            <Bar
              dataKey="__unknown"
              name="Not reported"
              stackId={stack}
              fill={`url(#${hatchId})`}
              stroke="none"
              maxBarSize={24}
              isAnimationActive={false}
            />
          ) : null}
          {series.map((group, index, all) =>
            lines ? (
              <Line
                key={group.key}
                dataKey={group.key}
                name={group.label}
                stroke={single ? theme.series[0] : theme.colorFor(dimension, group.key)}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={few ? { r: 2.5, strokeWidth: 0, fill: single ? theme.series[0] : theme.colorFor(dimension, group.key) } : false}
                activeDot={{ r: 4, stroke: theme.surface, strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ) : (
              <Bar
                key={group.key}
                dataKey={group.key}
                name={group.label}
                stackId={stack}
                fill={single ? theme.series[0] : theme.colorFor(dimension, group.key)}
                stroke={theme.surface}
                strokeWidth={1}
                maxBarSize={24}
                radius={!stack || index === all.length - 1 ? [3, 3, 0, 0] : 0}
                isAnimationActive={false}
                cursor={onPick && !single && group.key !== OTHER ? 'pointer' : undefined}
                onClick={onPick && !single && group.key !== OTHER ? () => onPick(group.key) : undefined}
              />
            ),
          )}
          {brush ? (
            <Brush
              dataKey="bucket"
              height={22}
              travellerWidth={10}
              stroke={theme.axis}
              fill={theme.surface}
              tickFormatter={(key) => bucketLabel(key, bucket)}
              onChange={(range) => setZoom(range)}
            />
          ) : null}
        </Chart>
      </Plot>
      <div className={cn('flex flex-wrap items-center justify-between gap-2', fill && 'shrink-0')}>
        {showLegend ? <Legend items={legend} onPick={onPick} pressed={pressed} fill={fill} /> : <span />}
        {zoomed && onRange ? (
          <Button
            size="xs"
            variant="soft"
            className="mr-2 print:hidden"
            onClick={() => onRange(rows[zoom.startIndex].bucket, rows[zoom.endIndex].bucket)}
            data-sw-zoom-apply
          >
            Use {bucketLabel(rows[zoom.startIndex].bucket, bucket)} to {bucketLabel(rows[zoom.endIndex].bucket, bucket)} for the page
          </Button>
        ) : null}
      </div>
    </ChartCard>
  )
}

// ---- Breakdown: ranked bars with share ----

// Horizontal bars, largest first, each with its value at the tip and its
// share. A group that reported nothing has a hatched track and says so.
// Each row is a button: pressing it filters the page to that group.
// `rows`: how many show before "Show all". `showShare`: each row's share of the total.
export function BreakdownChart({
  groups,
  metric,
  dimension,
  state,
  onPick,
  pressed,
  controls,
  title,
  rows: count = 8,
  showShare = true,
  fill = false,
  header = true,
  menu = null,
  view = null,
  onView = null,
}) {
  const theme = useChartTheme()
  const [all, setAll] = useState(false)
  const ranked = useMemo(
    () => [...(groups || [])].sort((a, b) => (valueOf(b, metric) ?? -1) - (valueOf(a, metric) ?? -1) || b.calls - a.calls),
    [groups, metric],
  )
  const total = ranked.reduce((sum, group) => sum + (valueOf(group, metric) || 0), 0)
  const max = Math.max(1, ...ranked.map((group) => valueOf(group, metric) || 0))
  const shown = all ? ranked : ranked.slice(0, count)
  const table = {
    columns: [title, METRIC_LABEL[metric], 'Share', 'Turns'],
    rows: ranked.map((group) => {
      const value = valueOf(group, metric)
      return [
        group.label,
        formatMetric(metric, value, { exact: true }),
        value === null ? '' : percent(value, total),
        formatCount(group.calls, { exact: true }),
      ]
    }),
  }
  return (
    <ChartCard
      title={`${METRIC_LABEL[metric]} by ${title.toLowerCase()}`}
      subtitle="Largest first. Press a row to show only it."
      controls={controls}
      table={table}
      state={state}
      empty={groups && !groups.length}
      testId="breakdown"
      fill={fill}
      header={header}
      menu={menu}
      view={view}
      onView={onView}
    >
      <ol
        className={cn('space-y-0.5 px-2 pt-1', fill && 'min-h-0 flex-1 overflow-y-auto')}
        data-sw-breakdown={dimension}
        data-sw-fit={fill ? '' : undefined}
      >
        {shown.map((group) => {
          const value = valueOf(group, metric)
          const unknown = value === null || value === undefined
          const color = theme.colorFor(dimension, group.key)
          return (
            <li key={group.key}>
              <button
                type="button"
                onClick={() => onPick?.(group.key)}
                aria-pressed={pressed?.includes(group.key)}
                aria-label={`${group.label}: ${formatMetric(metric, value, { exact: true })}${unknown ? '' : `, ${percent(value, total)} of the total`}, ${group.calls} turns. Show only this.`}
                className={cn(
                  'group grid w-full items-center gap-x-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                  fill
                    ? 'grid-cols-[minmax(0,38%)_minmax(0,1fr)_auto] @min-[30rem]/chart:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]'
                    : 'grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]',
                )}
                data-sw-breakdown-row={group.key}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg">
                  <span className="truncate">{group.label}</span>
                  {pressed?.includes(group.key) ? <Check size={12} className="shrink-0 text-accent" aria-hidden="true" /> : null}
                </span>
                <span className="relative block h-3 min-w-0">
                  {unknown ? (
                    <span
                      className="absolute inset-y-0 left-0 w-full rounded-r"
                      style={{ background: `repeating-linear-gradient(45deg, ${theme.axis} 0 1.5px, transparent 1.5px 5px)` }}
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="absolute inset-y-0 left-0 rounded-r"
                      style={{ width: `${Math.max((value / max) * 100, value ? 0.6 : 0)}%`, background: color }}
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span className="tabular flex items-baseline gap-2 text-xs">
                  <span className={cn('font-medium', unknown ? 'text-muted' : 'text-fg')}>{formatMetric(metric, value)}</span>
                  {showShare ? (
                    <span className="w-11 text-right text-muted" data-sw-breakdown-share>
                      {unknown ? '' : percent(value, total)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {ranked.length > count ? (
        <div className="shrink-0 px-3 pt-1 print:hidden">
          <Button size="xs" variant="ghost" onClick={() => setAll(!all)} data-sw-breakdown-all>
            {all ? `Show the top ${count}` : `Show all ${ranked.length}`}
          </Button>
        </div>
      ) : null}
    </ChartCard>
  )
}

// ---- Outcomes: a rate over time ----

// `mode`: each outcome's share of a bucket's turns (the default), or how many turns.
export function OutcomesChart({
  data,
  bucket,
  state,
  onPick,
  pressed,
  mode = 'share',
  fill = false,
  header = true,
  menu = null,
  view = null,
  onView = null,
}) {
  const theme = useChartTheme()
  const counts = mode === 'counts'
  const rows = useMemo(() => {
    if (!data) return []
    const found = new Map(data.points.map((point) => [point.bucket, point]))
    return data.buckets.map((key) => {
      const point = found.get(key)
      const row = { bucket: key, calls: point?.calls || 0 }
      // Shares of the turns of the bucket; a bucket with none stays empty.
      for (const id of OUTCOME_GROUP_IDS)
        row[id] = point?.calls ? (counts ? point.outcomes[id] || 0 : (point.outcomes[id] || 0) / point.calls) : undefined
      row.counts = point?.outcomes || {}
      return row
    })
  }, [data, counts])
  const totals = Object.fromEntries(OUTCOME_GROUP_IDS.map((id) => [id, rows.reduce((sum, row) => sum + (row.counts[id] || 0), 0)]))
  const all = Object.values(totals).reduce((a, b) => a + b, 0)
  const present = OUTCOME_GROUP_IDS.filter((id) => totals[id] > 0)
  const legend = present.map((id) => ({
    key: id,
    label: OUTCOME_GROUP_LABEL[id],
    color: theme.status[id],
    icon: OUTCOME_ICON[id],
    value: percent(totals[id], all),
  }))
  const table = {
    columns: [
      bucket === 'month' ? 'Month' : bucket === 'week' ? 'Week of' : 'Day',
      ...present.map((id) => OUTCOME_GROUP_LABEL[id]),
      'Turns',
    ],
    rows: rows.map((row) => [
      bucketLabel(row.bucket, bucket, { long: true }),
      ...present.map((id) => formatCount(row.counts[id] || 0, { exact: true })),
      formatCount(row.calls, { exact: true }),
    ]),
  }
  return (
    <ChartCard
      title="How turns ended"
      subtitle={counts ? 'The turns of each outcome, per bucket.' : 'The share of each outcome, per bucket.'}
      table={table}
      legend={legend}
      state={state}
      empty={data && !all}
      testId="outcomes"
      fill={fill}
      header={header}
      menu={menu}
      view={view}
      onView={onView}
    >
      <Plot fill={fill} height={220} data-sw-outcomes-mode={mode}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="32%" accessibilityLayer>
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis dataKey="bucket" tickFormatter={(key) => bucketLabel(key, bucket)} minTickGap={22} {...axisProps(theme)} />
          {counts ? (
            <YAxis
              width={40}
              allowDecimals={false}
              tickFormatter={(value) => formatAxis('calls', value)}
              {...axisProps(theme)}
              axisLine={false}
            />
          ) : (
            <YAxis
              width={40}
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(value) => `${Math.round(value * 100)}%`}
              {...axisProps(theme)}
              axisLine={false}
            />
          )}
          <Tooltip
            cursor={{ fill: theme.track, opacity: 0.7 }}
            isAnimationActive={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0].payload
              return (
                <TooltipBox
                  title={bucketLabel(label, bucket, { long: true })}
                  rows={present
                    .filter((id) => row.counts[id])
                    .map((id) => ({
                      label: OUTCOME_GROUP_LABEL[id],
                      value: `${percent(row.counts[id], row.calls)} (${formatCount(row.counts[id], { exact: true })})`,
                      color: theme.status[id],
                    }))}
                  footer={`${formatCount(row.calls, { exact: true })} ${row.calls === 1 ? 'turn' : 'turns'}`}
                />
              )
            }}
          />
          {present.map((id) => (
            <Bar
              key={id}
              dataKey={id}
              name={OUTCOME_GROUP_LABEL[id]}
              stackId="stack"
              fill={theme.status[id]}
              stroke={theme.surface}
              strokeWidth={1}
              maxBarSize={16}
              isAnimationActive={false}
              cursor={onPick ? 'pointer' : undefined}
              onClick={onPick ? () => onPick(id) : undefined}
            />
          ))}
        </BarChart>
      </Plot>
      <Legend items={legend} onPick={onPick} pressed={pressed} fill={fill} />
    </ChartCard>
  )
}

// ---- Approvals ----

// `mode`: one stacked bar per bucket (the default), or the three ends side by side.
export function ApprovalsChart({
  data,
  bucket,
  state,
  mode = 'stacked',
  fill = false,
  header = true,
  menu = null,
  view = null,
  onView = null,
}) {
  const theme = useChartTheme()
  const stack = mode === 'separate' ? undefined : 'stack'
  const series = [
    { key: 'person', label: 'Allowed by a person', color: theme.series[0] },
    { key: 'auto', label: 'Allowed without asking', color: theme.series[3] },
    { key: 'denied', label: 'Denied, expired or cancelled', color: theme.status.failed },
  ]
  const rows = useMemo(() => {
    if (!data) return []
    const found = new Map(data.points.map((point) => [point.bucket, point]))
    return data.buckets.map((key) => {
      const approvals = found.get(key)?.approvals
      const asked = approvals?.asked || 0
      const auto = approvals?.auto || 0
      return {
        bucket: key,
        asked,
        person: asked ? Math.max(0, (approvals.allowed || 0) - auto) : undefined,
        auto: asked ? auto : undefined,
        denied: asked ? approvals.denied || 0 : undefined,
      }
    })
  }, [data])
  const totals = Object.fromEntries(
    ['asked', 'person', 'auto', 'denied'].map((key) => [key, rows.reduce((sum, row) => sum + (row[key] || 0), 0)]),
  )
  const legend = series.map((item) => ({ ...item, value: formatCount(totals[item.key]), fixed: true }))
  const table = {
    columns: [bucket === 'month' ? 'Month' : bucket === 'week' ? 'Week of' : 'Day', 'Asked', ...series.map((item) => item.label)],
    rows: rows.map((row) => [bucketLabel(row.bucket, bucket, { long: true }), row.asked, row.person ?? 0, row.auto ?? 0, row.denied ?? 0]),
  }
  return (
    <ChartCard
      title="Approvals"
      subtitle="What agents asked to do during fixes, and how each request ended."
      table={table}
      legend={legend}
      state={state}
      empty={data && !totals.asked ? 'No agent asked for an approval in this period.' : false}
      emptyTitle="No approvals asked"
      testId="approvals"
      fill={fill}
      header={header}
      menu={menu}
      view={view}
      onView={onView}
    >
      <Plot fill={fill} height={220} data-sw-approvals-mode={mode}>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%" accessibilityLayer>
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis dataKey="bucket" tickFormatter={(key) => bucketLabel(key, bucket)} minTickGap={22} {...axisProps(theme)} />
          <YAxis
            width={40}
            allowDecimals={false}
            tickFormatter={(value) => formatAxis('calls', value)}
            {...axisProps(theme)}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: theme.track, opacity: 0.7 }}
            isAnimationActive={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0].payload
              return (
                <TooltipBox
                  title={bucketLabel(label, bucket, { long: true })}
                  rows={series
                    .map((item) => ({ label: item.label, value: formatCount(row[item.key] || 0, { exact: true }), color: item.color }))
                    .reverse()}
                  footer={`${formatCount(row.asked, { exact: true })} asked`}
                />
              )
            }}
          />
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              name={item.label}
              stackId={stack}
              fill={item.color}
              stroke={theme.surface}
              strokeWidth={1}
              maxBarSize={stack ? 24 : 12}
              radius={!stack || index === series.length - 1 ? [3, 3, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </Plot>
      <Legend items={legend} fill={fill} />
    </ChartCard>
  )
}

// ---- Latency: median and 95th percentile ----

const PERCENTILE = {
  p50: { label: 'Median', slot: 0 },
  p90: { label: '90th percentile', slot: 2, dash: '2 3' },
  p95: { label: '95th percentile', slot: 1, dash: '5 3' },
  p99: { label: '99th percentile', slot: 4, dash: '8 3 2 3' },
}
const LOG_TICKS = [1000, 10_000, 60_000, 600_000, 3_600_000, 36_000_000]
// `percentiles`: which lines to draw. `log`: a logarithmic duration axis
// (off unless asked), for when one slow day flattens every other.
export function LatencyChart({
  data,
  bucket,
  state,
  percentiles = ['p50', 'p95'],
  log = false,
  fill = false,
  header = true,
  menu = null,
  view = null,
  onView = null,
}) {
  const theme = useChartTheme()
  const shown = Object.keys(PERCENTILE).filter((key) => percentiles.includes(key))
  // A logarithmic axis has no zero: a turn that took no time at all sits on its floor.
  const plotted = (value) => (value === null || value === undefined ? undefined : log ? Math.max(value, 100) : value)
  const rows = (data?.buckets || []).map((row) => ({ ...row, ...Object.fromEntries(shown.map((key) => [key, plotted(row[key])])) }))
  const any = rows.some((row) => row.turns > 0)
  const series = shown.map((key) => ({
    key,
    label: PERCENTILE[key].label,
    color: theme.series[PERCENTILE[key].slot],
    dash: PERCENTILE[key].dash,
  }))
  const few = rows.filter((row) => row.turns > 0).length <= 31
  const highest = Math.max(1000, ...rows.flatMap((row) => shown.map((key) => row[key] || 0)))
  const lowest = Math.min(highest, ...rows.flatMap((row) => shown.map((key) => row[key] || Infinity)))
  const ticks = log
    ? LOG_TICKS.filter((tick, index) => tick >= lowest / 10 && (tick <= highest || LOG_TICKS[index - 1] < highest))
    : durationTicks(highest)
  const table = {
    columns: [
      bucket === 'month' ? 'Month' : bucket === 'week' ? 'Week of' : 'Day',
      ...series.map((item) => item.label),
      'Longest',
      'Finished turns',
    ],
    rows: (data?.buckets || []).map((row) => [
      bucketLabel(row.bucket, bucket, { long: true }),
      ...shown.map((key) => (row.turns ? formatDuration(row[key]) : '')),
      row.turns ? formatDuration(row.longest) : '',
      row.turns,
    ]),
  }
  return (
    <ChartCard
      title="Turn duration"
      subtitle={
        shown.join() === 'p50,p95'
          ? 'Half the turns finished within the median; 95 in 100 within the 95th percentile. Gaps: no finished turn.'
          : 'How long turns took: the share of them that finished within each line. Gaps: no finished turn.'
      }
      table={table}
      legend={series}
      state={state}
      empty={data && !any}
      testId="latency"
      fill={fill}
      header={header}
      menu={menu}
      view={view}
      onView={onView}
    >
      <Plot fill={fill} height={220} data-sw-latency-scale={log ? 'log' : 'linear'} data-sw-latency-lines={shown.join(' ')}>
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis dataKey="bucket" tickFormatter={(key) => bucketLabel(key, bucket)} minTickGap={22} {...axisProps(theme)} />
          {log ? (
            <YAxis
              width={52}
              scale="log"
              ticks={ticks}
              domain={[ticks[0], ticks.at(-1)]}
              allowDataOverflow
              tickFormatter={formatDurationTick}
              {...axisProps(theme)}
              axisLine={false}
            />
          ) : (
            <YAxis
              width={52}
              ticks={ticks}
              domain={[0, ticks.at(-1)]}
              tickFormatter={formatDurationTick}
              {...axisProps(theme)}
              axisLine={false}
            />
          )}
          <Tooltip
            cursor={{ stroke: theme.axis }}
            isAnimationActive={false}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = (data?.buckets || []).find((item) => item.bucket === payload[0].payload.bucket) || payload[0].payload
              return (
                <TooltipBox
                  title={bucketLabel(label, bucket, { long: true })}
                  rows={[...series]
                    .reverse()
                    .map((item) => ({ label: item.label, value: formatDuration(row[item.key]), color: item.color }))}
                  footer={`${formatCount(row.turns, { exact: true })} finished ${row.turns === 1 ? 'turn' : 'turns'} · longest ${formatDuration(row.longest)}`}
                />
              )
            }}
          />
          {series.map((item) => (
            <Line
              key={item.key}
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={2}
              strokeDasharray={item.dash}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={few ? { r: 3, fill: item.color, stroke: theme.surface, strokeWidth: 2 } : false}
              activeDot={{ r: 4, stroke: theme.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </Plot>
      <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 px-3 pt-1 text-xs text-fg', fill && 'shrink-0')} data-sw-chart-legend>
        {series.map((item) => (
          <li key={item.key} className="inline-flex items-center gap-1.5">
            <svg width="18" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="18" y2="3" stroke={item.color} strokeWidth="2" strokeDasharray={item.dash} />
            </svg>
            {item.label}
          </li>
        ))}
      </ul>
    </ChartCard>
  )
}

// A 12-point sparkline for a tile: the trend only, no axis, no numbers.
export function Sparkline({ values, color, width = 96, height = 24 }) {
  const known = values.filter((value) => value !== null && value !== undefined)
  if (known.length < 2) return <span style={{ width, height }} className="inline-block" />
  const max = Math.max(...known, 1)
  const step = width / (values.length - 1)
  let path = ''
  let pen = false
  values.forEach((value, index) => {
    if (value === null || value === undefined) {
      pen = false
      return
    }
    path += `${pen ? 'L' : 'M'}${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`
    pen = true
  })
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0">
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
