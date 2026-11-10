// Access overview: who (people, API tokens, share links) can do what in
// which project. People get their workspace role on every project; tokens
// and share links reach one project each.

import { useState } from 'react'
import { Check, Eye, KeyRound, Link2, Lock, Minus, ShieldCheck, Users } from 'lucide-react'
import {
  Badge,
  EmptyState,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../components/ui'
import { cn } from '../../lib/utils'
import { Avatar, Card, CardHeader, Field, LoadError, Loading, Notice, PageHeader, RoleBadge, Time } from '../components'
import { wsUrl } from '../lib/api'
import { ACCESS_LABEL, CAPABILITIES, ROLES, ROLE_LABEL, ROLE_SUMMARY, formatDate, roleAtLeast } from '../lib/format'
import { Link, currentHash } from '../lib/router'
import { useLoad } from '../state'
import { ShareModeBadge } from './shares'
import { ScopeBadges } from './tokens'
import { useWorkspace } from './workspace'

const ACCESS_TONE = { own: 'solid', manage: 'accent', comment: 'ok', view: 'neutral' }

function AccessBadge({ level }) {
  return (
    <Badge tone={ACCESS_TONE[level]} className="px-2 py-0.5 text-[11px]" data-sw-access={level}>
      {ACCESS_LABEL[level]}
    </Badge>
  )
}

// A short dash as tall as the pills beside it, from the same left edge, so
// it sits on their line.
const NoAccess = () => (
  <span className="inline-flex h-[22px] items-center align-middle text-faint">
    <span className="h-[1.5px] w-2.5 rounded-full bg-current" aria-hidden="true" />
    <span className="sr-only">No access</span>
  </span>
)

export function AccessSection() {
  const { workspaceId } = useWorkspace()
  const access = useLoad(wsUrl(workspaceId, '/access'))
  const [tab, setTab] = useState(() => (currentHash() === '#roles' ? 'roles' : 'projects'))
  return (
    <>
      <PageHeader
        title="Access"
        description="Who can reach which project, and with what. People get their role everywhere; tokens and share links reach one project."
      />
      {access.loading ? <Loading /> : null}
      {access.error ? <LoadError error={access.error} onRetry={access.reload} /> : null}
      {access.data ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4 w-full sm:inline-flex sm:w-auto">
            <TabsTrigger value="projects" className="h-11 px-3 lg:h-8" data-sw-tab="projects">
              By project
            </TabsTrigger>
            <TabsTrigger value="people" className="h-11 px-3 lg:h-8" data-sw-tab="people">
              By person
            </TabsTrigger>
            <TabsTrigger value="roles" className="h-11 px-3 lg:h-8" data-sw-tab="roles">
              Roles
            </TabsTrigger>
          </TabsList>
          <TabsContent value="projects">
            <ByProject data={access.data} />
          </TabsContent>
          <TabsContent value="people">
            <ByPerson data={access.data} />
          </TabsContent>
          <TabsContent value="roles">
            <RolesTable />
          </TabsContent>
        </Tabs>
      ) : null}
    </>
  )
}

