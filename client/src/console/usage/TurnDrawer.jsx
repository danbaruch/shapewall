// One agent turn with everything recorded about it: who asked, which agent
// on which machine, how it ended, how long it took, the numbers the agent
// reported (each "not reported" when it reported none), its tool calls by
// type, its approvals and who answered them, and where it happened, with a
// link there for people who may read it. Never the question or the answer:
// those are in the thread, under the thread's own access rule.

import { ArrowUpRight } from 'lucide-react'
import { Skeleton } from '../../components/ui'
import { KIND_LABEL, OUTCOME_GROUP_LABEL } from '../../../../src/hosted/usage-shape.js'
import { CopyField, LoadError } from '../components'
import { Link } from '../lib/router'
import { useWorkspace } from '../pages/workspace'
import { useWs } from './data'
import { formatCost, formatCount, formatDuration, formatExact, formatTime, percent } from './format'
import { Drawer, Fact, Facts, OutcomeChip, Unreported } from './pieces'
import { useChartTheme } from './theme'

const linkClass = 'inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline'

export function TurnDrawer({ id, onClose }) {
  const { workspaceId, isAdmin, data } = useWorkspace()
  const state = useWs(workspaceId, `/usage/rows/${encodeURIComponent(id)}`, { keep: false })
  const theme = useChartTheme()
  const row = state.data?.row
  const reported = (value, format = formatExact, what) =>
    value === null || value === undefined ? <Unreported what={what} /> : format(value)
  const tools = row?.tools ? Object.entries(row.tools).sort((a, b) => b[1] - a[1]) : []
  const most = Math.max(1, ...tools.map(([, count]) => count))
  // The activity around it: the same agent, from a minute before to a minute after.
  const around =
    row && isAdmin && row.agent
      ? `/w/${workspaceId}/activity?agent=${row.agent.id}&range=custom&from=${row.startedAt.slice(0, 10)}&to=${(row.endedAt || row.startedAt).slice(0, 10)}`
      : null
  return (
    <Drawer
      open
      onClose={onClose}
      title={row ? `${KIND_LABEL[row.kind] || row.kind} by ${row.agent?.name || 'no agent'}` : 'Agent turn'}
      description={row ? formatTime(row.startedAt) : null}
      testId="turn"
    >
      {state.isLoading ? (
        <div className="space-y-3 p-5" role="status">
          <span className="sr-only">Loading the turn</span>
          {[60, 80, 50, 70, 40].map((width, index) => (
            <Skeleton key={index} className="h-4" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : state.error ? (
        <div className="p-5">
          {state.error.status === 404 ? (
            <p className="text-sm text-muted" data-sw-turn-missing>
              This turn is not there, or it is not yours to see. Usage shows a member their own turns and the agents they connected.
            </p>
          ) : (
            <LoadError error={state.error} onRetry={state.refetch} />
          )}
        </div>
      ) : (
        <div data-sw-turn={row.id}>
          <Facts title="What happened">
            <Fact label="Outcome">
              <OutcomeChip outcome={row.outcome} />
              <span className="ml-1.5 text-xs text-muted">({OUTCOME_GROUP_LABEL[row.outcomeGroup]})</span>
            </Fact>
            <Fact label="Started">{formatTime(row.startedAt)}</Fact>
            <Fact label="Ended">{row.endedAt ? formatTime(row.endedAt) : <span className="text-muted">Still running</span>}</Fact>
            <Fact label="Duration">
              {row.durationMs === null ? <span className="text-muted">Still running</span> : formatDuration(row.durationMs)}
            </Fact>
            <Fact label="Agent's own time">{reported(row.agentMs, formatDuration, 'The agent’s own time')}</Fact>
          </Facts>
          <Facts title="Who and where">
            <Fact label="Asked by">
              {row.person ? (
                isAdmin || row.person.id === data.me.userId ? (
                  <Link to={`/w/${workspaceId}/activity/${row.person.id}`} className={linkClass}>
                    {row.person.name}
                  </Link>
                ) : (
                  row.person.name
                )
              ) : (
                <span className="text-muted">Nobody (the agent took it on its own)</span>
              )}
            </Fact>
            <Fact label="Agent">
              {row.agent ? (
                isAdmin ? (
                  <Link to={`/w/${workspaceId}/activity/${row.agent.id}`} className={linkClass}>
                    {row.agent.name}
                  </Link>
                ) : (
                  row.agent.name
                )
              ) : (
                <span className="text-muted">None</span>
              )}
            </Fact>
            <Fact label="Machine">{row.agent?.machine || <span className="text-muted">Not known</span>}</Fact>
            <Fact label="Project">{row.project.name}</Fact>
            <Fact label="Board">{row.boardId || <span className="text-muted">None</span>}</Fact>
            <Fact label="Thread">
              {row.thread
                ? row.thread.kind === 'comment'
                  ? `Comment #${row.commentNumber}`
                  : row.thread.kind === 'chat'
                    ? row.thread.id
                      ? 'Your private chat'
                      : 'A private chat (only its starter reads it)'
                    : 'The board’s chat'
                : row.commentNumber
                  ? `Comment #${row.commentNumber}`
                  : 'None'}
            </Fact>
            {row.link ? (
              <Fact label="Open">
                <a href={row.link.url} className={linkClass} data-sw-turn-link>
                  {row.link.label} <ArrowUpRight size={13} aria-hidden="true" />
                </a>
              </Fact>
            ) : null}
          </Facts>
          <Facts title="As the agent reported">
            <Fact label="Model">{row.model || <Unreported what="Model" />}</Fact>
            <Fact label="Effort">{row.effort || <Unreported what="Effort" />}</Fact>
            <Fact label="Input tokens">{reported(row.inputTokens, formatExact, 'Input tokens')}</Fact>
            <Fact label="Output tokens">{reported(row.outputTokens, formatExact, 'Output tokens')}</Fact>
            <Fact label="Cached tokens">{reported(row.cachedTokens, formatExact, 'Cached tokens')}</Fact>
            <Fact label="Context used">
              {row.contextUsed === null ? (
                <Unreported what="Context" />
              ) : (
                `${formatCount(row.contextUsed, { exact: true })}${row.contextSize ? ` of ${formatCount(row.contextSize, { exact: true })} (${percent(row.contextUsed, row.contextSize)})` : ''}`
              )}
            </Fact>
            <Fact label="Cost">{row.costMicros === null ? <Unreported what="Cost" /> : formatCost(row.costMicros)}</Fact>
          </Facts>
          <Facts title={`Steps${row.steps ? ` (${row.steps})` : ''}`}>
            {tools.length ? (
              <div className="col-span-2 space-y-1" data-sw-turn-tools>
                {tools.map(([name, count]) => (
                  <div key={name} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_2.5rem] items-center gap-2 text-xs">
                    <span className="truncate text-fg">{name}</span>
                    <span className="block h-2.5">
                      <span className="block h-full rounded-r" style={{ width: `${(count / most) * 100}%`, background: theme.series[0] }} />
                    </span>
                    <span className="tabular text-right text-fg">{count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="col-span-2 text-sm text-muted">{row.steps === 0 ? 'No tool call.' : 'No tool call was reported.'}</p>
            )}
          </Facts>
          <Facts title="Approvals">
            {row.approvals.asked ? (
              <>
                <Fact label="Asked">{row.approvals.asked}</Fact>
                <Fact label="Allowed">
                  {row.approvals.allowed ?? 0}
                  {row.approvals.auto ? <span className="text-muted"> ({row.approvals.auto} without asking)</span> : null}
                </Fact>
                <Fact label="Denied">{row.approvals.denied ?? 0}</Fact>
                {row.approvals.by.length ? (
                  <Fact label="Answered by">
                    <ul>
                      {row.approvals.by.map((person) => (
                        <li key={person.userId}>
                          {person.name}: {person.allowed} allowed{person.denied ? `, ${person.denied} denied` : ''}
                        </li>
                      ))}
                    </ul>
                  </Fact>
                ) : null}
              </>
            ) : (
              <p className="col-span-2 text-sm text-muted">
                {row.approvals.asked === 0 ? 'It asked for none.' : 'This kind of turn asks for none.'}
              </p>
            )}
          </Facts>
          <section className="space-y-2 px-5 py-3.5">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Turn id</h3>
            <CopyField value={row.id} label="Copy" testId="turn-id" />
            {around ? (
              <p className="pt-1 text-sm">
                <Link to={around} className={linkClass} data-sw-turn-activity>
                  Activity around this turn <ArrowUpRight size={13} aria-hidden="true" />
                </Link>
              </p>
            ) : null}
          </section>
        </div>
      )}
    </Drawer>
  )
}
