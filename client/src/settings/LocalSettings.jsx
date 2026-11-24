import { useRef, useState } from 'react'
import { Button, Dialog, Tabs, TabsContent, TabsList, TabsTrigger, ToggleGroup } from '../components/ui'
import { MODES, THEMES, useAppearance } from '../lib/theme'
import { AgentSettings } from './AgentSettings'
import { SettingsHint } from './SettingsHint'

// General preferences never need the installation owner's agent capability.
// The protected editor mounts only after an authorized reader picks Agent.
export default function LocalSettings({ open, onClose, info, boardCount, onSaved, onOpenUpdates, touch }) {
  const openingUpdates = useRef(false)
  // Unsaved agent edits: only the dialog's own close button closes it, not a stray click outside or Escape.
  const [dirty, setDirty] = useState(false)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      sticky={dirty}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (!openingUpdates.current) document.querySelector('[data-sw-profile-menu]')?.focus()
      }}
      title="Settings"
      size="md"
    >
      <LocalSettingsContent
        info={info}
        boardCount={boardCount}
        onSaved={onSaved}
        touch={touch}
        onDirtyChange={setDirty}
        onOpenUpdates={() => {
          openingUpdates.current = true
          onOpenUpdates()
        }}
      />
    </Dialog>
  )
}

// The board's Settings dialog: General and Agent tabs. The Workspace Console
// shows the same pieces on two pages instead: General on Settings, the agent
// details on Agents, under the Agents card (console/LocalConsole.jsx).
export function LocalSettingsContent({ info, boardCount, onSaved, onOpenUpdates, touch, onDirtyChange }) {
  return (
    <Tabs defaultValue="general" className="p-5">
      <TabsList className="mb-5 max-w-72" aria-label="Settings">
        <TabsTrigger value="general" large={touch} data-sw-settings-tab="general">
          General
        </TabsTrigger>
        <TabsTrigger value="agent" large={touch} data-sw-settings-tab="agent">
          Agent
        </TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <GeneralSettings info={info} boardCount={boardCount} touch={touch} onOpenUpdates={onOpenUpdates} />
      </TabsContent>
      <TabsContent value="agent">
        <AgentDetails info={info} onSaved={onSaved} touch={touch} onDirtyChange={onDirtyChange} />
      </TabsContent>
    </Tabs>
  )
}

// Appearance for this browser and this installation's details.
export function GeneralSettings({ info, boardCount, touch, onOpenUpdates }) {
  const [appearance, setAppearance] = useAppearance()
  return (
    <div className="space-y-6" data-sw-settings="general">
      <section className="space-y-3" aria-labelledby="sw-general-appearance">
        <div>
          <h2 id="sw-general-appearance" className="text-sm font-semibold text-fg">
            Appearance
          </h2>
          <p className="mt-1 text-xs text-muted">Saved in this browser and shared with your other Shapewall tabs.</p>
        </div>
        <div className="space-y-1.5" data-sw-settings-mode>
          <p className="text-xs font-medium text-fg">Mode</p>
          <ToggleGroup
            value={appearance.mode}
            onChange={(mode) => setAppearance({ mode })}
            options={MODES}
            label="Appearance mode"
            large={touch}
          />
        </div>
        <div className="space-y-1.5" data-sw-settings-theme>
          <p className="text-xs font-medium text-fg">Theme</p>
          <ToggleGroup
            value={appearance.theme}
            onChange={(theme) => setAppearance({ theme })}
            options={THEMES}
            label="Appearance theme"
            large={touch}
            className="grid grid-cols-2 sm:flex"
          />
        </div>
      </section>
      <section className="space-y-2" aria-labelledby="sw-general-installation">
        <h2 id="sw-general-installation" className="text-sm font-semibold text-fg">
          This installation
        </h2>
        <dl className="space-y-1 text-xs">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <dt className="text-muted">Name</dt>
            <dd className="min-w-0 break-words text-fg">{info?.title || 'Shapewall'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Boards</dt>
            <dd className="text-fg">{boardCount}</dd>
          </div>
        </dl>
        <Button size={touch ? 'touch' : 'md'} className="mt-2" onClick={onOpenUpdates} data-sw-settings-updates>
          About & Updates
        </Button>
      </section>
    </div>
  )
}

// The agent's connection details and the OpenAI-compatible endpoint form, or
// why they are not available here. `agentsHome`: on the console's Agents page,
// under the Agents card, so the agents are not listed again; elsewhere a link
// to that page stands in for them.
export function AgentDetails({ info, onSaved, touch, onDirtyChange, agentsHome = false }) {
  const agentAvailable = Boolean(info?.agent?.settingsEditable || info?.agent?.settingsReadonly)
  return agentAvailable ? (
    <AgentSettings
      onSaved={onSaved}
      touch={touch}
      buzz={Boolean(info?.buzzAvailable)}
      onDirtyChange={onDirtyChange}
      agents={agentsHome ? 'none' : 'link'}
    />
  ) : (
    <div className="space-y-2 text-sm" data-sw-settings-agent-unavailable>
      <h2 className="font-semibold text-fg">Agent settings</h2>
      <p className="text-muted">
        {info?.agent?.settingsLocked ? (
          <SettingsHint />
        ) : info?.agent ? (
          'Agent settings are managed on the computer serving this installation.'
        ) : (
          'Agent chat is not enabled for this installation. Ask the installer to enable it if you want to connect an agent.'
        )}
      </p>
    </div>
  )
}
