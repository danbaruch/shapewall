import { Fragment, useState } from 'react'
import { ChevronLeft, ChevronRight, GitFork, Pencil, Plus, Route, Trash2, Undo2, X } from 'lucide-react'
import { Button, IconButton, Input, Kbd, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'

function StepTip({ label, keyName }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label} <Kbd>{keyName}</Kbd>
    </span>
  )
}

// The path as a rail: one numbered dot per step (click to go there), the
// current one in the accent, steps already seen filled, the fork drawn as a
// split where the path chooses a branch. Long journeys scroll sideways.
function StepRail({ route, step, pageTitle, onStep, touch }) {
  const forksAt = new Map(route.forks.map((fork, index) => [fork.afterStep, { ...fork, index }]))
  // On touch each button is a 44 px target around its smaller dot (the dot
  // keeps its size); with more steps than fit, the rail scrolls sideways
  // inside the bar rather than shrinking the targets.
  const hit = touch ? 'h-11 min-w-11' : 'h-6 min-w-6'
  return (
    <ol
      className={cn('flex max-w-full min-w-0 items-center overflow-x-auto py-1', touch ? 'px-0.5' : 'gap-0.5')}
      aria-label="Steps"
      data-sw-journey-rail="true"
    >
      {route.steps.map((item, index) => {
        const number = index + 1
        const fork = forksAt.get(number)
        const isCurrent = number === step
        const seen = number < step
        return (
          <Fragment key={item.key || index}>
            {index > 0 ? (
              // Shorter on touch: the targets on either side already give the dots their spacing.
              <li
                aria-hidden="true"
                className={cn('h-0.5 shrink-0 rounded-full', touch ? '-mx-1.5 w-3' : 'w-3', number <= step ? 'bg-accent/60' : 'bg-line')}
              />
            ) : null}
            <li className="shrink-0">
              <Tooltip
                content={
                  <span>
                    Step {number}: {pageTitle(item.pageId)}
                    {item.branch ? <span className="opacity-75"> ({item.branch})</span> : null}
                  </span>
                }
                side="top"
              >
                <button
                  type="button"
                  onClick={() => onStep(number)}
                  className={cn(
                    'group/dot inline-flex items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                    hit,
                  )}
                  aria-current={isCurrent ? 'step' : undefined}
                  aria-label={`Step ${number}: ${pageTitle(item.pageId)}${item.branch ? ` (${item.branch})` : ''}`}
                  data-sw-journey-dot={number}
                >
                  <span
                    className={cn(
                      'tabular inline-flex items-center justify-center rounded-full px-1 text-[11px] leading-none font-semibold',
                      touch ? 'h-7 min-w-7' : 'h-6 min-w-6',
                      isCurrent
                        ? 'bg-accent text-accent-fg shadow-card ring-4 ring-accent/20'
                        : seen
                          ? 'bg-accent/15 text-accent group-hover/dot:bg-accent/25'
                          : 'border border-line bg-surface text-muted group-hover/dot:border-faint group-hover/dot:text-fg',
                      item.branch && !isCurrent && 'border-dashed',
                    )}
                    aria-hidden="true"
                  >
                    {number}
                  </span>
                </button>
              </Tooltip>
            </li>
            {fork ? (
              <>
                <li aria-hidden="true" className={cn('h-0.5 w-2 shrink-0 rounded-full', number < step ? 'bg-accent/60' : 'bg-line')} />
                <li className="shrink-0">
                  <Tooltip content={`The journey forks here: ${fork.options.map((option) => option.label).join(' or ')}`} side="top">
                    <button
                      type="button"
                      onClick={() => onStep(number)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium outline-none focus-visible:outline-2 focus-visible:outline-accent',
                        touch ? 'h-11 min-w-11 justify-center' : 'h-6',
                        number === step ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface-2 text-muted hover:text-fg',
                      )}
                      aria-label={`Fork after step ${number}: ${fork.options.find((option) => option.id === fork.chosen)?.label || ''} taken`}
                      data-sw-journey-rail-fork={fork.index}
                    >
                      <GitFork size={12} aria-hidden="true" />
                      <span className="max-w-24 truncate">{fork.options.find((option) => option.id === fork.chosen)?.label}</span>
                    </button>
                  </Tooltip>
                </li>
              </>
            ) : null}
          </Fragment>
        )
      })}
      {route.ended ? (
        <li className="ml-1 shrink-0 text-[11px] font-medium text-faint" data-sw-journey-rail-end="true">
          ends
        </li>
      ) : null}
    </ol>
  )
}

