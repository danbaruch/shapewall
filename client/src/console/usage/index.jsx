// The Usage and Activity pages of the Workspace Console, as one lazy chunk
// (pages/workspace.jsx loads it when either page opens). The charts
// (Recharts), the data grid (TanStack Table and Virtual) and the data layer
// (TanStack Query) live only here, so the board and the rest of the console
// never load them.

import { QueryClientProvider } from '@tanstack/react-query'
import { ActivityPage, AgentPage, PersonPage } from './ActivityPage'
import { queryClient } from './data'
import { UsagePage } from './UsagePage'
import './usage.css'

export default function UsageArea({ section, subjectId = null }) {
  let page
  if (section === 'usage') page = <UsagePage />
  else if (subjectId?.startsWith('us_')) page = <PersonPage key={subjectId} userId={subjectId} />
  else if (subjectId?.startsWith('ag_')) page = <AgentPage key={subjectId} agentId={subjectId} />
  else page = <ActivityPage />
  return <QueryClientProvider client={queryClient}>{page}</QueryClientProvider>
}
