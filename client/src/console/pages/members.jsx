// Members: everyone in the workspace with their role, when they joined and
// when they were last active. Admins change members and viewers; owners
// change anyone. Every change asks first; the server enforces the rules.

import { useEffect, useMemo, useState } from 'react'
import { MoreHorizontal, Search, ShieldCheck, UserMinus, UserPlus, Users } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui'
import { Avatar, Card, CheckToggle, ConfirmDialog, PageHeader, RoleBadge, Time } from '../components'
import { api, wsUrl } from '../lib/api'
import { ROLES, ROLE_LABEL, ROLE_SUMMARY } from '../lib/format'
import { assignableRoles, canRemoveMember } from '../../../../src/hosted/permissions.js'
import { Link, leaveTo } from '../lib/router'
import { useAction, useLoad, useSession, useToast } from '../state'
import { InviteDialog } from './invites'
import { useWorkspace } from './workspace'
import { TailnetVisitors } from './tailnet'

export function MembersSection() {
  const { data, role, isAdmin, workspaceId, reload } = useWorkspace()
  const { me, refresh } = useSession()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [inviting, setInviting] = useState(false)
  const [change, setChange] = useState(null) // { member, role }
  const [removing, setRemoving] = useState(null)
  const action = useAction()
  const owners = data.members.filter((item) => item.role === 'owner').length
  // Removing someone else revokes the API tokens they made; the dialog
  // lists them and can keep them instead (unchecked), inactive: a token
  // works only while its maker is an admin here.
  const removingOther = Boolean(removing) && removing.userId !== me.user.id
  const tokenList = useLoad(isAdmin && removingOther ? wsUrl(workspaceId, '/tokens') : null)
  const theirTokens = removingOther
    ? (tokenList.data?.tokens || []).filter((token) => token.status === 'active' && token.createdBy?.userId === removing.userId)
    : []
  const [revokeTokens, setRevokeTokens] = useState(true)
  useEffect(() => {
    if (removing) setRevokeTokens(true)
  }, [removing])

  const members = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const order = { owner: 0, admin: 1, member: 2, viewer: 3 }
    return data.members
      .filter((item) => !needle || item.displayName.toLowerCase().includes(needle) || item.handle.includes(needle))
      .sort((a, b) => order[a.role] - order[b.role] || a.displayName.localeCompare(b.displayName))
  }, [data.members, query])

  const confirmChange = () =>
    action.run(async () => {
      await api.patch(wsUrl(workspaceId, `/members/${change.member.userId}`), { role: change.role })
      const self = change.member.userId === me.user.id
      setChange(null)
      toast(`${change.member.displayName} is now ${ROLE_LABEL[change.role].toLowerCase()}`)
      await reload()
      if (self) await refresh()
    })
  const confirmRemove = () =>
    action.run(async () => {
      const self = removing.userId === me.user.id
      const result = await api.delete(
        wsUrl(workspaceId, `/members/${removing.userId}`),
        !self && theirTokens.length && !revokeTokens ? { revokeTokens: false } : {},
      )
      if (self) {
        leaveTo('/')
        return
      }
      setRemoving(null)
      const tokens = result?.revoked?.tokens || 0
      toast(
        tokens
          ? `Removed ${removing.displayName} and revoked ${tokens} API ${tokens === 1 ? 'token' : 'tokens'}`
          : `Removed ${removing.displayName}`,
      )
      await reload()
    })

  return (
    <>
      <PageHeader
        title="Members"
        description={`${data.members.length} ${data.members.length === 1 ? 'person' : 'people'} in ${data.workspace.name}. Roles apply to every project.`}
        actions={
          <>
            {isAdmin ? (
              <Button asChild size="touch" variant="secondary" className="lg:h-9">
                <Link to={`/w/${workspaceId}/access#roles`}>
                  <ShieldCheck size={15} aria-hidden="true" /> Roles and permissions
                </Link>
              </Button>
            ) : (
              <Button
                size="touch"
                variant="secondary"
                className="lg:h-9"
                onClick={() => document.getElementById('roles')?.scrollIntoView({ behavior: 'smooth' })}
              >
                <ShieldCheck size={15} aria-hidden="true" /> Roles and permissions
              </Button>
            )}
            {isAdmin ? (
              <Button size="touch" variant="default" onClick={() => setInviting(true)} className="lg:h-9" data-sw-invite-people>
                <UserPlus size={16} aria-hidden="true" /> Invite people
              </Button>
            ) : null}
          </>
        }
      />
      {isAdmin ? <TailnetVisitors /> : null}
      <Card>
        <div className="border-b border-line p-3 sm:px-5">
          <Input
            size="touch"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or handle"
            aria-label="Search members"
            className="lg:h-9 lg:text-sm"
          />
        </div>
        <div className="hidden grid-cols-[minmax(0,2fr)_10rem_8rem_8rem_3rem] gap-3 border-b border-line px-5 py-2 text-[11px] font-medium tracking-wide text-faint uppercase md:grid">
          <span>Person</span>
          <span>Role</span>
          <span>Joined</span>
          <span>Last active</span>
          <span className="sr-only">Actions</span>
        </div>
        {members.length ? (
          <ul className="divide-y divide-line" data-sw-members>
            {members.map((member) => {
              const self = member.userId === me.user.id
              const options = assignableRoles(role, member.role)
              const removable = !self && canRemoveMember(role, member.role)
              const lastOwner = member.role === 'owner' && owners <= 1
              return (
                <li
                  key={member.userId}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5 md:grid-cols-[minmax(0,2fr)_10rem_8rem_8rem_3rem]"
                  data-sw-member={member.handle}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={member.displayName} person />
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                        <span className="truncate">{member.displayName}</span>
                        {self ? <span className="shrink-0 text-xs font-normal text-faint">(you)</span> : null}
                      </p>
                      <p className="truncate text-xs text-muted">@{member.handle}</p>
                    </div>
                  </div>
                  <div className="col-start-1 row-start-2 md:col-start-auto md:row-start-auto">
                    {options.length && !(lastOwner && self) ? (
                      <Select
                        value={member.role}
                        onValueChange={(next) => (next !== member.role ? setChange({ member, role: next }) : null)}
                      >
                        <SelectTrigger
                          size="touch"
                          className="w-36 lg:h-8"
                          aria-label={`Role of ${member.displayName}`}
                          data-sw-role-select={member.handle}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((item) => (
                            <SelectItem key={item} value={item} disabled={lastOwner && item !== 'owner'}>
                              {ROLE_LABEL[item]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <RoleBadge role={member.role} />
                    )}
                  </div>
                  <div className="hidden text-xs text-muted md:block">
                    <Time value={member.joinedAt} />
                  </div>
                  <div className="col-start-1 row-start-3 text-xs text-muted md:col-start-auto md:row-start-auto">
                    <span className="md:hidden">Active </span>
                    <Time value={member.lastActiveAt} empty="Not yet" />
                    <span className="md:hidden">
                      {' '}
                      · joined <Time value={member.joinedAt} />
                    </span>
                  </div>
                  <div className="col-start-2 row-span-3 row-start-1 self-start md:col-start-auto md:row-span-1 md:row-start-auto md:self-center">
                    {removable || self ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="lg:h-8 lg:w-8"
                            aria-label={`Actions for ${member.displayName}`}
                            data-sw-member-menu={member.handle}
                          >
                            <MoreHorizontal size={16} aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {self ? (
                            <DropdownMenuItem tone="danger" disabled={lastOwner} onSelect={() => setRemoving(member)} data-sw-leave>
                              <UserMinus size={14} aria-hidden="true" />{' '}
                              {lastOwner ? 'Leave (make another owner first)' : 'Leave workspace'}
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem tone="danger" onSelect={() => setRemoving(member)} data-sw-remove-member>
                              <UserMinus size={14} aria-hidden="true" /> Remove from workspace
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <EmptyState icon={Users} title="Nobody matches">
            Try another name or handle.
          </EmptyState>
        )}
      </Card>
      {!isAdmin ? (
        <Card className="mt-5" id="roles">
          <div className="px-4 py-3.5 sm:px-5">
            <h2 className="text-[15px] font-semibold text-fg">Roles</h2>
            <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
              {ROLES.map((item) => (
                <div key={item} className="flex gap-2">
                  <dt className="w-16 shrink-0">
                    <RoleBadge role={item} />
                  </dt>
                  <dd className="text-muted">{ROLE_SUMMARY[item]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Card>
      ) : null}

      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
      <ConfirmDialog
        open={Boolean(change)}
        onClose={() => setChange(null)}
        title={change ? `Make ${change.member.displayName} ${ROLE_LABEL[change.role].toLowerCase()}?` : ''}
        confirmLabel="Change role"
        tone={change && ROLES.indexOf(change.role) < ROLES.indexOf(change.member.role) ? 'danger' : 'default'}
        busy={action.busy}
        error={action.error}
        onConfirm={confirmChange}
      >
        {change ? (
          <>
            <p>
              <span className="font-medium text-fg">{ROLE_LABEL[change.role]}:</span> {ROLE_SUMMARY[change.role]}
            </p>
            <p>
              The change applies to every project in the workspace at once{change.member.userId === me.user.id ? ', including for you' : ''}
              .
            </p>
            {['owner', 'admin'].includes(change.member.role) && !['owner', 'admin'].includes(change.role) ? (
              <p>Their pending invites, share links and API tokens are revoked.</p>
            ) : null}
            {change.member.role === 'owner' && change.role === 'admin' ? <p>Their pending owner invites are revoked.</p> : null}
            {change.role === 'owner' || change.member.role === 'owner' ? (
              <p className="text-xs">Making, changing or removing an owner always asks for your passkey.</p>
            ) : null}
          </>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={removing?.userId === me.user.id ? `Leave ${data.workspace.name}?` : `Remove ${removing?.displayName}?`}
        confirmLabel={removing?.userId === me.user.id ? 'Leave workspace' : 'Remove'}
        tone="danger"
        busy={action.busy}
        error={action.error}
        onConfirm={confirmRemove}
      >
        {removing?.userId === me.user.id ? (
          <p>
            You lose access to every project here, and your pending invites, share links and API tokens are revoked. An admin can invite you
            again.
          </p>
        ) : (
          <>
            <p>They lose access to every project at once. Their comments stay.</p>
            {['owner', 'admin'].includes(removing?.role) ? <p>Their pending invites and share links are revoked.</p> : null}
            {!isAdmin ? null : tokenList.loading ? (
              <p>Checking their API tokens...</p>
            ) : tokenList.error ? (
              <p className="text-warn" data-sw-remove-tokens-unknown>
                Their API tokens could not be checked ({tokenList.error.message}). Any that still work are revoked with them.
              </p>
            ) : theirTokens.length ? (
              <>
                <CheckToggle checked={revokeTokens} onChange={setRevokeTokens} id="remove-revoke-tokens">
                  Revoke the {theirTokens.length} API {theirTokens.length === 1 ? 'token' : 'tokens'} they made (
                  {theirTokens.map((token) => token.name).join(', ')})
                </CheckToggle>
                {!revokeTokens ? (
                  <p className="text-warn">
                    Kept tokens stop working anyway while they are not an admin here, and work again if they come back as one.
                  </p>
                ) : null}
              </>
            ) : (
              <p>They made no API tokens that still work.</p>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  )
}
