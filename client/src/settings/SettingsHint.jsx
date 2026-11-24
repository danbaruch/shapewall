// How to unlock agent settings when this tab has no owner link: one wording,
// used by the chat panel, quick connect and the settings dialogs.
import { useSyncExternalStore } from 'react'

export const TOKEN_HINT =
  'On the computer running Shapewall, open the Private owner link that shapewall serve printed, or run shapewall settings --open in the project folder, to open agent settings.'

// The exact command for this board (/api/info agent.settingsCommand, with its real config path), once the page knows it
// (App.jsx and the local console set it).
let command = null
const listeners = new Set()
export function setSettingsCommand(value) {
  const next = typeof value === 'string' && value ? value : null
  if (next === command) return
  command = next
  for (const listener of listeners) listener()
}
const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const current = () => command
const none = () => null

export function SettingsHint() {
  const exact = useSyncExternalStore(subscribe, current, none)
  return (
    <>
      On the computer running Shapewall, open the <strong className="font-medium text-fg">Private owner link</strong> that{' '}
      <code className="font-mono">shapewall serve</code> printed, or run{' '}
      <code className="font-mono break-all" data-sw-settings-command="true">
        {exact || 'shapewall settings --open'}
      </code>
      {exact ? '' : ' in the project folder'} to open agent settings.
    </>
  )
}
