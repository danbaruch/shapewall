// API tokens: what each one can do, who made it (and whether they left;
// such a token is inactive), when it was last used. Tokens are shown once, when made.

import { useMemo, useState } from 'react'
import { AlertTriangle, KeyRound, Pencil, Plus, Terminal } from 'lucide-react'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Toggle,
  ToggleGroup,
} from '../../components/ui'
import {
  Card,
  ConfirmDialog,
  CopyField,
  Field,
  FormError,
  LoadError,
  Loading,
  Notice,
  PageHeader,
  SecretResultDialog,
  Time,
  useSecretResult,
} from '../components'
import { api, serverOrigin, wsUrl } from '../lib/api'
import { SCOPES } from '../lib/format'
import { useAction, useLoad, useToast } from '../state'
import { useWorkspace } from './workspace'

const STATUS_TONE = { active: 'ok', inactive: 'warn', revoked: 'neutral', expired: 'neutral' }
const STATUS_LABEL = { inactive: 'Inactive', revoked: 'Revoked', expired: 'Expired' }
// What a new token starts with. Each one is a toggle in the dialog, so what
// is pressed is exactly what the token gets.
const DEFAULT_SCOPES = ['read', 'reply', 'status', 'resolve']
const EXPIRY = [
  ['never', 'No expiry', null],
  ['30', '30 days', 30],
  ['90', '90 days', 90],
  ['365', '1 year', 365],
]

export function TokensSection() {
  const { workspaceId, data } = useWorkspace()
  const tokens = useLoad(wsUrl(workspaceId, '/tokens'))
  const [filter, setFilter] = useState('active')
  const [creating, setCreating] = useState(false)
  const list = tokens.data?.tokens || []
  const shown = list.filter((item) => (filter === 'all' ? true : filter === 'active' ? item.status === 'active' : item.status !== 'active'))
  // A token works only while its maker is an admin here: these stopped.
  const orphans = list.filter((item) => item.status === 'inactive')
  return (
    <>
      <PageHeader
        title="API tokens"
        description="Tokens let the CLI, CI and agents push captures and work on comments in one project."
        actions={
          <Button
            variant="default"
            size="touch"
            onClick={() => setCreating(true)}
            className="lg:h-9"
            disabled={!data.projects.length}
            data-sw-new-token
          >
            <Plus size={16} aria-hidden="true" /> New token
          </Button>
        }
      />
      {orphans.length ? (
        <Notice
          tone="warn"
          className="mb-4"
          title={`${orphans.length} ${orphans.length === 1 ? 'token stopped' : 'tokens stopped'} working`}
        >
          A token works only while the person who made it is an admin or owner here. These were kept when their maker left or lost the admin
          role, and work again only if they come back as an admin. Revoke them, and make new ones where needed.
        </Notice>
      ) : null}
      <div className="mb-3">
        <ToggleGroup
          label="Show tokens"
          value={filter}
          onChange={setFilter}
          className="w-full sm:inline-flex sm:w-auto"
          itemClassName="h-11 px-3 lg:h-8"
          options={[
            // Counts on every option, so "Not working" matches the notice above.
            { id: 'active', label: 'Active', count: list.filter((item) => item.status === 'active').length },
            { id: 'inactive', label: 'Not working', count: list.filter((item) => item.status !== 'active').length },
            { id: 'all', label: 'All', count: list.length },
          ]}
        />
      </div>
      <Card>
        {tokens.loading ? <Loading /> : null}
        {tokens.error ? (
          <div className="p-4">
            <LoadError error={tokens.error} onRetry={tokens.reload} />
          </div>
        ) : null}
        {!tokens.loading && !tokens.error ? (
          shown.length ? (
            <TokenList tokens={shown} onChanged={tokens.reload} showProject />
          ) : (
            <EmptyState icon={KeyRound} title={filter === 'active' ? 'No active tokens' : 'Nothing here'}>
              {data.projects.length
                ? 'Make a token for a project to push captures or let an agent read comments.'
                : 'Create a project first.'}
            </EmptyState>
          )
        ) : null}
      </Card>
      <CreateToken open={creating} onClose={() => setCreating(false)} projects={data.projects} onCreated={tokens.reload} />
    </>
  )
}

export function ScopeBadges({ scopes }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <Badge key={scope} tone={scope === 'push' ? 'warn' : 'neutral'} className="px-1.5 py-0.5 text-[11px]">
          {scope}
        </Badge>
      ))}
    </span>
  )
}

