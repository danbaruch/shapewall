// What an agent is called and how it looks: the Name field, the icon picker
// and the accent colours, and the two places that show them.
//
// - AgentIdentityDialog: "Edit" on a connected agent's row (AgentsCard.jsx).
//   Saving posts to /api/agent/settings/identity, which changes nothing the
//   agent runs with: no restart, no test, and it works while it answers.
// - ConnectIdentity: the same fields inside the "Allow this?" confirmation
//   of a one-click Connect, the name first and the icon folded away.
//
// The rules are the server's (src/agent/identity.js): a name is one line of
// plain text, at most 40 characters. An uploaded picture is cropped to a
// square here and sent as a PNG (components/profile-photo.jsx profilePng,
// the profile photo's way); the server checks and re-encodes it.

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, ImageUp, RotateCcw } from 'lucide-react'
import { AGENT_NAME_MAX, AGENT_TINTS, cleanAgentName, isUploadIcon } from '../../../src/agent/identity.js'
import { agentLogo } from '../../../src/agent/agent-logos.js'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { Button, Dialog, Input, Spinner } from '../components/ui'
import { profilePng } from '../components/profile-photo'
import { AgentFace, BUILT_IN_ICONS, ICON_IDS, TINT_NAMES, tintColor } from '../chat/agentIcons'
import { Field } from './AgentSettingsParts'

export const ICON_MAX_BYTES = 2 * 1024 * 1024
// A picture chosen in the dialog and not saved yet.
const PENDING = 'upload:pending'

// The fields' value for an agent: { name, icon, tint, png }. `png` is the
// base64 of a picture chosen here (then `icon` is PENDING).
export const identityValue = (agent = {}) => ({ name: agent.label || '', icon: agent.icon || null, tint: agent.tint || null, png: null })

// What to send for `value`, against what is saved (`agent`): the body of
// POST /identity, or null when nothing but an upload changed.
export function identityChange(agent, value) {
  const change = {}
  if (value.name.trim() !== (agent.label || '')) change.name = value.name.trim()
  if (value.icon !== PENDING && value.icon !== (agent.icon || null)) change.icon = value.icon
  if (value.tint !== (agent.tint || null)) change.tint = value.tint
  return Object.keys(change).length ? change : null
}

// Saves `value` for the agent `id`: the name, icon and tint, then the
// picture when one was chosen. Returns the settings view after the last save.
export async function saveIdentity(id, agent, value) {
  let view = null
  const change = identityChange(agent, value)
  if (change) view = await api.post('/api/agent/settings/identity', { id, ...change })
  if (value.icon === PENDING && value.png) view = await api.post('/api/agent/settings/identity/icon', { id, png: value.png })
  return view
}

// One choice of a radio group drawn as a tile: the native radio is there for
// the keyboard and screen readers (arrow keys move, Space picks), the tile
// shows the focus ring and the check.
function TileRadio({ name, checked, onChange, label, children, className, ...props }) {
  return (
    <label
      className={cn(
        'relative inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl border-2 border-transparent',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent',
        checked ? 'border-accent bg-accent/10' : 'hover:border-line-strong',
        className,
      )}
      title={label}
      {...props}
    >
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      {children}
    </label>
  )
}

