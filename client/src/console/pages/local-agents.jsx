// Workspace > Agents on a local installation: the Agents card
// (settings/AgentsCard.jsx), with the connection details and the endpoint form
// below it (console/LocalConsole.jsx); its "Other" row scrolls to that form.
// The demo console shows the card read-only with a demo note (AgentsSection).
// Self-hosted multiplayer (`shapewall hosted`) has its own model (project
// agent tokens, pages/agent.jsx) and never renders this.

import { Bot } from 'lucide-react'
import { AgentsCard } from '../../settings/AgentsCard'
import { Card, CardHeader, PageHeader } from '../components'

// The Agents page's one line, in the local console and the demo.
export const AGENTS_DESCRIPTION = 'The coding agents that chat and fix comments on this computer, and how they connect.'

export function LocalAgents({ agent = null, touch, onChanged, onOpenEndpoint = null, demo = false }) {
  return (
    <Card id="agents" className="scroll-mt-20" data-sw-local-console-agents>
      <CardHeader
        icon={Bot}
        title="Connected agents"
        description="Connect, test and remove agents, and choose the one new chats and fixes use."
      />
      <div className="px-4 py-4 sm:px-5">
        <AgentsCard touch={touch} demo={demo} agent={agent} onChanged={onChanged} onOpenEndpoint={demo ? null : onOpenEndpoint} />
      </div>
    </Card>
  )
}

// The demo console's Agents page (pages/workspace.jsx lists it only in the demo).
export function AgentsSection() {
  return (
    <>
      <PageHeader title="Agents" description={AGENTS_DESCRIPTION} />
      <LocalAgents demo />
    </>
  )
}
