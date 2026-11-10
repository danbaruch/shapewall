// Agent feedback: the thumbs up and down people gave chat answers, for the
// owner tuning the agent. Totals, counts per day and per agent, the newest
// ratings with the question and an excerpt of the answer, filters by rating,
// time range and board, and a JSON export. Shared by the local console
// (/api/agent/feedback) and the workspace console (the demo's
// /api/workspaces/:ws/agent-feedback): `baseUrl` and `get` say which.

import { useEffect, useState } from 'react'
import { Download, MessageSquareText, ThumbsDown, ThumbsUp } from 'lucide-react'
import { markdownToPlain } from '../../../../src/agent/plain-text.js'
import {
  Badge,
  Button,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  ToggleGroup,
} from '../../components/ui'
import { Card, CardHeader, FormError, LoadError, Loading, PageHeader, Time } from '../components'
import { saveBlob } from '../lib/api'

export const REASON_LABELS = {
  wrong: 'Wrong',
  ignored: "Didn't do what I asked",
  slow: 'Too slow',
  unsafe: 'Unsafe change',
  other: 'Other',
}
const RANGES = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['365', 'Last year'],
]
const ALL = '__all__'
const percent = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '–')

// Saves the export as a file. The JSON comes through `get`, so it carries the
// same credentials (the local settings token) as every other call.
function saveJson(data) {
  const name = `shapewall-agent-feedback-${String(data.exportedAt || new Date().toISOString()).slice(0, 10)}.json`
  saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name)
}

