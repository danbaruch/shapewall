// /w/:ws/projects/:pid (admins): a project's boards, share links and API
// tokens, and deleting it.

import { useState } from 'react'
import { ArrowLeft, ArrowUpRight, Globe, KeyRound, LayoutDashboard, Link2, Plus, Trash2 } from 'lucide-react'
import { Button, EmptyState } from '../../components/ui'
import { Card, CardHeader, ConfirmDialog, CopyField, FormError, LoadError, Loading, Notice, PageHeader, Switch, Time } from '../components'
import { api, serverOrigin, wsUrl } from '../lib/api'
import { formatDate } from '../lib/format'
import { Link, leaveTo, withParam } from '../lib/router'
import { useAction, useLoad, useToast } from '../state'
import { CreateShare, ShareList, SharesOff } from './shares'
import { CreateToken, TokenList } from './tokens'
import { useWorkspace } from './workspace'
import { AgentPolicySection } from './agent'
import { GettingStarted } from './getting-started'

export function ProjectPage({ projectId }) {
  const { workspaceId, data, isAdmin, isOwner, reload } = useWorkspace()
  const publicAction = useAction()
  const project = data.projects.find((item) => item.id === projectId)
  const shares = useLoad(isAdmin && project ? wsUrl(workspaceId, `/projects/${projectId}/shares`) : null)
  const tokens = useLoad(isAdmin && project ? wsUrl(workspaceId, `/projects/${projectId}/tokens`) : null)
  const [sharing, setSharing] = useState(false)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [makingPrivate, setMakingPrivate] = useState(false)
  const remove = useAction()
  const toast = useToast()

  if (!project) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-lg font-semibold text-fg">Project not found</h1>
        <Link to={`/w/${workspaceId}`} className="mt-3 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline">
          Back to projects
        </Link>
      </Card>
    )
  }
  const shareOn = data.workspace.settings.shareLinks
  const setPublic = (next) =>
    publicAction.run(async () => {
      await api.put(wsUrl(workspaceId, `/projects/${projectId}/public`), { public: next })
      await reload()
      setMakingPrivate(false)
      toast(next ? 'This project is public' : 'This project is private again. The public URL stopped working.')
    })
  return (
    <>
      <Link
        to={`/w/${workspaceId}`}
        className="mb-3 inline-flex h-11 items-center gap-1.5 rounded-md text-sm text-muted outline-none hover:text-fg focus-visible:outline-2 focus-visible:outline-accent lg:h-8"
      >
        <ArrowLeft size={15} aria-hidden="true" /> Projects
      </Link>
      <PageHeader
        title={project.name}
        description={`Created ${formatDate(project.createdAt)}`}
        actions={
          <Button asChild size="touch" variant="default" className="lg:h-9">
            <a href={project.boardUrl}>
              Open board <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </Button>
        }
      />
      <div className="grid gap-5">
        {isAdmin && !project.boards.length ? (
          <GettingStarted
            workspaceId={workspaceId}
            data={data}
            project={project}
            tokens={tokens.data?.tokens || null}
            onNewToken={() => setTokenOpen(true)}
          />
        ) : null}
        <Card>
          <CardHeader
            icon={LayoutDashboard}
            title="Boards"
            description="Each board is one shapewall.config.json board, updated by every push."
          />
          {project.boards.length ? (
            <ul className="divide-y divide-line">
              {project.boards.map((board) => (
                <li key={board.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm sm:px-5">
                  <code className="font-mono text-[13px] text-fg">{board.id}</code>
                  <span className="text-xs text-muted">
                    {board.pushes} {board.pushes === 1 ? 'push' : 'pushes'} · last <Time value={board.pushedAt} />
                  </span>
                  <span className="flex-1" />
                  <a
                    href={withParam(project.boardUrl, 'board', board.id)}
                    className="inline-flex h-11 items-center gap-1 text-sm font-medium text-accent underline-offset-2 hover:underline lg:h-auto"
                  >
                    Open <ArrowUpRight size={14} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={LayoutDashboard} title="Nothing pushed yet">
              Make a token with the push scope below, then run shapewall push --remote {serverOrigin()}
            </EmptyState>
          )}
        </Card>

        {isAdmin ? (
          <Card data-sw-project-shares>
            <CardHeader
              icon={Link2}
              title="Share links"
              description="For people outside the workspace: this project only, until the link expires or you revoke it."
              actions={
                shareOn ? (
                  <Button size="touch" variant="default" onClick={() => setSharing(true)} className="lg:h-9" data-sw-new-share>
                    <Plus size={16} aria-hidden="true" /> New share link
                  </Button>
                ) : null
              }
            />
            {!shareOn ? (
              <div className="p-4 sm:p-5">
                <SharesOff isAdmin={isAdmin} />
              </div>
            ) : null}
            {shares.loading ? <Loading /> : null}
            {shares.error ? (
              <div className="p-4">
                <LoadError error={shares.error} onRetry={shares.reload} />
              </div>
            ) : null}
            {shares.data && (shareOn || shares.data.shares.length) ? (
              <ShareList shares={shares.data.shares} onChanged={shares.reload} projectId={projectId} />
            ) : null}
          </Card>
        ) : null}

        {isAdmin && data.features?.publicProjects ? (
          <Card data-sw-project-public>
            <CardHeader
              icon={Globe}
              title="Public"
              description="Anyone with the URL can view this project's boards and comments. They cannot comment or change anything."
              actions={
                (isOwner && data.workspace.settings.publicProjects) || project.public ? (
                  <Switch
                    checked={Boolean(project.public)}
                    label="Public"
                    disabled={publicAction.busy || (!project.public && !isOwner)}
                    onChange={(next) => (next ? setPublic(true) : setMakingPrivate(true))}
                  />
                ) : null
              }
            />
            <div className="space-y-3 px-4 py-4 text-sm text-muted sm:px-5">
              {project.public ? (
                <>
                  <CopyField value={`${window.location.origin}${project.public.url}`} testId="public" />
                  <p>
                    Public since <Time value={project.public.since} />. Making it private stops this URL at once; making it public again
                    gives a new one.
                  </p>
                </>
              ) : !data.workspace.settings.publicProjects ? (
                <Notice tone="info">Public projects are off in this workspace. An owner turns them on in Settings.</Notice>
              ) : isOwner ? (
                <p>Private. Making it public asks for your passkey.</p>
              ) : (
                <p>Private. Only an owner can make a project public.</p>
              )}
              {makingPrivate ? null : <FormError error={publicAction.error} />}
            </div>
          </Card>
        ) : null}

        {isAdmin ? (
          <Card>
            <CardHeader
              icon={KeyRound}
              title="API tokens"
              description="For the CLI, CI and agents working in this project."
              actions={
                <Button size="touch" variant="secondary" onClick={() => setTokenOpen(true)} className="lg:h-9" data-sw-project-new-token>
                  <Plus size={16} aria-hidden="true" /> New token
                </Button>
              }
            />
            {tokens.loading ? <Loading /> : null}
            {tokens.error ? (
              <div className="p-4">
                <LoadError error={tokens.error} onRetry={tokens.reload} />
              </div>
            ) : null}
            {tokens.data && !tokens.error ? (
              tokens.data.tokens.length ? (
                <TokenList tokens={tokens.data.tokens} onChanged={tokens.reload} />
              ) : (
                <EmptyState icon={KeyRound} title="No tokens yet" />
              )
            ) : null}
          </Card>
        ) : null}

        {isAdmin ? <AgentPolicySection workspaceId={workspaceId} projectId={projectId} /> : null}

        {isAdmin ? (
          <Card className="border-bad/30">
            <CardHeader
              icon={Trash2}
              title="Delete project"
              description="Its boards, captures, comments, tokens and share links go with it."
              actions={
                <Button
                  size="touch"
                  variant="danger"
                  onClick={() => setDeleting(true)}
                  className="border border-bad/40 lg:h-9"
                  data-sw-delete-project
                >
                  Delete project
                </Button>
              }
            />
          </Card>
        ) : null}
      </div>
      {isAdmin ? (
        <>
          <CreateShare open={sharing} onClose={() => setSharing(false)} project={project} onCreated={shares.reload} />
          <CreateToken
            open={tokenOpen}
            onClose={() => setTokenOpen(false)}
            projects={data.projects}
            projectId={projectId}
            onCreated={tokens.reload}
          />
          <ConfirmDialog
            open={deleting}
            onClose={() => setDeleting(false)}
            title={`Delete ${project.name}?`}
            confirmLabel="Delete project"
            tone="danger"
            confirmText={project.name}
            busy={remove.busy}
            error={remove.error}
            onConfirm={() =>
              remove.run(async () => {
                await api.delete(wsUrl(workspaceId, `/projects/${projectId}`))
                toast(`Deleted ${project.name}`)
                leaveTo(`/w/${workspaceId}`)
              })
            }
          >
            <p>This deletes every board, capture, comment, token and share link of the project. It cannot be undone.</p>
          </ConfirmDialog>
          <ConfirmDialog
            open={makingPrivate}
            onClose={() => setMakingPrivate(false)}
            title={`Make ${project.name} private?`}
            confirmLabel="Make private"
            tone="danger"
            busy={publicAction.busy}
            error={publicAction.error}
            onConfirm={() => setPublic(false)}
          >
            <p>
              The public URL stops working at once, for everyone you sent it to. Making the project public again gives it a new URL: the old
              one never comes back.
            </p>
          </ConfirmDialog>
        </>
      ) : null}
    </>
  )
}
