import { lazy, Suspense, useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { LayoutDashboard } from 'lucide-react'
import { useOpened, useParams, useResource } from './lib/hooks'
import { Button, EmptyState, TooltipProvider } from './components/ui'
import { BoardLoadError, BoardSkeleton } from './components/app-states'
import Board from './board/Board'
import { setFixtureClock } from './lib/utils'
import { boardSwitchChanges } from './lib/boardParams'
import { DEMO, useDemo } from './lib/demo'
import { setAgentEventsOwner, useAgentsChanged } from './lib/agentEvents'
import { rememberAgents } from './lib/agentIdentity'
import { setSettingsCommand } from './settings/SettingsHint'
import { PairingScreen, DevicesPanel } from './pairing/Pairing'
import { DemoResetDialog, DemoShareProblem } from './components/demo-banner'
const BuzzDialog = lazy(() => import('./buzz/BuzzDialog'))

const REMOTE = !DEMO && typeof document !== 'undefined' && Boolean(document.querySelector('meta[name="shapewall-remote"]'))

export default function App() {
  const [pairingLost, setPairingLost] = useState(false)
  const [buzzOpen, setBuzzOpen] = useState(false)
  const buzzOpened = useOpened(buzzOpen)
  useEffect(() => {
    const onLost = () => setPairingLost(true)
    window.addEventListener('shapewall:pairing-required', onLost)
    return () => window.removeEventListener('shapewall:pairing-required', onLost)
  }, [])
  const access = useResource(REMOTE ? '/api/pairing' : null)
  const admitted = !REMOTE || ['host', 'device', 'identity'].includes(access.data?.access)
  const info = useResource(admitted ? '/api/info' : null)
  // The chat header and agent picker read the agent from info: follow
  // changes made in another tab, the Agents page or the agents file.
  useAgentsChanged(info.refetch, Boolean(info.data?.agent))
  // Every connected agent's name and icon, for the places that only have a
  // name to go on (an agent's reply on a comment thread, lib/agentIdentity.js).
  const agents = useResource(admitted && info.data?.agent?.configured ? '/api/agent/status' : null)
  useAgentsChanged(agents.refetch, Boolean(info.data?.agent?.configured))
  const knownAgents = info.data?.agent?.configured ? [info.data.agent, agents.data, ...(agents.data?.profiles || [])] : []
  const knownKey = JSON.stringify(knownAgents.map((agent) => [agent?.label, agent?.icon, agent?.tint, agent?.logo]))
  useEffect(() => rememberAgents(knownAgents), [knownKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // The owner-only events stream opens once the server says this page is the owner's.
  const eventsOwner = info.data?.agent?.ownerWrites === true
  useEffect(() => setAgentEventsOwner(eventsOwner), [eventsOwner])
  // A locked tab's settings hint names the exact command for this board.
  const settingsCommand = info.data?.agent?.settingsCommand || null
  useEffect(() => setSettingsCommand(settingsCommand), [settingsCommand])
  const demo = useDemo()
  const list = useResource(admitted ? '/api/boards' : null)
  const [params, updateParams] = useParams()
  const boards = Array.isArray(list.data?.boards) ? list.data.boards : []
  const wanted = params.get('board')
  const board = boards.find((item) => item.id === wanted) || boards[0]
  // A demo export's fixed fixture time (see setFixtureClock); idempotent.
  setFixtureClock(info.data?.fixturesAt)
  const shareProblem = DEMO ? demo?.shareProblem : null
  useDemoTitle(shareProblem ? 'Share link' : board?.title)
  // The demo took a share link out of the address bar (demo/install.js) after
  // the query was read here: forget it too, or the next change writes it back.
  const staleShare = DEMO && params.has('share')
  useEffect(() => {
    if (staleShare) updateParams({ share: null })
  }, [staleShare, updateParams])

  if (
    (REMOTE && !access.loading && !admitted) ||
    pairingLost ||
    info.error?.code === 'pairing_required' ||
    list.error?.code === 'pairing_required'
  )
    return <PairingScreen />
  if (shareProblem) return <DemoShareProblem problem={shareProblem} onLeave={demo.leaveShare} />
  if (list.loading || info.loading) return <BoardSkeleton />
  // What this person may do comes from /api/info: without it the board
  // would show every control as allowed, so a failed info is a failed load.
  const infoMissing = Boolean(info.error) && !info.data
  if (list.error || infoMissing) {
    const retry = () => Promise.all([list.error ? list.refetch() : null, info.error ? info.refetch() : null])
    return (
      <>
        <BoardLoadError
          error={list.error || info.error}
          onRetry={retry}
          extra={
            DEMO ? (
              <>
                <Button asChild size="touch" variant="secondary" className="lg:h-10">
                  <a href="console.html#/signin">Sign in to the demo</a>
                </Button>
                <Button size="touch" variant="ghost" className="lg:h-10" onClick={() => demo?.reset()}>
                  Reset the demo
                </Button>
              </>
            ) : null
          }
        />
        {DEMO ? <DemoResetDialog /> : null}
      </>
    )
  }
  if (!board) {
    return (
      <div className="flex h-full bg-sunken">
        <EmptyState size="lg" icon={LayoutDashboard} title="No boards yet">
          {info.data?.hosted ? (
            <>
              Capture your app locally, then run <code className="font-mono text-ui text-fg">shapewall push</code> with a project token.
            </>
          ) : (
            <>
              Add pages to <code className="font-mono text-ui text-fg">shapewall.config.json</code>, then run{' '}
              <code className="font-mono text-ui text-fg">shapewall capture</code>.
            </>
          )}
        </EmptyState>
      </div>
    )
  }
  return (
    <TooltipProvider>
      <DevicesPanel info={info.data} />
      {info.data?.buzzAvailable === true && buzzOpened ? (
        <Suspense fallback={null}>
          <BuzzDialog key={board.id} open={buzzOpen} onClose={() => setBuzzOpen(false)} boardId={board.id} />
        </Suspense>
      ) : null}
      <ReactFlowProvider key={board.id}>
        <Board
          boardId={board.id}
          boards={boards}
          info={info.data}
          onInfoChanged={info.refetch}
          onOpenBuzz={() => setBuzzOpen(true)}
          // Another board: everything that names something on this one goes (lib/boardParams.js).
          onPickBoard={(id) => (id === board.id ? null : updateParams(boardSwitchChanges(id)))}
        />
      </ReactFlowProvider>
    </TooltipProvider>
  )
}

// The demo's tab title: "Lumen Notes board · Shapewall demo".
function useDemoTitle(title) {
  useEffect(() => {
    if (!DEMO || !title) return
    const name = String(title).replace(/\s*\(demo\)$/i, '')
    document.title = name === 'Share link' ? 'Share link · Shapewall demo' : `${name} board · Shapewall demo`
  }, [title])
}