function useFeedback(get, url) {
  const [state, setState] = useState({ url: null, data: null, error: null })
  const [ticket, setTicket] = useState(0)
  useEffect(() => {
    let live = true
    get(url).then(
      (data) => live && setState({ url, data, error: null }),
      (error) => live && setState((current) => ({ url, data: current.data, error })),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ticket])
  return { ...state, loading: state.url !== url, reload: () => setTicket((value) => value + 1) }
}

export function AgentFeedbackView({ baseUrl, get, touch = false, intro = null }) {
  const [rating, setRating] = useState('all')
  const [days, setDays] = useState('30')
  const [board, setBoard] = useState(ALL)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  const params = new URLSearchParams({ days })
  if (rating !== 'all') params.set('rating', rating)
  if (board !== ALL) params.set('board', board)
  const feedback = useFeedback(get, `${baseUrl}?${params}`)
  const data = feedback.data
  const size = touch ? 'touch' : 'sm'

  const exportAll = async () => {
    setExporting(true)
    setExportError(null)
    try {
      saveJson(await get(`${baseUrl}/export`))
    } catch (error) {
      setExportError(error)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div data-sw-agent-feedback>
      <PageHeader
        title="Agent feedback"
        description="Thumbs up and down on chat answers, with the reasons and notes people gave. Use them to tune your agent's instructions."
        actions={
          <Button
            size="touch"
            variant="secondary"
            onClick={exportAll}
            disabled={exporting}
            className="lg:h-9"
            data-sw-agent-feedback-export
          >
            {exporting ? <Spinner /> : <Download size={15} aria-hidden="true" />} Export JSON
          </Button>
        }
      />
      {intro}
      {exportError ? (
        <div className="mb-4">
          <FormError error={exportError} />
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-sw-agent-feedback-filters>
        <ToggleGroup
          label="Rating"
          large={touch}
          value={rating}
          onChange={setRating}
          options={[
            { id: 'all', label: 'All' },
            { id: 'up', label: 'Up' },
            { id: 'down', label: 'Down' },
          ]}
        />
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger size={size} className="w-40" aria-label="Time range" data-sw-agent-feedback-range>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data?.boards?.length > 1 ? (
          <Select value={board} onValueChange={setBoard}>
            <SelectTrigger size={size} className="w-48" aria-label="Board" data-sw-agent-feedback-board>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All boards</SelectItem>
              {data.boards.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {feedback.loading && data ? <Spinner /> : null}
      </div>

      {!data && feedback.loading ? (
        <Card>
          <Loading label="Loading agent feedback" />
        </Card>
      ) : feedback.error && !data ? (
        <Card className="p-4">
          <LoadError error={feedback.error} onRetry={feedback.reload} />
        </Card>
      ) : data ? (
        <FeedbackBody data={data} />
      ) : null}
    </div>
  )
}

function Stat({ label, value, detail, icon: Icon }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-caption font-medium text-muted">
        {Icon ? <Icon size={13} aria-hidden="true" /> : null}
        {label}
      </p>
      <p className="mt-1 text-heading font-semibold text-fg tabular-nums">{value}</p>
      {detail ? <p className="text-caption text-muted">{detail}</p> : null}
    </Card>
  )
}

function FeedbackBody({ data }) {
  const { summary, items } = data
  const reasons = Object.entries(summary.reasons || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  if (!summary.total) {
    return (
      <Card>
        <EmptyState icon={MessageSquareText} title="No feedback yet">
          When people rate the agent&apos;s answers in the board chat (thumbs up or down under an answer), the ratings show here.
        </EmptyState>
      </Card>
    )
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 sm:gap-3" data-sw-agent-feedback-totals={`${summary.up}/${summary.down}`}>
        <Stat label="Ratings" value={summary.total} detail={`Last ${data.days} days`} />
        <Stat label="Thumbs up" icon={ThumbsUp} value={summary.up} detail={percent(summary.up, summary.total)} />
        <Stat label="Thumbs down" icon={ThumbsDown} value={summary.down} detail={percent(summary.down, summary.total)} />
      </div>
      {reasons.length ? (
        <div className="flex flex-wrap items-center gap-1.5" data-sw-agent-feedback-reasons>
          <span className="text-caption font-medium text-muted">Reasons given:</span>
          {reasons.map(([id, count]) => (
            <Badge key={id}>
              {REASON_LABELS[id] || id} <span className="tabular-nums">{count}</span>
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <CountTable title="Per day" rows={summary.byDay.map((row) => ({ key: row.day, label: dayLabel(row.day), ...row }))} />
        <CountTable title="Per agent" rows={summary.byAgent.map((row) => ({ key: row.agent, label: row.agent, ...row }))} />
      </div>
      <Card data-sw-agent-feedback-items={items.length}>
        <CardHeader
          title="Ratings"
          description={data.more ? `The newest ${items.length}; ${data.more} more in the export.` : 'Newest first.'}
        />
        {items.length ? (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <FeedbackItem key={`${item.boardId}/${item.threadId}/${item.messageId}/${item.rater}`} item={item} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-muted sm:px-5">No ratings match these filters.</p>
        )}
      </Card>
    </div>
  )
}

const dayLabel = (day) => {
  const date = new Date(`${day}T12:00:00Z`)
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function CountTable({ title, rows }) {
  return (
    <Card>
      <CardHeader title={title} />
      <table className="w-full text-ui">
        <thead>
          <tr className="text-caption text-muted">
            <th scope="col" className="px-4 py-2 text-left font-medium sm:px-5">
              {title === 'Per day' ? 'Day' : 'Agent'}
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              <ThumbsUp size={13} aria-hidden="true" className="ml-auto" />
              <span className="sr-only">Thumbs up</span>
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium sm:px-5">
              <ThumbsDown size={13} aria-hidden="true" className="ml-auto" />
              <span className="sr-only">Thumbs down</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.slice(0, 10).map((row) => (
            <tr key={row.key}>
              <th scope="row" className="truncate px-4 py-2 text-left font-normal text-fg sm:px-5">
                {row.label}
              </th>
              <td className="px-2 py-2 text-right text-fg tabular-nums">{row.up}</td>
              <td className="px-4 py-2 text-right text-fg tabular-nums sm:px-5">{row.down}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function FeedbackItem({ item }) {
  const Icon = item.rating === 'up' ? ThumbsUp : ThumbsDown
  return (
    <li className="px-4 py-3 sm:px-5" data-sw-agent-feedback-item={item.rating}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
        <span className="inline-flex items-center gap-1 font-medium text-fg">
          <Icon size={13} aria-hidden="true" />
          {item.rating === 'up' ? 'Thumbs up' : 'Thumbs down'}
        </span>
        <span aria-hidden="true">·</span>
        <span>{item.raterName || 'Someone'}</span>
        <span aria-hidden="true">·</span>
        <span>{item.agentName}</span>
        {item.boardTitle ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{item.boardTitle}</span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <Time value={item.updatedAt} />
      </div>
      {item.reasons?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.reasons.map((id) => (
            <Badge key={id} tone="warn">
              {REASON_LABELS[id] || id}
            </Badge>
          ))}
        </div>
      ) : null}
      {item.note ? <p className="mt-1.5 text-sm break-words whitespace-pre-wrap text-fg">{item.note}</p> : null}
      <dl className="mt-2 space-y-1 rounded-md bg-surface-2/60 px-2.5 py-2 text-ui">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted">Question</dt>
          <dd className="min-w-0 break-words text-fg">{item.question || '(an image or an empty message)'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted">Answer</dt>
          <dd className="line-clamp-3 min-w-0 break-words text-fg/90">{markdownToPlain(item.answer) || '(no text)'}</dd>
        </div>
      </dl>
    </li>
  )
}
