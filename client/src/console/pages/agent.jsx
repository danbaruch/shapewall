// A project's agent policy: who may send comments to an agent, and how much
// the agent may run. The server checks and enforces all of it.

import { useState } from 'react'
import { Bot } from 'lucide-react'
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Input, Spinner, Textarea } from '../../components/ui'
import { Card, CardHeader, CheckToggle, Field, FormError, Loading, LoadError, Notice } from '../components'
import { ROLE_LABEL } from '../lib/format'
import { api, wsUrl } from '../lib/api'
import { useAction, useLoad, useToast } from '../state'

// [key, label, the most, what an older server that does not send it means]
const LIMITS = [
  ['dailyClaims', 'Runs per day (UTC)', 10000, 50],
  ['maxOpenClaims', 'Runs in progress at once', 100, 3],
  // Chat with connected agents (`shapewall agent connect`).
  ['dailyTurns', 'Chat turns per day (UTC)', 100000, 200],
]

export function AgentPolicySection({ workspaceId, projectId }) {
  const url = wsUrl(workspaceId, `/projects/${projectId}/agent`)
  const load = useLoad(url)
  return (
    <Card data-sw-agent-policy>
      <CardHeader
        icon={Bot}
        title="Agent policy"
        description="Who can send comments to an agent in this project, and how much the agent may run."
      />
      {load.loading ? (
        <Loading />
      ) : load.error ? (
        <div className="p-4">
          <LoadError error={load.error} onRetry={load.reload} />
        </div>
      ) : load.data ? (
        // Keyed by the saved policy: the form starts over from what the server kept.
        <PolicyForm key={JSON.stringify(load.data.policy)} policy={load.data.policy} url={url} onSaved={load.reload} />
      ) : null}
    </Card>
  )
}

function PolicyForm({ policy, url, onSaved }) {
  const toast = useToast()
  const [draft, setDraft] = useState(policy)
  const [handles, setHandles] = useState(policy.trustedHandles.join(', '))
  // Kept as typed: an emptied field is a mistake to point out, not a limit of 0.
  const [limits, setLimits] = useState(() =>
    Object.fromEntries(LIMITS.map(([key, , , fallback]) => [key, String(policy[key] ?? fallback)])),
  )
  const [overrides, setOverrides] = useState(JSON.stringify(policy.boards || {}, null, 2))
  const action = useAction()
  const set = (key, value) => setDraft({ ...draft, [key]: value })

  const limitProblem = (key, max) => {
    const text = limits[key].trim()
    const value = Number(text)
    return text !== '' && Number.isInteger(value) && value >= 0 && value <= max ? null : `A whole number from 0 to ${max}.`
  }
  let overridesProblem = null
  try {
    const parsed = JSON.parse(overrides)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) overridesProblem = 'This must be a JSON object, such as {}.'
  } catch {
    overridesProblem = 'This is not valid JSON.'
  }
  const invalid = Boolean(overridesProblem) || LIMITS.some(([key, , max]) => limitProblem(key, max))

  const save = (event) => {
    event.preventDefault()
    if (invalid) return
    action.run(async () => {
      await api.put(url, {
        ...draft,
        ...Object.fromEntries(LIMITS.map(([key]) => [key, Number(limits[key])])),
        trustedHandles: handles
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
        boards: JSON.parse(overrides),
      })
      toast('Agent policy saved')
      await onSaved()
    })
  }

  return (
    <form className="space-y-4 px-4 py-4 sm:px-5" onSubmit={save} noValidate>
      <Field label="Trusted handles (comma separated)" hint="People whose comments go to the agent, besides the roles below.">
        {(field) => (
          <Input
            {...field}
            size="touch"
            value={handles}
            onChange={(event) => setHandles(event.target.value)}
            autoCapitalize="none"
            spellCheck={false}
            placeholder="ada, sam"
          />
        )}
      </Field>
      <fieldset>
        <legend className="mb-1.5 block text-ui font-medium text-fg">Trusted roles</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {['member', 'admin', 'owner'].map((role) => (
            <CheckToggle
              key={role}
              checked={draft.trustedRoles.includes(role)}
              onChange={(checked) =>
                set('trustedRoles', checked ? [...draft.trustedRoles, role] : draft.trustedRoles.filter((item) => item !== role))
              }
            >
              {ROLE_LABEL[role] || role}
            </CheckToggle>
          ))}
        </div>
      </fieldset>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        {LIMITS.map(([key, label, max]) => (
          <Field
            key={key}
            label={label}
            hint={key === 'dailyTurns' ? '0 stops chat with connected agents.' : '0 stops new runs.'}
            error={limitProblem(key, max)}
          >
            {(field) => (
              <Input
                {...field}
                size="touch"
                type="number"
                inputMode="numeric"
                min="0"
                max={max}
                value={limits[key]}
                onChange={(event) => setLimits({ ...limits, [key]: event.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="space-y-2">
        <CheckToggle checked={draft.onlyMentions} onChange={(checked) => set('onlyMentions', checked)}>
          Only comments that mention @agent
        </CheckToggle>
        <CheckToggle checked={draft.approveNonAdmin} onChange={(checked) => set('approveNonAdmin', checked)}>
          An admin approves runs that other people ask for
        </CheckToggle>
      </div>
      <Collapsible defaultOpen={Object.keys(policy.boards || {}).length > 0}>
        <CollapsibleTrigger className="-mx-2 w-auto" data-sw-agent-overrides-toggle>
          Advanced: different rules for one board
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pt-2">
            <Field
              label="Per-board rules (JSON)"
              hint="Keyed by board id. Leave it as {} unless one board needs different rules from the project."
              error={overridesProblem}
            >
              {(field) => (
                <Textarea
                  {...field}
                  size="touch"
                  className="font-mono lg:text-sm"
                  rows={4}
                  spellCheck={false}
                  value={overrides}
                  onChange={(event) => setOverrides(event.target.value)}
                />
              )}
            </Field>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Notice>The agent never acts on guest comments or its own comments. Editing a comment clears its approval.</Notice>
      <FormError error={action.error} />
      <div className="flex justify-end">
        <Button type="submit" size="touch" variant="default" className="lg:h-9" disabled={action.busy || invalid}>
          {action.busy ? <Spinner /> : null} Save agent policy
        </Button>
      </div>
    </form>
  )
}