export function TokenList({ tokens, onChanged, showProject = false }) {
  const { workspaceId } = useWorkspace()
  const toast = useToast()
  const [revoking, setRevoking] = useState(null)
  const revoke = useAction()
  // { token, name }: the token being renamed and what is typed.
  const [renaming, setRenaming] = useState(null)
  const rename = useAction()
  const renamed = renaming?.name.trim() || ''
  const saveName = () =>
    rename.run(async () => {
      await api.patch(wsUrl(workspaceId, `/projects/${renaming.token.projectId}/tokens/${renaming.token.id}`), { name: renamed })
      setRenaming(null)
      toast('Token renamed')
      await onChanged()
    })
  return (
    <>
      <ul className="divide-y divide-line" data-sw-token-list>
        {tokens.map((token) => (
          <li
            key={token.id}
            className="grid gap-2 px-4 py-3 sm:px-5 md:grid-cols-[1.6fr_1fr_1fr_auto] md:items-center"
            data-sw-token={token.name}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium text-fg">{token.name}</p>
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{token.prefix}…</code>
                {token.status !== 'active' ? (
                  <Badge tone={STATUS_TONE[token.status]} className="px-2 py-0.5 text-[11px]">
                    {STATUS_LABEL[token.status] || token.status}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                {showProject ? <span className="font-medium text-fg">{token.projectName}</span> : null}
                <ScopeBadges scopes={token.scopes} />
              </div>
            </div>
            <div className="text-xs text-muted">
              <p>
                By {token.createdBy ? token.createdBy.displayName || `@${token.createdBy.handle}` : 'unknown'}{' '}
                {token.createdBy?.left ? (
                  <Badge tone="warn" className="ml-1 px-1.5 py-0.5 text-[10.5px]" data-sw-token-orphan>
                    <AlertTriangle size={10} aria-hidden="true" /> Left the workspace
                  </Badge>
                ) : token.status === 'inactive' ? (
                  <Badge tone="warn" className="ml-1 px-1.5 py-0.5 text-[10.5px]" data-sw-token-orphan>
                    <AlertTriangle size={10} aria-hidden="true" /> No longer an admin
                  </Badge>
                ) : null}
              </p>
              <p className="mt-0.5">
                Made <Time value={token.createdAt} />
              </p>
            </div>
            <div className="text-xs text-muted">
              <p>
                Last used <Time value={token.lastUsedAt} empty="never" />
              </p>
              <p className="mt-0.5">
                {token.expiresAt ? (
                  <Time value={token.expiresAt} prefix={token.status === 'expired' ? 'Expired ' : 'Expires '} />
                ) : (
                  'No expiry'
                )}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 md:justify-end">
              {token.status === 'active' || token.status === 'inactive' ? (
                <Button
                  size="touch"
                  onClick={() => {
                    rename.setError(null)
                    setRenaming({ token, name: token.name })
                  }}
                  className="lg:h-8"
                  data-sw-rename-token={token.name}
                >
                  <Pencil size={13} aria-hidden="true" /> Rename
                </Button>
              ) : null}
              {token.status === 'active' || token.status === 'inactive' ? (
                <Button
                  size="touch"
                  variant="danger"
                  onClick={() => setRevoking(token)}
                  className="lg:h-8"
                  data-sw-revoke-token={token.name}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title={`Revoke "${revoking?.name}"?`}
        confirmLabel="Revoke token"
        tone="danger"
        busy={revoke.busy}
        error={revoke.error}
        onConfirm={() =>
          revoke.run(async () => {
            await api.delete(wsUrl(workspaceId, `/projects/${revoking.projectId}/tokens/${revoking.id}`))
            setRevoking(null)
            toast('Token revoked')
            await onChanged()
          })
        }
      >
        <p>Anything using it (CI, an agent, a teammate's machine) stops working at once. This cannot be undone.</p>
      </ConfirmDialog>
      <Dialog
        open={Boolean(renaming)}
        onClose={() => (rename.busy ? null : setRenaming(null))}
        title="Rename token"
        description="An agent that uses this token signs its replies with this name."
        wrapDescription
        footer={
          <>
            <Button size="touch" className="lg:h-9" onClick={() => setRenaming(null)} disabled={rename.busy}>
              Cancel
            </Button>
            <Button
              size="touch"
              variant="default"
              className="lg:h-9"
              onClick={saveName}
              disabled={rename.busy || !renamed || renamed === renaming?.token.name}
              data-sw-rename-token-save
            >
              {rename.busy ? 'Saving...' : 'Save'}
            </Button>
          </>
        }
      >
        <form
          className="space-y-2 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (renamed && renamed !== renaming?.token.name && !rename.busy) saveName()
          }}
        >
          <label htmlFor="sw-rename-token" className="block text-xs font-medium text-fg">
            Name
          </label>
          <Input
            id="sw-rename-token"
            size="touch"
            className="lg:h-9"
            value={renaming?.name || ''}
            maxLength={60}
            onChange={(event) => setRenaming((current) => (current ? { ...current, name: event.target.value } : current))}
            data-sw-rename-token-input
          />
          <p className="text-xs text-muted">
            What it already wrote keeps the old name. The token itself, its scopes and its expiry do not change.
          </p>
          {rename.error ? (
            <p className="text-sm text-bad" role="alert">
              {rename.error}
            </p>
          ) : null}
        </form>
      </Dialog>
    </>
  )
}

// `defaultScopes`: what a new token starts with (the Agents page starts with
// the scopes an agent needs).
export function CreateToken({ open, onClose, projects, projectId = null, onCreated, defaultScopes = DEFAULT_SCOPES }) {
  const { workspaceId } = useWorkspace()
  const [project, setProject] = useState(projectId || '')
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState(defaultScopes)
  const [expiry, setExpiry] = useState('90')
  const { run, busy, error, setError } = useAction()
  const [result, setResult] = useSecretResult(open, () => {
    setProject(projectId || projects[0]?.id || '')
    setName('')
    setScopes(defaultScopes)
    setExpiry('90')
    setError(null)
  })
  const toggle = (scope) => setScopes((list) => (list.includes(scope) ? list.filter((item) => item !== scope) : [...list, scope]))
  const projectName = useMemo(() => projects.find((item) => item.id === project)?.name, [projects, project])
  const create = (event) => {
    event.preventDefault()
    run(async () => {
      const days = EXPIRY.find(([id]) => id === expiry)[2]
      const made = await api.post(wsUrl(workspaceId, `/projects/${project}/tokens`), {
        name,
        scopes,
        ...(days ? { expiresInDays: days } : {}),
      })
      setResult(made)
      await onCreated?.()
    })
  }
  return (
    <SecretResultDialog
      open={open}
      onClose={onClose}
      busy={busy}
      result={result}
      title="New API token"
      resultTitle="Token created"
      doneProps={{ 'data-sw-token-done': true }}
      renderResult={(made) => (
        <>
          <Notice tone="warn" title="Copy it now: it is shown once">
            Store it as SHAPEWALL_TOKEN in an environment variable or your CI secrets, never in a repository.
          </Notice>
          <CopyField value={made.token} testId="token" />
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
              <Terminal size={13} aria-hidden="true" /> Push from your project folder (this command includes the token)
            </p>
            <CopyField value={`SHAPEWALL_TOKEN=${made.token} shapewall push --remote ${serverOrigin()}`} testId="token-command" />
            <p className="mt-2 text-xs text-muted">
              On your own machine, <code className="font-mono text-fg">shapewall login --remote {serverOrigin()}</code> makes and stores a
              token for you instead.
            </p>
          </div>
        </>
      )}
    >
      {
        <form onSubmit={create} className="space-y-4 px-5 py-4">
          {projectId ? null : (
            <Field label="Project">
              {(props) => (
                <Select value={project} onValueChange={setProject}>
                  <SelectTrigger size="touch" className="w-full" {...props} data-sw-token-project>
                    <SelectValue placeholder="Pick a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          )}
          <Field label="Name" hint="Where it is used, like GitHub Actions or Ada's agent.">
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                placeholder="CI"
                data-sw-token-name
              />
            )}
          </Field>
          <fieldset>
            <legend className="mb-1.5 block text-[13px] font-medium text-fg">
              What it can do{projectName ? ` in ${projectName}` : ''}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {SCOPES.map(([id, label, hint]) => (
                <Toggle
                  key={id}
                  pressed={scopes.includes(id)}
                  onPressedChange={() => toggle(id)}
                  size="touch"
                  className="h-auto min-h-11 w-full flex-col items-start justify-center gap-0 px-3 py-2 text-left whitespace-normal"
                  data-sw-scope={id}
                >
                  <span className="text-sm font-medium text-fg">{label}</span>
                  <span className="text-xs font-normal text-muted">{hint}</span>
                </Toggle>
              ))}
            </div>
          </fieldset>
          <Field label="Expires">
            {(props) => (
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger size="touch" className="w-full sm:w-56" {...props} data-sw-token-expiry>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY.map(([id, label]) => (
                    <SelectItem key={id} value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
              Cancel
            </Button>
            <Button
              type="submit"
              size="touch"
              variant="default"
              disabled={busy || !name.trim() || !scopes.length || !project}
              className="lg:h-10"
              data-sw-token-create
            >
              {busy ? <Spinner /> : null} Create token
            </Button>
          </div>
        </form>
      }
    </SecretResultDialog>
  )
}
