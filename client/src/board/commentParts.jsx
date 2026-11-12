// Small pieces of a comment shared by the thread (popover and sheet), the
// comment list and the pins: chips, links, author labels and colours.
import { Bot, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, RotateCcw } from 'lucide-react'
import { Avatar, Badge } from '../components/ui'
import { cn, formatRelative, shownTime } from '../lib/utils'

// A fix reference is linked only when it is an http(s) URL; anything else
// (a commit, a ticket id) is shown as text.
export function safeHttpUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export function FixRef({ value, touch }) {
  if (!value) return null
  const href = safeHttpUrl(value)
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted" data-sw-fix-ref="true">
      <GitPullRequest size={12} className="shrink-0" aria-hidden="true" /> <span className="shrink-0">Fixed in</span>{' '}
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className={cn('truncate text-accent hover:underline', touch && 'py-2')}>
          {value}
        </a>
      ) : (
        <code className="truncate font-mono text-[11px] text-fg">{value}</code>
      )}
    </p>
  )
}

const PULL_ICONS = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed }

// The GitHub issue made from a comment and the pull requests linked to it.
export function GithubLinks({ github, touch }) {
  const issue = github?.issue
  const pulls = github?.pulls || []
  if (!issue && !pulls.length) return null
  const linkClass = cn('inline-flex min-w-0 items-center gap-1 text-accent hover:underline', touch && 'min-h-11')
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted" data-sw-github="true">
      {issue && safeHttpUrl(issue.url) ? (
        <a
          href={safeHttpUrl(issue.url)}
          target="_blank"
          rel="noreferrer noopener"
          className={linkClass}
          data-sw-github-issue-link={issue.number}
        >
          <CircleDot size={12} className="shrink-0" aria-hidden="true" /> Issue #{issue.number}
        </a>
      ) : null}
      {pulls.map((pull) => {
        const Icon = PULL_ICONS[pull.state] || GitPullRequest
        const href = safeHttpUrl(pull.url)
        if (!href) return null
        return (
          <a
            key={pull.number}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className={linkClass}
            aria-label={pull.title ? `PR #${pull.number} ${pull.state}: ${pull.title}` : undefined}
            data-sw-github-pull={pull.number}
            data-sw-github-pull-state={pull.state}
          >
            <Icon size={12} className="shrink-0" aria-hidden="true" /> PR #{pull.number}
            <span className="text-faint">{pull.state}</span>
          </a>
        )
      })}
    </p>
  )
}

// The agent status (set by `shapewall watch`, MCP clients or the CLI) as a
// small chip. Read-only on the board.
const AGENT_LABELS = {
  queued: { label: 'Queued', tone: 'neutral' },
  working: { label: 'Agent working', tone: 'accent' },
  done: { label: 'Agent done', tone: 'ok' },
  'needs-human': { label: 'Needs a person', tone: 'warn' },
  // Agent branch mode: the fix is committed on a branch, not in the checkout yet.
  // It waits on a person (Apply), so it wears the attention colour, like "Needs a person"
  // and like the toolbar's agent activity mark.
  'branch-ready': { label: 'Fix ready on branch', tone: 'warn' },
}

// `branch`: the branch a branch-ready fix waits on (local boards know it).
export function AgentStatusChip({ status, at = null, branch = null }) {
  const info = AGENT_LABELS[status]
  if (!info) return null
  const named = status === 'branch-ready' && branch
  const label = named ? `${info.label} ${branch}` : info.label
  return (
    <Badge
      tone={info.tone}
      aria-label={at ? `Agent status: ${label} (${formatRelative(at)})` : `Agent status: ${label}`}
      data-sw-agent-status={status}
      className={named ? 'max-w-full' : undefined}
    >
      <Bot size={10} aria-hidden="true" />{' '}
      {named ? (
        <>
          {info.label} <span className="min-w-0 truncate font-mono">{branch}</span>
        </>
      ) : (
        label
      )}
    </Badge>
  )
}