// Rows: people, tokens, share links. Columns: projects. A table on wide
// screens; on phones, pick a project and read its list.
function ByProject({ data }) {
  const { workspaceId } = useWorkspace()
  const [picked, setPicked] = useState(data.projects[0]?.id || '')
  if (!data.projects.length) {
    return (
      <Card>
        <EmptyState icon={ShieldCheck} title="No projects yet">
          People still have their roles; tokens and share links come with projects.
        </EmptyState>
      </Card>
    )
  }
  const rows = [
    ...data.people.map((person) => ({
      key: person.userId,
      kind: 'person',
      label: person.displayName,
      sub: `@${person.handle}`,
      badge: <RoleBadge role={person.role} />,
      reaches: () => true,
      cell: () => <AccessBadge level={person.access} />,
    })),
    ...data.tokens.map((token) => ({
      key: token.id,
      kind: 'token',
      label: token.name,
      sub: `${token.prefix}…${token.createdBy?.left ? ' · maker left' : ''}`,
      warn: token.createdBy?.left,
      reaches: (projectId) => projectId === token.projectId,
      cell: (projectId) => (projectId === token.projectId ? <ScopeBadges scopes={token.scopes} /> : <NoAccess />),
    })),
    ...data.shares.map((share) => ({
      key: share.id,
      kind: 'share',
      label: share.name,
      sub: `Guests · expires ${formatDate(share.expiresAt)}`,
      lock: share.passcode,
      reaches: (projectId) => projectId === share.projectId,
      cell: (projectId) => (projectId === share.projectId ? <ShareModeBadge mode={share.mode} /> : <NoAccess />),
    })),
  ]
  const KIND_ICON = { person: Users, token: KeyRound, share: Link2 }
  const project = data.projects.find((item) => item.id === picked)
  const pendingCount = Object.values(data.pendingInvites).reduce((sum, n) => sum + n, 0)
  return (
    <div className="space-y-4">
      {pendingCount ? (
        <Notice
          tone="info"
          action={
            <Link
              to={`/w/${workspaceId}/invites`}
              className="inline-flex h-11 items-center text-sm font-medium text-accent underline-offset-2 hover:underline lg:h-auto"
            >
              Invites
            </Link>
          }
        >
          {pendingCount} pending {pendingCount === 1 ? 'invite' : 'invites'} will add{' '}
          {Object.entries(data.pendingInvites)
            .map(([role, n]) => `${n} ${ROLE_LABEL[role].toLowerCase()}${n === 1 ? '' : 's'}`)
            .join(', ')}{' '}
          when used.
        </Notice>
      ) : null}
      {!data.shareLinksOn ? <p className="text-xs text-muted">Share links are off in this workspace.</p> : null}

      {/* Wide screens: the matrix. */}
      <Card className="hidden overflow-x-auto md:block" data-sw-access-matrix>
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            {/* One header style for "Who" and the project names. */}
            <tr className="border-b border-line text-left text-[12px] font-medium text-muted">
              <th scope="col" className="sticky left-0 bg-surface px-5 py-2.5 font-medium">
                Who
              </th>
              {data.projects.map((item) => (
                <th key={item.id} scope="col" className="px-3 py-2.5 font-medium">
                  {item.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              const Icon = KIND_ICON[row.kind]
              return (
                <tr key={row.key} data-sw-access-row={row.kind}>
                  <th scope="row" className="sticky left-0 bg-surface px-5 py-2.5 text-left font-normal">
                    <div className="flex items-center gap-2.5">
                      <Icon size={15} className="shrink-0 text-faint" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate font-medium text-fg">
                          {row.label}
                          {row.lock ? (
                            <>
                              <Lock size={12} className="text-muted" aria-hidden="true" />
                              <span className="sr-only">(passcode)</span>
                            </>
                          ) : null}
                        </p>
                        <p className={cn('truncate text-xs', row.warn ? 'text-warn' : 'text-muted')}>{row.sub}</p>
                      </div>
                      {row.badge ? <span className="ml-auto pl-2">{row.badge}</span> : null}
                    </div>
                  </th>
                  {data.projects.map((item) => (
                    <td key={item.id} className="px-3 py-2.5">
                      {row.cell(item.id)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      {/* Phones: one project at a time. */}
      <div className="space-y-3 md:hidden">
        <Field label="Project">
          {(props) => (
            <Select value={picked} onValueChange={setPicked}>
              <SelectTrigger size="touch" className="w-full" {...props} data-sw-access-project>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data.projects.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Card>
          <ul className="divide-y divide-line">
            {rows
              .filter((row) => row.reaches(project.id))
              .map((row) => {
                const Icon = KIND_ICON[row.kind]
                return (
                  <li key={row.key} className="flex items-center gap-3 px-4 py-3">
                    <Icon size={15} className="shrink-0 text-faint" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{row.label}</p>
                      <p className={cn('truncate text-xs', row.warn ? 'text-warn' : 'text-muted')}>{row.sub}</p>
                    </div>
                    <div className="shrink-0">{row.cell(project.id)}</div>
                  </li>
                )
              })}
          </ul>
        </Card>
      </div>
    </div>
  )
}

// One person (or token, or link): what they reach and what that allows.
function ByPerson({ data }) {
  const [picked, setPicked] = useState(data.people[0] ? `person:${data.people[0].userId}` : '')
  const [kind, id] = picked.split(':')
  const person = kind === 'person' ? data.people.find((item) => item.userId === id) : null
  const token = kind === 'token' ? data.tokens.find((item) => item.id === id) : null
  const share = kind === 'share' ? data.shares.find((item) => item.id === id) : null
  const projectName = (projectId) => data.projects.find((item) => item.id === projectId)?.name || 'a deleted project'
  return (
    <div className="space-y-4">
      <Field label="Show access for">
        {(props) => (
          <Select value={picked} onValueChange={setPicked}>
            <SelectTrigger size="touch" className="w-full sm:w-96" {...props} data-sw-access-person>
              <SelectValue placeholder="Pick someone" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>People</SelectLabel>
                {data.people.map((item) => (
                  <SelectItem key={item.userId} value={`person:${item.userId}`}>
                    {item.displayName} (@{item.handle})
                  </SelectItem>
                ))}
              </SelectGroup>
              {data.tokens.length ? (
                <SelectGroup>
                  <SelectLabel>API tokens</SelectLabel>
                  {data.tokens.map((item) => (
                    <SelectItem key={item.id} value={`token:${item.id}`}>
                      {item.name} ({item.prefix}…)
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {data.shares.length ? (
                <SelectGroup>
                  <SelectLabel>Share links</SelectLabel>
                  {data.shares.map((item) => (
                    <SelectItem key={item.id} value={`share:${item.id}`}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
            </SelectContent>
          </Select>
        )}
      </Field>
      {person ? (
        <Card data-sw-access-detail="person">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-4 sm:px-5">
            <Avatar name={person.displayName} person className="h-11 w-11 text-sm" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-fg">{person.displayName}</p>
              <p className="text-xs text-muted">
                @{person.handle} · joined <Time value={person.joinedAt} /> · active <Time value={person.lastActiveAt} empty="not yet" />
              </p>
            </div>
            <RoleBadge role={person.role} />
          </div>
          <div className="grid gap-5 px-4 py-4 sm:px-5 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-fg">Projects</h3>
              {data.projects.length ? (
                <ul className="space-y-1.5">
                  {data.projects.map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-fg">{item.name}</span>
                      <AccessBadge level={person.access} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No projects yet.</p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-fg">As {ROLE_LABEL[person.role].toLowerCase()}, they can</h3>
              <ul className="space-y-1.5 text-sm">
                {CAPABILITIES.map(([label, least]) => {
                  const yes = roleAtLeast(person.role, least)
                  return (
                    <li key={label} className={cn('flex items-start gap-2', yes ? 'text-fg' : 'text-faint line-through')}>
                      {yes ? (
                        <Check size={14} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
                      ) : (
                        <Minus size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                      )}
                      <span className="sr-only">{yes ? 'Can:' : 'Cannot:'}</span>
                      {label}
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
          {data.tokens.some((item) => item.createdBy?.userId === person.userId) ? (
            <div className="border-t border-line px-4 py-4 sm:px-5">
              <h3 className="mb-2 text-[13px] font-semibold text-fg">Tokens they made</h3>
              <ul className="space-y-1.5 text-sm">
                {data.tokens
                  .filter((item) => item.createdBy?.userId === person.userId)
                  .map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-2">
                      <KeyRound size={13} className="text-faint" aria-hidden="true" />
                      <span className="text-fg">{item.name}</span>
                      <span className="text-xs text-muted">in {projectName(item.projectId)}</span>
                      <ScopeBadges scopes={item.scopes} />
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}
      {token ? (
        <Card data-sw-access-detail="token">
          <CardHeader icon={KeyRound} title={token.name} description={`${token.prefix}… · ${projectName(token.projectId)} only`} />
          <div className="space-y-2 px-4 py-4 text-sm sm:px-5">
            <ScopeBadges scopes={token.scopes} />
            <p className="text-muted">
              Made by {token.createdBy?.displayName || 'unknown'} · last used <Time value={token.lastUsedAt} empty="never" /> ·{' '}
              {token.expiresAt ? <Time value={token.expiresAt} prefix="expires " /> : 'no expiry'}
            </p>
            {token.createdBy?.left ? (
              <Notice tone="warn">The person who made this token has left the workspace, so it no longer works. Revoke it.</Notice>
            ) : null}
          </div>
        </Card>
      ) : null}
      {share ? (
        <Card data-sw-access-detail="share">
          <CardHeader icon={Eye} title={share.name} description={`Guests · ${projectName(share.projectId)} only`} />
          <div className="space-y-2 px-4 py-4 text-sm sm:px-5">
            <div className="flex flex-wrap gap-2">
              <ShareModeBadge mode={share.mode} />
              {share.passcode ? (
                <Badge tone="neutral" className="px-2 py-0.5 text-[11px]">
                  <Lock size={11} aria-hidden="true" /> Passcode
                </Badge>
              ) : null}
            </div>
            <p className="text-muted">
              Opened {share.opens} {share.opens === 1 ? 'time' : 'times'} · last <Time value={share.lastUsedAt} empty="never" /> ·{' '}
              <Time value={share.expiresAt} prefix="expires " />
            </p>
            <p className="text-muted">
              Guests see this project's boards and comments
              {share.mode === 'comment' ? ', and add comments and replies marked as a guest' : ''}. Nothing else in the workspace.
            </p>
          </div>
        </Card>
      ) : null}
    </div>
  )
}

export function RolesTable() {
  return (
    <Card data-sw-roles-table>
      <CardHeader
        icon={ShieldCheck}
        title="Roles and permissions"
        description="A role applies to every project in the workspace. Guests come from share links."
      />
      {/* Phones: each thing with the lowest role that can do it (roles build on each other). */}
      <ul className="divide-y divide-line md:hidden" data-sw-roles-list>
        {CAPABILITIES.map(([label, least]) => (
          <li key={label} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 text-fg">{label}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
              <RoleBadge role={least} />
              {least === 'owner' ? 'only' : 'and up'}
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="px-5 py-2.5 text-left text-[11px] font-medium tracking-wide text-faint uppercase">
                Can
              </th>
              {[...ROLES, 'guest'].map((role) => (
                <th key={role} scope="col" className="px-2 py-2.5 text-center">
                  <RoleBadge role={role} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {CAPABILITIES.map(([label, least]) => (
              <tr key={label}>
                <th scope="row" className="px-5 py-2 text-left font-normal text-fg">
                  {label}
                </th>
                {ROLES.map((role) => (
                  <td key={role} className="px-2 py-2 text-center">
                    {roleAtLeast(role, least) ? (
                      <Check size={15} className="mx-auto text-ok" aria-hidden="true" />
                    ) : (
                      <Minus size={15} className="mx-auto text-faint" aria-hidden="true" />
                    )}
                    <span className="sr-only">{roleAtLeast(role, least) ? 'Yes' : 'No'}</span>
                  </td>
                ))}
                <td className="px-2 py-2 text-center">
                  {least === 'viewer' ? (
                    <span className="text-xs text-muted">One project</span>
                  ) : label.startsWith('Comment') ? (
                    <span className="text-xs text-muted">Comment and reply, on comment links</span>
                  ) : (
                    <>
                      <Minus size={15} className="mx-auto text-faint" aria-hidden="true" />
                      <span className="sr-only">No</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="grid gap-2 border-t border-line px-5 py-4 text-sm sm:grid-cols-2">
        {ROLES.map((role) => (
          <div key={role} className="flex gap-2">
            <dt className="w-16 shrink-0">
              <RoleBadge role={role} />
            </dt>
            <dd className="text-muted">{ROLE_SUMMARY[role]}</dd>
          </div>
        ))}
        <div className="flex gap-2">
          <dt className="w-16 shrink-0">
            <RoleBadge role="guest" />
          </dt>
          <dd className="text-muted">Someone with a share link: one project, no account, comments marked as a guest.</dd>
        </div>
      </dl>
    </Card>
  )
}
