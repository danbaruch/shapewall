// The four steps from nothing to a team on a board: a project, a token,
// a push, an invite. Shown while a project (or the workspace) is empty;
// each step ticks itself off from what the server already knows.

import { Check } from 'lucide-react'
import { Button } from '../../components/ui'
import { cn } from '../../lib/utils'
import { Card, CopyField } from '../components'
import { serverOrigin } from '../lib/api'
import { navigate } from '../lib/router'

export function GettingStarted({ workspaceId, data, project = null, tokens = null, onNewProject, onNewToken }) {
  const hasToken = Boolean(tokens?.some((token) => token.status === 'active' && token.scopes.includes('push')))
  const pushed = Boolean(project?.boards.length)
  const invited = data.members.length > 1 || data.invites.length > 0
  const steps = [
    {
      id: 'project',
      title: 'Create a project',
      body: 'One per site or app.',
      done: Boolean(project) || data.projects.length > 0,
      action: onNewProject ? (
        <Button size="touch" variant="default" onClick={onNewProject} className="lg:h-9" data-sw-start-project>
          New project
        </Button>
      ) : null,
    },
    {
      id: 'token',
      title: 'Make a push token',
      body: 'A token with the push scope lets the CLI or CI upload captures to this project.',
      done: hasToken,
      action:
        project && onNewToken ? (
          <Button size="touch" variant={hasToken ? 'secondary' : 'default'} onClick={onNewToken} className="lg:h-9" data-sw-start-token>
            Make a token
          </Button>
        ) : null,
    },
    {
      id: 'push',
      title: 'Push your captures',
      body: 'From the folder with shapewall.config.json, after a local capture. The token dialog has this command with the token filled in.',
      done: pushed,
      extra: project ? <CopyField value={`shapewall push --remote ${serverOrigin()}`} testId="start-push" className="mt-2" /> : null,
    },
    {
      id: 'invite',
      title: 'Invite your team',
      body: 'Teammates comment on the board; agents pick the comments up.',
      done: invited,
      action: (
        <Button
          size="touch"
          variant={invited ? 'secondary' : 'default'}
          onClick={() => navigate(`/w/${workspaceId}/invites`)}
          className="lg:h-9"
          data-sw-start-invite
        >
          Invite people
        </Button>
      ),
    },
  ]
  const next = steps.find((step) => !step.done)?.id
  return (
    <Card className="p-4 sm:p-5" data-sw-getting-started>
      <h2 className="text-[15px] font-semibold text-fg">Get started</h2>
      <ol className="mt-3 space-y-3">
        {steps.map((step, index) => (
          <li key={step.id} className="flex gap-3" data-sw-start-step={step.id} data-done={step.done ? 'true' : 'false'}>
            <span
              className={cn(
                'mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular',
                step.done ? 'border-ok bg-ok text-white' : step.id === next ? 'border-accent text-accent' : 'border-line text-muted',
              )}
              aria-hidden="true"
            >
              {step.done ? <Check size={14} /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm font-medium', step.done ? 'text-muted line-through' : 'text-fg')}>
                {step.title}
                <span className="sr-only">{step.done ? ' (done)' : ''}</span>
              </p>
              {!step.done ? <p className="mt-0.5 text-xs text-muted">{step.body}</p> : null}
              {!step.done && step.extra ? step.extra : null}
              {!step.done && step.action ? <div className="mt-2">{step.action}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}
