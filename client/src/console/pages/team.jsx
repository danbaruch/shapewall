// Team mode on the solo engine (shapewall serve, 2.0.0): the owner's Invite
// people. The engine starts with only its owner on this machine; turning team
// mode on puts the same board on the owner's tailnet (tailscale serve with
// tailnet sign-in) for the people the owner invites, with no copy of anything.
// Turning it off is back to this machine only. The server decides everything
// (src/hosted/solo/team-routes.js): who may switch it (the owner, on this
// machine), the typed confirmation, and what it says about who can reach it.
//
//   TeamCard          Members: off (only you) or on (the address, who can reach it, Stop sharing)
//   TeamOnDialog      what turning it on does, then the switch
//   useTeam()         { team (the workspace's features.team or null), owner }

import { useState } from 'react'
import { Network, Power, UserPlus } from 'lucide-react'
import { Button, Spinner } from '../../components/ui'
import { Card, CardHeader, ConfirmDialog, CopyField, Notice } from '../components'
import { api } from '../lib/api'
import { useAction, useLoad, useToast } from '../state'
import { useWorkspace } from './workspace'

// The engine's team mode as the workspace answer says it, for its owner; null on any other server.
export function useTeam() {
  const { data, role } = useWorkspace()
  const team = data.features?.team || null
  return { team: team?.available ? team : null, owner: role === 'owner' }
}

export function TeamOnDialog({ open, onClose, onDone }) {
  const { reload } = useWorkspace()
  const toast = useToast()
  const { run, busy, error } = useAction()
  const turnOn = () =>
    run(async () => {
      await api.post('/solo/team', { on: true })
      await reload()
      toast('The board is on your tailnet for the people you invite')
      onDone?.()
    })
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Invite people"
      confirmLabel="Put it on my tailnet"
      onConfirm={turnOn}
      busy={busy}
      error={error}
    >
      <p>
        Right now only you, on this machine, can reach this board. To invite people, Shapewall puts the same board on your tailnet with
        tailscale serve: the same data, nothing is copied, and you stay its owner.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>Only people you invite see the board, signed in by their Tailscale login. Anyone else on your tailnet sees whom to ask.</li>
        <li>It is not on the public internet. Tagged devices are never signed in.</li>
        <li>You can turn it off at any time: the board is on this machine only again.</li>
      </ul>
      <p>This machine needs Tailscale, signed in, with HTTPS certificates on for your tailnet.</p>
    </ConfirmDialog>
  )
}

export function TeamCard({ onInvite }) {
  const { team, owner } = useTeam()
  const { reload } = useWorkspace()
  const toast = useToast()
  const [asking, setAsking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const status = useLoad(team?.on && owner ? '/solo/team' : null)
  const stop = useAction()
  if (!team || !owner) return null
  if (!team.on)
    return (
      <>
        <Card className="mb-5" data-sw-team="off">
          <CardHeader
            icon={Network}
            title="Only you can reach this board"
            description="It runs on this machine. Invite people to put the same board on your tailnet for them, with nothing copied."
            actions={
              <Button size="touch" variant="secondary" className="lg:h-9" onClick={() => setAsking(true)} data-sw-team-on>
                <UserPlus size={15} aria-hidden="true" /> Invite people
              </Button>
            }
          />
          {team.problem ? (
            <div className="px-4 py-3 sm:px-5">
              <Notice tone="warn" title="Team mode could not start">
                {team.problem}
              </Notice>
            </div>
          ) : null}
        </Card>
        <TeamOnDialog
          open={asking}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false)
            onInvite?.()
          }}
        />
      </>
    )
  const lines = status.data?.lines || []
  return (
    <>
      <Card className="mb-5" data-sw-team="on">
        <CardHeader
          icon={Network}
          title="On your tailnet"
          description="The people you invite open this address from their own tailnet devices. You keep using the board on this machine."
          actions={
            <Button size="touch" variant="ghost" className="lg:h-9" onClick={() => setStopping(true)} data-sw-team-off>
              <Power size={15} aria-hidden="true" /> Stop sharing
            </Button>
          }
        />
        <div className="space-y-3 px-4 py-3 sm:px-5">
          {team.origin ? <CopyField value={team.origin} testId="team-origin" /> : null}
          {status.loading && !lines.length ? <Spinner /> : null}
          {lines.length ? (
            <ul className="space-y-1 text-sm text-muted" data-sw-team-reach>
              {lines.slice(1).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>
      <ConfirmDialog
        open={stopping}
        onClose={() => setStopping(false)}
        title="Stop sharing"
        confirmLabel="Stop sharing"
        tone="danger"
        busy={stop.busy}
        error={stop.error}
        onConfirm={() =>
          stop.run(async () => {
            await api.post('/solo/team', { on: false })
            setStopping(false)
            await reload()
            toast('Only this machine reaches the board now')
          })
        }
      >
        <p>
          The board comes off your tailnet: nobody but you, on this machine, can reach it. Members and their comments stay; when you turn it
          on again they sign in as before.
        </p>
      </ConfirmDialog>
    </>
  )
}