// The icon and colour pickers. `value`/`onChange`: see identityValue.
// `label`: the name the initials come from. `logo`: the agent's product
// mark, its default icon. `upload`: offer a picture (not in the demo).
export function IconPicker({ value, onChange, label, logo = null, upload = true, disabled = false }) {
  const group = useId()
  const file = useRef(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const mark = agentLogo(logo)
  const preview = value.png ? `data:image/png;base64,${value.png}` : null
  const uploaded = value.icon === PENDING || isUploadIcon(value.icon)
  // A colour shows on a built-in avatar and on initials: not on a picture or a product mark.
  const tinted = !uploaded && (value.icon || !mark)
  const choose = async (picked) => {
    if (!picked) return
    setBusy(true)
    setProblem('')
    try {
      const png = await profilePng(picked, { maxBytes: ICON_MAX_BYTES, maxLabel: '2 MB' })
      onChange({ ...value, icon: PENDING, png })
    } catch (caught) {
      setProblem(caught.message || 'This image could not be read.')
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ''
    }
  }
  const pick = (icon) => onChange({ ...value, icon, png: null })
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-fg" id={`${group}-icons`}>
          Icon
        </p>
        <div role="radiogroup" aria-labelledby={`${group}-icons`} className="flex flex-wrap gap-1" data-sw-agent-icon-options>
          <TileRadio
            name={`${group}-icon`}
            checked={!value.icon}
            onChange={() => pick(null)}
            label={mark ? `Default: the ${mark.name} mark` : 'Default: initials'}
            data-sw-agent-icon-option="default"
          >
            <AgentFace label={label} logo={logo} tint={value.tint} size="lg" className="h-9 w-9" />
          </TileRadio>
          {ICON_IDS.map((id) => (
            <TileRadio
              key={id}
              name={`${group}-icon`}
              checked={value.icon === id}
              onChange={() => pick(id)}
              label={BUILT_IN_ICONS[id].name}
              data-sw-agent-icon-option={id}
            >
              <AgentFace label={label} icon={id} tint={value.tint} size="lg" className="h-9 w-9" />
            </TileRadio>
          ))}
          {uploaded ? (
            <TileRadio name={`${group}-icon`} checked onChange={() => {}} label="Your picture" data-sw-agent-icon-option="upload">
              <AgentFace label={label} icon={value.icon === PENDING ? null : value.icon} src={preview} size="lg" className="h-9 w-9" />
            </TileRadio>
          ) : null}
        </div>
        {upload ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <Button size="touch" className="lg:h-8" disabled={busy || disabled} onClick={() => file.current?.click()}>
              {busy ? <Spinner /> : <ImageUp size={14} aria-hidden="true" />} Upload a picture
            </Button>
            <p className="text-xs text-muted">PNG, JPEG or WebP, up to 2 MB. Cropped to a square.</p>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              aria-label="Choose a picture for the icon"
              onChange={(event) => void choose(event.target.files?.[0])}
              data-sw-agent-icon-upload
            />
          </div>
        ) : null}
        {problem ? (
          <p className="text-xs text-bad" role="alert" data-sw-agent-icon-problem>
            {problem}
          </p>
        ) : null}
      </div>
      {tinted ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-fg" id={`${group}-tints`}>
            Colour
          </p>
          <div role="radiogroup" aria-labelledby={`${group}-tints`} className="flex flex-wrap gap-1" data-sw-agent-tint-options>
            <TileRadio
              name={`${group}-tint`}
              checked={!value.tint}
              onChange={() => onChange({ ...value, tint: null })}
              label="Default colour"
              data-sw-agent-tint-option="default"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface-2 text-muted">
                <RotateCcw size={13} aria-hidden="true" />
              </span>
            </TileRadio>
            {AGENT_TINTS.map((tint) => (
              <TileRadio
                key={tint}
                name={`${group}-tint`}
                checked={value.tint === tint}
                onChange={() => onChange({ ...value, tint })}
                label={TINT_NAMES[tint]}
                data-sw-agent-tint-option={tint}
              >
                <span className="h-7 w-7 rounded-full" style={{ background: tintColor(tint) }} />
              </TileRadio>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// The Name field. `builtIn`: the name an empty field falls back to. `hint`:
// where the name shows, when that is not the local board (a team server).
export function NameField({ value, onChange, builtIn = '', touch = false, id, problem = null, disabled = false, hint = null }) {
  return (
    <Field
      label="Name"
      htmlFor={id}
      problem={problem}
      hint={
        hint ||
        (builtIn
          ? `Shown in chats, on its replies and on Fix buttons. Leave it empty for "${builtIn}".`
          : 'Shown in chats, on its replies and on Fix buttons.')
      }
    >
      <Input
        id={id}
        size={touch ? 'touch' : 'sm'}
        value={value.name}
        onChange={(event) => onChange({ ...value, name: event.target.value })}
        placeholder={builtIn || 'Agent'}
        maxLength={AGENT_NAME_MAX}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={problem ? 'true' : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        data-sw-agent-name-input
      />
    </Field>
  )
}

// Why the typed name would be refused, in the dialog's words, or null.
export function nameProblem(name) {
  const { problem } = cleanAgentName(name)
  if (!problem) return null
  return /control/.test(problem) ? 'One line of plain text, without control characters.' : `At most ${AGENT_NAME_MAX} characters.`
}

// Inside the Connect confirmation: the name, then the icon folded away.
export function ConnectIdentity({ value, onChange, builtIn, logo = null, upload = true, touch = false, disabled = false }) {
  const id = useId()
  return (
    <div className="space-y-3 border-b border-line px-5 pt-5 pb-4" data-sw-connect-identity>
      <NameField
        id={`${id}-name`}
        value={value}
        onChange={onChange}
        builtIn={builtIn}
        touch={touch}
        problem={nameProblem(value.name)}
        disabled={disabled}
      />
      <details className="group" data-sw-connect-icon>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs font-medium text-fg lg:min-h-8 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={13} className="text-muted transition-transform group-open:rotate-90" aria-hidden="true" />
          <AgentFace
            label={value.name || builtIn}
            icon={value.icon === PENDING ? null : value.icon}
            tint={value.tint}
            logo={logo}
            size="sm"
            src={value.png ? `data:image/png;base64,${value.png}` : null}
          />
          Icon (optional)
        </summary>
        <div className="pt-2">
          <IconPicker value={value} onChange={onChange} label={value.name || builtIn} logo={logo} upload={upload} disabled={disabled} />
        </div>
      </details>
    </div>
  )
}

// `agent`: { id, label, icon, tint, logo, builtIn } or null (closed).
// `onSaved(view)`: the settings view after the save (null: nothing changed).
// `waiting`: this agent's connection test is still running (it was just
// connected): the save waits for the test on the server, and says so.
export function AgentIdentityDialog({ agent, upload = true, touch = false, waiting = false, onClose, onSaved }) {
  const id = useId()
  const [value, setValue] = useState(identityValue())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lastId = useRef(null)
  // Fresh fields each time it opens for an agent.
  useEffect(() => {
    if (agent) {
      lastId.current = agent.id
      setValue(identityValue(agent))
      setError('')
    }
  }, [agent])
  const size = touch ? 'touch' : 'md'
  const problem = nameProblem(value.name)
  // An agent Shapewall has no built-in name for must keep a name.
  const needsName = agent && !agent.builtIn && !value.name.trim() ? 'Give it a name.' : null
  const changed = agent ? Boolean(identityChange(agent, value)) || Boolean(value.png) : false
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const view = await saveIdentity(agent.id, agent, value)
      await onSaved?.(view)
      onClose()
    } catch (caught) {
      setError(caught.message || 'It could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  const preview = value.png ? `data:image/png;base64,${value.png}` : null
  return (
    <Dialog
      open={Boolean(agent)}
      onClose={() => (busy ? null : onClose())}
      title="Name and icon"
      description="How this agent shows on the board. It keeps running; nothing is restarted."
      wrapDescription
      size="md"
      onCloseAutoFocus={(event) => {
        // Back to the Edit button it was opened from. The list is drawn
        // again after a save, so the button is looked up, not remembered.
        const opener = document.querySelector(`[data-sw-agent-edit="${CSS.escape(lastId.current || '')}"]`)
        if (!opener) return
        event.preventDefault()
        opener.focus()
      }}
      footer={
        <>
          <Button size={size} onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size={size}
            variant="default"
            onClick={save}
            disabled={busy || !changed || Boolean(problem || needsName)}
            data-sw-agent-identity-save
          >
            {busy ? (waiting ? 'Saving when the connection test finishes...' : 'Saving...') : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4 p-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && changed && !problem && !needsName) save()
        }}
        data-sw-agent-identity={agent?.id}
      >
        <div className="flex items-center gap-3">
          <AgentFace
            label={value.name || agent?.builtIn || agent?.label}
            icon={value.icon === PENDING ? null : value.icon}
            tint={value.tint}
            logo={agent?.logo}
            src={preview}
            size="xl"
            data-sw-agent-identity-preview
          />
          <div className="min-w-0 flex-1">
            <NameField
              id={`${id}-name`}
              value={value}
              onChange={setValue}
              builtIn={agent?.builtIn || ''}
              touch={touch}
              problem={problem || needsName}
              disabled={busy}
            />
          </div>
        </div>
        <IconPicker
          value={value}
          onChange={setValue}
          label={value.name || agent?.builtIn || agent?.label}
          logo={agent?.logo}
          upload={upload}
          disabled={busy}
        />
        {waiting && !error ? (
          <p className="text-xs text-muted" role="status" data-sw-agent-identity-waiting>
            Its connection test is still running. Save waits for it to finish, then saves.
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-bad" role="alert" data-sw-agent-identity-error>
            {error}
          </p>
        ) : null}
        {/* Enter in the name field saves. */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </Dialog>
  )
}
