// The workspace's projects: each one's boards come from `shapewall push`.

import { useEffect, useState } from 'react'
import { ArrowUpRight, FolderKanban, MessageSquare, Plus, Settings2, UserRoundCheck } from 'lucide-react'
import { Badge, Button, Dialog, EmptyState, Input, Spinner } from '../../components/ui'
import { Card, Field, FormError, PageHeader, Time } from '../components'
import { api, wsUrl } from '../lib/api'
import { Link, navigateSoon } from '../lib/router'
import { useAction, useToast } from '../state'
import { useWorkspace } from './workspace'
import { GettingStarted } from './getting-started'

export function ProjectsSection() {
  const { data, isAdmin, workspaceId, reload } = useWorkspace()
  const [open, setOpen] = useState(false)
  const toast = useToast()
  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project holds the boards you push from your machine or CI, their comments, tokens and share links."
        actions={
          isAdmin ? (
            <Button variant="default" size="touch" onClick={() => setOpen(true)} className="lg:h-9" data-sw-new-project>
              <Plus size={16} aria-hidden="true" /> New project
            </Button>
          ) : null
        }
      />
      {data.projects.length ? (
        <div className="grid animate-fade-in gap-4 md:grid-cols-2" data-sw-project-grid>
          {data.projects.map((project) => (
            <ProjectCard key={project.id} project={project} isAdmin={isAdmin} workspaceId={workspaceId} />
          ))}
        </div>
      ) : isAdmin ? (
        <GettingStarted workspaceId={workspaceId} data={data} onNewProject={() => setOpen(true)} />
      ) : (
        <Card>
          <EmptyState icon={FolderKanban} title="No projects yet">
            An admin creates projects. Boards appear here once someone pushes captures.
          </EmptyState>
        </Card>
      )}
      <NewProject
        open={open}
        onClose={() => setOpen(false)}
        workspaceId={workspaceId}
        onCreated={async (project) => {
          await reload()
          setOpen(false)
          toast(`Created ${project.name}`)
          navigateSoon(`/w/${workspaceId}/projects/${project.id}`)
        }}
      />
    </>
  )
}

function NewProject({ open, onClose, onCreated, workspaceId }) {
  const [name, setName] = useState('')
  const { run, busy, error, setError } = useAction()
  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open, setError])
  const create = (event) => {
    event.preventDefault()
    run(async () => {
      const result = await api.post(wsUrl(workspaceId, '/projects'), { name })
      await onCreated(result.project)
    })
  }
  return (
    <Dialog open={open} onClose={() => (busy ? null : onClose())} title="New project" description="Usually one per site or app.">
      <form onSubmit={create} className="space-y-4 px-5 py-4">
        <Field label="Name">
          {(props) => (
            <Input
              {...props}
              size="touch"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="Marketing site"
              data-sw-project-name
            />
          )}
        </Field>
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
            Cancel
          </Button>
          <Button type="submit" size="touch" variant="default" disabled={busy || !name.trim()} className="lg:h-10" data-sw-project-create>
            {busy ? <Spinner /> : null} Create project
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// One project: a cover (the board's first captured page, when the server
// sends board summaries), what needs attention, and the two ways in. The whole
// card opens the board; Tokens and sharing sits above that link.
function ProjectCard({ project, isAdmin, workspaceId }) {
  const last = project.boards
    .map((board) => board.pushedAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  const summaries = project.boards.map((board) => board.summary).filter(Boolean)
  const cover = summaries.find((summary) => summary.thumbnailUrl)?.thumbnailUrl || null
  const total = (key) => summaries.reduce((sum, summary) => sum + (Number(summary[key]) || 0), 0)
  const pages = total('pages')
  const open = total('openComments')
  const needsPerson = total('needsPerson')
  const hasBoard = project.boards.length > 0
  return (
    <Card
      className="group relative flex flex-col overflow-hidden transition-[box-shadow,border-color,translate] duration-(--motion-fast) ease-standard hover:-translate-y-px hover:border-line-strong hover:shadow-lift focus-within:border-line-strong"
      data-sw-project={project.name}
    >
      <div className="relative h-36 overflow-hidden border-b border-line bg-surface-2" aria-hidden="true">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="absolute inset-x-6 top-5 w-[calc(100%-3rem)] rounded-t-md object-cover object-top shadow-pop transition-transform duration-(--motion-base) ease-standard group-hover:-translate-y-0.5"
          />
        ) : (
          <div className="sw-project-cover flex h-full items-center justify-center">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface text-accent shadow-card">
              <FolderKanban size={22} />
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <div className="min-w-0">
          <a
            href={project.boardUrl}
            className="flex min-h-11 items-center truncate text-title font-semibold text-fg outline-none lg:min-h-0 after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
            data-sw-project-link={project.name}
          >
            {project.name}
          </a>
          <p className="mt-0.5 text-ui text-muted">
            {hasBoard ? (
              <>
                {project.boards.length} {project.boards.length === 1 ? 'board' : 'boards'}
                {pages ? ` · ${pages} ${pages === 1 ? 'page' : 'pages'}` : ''}
                {last ? (
                  <>
                    {' · pushed '}
                    <span className="relative z-10">
                      <Time value={last} />
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              'Nothing pushed yet'
            )}
          </p>
        </div>
        {summaries.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5" data-sw-project-stats>
            <Badge tone={open ? 'accent' : 'neutral'} className="gap-1 tabular-nums">
              <MessageSquare size={12} aria-hidden="true" />
              {open ? `${open} open ${open === 1 ? 'comment' : 'comments'}` : 'No open comments'}
            </Badge>
            {needsPerson ? (
              <Badge tone="warn" className="gap-1 tabular-nums">
                <UserRoundCheck size={12} aria-hidden="true" />
                {needsPerson} {needsPerson === 1 ? 'needs' : 'need'} a person
              </Badge>
            ) : null}
          </div>
        ) : null}
        <div className="relative z-10 mt-4 flex flex-wrap gap-2 pt-1">
          <Button asChild size="touch" variant="default" className="lg:h-9">
            <a href={project.boardUrl} data-sw-open-board={project.name}>
              Open board <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </Button>
          {isAdmin ? (
            <Button asChild size="touch" variant="secondary" className="lg:h-9">
              <Link to={`/w/${workspaceId}/projects/${project.id}`} data-sw-manage-project={project.name}>
                <Settings2 size={15} aria-hidden="true" /> Tokens and sharing
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
