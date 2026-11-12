// A workspace's step-up settings ("Ask for a passkey again before...",
// src/hosted/step-up.js): reading them, and one function per setting to
// change them, so the console's routes and a later admin tool call the same
// code. Every change is an owner's, is written to the audit log with the
// value before and after, and a change that asks for the passkey less needs
// a fresh passkey check itself (the actor says whether it has one; a caller
// cannot leave that out).
//
//   const settings = stepUpSettings(t)
//   settings.get()
//   settings.setGroup(actor, 'tokens', true)
//   settings.setWindow(actor, 30)
//   settings.setAdminIdle(actor, true)
//   settings.setCliApproval(actor, true)
//
// actor: { role, fresh, audit(action, target, detail) }
//   fresh: true when the person passed a passkey check in the last 10
//   minutes; or a function that throws the refusal to send when they did not.

import { HttpError } from './http.js'
import { STEP_UP_GROUPS, STEP_UP_WINDOWS, readStepUp, stepUpWeaker } from './step-up.js'

export function stepUpSettings(t) {
  const get = () => readStepUp(t.get('SELECT step_up FROM workspaces WHERE workspace_id = :ws')?.step_up)

  function change(actor, setting, next) {
    if (actor?.role !== 'owner')
      throw new HttpError(403, 'forbidden', 'Only an owner changes when this workspace asks for a passkey again.')
    const before = get()
    const after = readStepUp({ ...before, ...next })
    if (JSON.stringify(before) === JSON.stringify(after)) return after
    if (stepUpWeaker(before, after)) {
      if (typeof actor.fresh === 'function') actor.fresh()
      else if (actor.fresh !== true)
        throw new HttpError(403, 'reauth_required', 'Confirm with your passkey first (always needed to make these settings weaker).')
    }
    t.run('UPDATE workspaces SET step_up = :value WHERE workspace_id = :ws', { value: JSON.stringify(after) })
    const key = Object.keys(next)[0]
    actor.audit('step_up_changed', null, { setting, before: before[key], after: after[key] })
    return after
  }

  return {
    get,
    // One group on or off.
    setGroup(actor, group, on) {
      if (!STEP_UP_GROUPS.includes(group)) throw new HttpError(400, 'invalid_settings', `group: one of ${STEP_UP_GROUPS.join(', ')}.`)
      if (typeof on !== 'boolean') throw new HttpError(400, 'invalid_settings', 'on: true or false.')
      return change(actor, group, { [group]: on })
    },
    // How long one passkey check counts for the groups that are on.
    setWindow(actor, minutes) {
      if (!STEP_UP_WINDOWS.includes(minutes))
        throw new HttpError(400, 'invalid_settings', `windowMinutes: one of ${STEP_UP_WINDOWS.join(', ')}.`)
      return change(actor, 'windowMinutes', { windowMinutes: minutes })
    },
    // Admin pages ask again after 12 hours without a visit to one.
    setAdminIdle(actor, on) {
      if (typeof on !== 'boolean') throw new HttpError(400, 'invalid_settings', 'adminIdle: true or false.')
      return change(actor, 'adminIdle', { adminIdle: on })
    },
    // Tailnet sign-in: CLI logins and agent connections wait for the browser anyway.
    setCliApproval(actor, on) {
      if (typeof on !== 'boolean') throw new HttpError(400, 'invalid_settings', 'cliApproval: true or false.')
      return change(actor, 'cliApproval', { cliApproval: on })
    },
  }
}
