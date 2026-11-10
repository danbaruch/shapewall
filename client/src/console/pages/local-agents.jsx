// Workspace > Agents on a local installation: the Agents card
// (settings/AgentsCard.jsx), and below it the Chat connection card with the
// connection details and the endpoint form; the card's "Other" row scrolls
// to that form. LocalConsole.jsx renders it from /api/info; the demo console
// renders the same page (AgentsSection) from the demo backend's sample data
// (demo/backend/routes-agents.js).
// Self-hosted multiplayer (`shapewall hosted`) has its own model (project
// agent tokens, pages/agent.jsx) and never renders this.

import { Bot, Plug } from 'lucide-react'
import { AgentsCard } from '../../settings/AgentsCard'
import { AgentDetails } from '../../settings/LocalSettings'
import { useMediaQuery } from '../../lib/hooks'
import { notifyAgentsChanged } from '../../lib/agentEvents'
import { Card, CardHeader, PageHeader } from '../components'

// The Agents page's one line, in the local console and the demo.
export const AGENTS_DESCRIPTION = 'The coding agents that chat and fix comments on this computer, and how they connect.'

export function LocalAgents({ agent = null, touch, onChanged, onOpenEndpoint = null }) {
  return (
    <Card id="agents" className="scroll-mt-20" data-sw-local-console-agents>
      <CardHeader
        icon={Bot}
        title="Connected agents"
        description="Connect, test and remove agents, and choose the one new chats and fixes use."
      />
      <div className="px-4 py-4 sm:px-5">
        <AgentsCard touch={touch} agent={agent} onChanged={onChanged} onOpenEndpoint={onOpenEndpoint} />
      </div>
    </Card>
  )
}

// The page below its header: the Agents card, then the Chat connection card.
// `info`: /api/info (its `agent`). `onChanged`: after a change on either card.
export function AgentsPage({ info, touch, onChanged }) {
  // A new default or a removed agent changes what chat uses: the Chat
  // connection card follows, without losing unsaved typing (it listens for
  // "agents changed", lib/agentEvents.js; this says it at once on this page
  // too, before the server's event arrives).
  const agentsChanged = async () => {
    notifyAgentsChanged('local')
    await onChanged?.()
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      {info?.agent ? (
        <LocalAgents
          agent={info.agent}
          touch={touch}
          onChanged={agentsChanged}
          onOpenEndpoint={() => document.querySelector('[data-sw-local-console-agent-details]')?.scrollIntoView({ block: 'start' })}
        />
      ) : null}
      <Card className="scroll-mt-20" data-sw-local-console-agent-details>
        <CardHeader
          icon={Plug}
          title="Chat connection"
          description="What the board chat uses now, the source folder agents work in, and an OpenAI-compatible endpoint."
        />
        <div className="px-4 py-4 sm:px-5">
          <AgentDetails info={info} onSaved={onChanged} touch={touch} agentsHome={Boolean(info?.agent)} />
        </div>
      </Card>
    </div>
  )
}

// What the demo's pretend computer says about its agent settings: editable
// from this browser, as on the machine running Shapewall.
const DEMO_INFO = { agent: { settingsEditable: true } }

// The demo console's Agents page (pages/workspace.jsx lists it only in the demo).
export function AgentsSection() {
  const wide = useMediaQuery('(min-width: 1024px)')
  return (
    <>
      <PageHeader title="Agents" description={AGENTS_DESCRIPTION} />
      <AgentsPage info={DEMO_INFO} touch={!wide} onChanged={() => {}} />
    </>
  )
}
