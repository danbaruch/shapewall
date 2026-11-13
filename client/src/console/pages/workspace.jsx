// /w/:ws/...: a workspace with its sections. Admin sections show only to
// admins and owners (the server refuses them to anyone else anyway).

import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Bot,
  FolderKanban,
  KeyRound,
  Lock,
  MailPlus,
  MessageSquareText,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { Card, LoadError, Loading, RoleBadge } from '../components'
import { api, wsUrl } from '../lib/api'
import { ROLE_LABEL, roleAtLeast } from '../lib/format'
import { Link } from '../lib/router'
import { useMediaQuery } from '../../lib/hooks'
import { SidebarSections } from '../shell'
import { useLoad } from '../state'
import { ProjectsSection } from './projects'
import { ProjectPage } from './project'
import { MembersSection } from './members'
import { InvitesSection } from './invites'
import { AccessSection } from './access'
import { TokensSection } from './tokens'
import { AuditSection } from './audit'
import { SettingsSection } from './settings'
import { AgentFeedbackView } from './agent-feedback'
import { AgentsSection } from './local-agents'
import { AgentsOverview, ProjectAgentsPage } from './agents'
import { DEMO } from '../../lib/demo'

// Usage and Activity bring the charts and the data grid with them: loaded
// only when one of the two pages opens, so no other page pays for them.
const UsageArea = lazy(() => import('../usage/index.jsx'))

const WorkspaceContext = createContext(null)
export const useWorkspace = () => useContext(WorkspaceContext)

const SECTIONS = [
  ['projects', 'Projects', FolderKanban, 'viewer'],
  ['members', 'Members', Users, 'viewer'],
  ['invites', 'Invites', MailPlus, 'admin'],
  ['access', 'Access', ShieldCheck, 'admin'],
  ['tokens', 'API tokens', KeyRound, 'admin'],
  ['audit', 'Audit log', ScrollText, 'admin'],
  // A team server: every agent of the workspace (pages/agents.jsx), for
  // admins. The demo shows the local console's Agents page here instead,
  // read-only, to everyone.
  ['agents', 'Agents', Bot, DEMO ? 'viewer' : 'admin'],
  // What agents did (a member: their own turns) and what people did (anyone:
  // their own activity; admins: everyone's, and the access review).
  ['usage', 'Usage', BarChart3, 'member'],
  ['activity', 'Activity', Activity, 'viewer'],
  // Only where the server's boards have chat (features.agentFeedback).
  ['feedback', 'Agent feedback', MessageSquareText, 'admin'],
  ['settings', 'Settings', Settings, 'viewer'],
]