// The open journey: where you are on a step rail, previous / next (also the
// arrow keys), and for journeys made on the board, edit and delete. Back
// closes it. `route` is the path being stepped through (resolvePath): at a
// step where the journey forks, the bar asks which way to go, and Next
// follows it.
export function JourneyBar({ journey, route, step, pageTitle, onStep, onChoose, onClose, onEdit, onDelete, canEdit, busy, touch }) {
  const [confirming, setConfirming] = useState(false)
  const total = route.steps.length
  const current = route.steps[step - 1]
  const forkIndex = route.forks.findIndex((item) => item.afterStep === step)
  const fork = forkIndex >= 0 ? route.forks[forkIndex] : null
  const size = touch ? 'touch' : 'sm'
  const name = (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-fg">
      <Route size={14} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="truncate">{journey.name}</span>
    </span>
  )
  return (
    <div
      className={cn(
        'pointer-events-auto absolute z-30 flex flex-col gap-1.5 rounded-xl border border-line bg-surface/95 shadow-pop backdrop-blur',
        touch
          ? 'inset-x-2 bottom-2 p-2'
          : 'bottom-4 left-1/2 w-max max-w-[min(760px,calc(100%-2rem))] min-w-[440px] -translate-x-1/2 px-3 py-2',
      )}
      role="region"
      aria-label={`Journey: ${journey.name}`}
      data-sw-journey-bar={journey.id}
      data-sw-journey-path={route.forks.map((item) => item.chosen).join(',')}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 px-0.5">
          {journey.description && !touch ? (
            <Tooltip content={journey.description} side="top" align="start">
              <span
                tabIndex={0}
                className="block min-w-0 rounded outline-none focus-visible:outline-2 focus-visible:outline-accent"
                data-sw-journey-description="true"
              >
                {name}
              </span>
            </Tooltip>
          ) : (
            name
          )}
          <p className="truncate text-xs text-muted" aria-live="polite" data-sw-journey-step={step}>
            <span className="tabular font-medium text-fg">
              Step {step} of {total}
            </span>
            {current?.branch ? <span data-sw-journey-branch-now={current.branch}> ({current.branch})</span> : null}:{' '}
            {pageTitle(current?.pageId)}
            {route.ended && step === total ? ', where this branch ends' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content={touch ? null : <StepTip label="Previous step" keyName="←" />}>
            <Button
              size={touch ? 'icon' : 'icon-sm'}
              disabled={step <= 1}
              onClick={() => onStep(step - 1)}
              aria-label="Previous step"
              data-sw-journey-prev="true"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip content={touch ? null : <StepTip label="Next step" keyName="→" />}>
            <Button
              size={touch ? 'touch' : 'sm'}
              variant="default"
              className="px-2.5"
              disabled={step >= total}
              onClick={() => onStep(step + 1)}
              aria-label="Next step"
              data-sw-journey-next="true"
            >
              Next <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </Tooltip>
          {canEdit ? (
            <>
              <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
              {onEdit ? (
                <IconButton size={touch ? 'icon' : 'icon-sm'} onClick={onEdit} disabled={busy} label="Edit this journey">
                  <Pencil size={14} aria-hidden="true" />
                </IconButton>
              ) : null}
              {confirming ? (
                <Button size={size} variant="danger" disabled={busy} onClick={onDelete} data-sw-journey-delete-confirm="true">
                  <Trash2 size={14} aria-hidden="true" /> Delete
                </Button>
              ) : (
                <IconButton
                  size={touch ? 'icon' : 'icon-sm'}
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  label="Delete this journey"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </IconButton>
              )}
            </>
          ) : null}
          <IconButton
            size={touch ? 'icon' : 'icon-sm'}
            onClick={onClose}
            label="Close the journey"
            tooltip={touch ? null : <StepTip label="Close the journey" keyName="Esc" />}
            data-sw-journey-close="true"
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <StepRail route={route} step={step} pageTitle={pageTitle} onStep={onStep} touch={touch} />
      {fork ? (
        <div
          className="flex w-full flex-wrap items-center gap-1.5 border-t border-line pt-2"
          role="group"
          aria-label="The journey forks here. Which way?"
          data-sw-journey-fork={forkIndex}
        >
          <span className={cn('flex items-center gap-1 text-xs font-medium text-muted', touch && 'w-full px-1')}>
            <GitFork size={13} className="shrink-0 text-accent" aria-hidden="true" /> Which way?
          </span>
          {fork.options.map((option) => {
            const chosen = option.id === fork.chosen
            return (
              <Button
                key={option.id}
                size={size}
                variant={chosen ? 'default' : 'secondary'}
                className={cn('max-w-full min-w-0', touch && 'flex-1')}
                aria-pressed={chosen}
                onClick={() => onChoose(forkIndex, option.id)}
                data-sw-journey-branch={option.id}
              >
                <span className="truncate">{option.label}</span>
                {option.end ? <span className="text-[11px] opacity-75">(ends)</span> : null}
              </Button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// "New journey" (or edit): click pages in order, name it, save. "Fork here"
// after a page splits the journey into named branches (say "Card works" and
// "Card declined"); clicks then fill the branch picked below, and "Back to
// the main line" adds the steps every branch rejoins at. A branch can end
// the journey instead of rejoining. One level of forks here; deeper ones
// still come from the config.
export function JourneyBuilder({ draft, onChange, onSave, onCancel, pageTitle, busy, touch }) {
  const size = touch ? 'touch' : 'sm'
  const steps = draft.steps
  const into = draft.into || null
  const pageCount = countPages(steps)
  const problem = builderProblem(steps)
  const canSave = draft.name.trim() && pageCount >= 2 && !problem && !busy
  const last = steps[steps.length - 1]
  const edit = (change) => {
    const next = structuredClone(steps)
    const cursor = change(next)
    onChange({ ...draft, steps: next, into: cursor === undefined ? into : cursor })
  }
  const addFork = () =>
    edit((next) => {
      next.push({
        branches: [
          { label: 'Branch 1', steps: [] },
          { label: 'Branch 2', steps: [] },
        ],
      })
      return { fork: next.length - 1, branch: 0 }
    })
  // Undo takes back the last page added where clicks go now.
  const undo = () =>
    edit((next) => {
      const list = into ? next[into.fork]?.branches?.[into.branch]?.steps : next
      if (list?.length) {
        list.pop()
        return into
      }
      if (into) {
        // An empty branch: drop the whole fork when every branch is empty.
        const fork = next[into.fork]
        if (fork.branches.every((branch) => !branch.steps.length)) {
          next.splice(into.fork, 1)
          return null
        }
        return into
      }
      return null
    })
  return (
    <div
      className={cn(
        'pointer-events-auto absolute z-30 flex max-h-[70%] flex-col gap-2 overflow-y-auto rounded-xl border border-accent/50 bg-surface/95 p-3 shadow-pop backdrop-blur',
        touch ? 'inset-x-2 bottom-2' : 'bottom-4 left-1/2 w-[min(680px,calc(100%-2rem))] -translate-x-1/2',
      )}
      role="region"
      aria-label={draft.id ? 'Edit journey' : 'New journey'}
      data-sw-journey-builder="true"
    >
      <div className="flex items-center gap-2">
        <Route size={15} className="shrink-0 text-accent" aria-hidden="true" />
        <label className="min-w-0 flex-1">
          <span className="sr-only">Journey name</span>
          <Input
            size={touch ? 'touch' : 'sm'}
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value.slice(0, 120) })}
            placeholder="Name this journey, e.g. Sign up"
            data-sw-journey-name="true"
          />
        </label>
      </div>
      <p className="text-xs text-muted" data-sw-journey-into={into ? `${into.fork}:${into.branch}` : 'main'}>
        {touch ? 'Tap' : 'Click'} pages in the order people visit them
        {into ? (
          <>
            {' '}
            -- adding to <span className="font-semibold text-fg">{steps[into.fork]?.branches?.[into.branch]?.label || 'the branch'}</span>.
          </>
        ) : (
          '.'
        )}
      </p>
      <ol className="flex flex-wrap items-start gap-1.5" data-sw-journey-draft={flatDraft(steps)}>
        {steps.map((item, index) =>
          typeof item === 'string' ? (
            <StepChip
              key={`${item}-${index}`}
              number={index + 1}
              title={pageTitle(item)}
              touch={touch}
              onRemove={() =>
                edit((next) => {
                  next.splice(index, 1)
                  return null
                })
              }
            />
          ) : (
            <li
              key={`fork-${index}`}
              className="w-full rounded-lg border border-line bg-surface-2/50 p-2"
              data-sw-journey-draft-fork={index}
            >
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted">
                <GitFork size={13} className="shrink-0 text-accent" aria-hidden="true" /> Fork: which way?
              </p>
              <div className="flex flex-col gap-1.5">
                {item.branches.map((branch, at) => {
                  const active = into?.fork === index && into?.branch === at
                  return (
                    <div
                      key={at}
                      className={cn('flex flex-wrap items-center gap-1.5 rounded-md p-1', active && 'bg-accent/10 ring-1 ring-accent/50')}
                      data-sw-journey-draft-branch={at}
                    >
                      <Input
                        size={touch ? 'touch' : 'xs'}
                        className="w-36"
                        value={branch.label}
                        aria-label={`Branch ${at + 1} name`}
                        onChange={(event) =>
                          edit((next) => {
                            next[index].branches[at].label = event.target.value.slice(0, 60)
                          })
                        }
                      />
                      {branch.steps.map((pageId, stepAt) =>
                        typeof pageId !== 'string' ? (
                          <span key={'nested-' + stepAt} className="text-xs text-faint">
                            (a nested fork, edit it in the config)
                          </span>
                        ) : (
                          <StepChip
                            key={`${pageId}-${stepAt}`}
                            title={pageTitle(pageId)}
                            touch={touch}
                            onRemove={() =>
                              edit((next) => {
                                next[index].branches[at].steps.splice(stepAt, 1)
                              })
                            }
                          />
                        ),
                      )}
                      <Button
                        size={touch ? 'touch' : 'xs'}
                        variant={active ? 'default' : 'ghost'}
                        aria-pressed={active}
                        onClick={() => onChange({ ...draft, into: { fork: index, branch: at } })}
                        data-sw-journey-fill-branch={at}
                      >
                        {active ? 'Adding here' : 'Add pages here'}
                      </Button>
                      <Button
                        size={touch ? 'touch' : 'xs'}
                        variant={branch.end ? 'default' : 'ghost'}
                        aria-pressed={Boolean(branch.end)}
                        onClick={() =>
                          edit((next) => {
                            if (next[index].branches[at].end) delete next[index].branches[at].end
                            else next[index].branches[at].end = true
                          })
                        }
                        data-sw-journey-branch-end={at}
                      >
                        {branch.end ? 'Ends here' : 'Rejoins'}
                      </Button>
                      {item.branches.length > 2 ? (
                        <IconButton
                          className={cn('rounded-full', touch ? 'h-11 w-11' : 'h-6 w-6')}
                          onClick={() =>
                            edit((next) => {
                              next[index].branches.splice(at, 1)
                              return into?.fork === index ? { fork: index, branch: 0 } : into
                            })
                          }
                          label={`Remove branch ${at + 1}`}
                          tooltip="Remove the branch"
                        >
                          <X size={12} aria-hidden="true" />
                        </IconButton>
                      ) : null}
                    </div>
                  )
                })}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {item.branches.length < 6 ? (
                  <Button
                    size={touch ? 'touch' : 'xs'}
                    variant="ghost"
                    onClick={() =>
                      edit((next) => {
                        next[index].branches.push({ label: `Branch ${next[index].branches.length + 1}`, steps: [] })
                        return { fork: index, branch: next[index].branches.length - 1 }
                      })
                    }
                    data-sw-journey-add-branch="true"
                  >
                    <Plus size={13} aria-hidden="true" /> Branch
                  </Button>
                ) : null}
                {into?.fork === index ? (
                  <Button
                    size={touch ? 'touch' : 'xs'}
                    variant="ghost"
                    onClick={() => onChange({ ...draft, into: null })}
                    data-sw-journey-main="true"
                  >
                    Back to the main line
                  </Button>
                ) : null}
              </div>
            </li>
          ),
        )}
        {!steps.length ? <li className="text-xs text-faint">No steps yet.</li> : null}
      </ol>
      {problem ? (
        <p className="text-xs text-warn" data-sw-journey-problem="true">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Tooltip content={touch ? null : 'Split the journey here into branches'}>
          <Button
            size={size}
            variant="ghost"
            className="mr-auto"
            disabled={typeof last !== 'string' || busy}
            onClick={addFork}
            data-sw-journey-fork-add="true"
          >
            <GitFork size={14} aria-hidden="true" /> Fork here
          </Button>
        </Tooltip>
        <Button size={size} variant="ghost" disabled={!steps.length || busy} onClick={undo}>
          <Undo2 size={14} aria-hidden="true" /> Undo
        </Button>
        <Button size={size} onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size={size} variant="default" onClick={onSave} disabled={!canSave} data-sw-journey-save="true">
          {busy ? 'Saving...' : 'Save journey'}
        </Button>
      </div>
    </div>
  )
}

function StepChip({ number, title, touch, onRemove }) {
  return (
    <li className="inline-flex items-center gap-1 rounded-full bg-accent/10 py-0.5 pr-0.5 pl-2 text-xs font-medium text-fg">
      {number ? <span className="font-bold text-accent">{number}</span> : null} {title}
      <IconButton
        className={cn('rounded-full', touch ? 'h-9 w-9' : 'h-5 w-5')}
        onClick={onRemove}
        label={number ? `Remove step ${number}` : `Remove ${title}`}
        tooltip="Remove"
      >
        <X size={12} aria-hidden="true" />
      </IconButton>
    </li>
  )
}

// Page references across the main line and every branch.
function countPages(steps) {
  return steps.reduce(
    (sum, item) => sum + (typeof item === 'string' ? 1 : item.branches.reduce((n, branch) => n + branch.steps.length, 0)),
    0,
  )
}

// The draft as text, for tests: "home,signup,[ok:verify|expired:verify-expired],welcome".
function flatDraft(steps) {
  return steps
    .map((item) =>
      typeof item === 'string'
        ? item
        : `[${item.branches.map((branch) => `${branch.label}:${branch.steps.join('+')}${branch.end ? '!' : ''}`).join('|')}]`,
    )
    .join(',')
}

// What the server would refuse, said before Save (src/journey-paths.js checkSteps).
function builderProblem(steps) {
  for (let index = 0; index < steps.length; index += 1) {
    const item = steps[index]
    if (typeof item === 'string') continue
    const followed = index < steps.length - 1
    const labels = new Set()
    for (const branch of item.branches) {
      const label = branch.label.trim()
      if (!label) return 'Every branch needs a name.'
      if (labels.has(label.toLowerCase())) return `Two branches are called "${label}".`
      labels.add(label.toLowerCase())
      if (!branch.steps.length && (branch.end || !followed)) {
        return `"${label}" has no pages: add some, or add a step after the fork for it to skip to.`
      }
    }
    if (item.branches.every((branch) => branch.end) && followed) return 'Every branch ends, so nothing can follow the fork.'
  }
  return null
}
