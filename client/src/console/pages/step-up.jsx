// Settings, "Ask for a passkey again": when this workspace wants the passkey
// confirmed again before an action (src/hosted/step-up.js). Everything is off
// by default: being signed in with the right role is enough. Owners change
// it; everyone who sees Settings can read it. Asking for less is itself one
// of the few things that always need the passkey: the server says so, and
// the dialog opens (ReauthProvider).

import { KeyRound } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui'
import { Card, CardHeader, FormError, Switch } from '../components'
import { api, wsUrl } from '../lib/api'
import { useAction, useToast } from '../state'
import { useWorkspace } from './workspace'
import {
  STEP_UP_ALWAYS,
  STEP_UP_GROUPS,
  STEP_UP_GROUP_COVERS,
  STEP_UP_GROUP_LABEL,
  STEP_UP_WINDOWS,
  stepUpWindowLabel,
} from '../../../../src/hosted/step-up.js'

function Row({ id, title, children, control }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 sm:px-5" data-sw-step-up-row={id}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-ui text-muted">{children}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </li>
  )
}

const State = ({ on }) => (
  <span className={on ? 'text-ui font-medium text-fg' : 'text-ui text-muted'} data-sw-step-up-state={on ? 'on' : 'off'}>
    {on ? 'On' : 'Off'}
  </span>
)

export function StepUpCard() {
  const { data, isOwner, workspaceId, reload } = useWorkspace()
  const toast = useToast()
  const change = useAction()
  const settings = data.workspace.settings.stepUp
  // An older server (and the demo) has no such setting.
  if (!settings) return null
  const anyOn = STEP_UP_GROUPS.some((group) => settings[group]) || settings.adminIdle
  const set = (body, done) =>
    change.run(async () => {
      await api.patch(wsUrl(workspaceId, '/step-up'), body)
      await reload()
      toast(done)
    })
  const toggle = (id, on, body, name) =>
    isOwner ? (
      <Switch
        checked={on}
        label={name}
        disabled={change.busy}
        onChange={(next) => set(body(next), `${name}: ${next ? 'the passkey is asked for again' : 'no longer asks for the passkey'}`)}
      />
    ) : (
      <State on={on} />
    )
  return (
    <Card data-sw-settings-step-up>
      <CardHeader
        icon={KeyRound}
        title="Ask for a passkey again"
        description="Being signed in with the right role is enough for everything in this workspace. Switch on what you want confirmed with a passkey again before it happens."
      />
      <ul className="divide-y divide-line">
        {STEP_UP_GROUPS.map((group) => (
          <Row
            key={group}
            id={group}
            title={STEP_UP_GROUP_LABEL[group]}
            control={toggle(group, settings[group], (next) => ({ group, on: next }), STEP_UP_GROUP_LABEL[group])}
          >
            Before: {STEP_UP_GROUP_COVERS[group]}.
          </Row>
        ))}
        <Row
          id="adminIdle"
          title="Admin pages after 12 hours away"
          control={toggle('adminIdle', settings.adminIdle, (next) => ({ adminIdle: next }), 'Admin pages after 12 hours away')}
        >
          Members, tokens, the audit log and the other admin pages ask once more when you come back after 12 hours without opening one.
        </Row>
        {data.features?.tailnetSignIn ? (
          <Row
            id="cliApproval"
            title="Approve command line logins in the browser"
            control={toggle(
              'cliApproval',
              settings.cliApproval,
              (next) => ({ cliApproval: next }),
              'Approve command line logins in the browser',
            )}
          >
            Off: shapewall login and agent connect on a tailnet machine are approved by that machine’s tailnet user, with no code. A tailnet
            identity is per device, not per person: anything running as you on a tailnet device of yours can act as you here. On: approving
            a machine needs the code, this console and a passkey check, and so does making an API token (a token is what a command line or
            an agent works with); the server refuses a session that only a tailnet identity stands behind, for both.
          </Row>
        ) : null}
        <Row
          id="window"
          title="One check counts for"
          control={
            isOwner ? (
              <Select
                value={String(settings.windowMinutes)}
                onValueChange={(value) =>
                  set({ windowMinutes: Number(value) }, `One passkey check now counts for ${stepUpWindowLabel(Number(value))}`)
                }
                disabled={change.busy}
              >
                <SelectTrigger size="touch" className="w-36 lg:h-9" aria-label="One check counts for" data-sw-step-up-window>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STEP_UP_WINDOWS.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {stepUpWindowLabel(minutes)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-ui text-fg">{stepUpWindowLabel(settings.windowMinutes)}</span>
            )
          }
        >
          {anyOn
            ? 'After a passkey check, what is switched on above is not asked again for this long.'
            : 'Nothing above is switched on, so nothing here asks yet.'}
        </Row>
      </ul>
      <div className="space-y-2 border-t border-line px-4 py-3.5 text-ui text-muted sm:px-5" data-sw-step-up-always>
        <p>
          <span className="font-medium text-fg">Always asked, on every server</span> (once every 10 minutes): {STEP_UP_ALWAYS.join('; ')}.
        </p>
        <p>
          {isOwner
            ? 'Switching something on needs nothing more. Switching it off, or a longer time, asks for your passkey.'
            : 'Only an owner changes these.'}{' '}
          A session that started with a recovery code is always asked.
        </p>
        <FormError error={change.error} />
      </div>
    </Card>
  )
}
