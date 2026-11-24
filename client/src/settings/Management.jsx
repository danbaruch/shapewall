import { AgentSettings } from './AgentSettings'
import { useMediaQuery } from '../lib/hooks'

export default function Management() {
  const touch = useMediaQuery('(max-width: 600px)')
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6" data-sw-agent-management>
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-fg">Shapewall agent settings</h1>
        <p className="text-sm text-muted">
          This temporary window changes the agent for this source project. Stop active agent turns before changing connections. Your
          account-protected board stays separate. Close this server with Ctrl-C when finished.
        </p>
      </header>
      <AgentSettings touch={touch} />
    </main>
  )
}