// A comment that was resolved and opened again.
export function ReopenedChip({ comment }) {
  if (comment.status !== 'open' || !comment.reopenCount) return null
  return (
    <Badge tone="bad" data-sw-reopened={comment.reopenCount}>
      <RotateCcw size={10} aria-hidden="true" /> Reopened{comment.reopenCount > 1 ? ` ${comment.reopenCount}x` : ''}
    </Badge>
  )
}

// Hosted boards say who is an agent (a token); local boards have only the
// name, so a name with "agent" or "bot" in it counts there.
export function isAgentAuthor({ name, handle, agent }) {
  return agent === true || (agent === undefined && !handle && /agent|bot/i.test(name || ''))
}

// Who wrote a comment or reply: `handle` for a person (shown beside the
// display name, which anyone can choose) and an "agent" tag for a token.
export function AuthorLabel({ name, handle, agent, className }) {
  const isAgent = isAgentAuthor({ name, handle, agent })
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="truncate font-semibold text-fg" data-sw-author={isAgent ? 'agent' : 'person'}>
        {name}
      </span>
      {handle ? <span className="shrink-0 text-faint">@{handle}</span> : null}
      {agent === true ? (
        <Badge shape="tag" className="bg-line text-fg">
          agent
        </Badge>
      ) : null}
    </span>
  )
}

// The colour of a person comes from their display name: a guest sees no
// handles, so keying on the handle would repaint everyone per viewer.
export const personColorKey = ({ name, handle }) => String(name || handle || '').toLowerCase()

// The avatar of a comment or reply author, in their colour.
export function AuthorAvatar({ name, handle, agent, agentId = null, size = 'md', className }) {
  return (
    <Avatar
      person
      agent={isAgentAuthor({ name, handle, agent })}
      agentId={agentId}
      name={name}
      colorKey={personColorKey({ name, handle })}
      size={size}
      className={className}
    />
  )
}

// The author of a comment as { name, handle, agent }.
export const commentAuthor = (comment) => ({ name: comment.author, handle: comment.authorHandle, agent: comment.authorAgent })
// `agentId`: hosted boards, which of the project's agents wrote it.
export const replyAuthor = (reply) => ({ name: reply.author, handle: reply.handle, agent: reply.agent, agentId: reply.agentId || null })

export const repliesLabel = (count) => `${count} ${count === 1 ? 'reply' : 'replies'}`

// What a pinned element is, in words: 'the "Create account" button', 'the
// empty cta link'. The selector is agent context: the thread shows this
// and keeps the selector for a tooltip.
const ELEMENT_NAMES = {
  a: 'link',
  button: 'button',
  input: 'field',
  textarea: 'text box',
  select: 'menu',
  img: 'image',
  svg: 'icon',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  p: 'text',
  li: 'list item',
  label: 'label',
  nav: 'navigation',
  table: 'table',
  th: 'column header',
  td: 'table cell',
  form: 'form',
  header: 'header',
  footer: 'footer',
}
export function anchorLabel(anchor) {
  if (!anchor) return null
  const step = String(anchor.selector || '')
    .split(' > ')
    .pop()
  const tag = /^([a-z][a-z0-9-]*)/i.exec(step)?.[1]?.toLowerCase() || ''
  const kind = ELEMENT_NAMES[tag] || 'element'
  const text = String(anchor.text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text) {
    const short = text.length > 48 ? `${text.slice(0, 47)}…` : text
    return kind === 'text' || kind === 'element' ? `“${short}”` : `the “${short}” ${kind}`
  }
  const named = /\[(?:data-testid|aria-label|name|id)="([^"]+)"\]/.exec(step)?.[1] || /#([\w-]+)/.exec(step)?.[1] || ''
  const words = named
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  return words ? `the ${words} ${kind}` : `a ${kind}`
}

// "Tue, Nov 4, 10:12 AM" for a time's tooltip.
export function exactTime(value) {
  const date = new Date(shownTime(value))
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : ''
}
