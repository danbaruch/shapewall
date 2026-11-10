// Workspace settings: the name, share links on or off (admins), leaving,
// and deleting the workspace (the owner, with the name typed back).

import { useEffect, useState } from 'react'
import { DoorOpen, Download, Globe, Link2, PencilLine, Trash2 } from 'lucide-react'
import { Button, Input, Spinner } from '../../components/ui'
import { Card, CardHeader, ConfirmDialog, Field, FormError, Notice, PageHeader, Switch, demoNote } from '../components'
import { DEMO } from '../../lib/demo'
import { api, download, wsUrl } from '../lib/api'
import { useAction, useSession, useToast } from '../state'
import { useWorkspace } from './workspace'
import { currentHash, leaveTo } from '../lib/router'
import { LocalAgents } from './local-agents'

export function SettingsSection() {
  const { data, isAdmin, isOwner, workspaceId, reload } = useWorkspace()
  const { me, refresh } = useSession()
  const toast = useToast()
  const [name, setName] = useState(data.workspace.name)
  useEffect(() => setName(data.workspace.name), [data.workspace.name])
  const rename = useAction()
  const share = useAction()
  const publicSwitch = useAction()
  const leave = useAction()
  const destroy = useAction()
  const exporter = useAction()
  const [leaving, setLeaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Turning share links or public projects off stops every link at once: ask first.
  const [turningOff, setTurningOff] = useState(null) // 'shares' | 'public'
  const owners = data.members.filter((item) => item.role === 'owner').length
  const lastOwner = isOwner && owners <= 1
  const shareOn = data.workspace.settings.shareLinks
  // Older servers (and the demo) have no public projects.
  const publicSupported = Boolean(data.features?.publicProjects)
  const publicOn = Boolean(data.workspace.settings.publicProjects)
  // The demo keeps its main workspace, so there is always something to look at.
  const deletable = data.features?.deleteWorkspace !== false

  const setShareLinks = (next) =>
    share.run(async () => {
      await api.patch(wsUrl(workspaceId, '/settings'), { shareLinks: next })
      await reload()
      setTurningOff(null)
      toast(next ? 'Share links are on' : 'Share links are off. Every link stopped working.')
    })
  const setPublicProjects = (next) =>
    publicSwitch.run(async () => {
      await api.patch(wsUrl(workspaceId, '/public-projects'), { enabled: next })
      await reload()
      setTurningOff(null)
      toast(next ? 'Public projects are on' : 'Public projects are off. Every public URL was cleared.')
    })

  const save = (event) => {
    event.preventDefault()
    rename.run(async () => {
      await api.patch(wsUrl(workspaceId), { name })
      await Promise.all([reload(), refresh()])
      toast('Workspace renamed')
    })
  }

  // The demo only: the local console's Agents card, read-only with a demo
  // note, so visitors see where agents are chosen. `shapewall hosted` has its
  // own agent model (pages/agent.jsx) and never shows it.
  useEffect(() => {
    if (DEMO && currentHash() === '#agents') document.getElementById('agents')?.scrollIntoView({ block: 'start' })
  }, [])

  return (
    <>
      <PageHeader title="Settings" description="The workspace name, sharing, export, and leaving or deleting it." />
      <div className="grid gap-5">
        {DEMO ? <LocalAgents demo /> : null}
        <Card>
          <CardHeader icon={PencilLine} title="Name" description="Shown to members, in invites and to guests of share links." />
          <form onSubmit={save} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-end sm:px-5">
            <Field label="Workspace name" className="flex-1">
              {(props) => (
                <Input
                  {...props}
                  size="touch"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  disabled={!isAdmin}
                  data-sw-settings-name
                />
              )}
            </Field>
            {isAdmin ? (
              <Button type="submit" size="touch" variant="secondary" disabled={rename.busy || !name.trim() || name === data.workspace.name}>
                {rename.busy ? <Spinner /> : null} Save
              </Button>
            ) : null}
          </form>
          {rename.error ? (
            <div className="px-4 pb-4 sm:px-5">
              <FormError error={rename.error} />
            </div>
          ) : null}
        </Card>

        <Card data-sw-settings-shares>
          <CardHeader
            icon={Link2}
            title="Share links"
            description="Let admins share a project's boards with people outside the workspace, view-only or with guest comments."
            actions={
              isAdmin ? (
                <Switch
                  checked={shareOn}
                  label="Share links"
                  disabled={share.busy}
                  onChange={(next) => (next ? setShareLinks(true) : setTurningOff('shares'))}
                />
              ) : null
            }
          />
          <div className="space-y-2 px-4 py-4 text-sm text-muted sm:px-5">
            <p>
              {shareOn
                ? 'On. Each link reaches one project, expires, can have a passcode and can be revoked. Turning this off stops every link at once; turning it back on restores the ones that are not revoked or expired.'
                : isAdmin
                  ? 'Off. No share link works in this workspace. Turning this on asks for your passkey.'
                  : 'Off. No share link works in this workspace. An admin can turn them on.'}
            </p>
            {turningOff === 'shares' ? null : <FormError error={share.error} />}
          </div>
        </Card>

        {publicSupported ? (
          <Card data-sw-settings-public>
            <CardHeader
              icon={Globe}
              title="Public projects"
              description="Let the owner put a project on the open web: anyone with its URL can view the boards and comments, and change nothing."
              actions={
                isOwner || (isAdmin && publicOn) ? (
                  <Switch
                    checked={publicOn}
                    label="Public projects"
                    disabled={publicSwitch.busy}
                    onChange={(next) => (next ? setPublicProjects(true) : setTurningOff('public'))}
                  />
                ) : null
              }
            />
            <div className="space-y-2 px-4 py-4 text-sm text-muted sm:px-5">
              <p>
                {publicOn
                  ? 'On. An owner makes a project public on its page. Public boards are view-only and not indexed. Turning this off clears every public URL for good.'
                  : isOwner
                    ? 'Off. Turning this on asks for your passkey. Each project still stays private until you make it public.'
                    : 'Off. Only an owner can turn public projects on.'}
              </p>
              {turningOff === 'public' ? null : <FormError error={publicSwitch.error} />}
            </div>
          </Card>
        ) : null}

        {isAdmin ? (
          <Card data-sw-settings-export>
            <CardHeader
              icon={Download}
              title="Export"
              description={demoNote(
                "A zip of the workspace: members, projects, every board's pages and screenshots, comments and the audit log. No secrets.",
              )}
              actions={
                <Button
                  size="touch"
                  variant="secondary"
                  disabled={exporter.busy || DEMO}
                  onClick={() =>
                    exporter.run(async () => {
                      const saved = await download('POST', wsUrl(workspaceId, '/export'), {}, 'shapewall-export.zip')
                      toast(`Saved ${saved.name}`)
                    })
                  }
                  className="lg:h-9"
                  data-sw-export
                >
                  {exporter.busy ? <Spinner /> : <Download size={15} aria-hidden="true" />} Download a copy
                </Button>
              }
            />
            {exporter.error ? (
              <div className="px-4 pb-4 sm:px-5">
                <FormError error={exporter.error} />
              </div>
            ) : null}
          </Card>
        ) : null}

        <Card className="border-bad/30">
          <CardHeader
            icon={DoorOpen}
            title="Leave workspace"
            description={lastOwner ? 'You are the only owner. Make someone else an owner first.' : 'You lose access to every project here.'}
            actions={
              <Button
                size="touch"
                variant="danger"
                onClick={() => setLeaving(true)}
                disabled={lastOwner}
                className="border border-bad/40 lg:h-9"
                data-sw-leave-workspace
              >
                Leave
              </Button>
            }
          />
        </Card>

        {isOwner ? (
          <Card className="border-bad/30">
            <CardHeader
              icon={Trash2}
              title="Delete workspace"
              description={
                deletable
                  ? 'Every project, board, capture, comment, token, invite, share link and the audit log are deleted. This cannot be undone.'
                  : 'The demo keeps this workspace, so there is always something to look at. On a real server, the owner deletes a workspace here.'
              }
              actions={
                <Button
                  size="touch"
                  variant="danger"
                  disabled={!deletable}
                  onClick={() => setDeleting(true)}
                  className="border border-bad/40 lg:h-9"
                  data-sw-delete-workspace
                >
                  Delete workspace
                </Button>
              }
            />
            {deletable ? (
              <div className="px-4 py-3 sm:px-5">
                <Notice tone="info">Download a copy first (Export, above) if you may want any of it later.</Notice>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>

      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title={`Leave ${data.workspace.name}?`}
        confirmLabel="Leave workspace"
        tone="danger"
        busy={leave.busy}
        error={leave.error}
        onConfirm={() =>
          leave.run(async () => {
            await api.delete(wsUrl(workspaceId, `/members/${me.user.id}`))
            leaveTo('/')
          })
        }
      >
        <p>
          You lose access to every project here, and your pending invites, share links and API tokens are revoked. An admin can invite you
          again.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={turningOff === 'shares'}
        onClose={() => setTurningOff(null)}
        title="Turn share links off?"
        confirmLabel="Turn off"
        tone="danger"
        busy={share.busy}
        error={share.error}
        onConfirm={() => setShareLinks(false)}
      >
        <p>
          Every share link in this workspace stops working at once, including for guests who have a board open now. Turning this back on
          restores the links that are not revoked or expired.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={turningOff === 'public'}
        onClose={() => setTurningOff(null)}
        title="Turn public projects off?"
        confirmLabel="Turn off"
        tone="danger"
        busy={publicSwitch.busy}
        error={publicSwitch.error}
        onConfirm={() => setPublicProjects(false)}
      >
        <p>Every public URL in this workspace stops working at once, for everyone you sent one to.</p>
        <p className="text-bad">
          This cannot be undone. The public URLs are cleared for good: turning public projects back on publishes nothing, and a project made
          public again gets a new URL.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${data.workspace.name}?`}
        confirmLabel="Delete forever"
        tone="danger"
        confirmText={data.workspace.name}
        busy={destroy.busy}
        error={destroy.error}
        onConfirm={() =>
          destroy.run(async () => {
            await api.delete(wsUrl(workspaceId), { confirm: data.workspace.name })
            leaveTo('/')
          })
        }
      >
        <p>
          {data.members.length} {data.members.length === 1 ? 'person loses' : 'people lose'} access, and {data.projects.length}{' '}
          {data.projects.length === 1 ? 'project is' : 'projects are'} deleted with all their boards and comments. API tokens and share
          links stop working.
        </p>
      </ConfirmDialog>
    </>
  )
}
