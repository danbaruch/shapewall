import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react'
import { Badge, Button } from '../../components/ui'
import { cn } from '../../lib/utils'
import { CATEGORIES, capitalize } from './model'
import Disclosure from './Disclosure'

// Issues first: every current finding across pages, the ones that need a
// person at the top, then notes.
export default function IssuesTab({ issues, pages, category, onCategory, onView, onDraft, canComment, onSeo }) {
  const shown = issues.filter((i) => category === 'all' || i.category === category)
  const warnings = shown.filter((i) => i.severity === 'warning')
  const notes = shown.filter((i) => i.severity !== 'warning')
  const title = (id) => pages.find((p) => p.id === id)?.title || id
  return (
    <div className="space-y-3" data-sw-checks-issues="true">
      {category !== 'all' ? (
        <div className="flex items-center gap-2 text-xs">
          <p className="min-w-0 flex-1 text-muted">
            Showing <span className="font-medium text-fg">{CATEGORIES.find((c) => c.id === category)?.label}</span> only
          </p>
          <Button size="xs" variant="ghost" className="h-11 lg:h-7" onClick={() => onCategory('all')} data-sw-checks-show-all="true">
            Show all
          </Button>
        </div>
      ) : null}
      {!shown.length ? (
        <p className="flex items-center gap-2 rounded-lg bg-ok/10 p-3 text-xs">
          <CircleCheck size={15} className="shrink-0 text-ok" aria-hidden="true" />
          No findings in the checks that ran{category === 'all' ? '' : ` for ${CATEGORIES.find((c) => c.id === category)?.label}`}. Pages
          that were not checked are listed under Pages.
        </p>
      ) : null}
      {warnings.length ? (
        <section className="space-y-2" aria-label="Needs attention">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <TriangleAlert size={14} className="text-warn" aria-hidden="true" />
            Needs attention <span className="font-normal text-muted tabular">{warnings.length}</span>
          </h3>
          {warnings.map((issue) => (
            <IssueRow key={issue.key} issue={issue} title={title(issue.pageId)} {...{ onView, onDraft, canComment, onSeo }} />
          ))}
        </section>
      ) : null}
      {notes.length ? (
        warnings.length ? (
          <Disclosure label={`Notes (${notes.length})`} data-sw-checks-notes="true">
            <div className="space-y-2">
              {notes.map((issue) => (
                <IssueRow key={issue.key} issue={issue} title={title(issue.pageId)} {...{ onView, onDraft, canComment, onSeo }} />
              ))}
            </div>
          </Disclosure>
        ) : (
          <section className="space-y-2" aria-label="Notes">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold">
              <Info size={14} className="text-muted" aria-hidden="true" />
              Notes <span className="font-normal text-muted tabular">{notes.length}</span>
            </h3>
            {notes.map((issue) => (
              <IssueRow key={issue.key} issue={issue} title={title(issue.pageId)} {...{ onView, onDraft, canComment, onSeo }} />
            ))}
          </section>
        )
      ) : null}
    </div>
  )
}

function IssueRow({ issue, title, onView, onDraft, canComment, onSeo }) {
  const { finding } = issue
  const warning = issue.severity === 'warning'
  const Icon = warning ? (issue.category === 'reliability' ? CircleX : TriangleAlert) : Info
  return (
    <article
      className="rounded-lg border border-line bg-surface p-2.5 shadow-card"
      data-sw-check-finding={finding.id}
      data-sw-check-issue={issue.key}
    >
      <div className="flex gap-2">
        <Icon
          size={16}
          className={cn('mt-0.5 shrink-0', warning ? (issue.category === 'reliability' ? 'text-bad' : 'text-warn') : 'text-muted')}
          aria-label={warning ? 'Needs attention' : 'Note'}
          role="img"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <span className="font-medium text-fg">{title}</span>
            <span aria-hidden="true">·</span>
            <span>{issue.viewports.map(capitalize).join(', ')}</span>
            <Badge tone="neutral" shape="tag">
              {issue.category}
            </Badge>
          </div>
          <h4 className="text-sm leading-5 font-medium">{finding.title}</h4>
          <p className="text-xs leading-4 text-muted">{finding.observation}</p>
          <p className="text-xs leading-4">{finding.nextAction}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        {issue.category === 'seo' && onSeo ? (
          <Button size="xs" variant="ghost" className="h-11 lg:h-7" onClick={() => onSeo(issue.pageId)}>
            See in SEO
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="h-11 lg:h-7"
          disabled={!issue.canvasCapture}
          onClick={() => onView(issue.pageId, issue.viewports[0])}
        >
          View page
        </Button>
        {canComment && issue.canvasCapture ? (
          <Button size="xs" variant="secondary" className="h-11 lg:h-7" onClick={() => onDraft(issue.view, issue.report, finding)}>
            Create comment
          </Button>
        ) : null}
      </div>
    </article>
  )
}
