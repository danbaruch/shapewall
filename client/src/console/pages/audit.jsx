// The audit log: who did what, when and from where. Filters by actor,
// action and time range; pages of 50, newest first.

import { useCallback, useEffect, useState } from 'react'
import { Bot, Download, Globe, ScrollText, Search, ServerCog, UserRound, X } from 'lucide-react'
import {
  Button,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '../../components/ui'
import { Card, FormError, LoadError, Loading, PageHeader, Time, demoNote } from '../components'
import { DEMO } from '../../lib/demo'
import { download, wsUrl } from '../lib/api'
import { AUDIT_RANGES, describeAudit, formatDateTime } from '../lib/format'
import { useAction, useLoad, usePagedLoad } from '../state'
import { useWorkspace } from './workspace'

const ACTOR_ICON = { user: UserRound, token: Bot, guest: Globe, system: ServerCog }
const ALL = '__all__'
// "share_created" reads "Share created" in the filter.
const actionLabel = (action) => {
  const text = action.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function AuditSection() {
  const { workspaceId } = useWorkspace()
  const filters = useLoad(wsUrl(workspaceId, '/audit/filters'))
  const [actor, setActor] = useState(ALL)
  const [action, setAction] = useState(ALL)
  const [range, setRange] = useState('any')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const exporter = useAction()
  // Search as you type, without a request per key.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const filterParams = useCallback(() => {
    const params = new URLSearchParams()
    if (actor !== ALL) params.set('actor', actor)
    if (action !== ALL) params.set('action', action)
    const days = AUDIT_RANGES.find(([id]) => id === range)?.[2]
    if (days) params.set('from', new Date(Date.now() - days * 86_400_000).toISOString())
    if (q) params.set('q', q)
    return params
  }, [actor, action, range, q])
  const query = useCallback(
    (before) => {
      const params = filterParams()
      params.set('limit', '50')
      if (before) params.set('before', String(before))
      return wsUrl(workspaceId, `/audit?${params}`)
    },
    [filterParams, workspaceId],
  )
  const exportCsv = () => exporter.run(() => download('GET', wsUrl(workspaceId, `/audit/export?${filterParams()}`), undefined, 'audit.csv'))

  // A filter change makes a new `query`, which starts the list over.
  const state = usePagedLoad(query, 'entries')
  const entries = state.items

  const actors = filters.data?.actors || []
  const actions = filters.data?.actions || []
  const filtered = actor !== ALL || action !== ALL || range !== 'any' || Boolean(q)
  const people = actors.filter((item) => item.type === 'user')
  const tokens = actors.filter((item) => item.type === 'token')
  const guests = actors.filter((item) => item.type === 'guest')
  const actorValue = (item) => `${item.type === 'guest' ? 'share' : item.type}:${item.id}`

  return (
    <>
      <PageHeader
        title="Audit log"
        description={demoNote('Membership, invites, projects, tokens, share links, pushes and moderation in this workspace.')}
        actions={
          <Button
            size="touch"
            variant="secondary"
            onClick={exportCsv}
            disabled={exporter.busy || DEMO}
            className="lg:h-9"
            data-sw-audit-export
          >
            {exporter.busy ? <Spinner /> : <Download size={15} aria-hidden="true" />} Export CSV
          </Button>
        }
      />
      <Card className="mb-4 p-3 sm:p-4" data-sw-audit-filters>
        <div className="mb-2">
          <Input
            size="touch"
            icon={Search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search names, projects, tokens, links"
            aria-label="Search the audit log"
            className="lg:h-9"
            maxLength={100}
            data-sw-audit-search
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <Select value={actor} onValueChange={setActor}>
            <SelectTrigger size="touch" className="w-full lg:h-9" aria-label="Who" data-sw-audit-actor>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Everyone</SelectItem>
              {people.length ? (
                <SelectGroup>
                  <SelectLabel>People</SelectLabel>
                  {people.map((item) => (
                    <SelectItem key={item.id} value={actorValue(item)}>
                      {item.label}
                      {item.handle ? ` (@${item.handle})` : ''}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {tokens.length ? (
                <SelectGroup>
                  <SelectLabel>API tokens</SelectLabel>
                  {tokens.map((item) => (
                    <SelectItem key={item.id} value={actorValue(item)}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {guests.length ? (
                <SelectGroup>
                  <SelectLabel>Share link guests</SelectLabel>
                  {guests.map((item) => (
                    <SelectItem key={item.id} value={actorValue(item)}>
                      {item.link}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger size="touch" className="w-full lg:h-9" aria-label="What" data-sw-audit-action>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All actions</SelectItem>
              {actions.map((item) => (
                <SelectItem key={item} value={item}>
                  {actionLabel(item)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger size="touch" className="w-full lg:h-9" aria-label="When" data-sw-audit-range>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUDIT_RANGES.map(([id, label]) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filtered ? (
          <Button
            size="touch"
            variant="ghost"
            className="mt-2 lg:h-8"
            onClick={() => {
              setActor(ALL)
              setAction(ALL)
              setRange('any')
              setSearch('')
              setQ('')
            }}
          >
            <X size={14} aria-hidden="true" /> Clear filters
          </Button>
        ) : null}
        <FormError error={exporter.error} />
      </Card>
      <Card>
        {state.loading ? <Loading /> : null}
        {state.error ? (
          <div className="p-4">
            <LoadError error={state.error} onRetry={entries.length ? state.loadMore : state.reload} />
          </div>
        ) : null}
        {!state.loading && !state.error && !entries.length ? (
          <EmptyState icon={ScrollText} title={filtered ? 'Nothing matches these filters' : 'No events yet'} />
        ) : null}
        {!state.loading && entries.length ? (
          <ol className="divide-y divide-line" data-sw-audit-list>
            {entries.map((entry) => {
              const Icon = ACTOR_ICON[entry.actor.type] || ServerCog
              return (
                <li key={entry.id} className="flex gap-3 px-4 py-3 sm:px-5" data-sw-audit-entry={entry.action}>
                  <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                    <Icon size={15} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg">
                      <span className="font-medium">{entry.actor.label}</span>
                      {entry.actor.type === 'guest' && entry.actor.named ? <span className="text-muted"> (guest)</span> : null}
                      {entry.actor.type === 'token' ? <span className="text-muted"> (token)</span> : null} {describeAudit(entry)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      <Time value={entry.at} /> <span className="text-faint">· {formatDateTime(entry.at)}</span>
                      {entry.ip ? ` · ${entry.ip}` : ''}
                    </p>
                  </div>
                </li>
              )
            })}
          </ol>
        ) : null}
        {state.next && !state.loading ? (
          <div className="border-t border-line p-3 text-center">
            <Button size="touch" variant="secondary" onClick={state.loadMore} disabled={state.more} className="lg:h-9" data-sw-audit-more>
              {state.more ? <Spinner /> : null} Load older events
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  )
}