export function WorkspacePage({ workspaceId, section, projectId, subjectId = null }) {
  const detail = useLoad(wsUrl(workspaceId))
  // A desktop has the app sidebar, which lists the sections (shell.jsx).
  const wide = useMediaQuery('(min-width: 1024px)')
  // The tab says which page of which workspace: "Members -- Acme -- Shapewall".
  const loaded = detail.data
  const projectName = projectId ? loaded?.projects.find((item) => item.id === projectId)?.name || 'Project' : null
  const pageName = projectId
    ? section === 'agents' && !DEMO
      ? `Agents of ${projectName}`
      : projectName
    : SECTIONS.find(([id]) => id === section)?.[1] || 'Projects'
  const workspaceName = loaded?.workspace.name
  useEffect(() => {
    if (workspaceName) document.title = [pageName, workspaceName, 'Shapewall'].join(' · ')
  }, [pageName, workspaceName])
  if (detail.loading && !detail.data) return <Loading />
  if (!detail.data) {
    return detail.error?.status === 404 ? (
      <Card className="p-8 text-center">
        <h1 className="text-lg font-semibold text-fg">Workspace not found</h1>
        <p className="mt-1 text-sm text-muted">It does not exist, or you are not in it.</p>
        <Link to="/" className="mt-4 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline">
          Back to your workspaces
        </Link>
      </Card>
    ) : (
      <LoadError error={detail.error} onRetry={detail.reload} />
    )
  }
  const data = detail.data
  const role = data.role
  const value = {
    workspaceId,
    data,
    reload: detail.reload,
    role,
    isAdmin: roleAtLeast(role, 'admin'),
    isOwner: role === 'owner',
  }
  const sections = SECTIONS.filter(([id]) => id !== 'feedback' || data.features?.agentFeedback)
  const visible = sections.filter(([, , , least]) => roleAtLeast(role, least))
  // A section this role cannot see (a link from an admin, an old bookmark)
  // says so instead of quietly showing the projects.
  const needs = SECTIONS.find(
    ([id]) => id === section && sections.some(([known]) => known === id) && !visible.some(([seen]) => seen === id),
  )
  const current = needs ? section : visible.some(([id]) => id === section) ? section : 'projects'
  // A project's Agents page (/w/:ws/agents/:pid) belongs to Agents.
  const projectAgents = Boolean(projectId) && section === 'agents' && !DEMO
  const active = projectAgents ? 'agents' : projectId ? 'projects' : current
  let body
  if (needs) body = <NeedsRole section={needs[1]} least={needs[3]} role={role} workspaceId={workspaceId} />
  else if (projectAgents) body = <ProjectAgentsPage key={projectId} projectId={projectId} />
  else if (projectId) body = <ProjectPage projectId={projectId} />
  else if (current === 'members') body = <MembersSection />
  else if (current === 'invites') body = <InvitesSection />
  else if (current === 'access') body = <AccessSection />
  else if (current === 'tokens') body = <TokensSection />
  else if (current === 'audit') body = <AuditSection />
  else if (current === 'agents') body = DEMO ? <AgentsSection /> : <AgentsOverview />
  else if (current === 'usage' || current === 'activity')
    body = (
      <Suspense fallback={<Loading label="Loading the page" rows={4} />}>
        <UsageArea section={current} subjectId={subjectId} />
      </Suspense>
    )
  else if (current === 'settings') body = <SettingsSection />
  else if (current === 'feedback') body = <AgentFeedbackView baseUrl={wsUrl(workspaceId, '/agent-feedback')} get={api.get} />
  else body = <ProjectsSection />

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="mb-5 flex flex-wrap items-center gap-2 lg:hidden">
        {/* Not a heading: each section brings the page's h1. */}
        <p className="min-w-0 truncate text-lg font-semibold text-fg">{data.workspace.name}</p>
        <RoleBadge role={role} />
      </div>
      <SidebarSections
        label={data.workspace.name}
        sections={visible.map(([id, label, Icon]) => ({
          id: `ws-${id}`,
          label,
          icon: Icon,
          to: id === 'projects' ? `/w/${workspaceId}` : `/w/${workspaceId}/${id}`,
          active: active === id,
          'data-sw-nav': id,
        }))}
      />
      <div>
        {wide ? null : (
          <nav aria-label="Workspace" className="-mx-3 mb-5">
            <NavPills active={active}>
              {visible.map(([id, label, Icon]) => (
                <li key={id} className="shrink-0">
                  <Link
                    to={id === 'projects' ? `/w/${workspaceId}` : `/w/${workspaceId}/${id}`}
                    aria-current={active === id ? 'page' : undefined}
                    className={cn(
                      'flex h-11 items-center gap-2.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-accent',
                      active === id ? 'border-accent/40 bg-accent/10 text-fg' : 'border-line bg-surface text-muted hover:text-fg',
                    )}
                    data-sw-nav={id}
                  >
                    <Icon size={16} aria-hidden="true" className={active === id ? 'text-accent' : ''} />
                    {label}
                  </Link>
                </li>
              ))}
            </NavPills>
          </nav>
        )}
        <div className="min-w-0">{body}</div>
      </div>
    </WorkspaceContext.Provider>
  )
}

// Below the desktop sidebar's width only. The section pills scroll sideways: a fade at the edge with more
// to see says so, and the current one scrolls into view clear of the fades
// (scroll padding as wide as each fade).
function NavPills({ active, children }) {
  const list = useRef(null)
  const [more, setMore] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const node = list.current
    if (!node) return
    const left = node.scrollLeft > 4
    const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 4
    setMore((current) => (current.left === left && current.right === right ? current : { left, right }))
  }, [])
  useEffect(() => {
    const node = list.current
    node?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [active, measure])
  return (
    <div className="relative" data-sw-nav-pills>
      <ul ref={list} onScroll={measure} className="sw-scroll-x flex scroll-pr-10 scroll-pl-8 gap-1 overflow-x-auto px-3">
        {children}
      </ul>
      {more.left ? <span className="pointer-events-none absolute inset-y-0 left-0 w-8 sw-nav-fade-left" aria-hidden="true" /> : null}
      {more.right ? (
        <span className="pointer-events-none absolute inset-y-0 right-0 w-10 sw-nav-fade-right" aria-hidden="true" data-sw-nav-more />
      ) : null}
    </div>
  )
}

function NeedsRole({ section, least, role, workspaceId }) {
  return (
    <Card className="p-8 text-center" data-sw-needs-role={least}>
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-muted">
        <Lock size={20} aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-fg">This page needs the {ROLE_LABEL[least].toLowerCase()} role</h1>
      <p className="mt-1 text-sm text-muted">
        {section} is for {least === 'member' ? 'members, admins and owners' : 'admins and owners'}. You are a{' '}
        {ROLE_LABEL[role].toLowerCase()} here; ask an admin if you need it.
      </p>
      <Link to={`/w/${workspaceId}`} className="mt-4 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline">
        Back to the projects
      </Link>
    </Card>
  )
}
