// Workspace > Settings > Agents on a local installation: the Agents card
// (settings/AgentsCard.jsx). Its "Other" row opens the Agent tab below it
// (the endpoint form).
// Self-hosted multiplayer (`shapewall hosted`) has its own model (project
// agent tokens, pages/agent.jsx) and never renders this.

import { Bot } from 'lucide-react'
import { AgentsCard } from '../../settings/AgentsCard'
import { Card, CardHeader } from '../components'

export function LocalAgents({ agent = null, touch, onChanged, onOpenEndpoint = null, demo = false }) {
  return (
    <Card id="agents" className="scroll-mt-20" data-sw-local-console-agents>
      <CardHeader
        icon={Bot}
        title="Agents"
        description="The coding agents that chat and fix comments on this computer, and the one new chats and fixes use."
      />
      <div className="px-4 py-4 sm:px-5">
        <AgentsCard touch={touch} demo={demo} agent={agent} onChanged={onChanged} onOpenEndpoint={demo ? null : onOpenEndpoint} />
      </div>
    </Card>
  )
}
