// The chat header and its pieces: who answers (AgentChip), where messages go
// (AgentDestination), Chat settings, the thread and profile pickers, and the
// not-connected state (ConnectAgent).

import { useState } from 'react'
import { Bot, ChevronDown, Copy, Download, ExternalLink, History, Settings2, SquarePen, Trash2, X } from 'lucide-react'
import { Badge, Button, EmptyState, IconButton, Popover, PopoverContent, PopoverTrigger, Tooltip } from '../components/ui'
import { PanelHeader } from '../components/panel-header'
import { cn } from '../lib/utils'
import { ReadAloudSettings } from './ReadAloud'
import { dictationUnavailable } from './speech'
import McpSetup from './McpSetup'
import Disclosure from './Disclosure'
import { STATE_DOT, STATE_TEXT } from './profiles'
import { AgentPicker } from './AgentPicker'
import { AgentFace, faceOf } from './agentIcons'
import { DOCS_URL, QuickConnect } from './QuickConnect'
import { SettingsHint } from '../settings/SettingsHint'

// ---- Not connected -------------------------------------------------------------

// The files way: a config entry or a terminal command, then a restart.
export function FilesSetup({ agent }) {
  return (
    <>
      <p>
        Shapewall does not ship a model. Point it at any OpenAI-compatible endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio) in{' '}
        <code className="font-mono">shapewall.config.json</code>, with the key in an environment variable, then restart{' '}
        <code className="font-mono">shapewall serve</code>.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-line bg-sunken p-2 text-left font-mono text-[11px] leading-4 text-fg">
        {'"agent": {\n  "baseUrl": "https://api.deepseek.com",\n  "model": "deepseek-chat",\n  "apiKeyEnv": "DEEPSEEK_API_KEY"\n}'}
      </pre>
      <p className="mt-3">
        Or chat with an agent CLI on your machine (Claude Code, Codex, goose, Gemini CLI) over ACP, with its own login:
      </p>
      <pre
        className="mt-2 overflow-x-auto rounded-md border border-line bg-sunken p-2 text-left font-mono text-[11px] leading-4 text-fg"
        data-sw-chat-acp-example="true"
      >
        {'npm install -g @agentclientprotocol/claude-agent-acp\nshapewall serve --agent-acp "claude-agent-acp"'}
      </pre>
      <McpSetup />
      {agent?.problem ? (
        <p className="mt-2 text-bad" data-sw-chat-problem="true">
          The agent config needs a fix: {agent.problem}.
        </p>
      ) : null}
    </>
  )
}

// Not connected. With the settings token (onOpenSettings): the agents found
// on this machine, one click each. Without it on a board that could have it
// (settingsHint): how to get it, with the files way folded away. Otherwise
// (a shared board with --chat): the files way.
export function ConnectAgent({ agent, touch, onOpenSettings, settingsHint, onConnected }) {
  const docs = (
    <Button asChild variant="default" size={touch ? 'touch' : 'sm'} className="mt-3">
      <a href={agent?.docsUrl || DOCS_URL} target="_blank" rel="noreferrer" data-sw-chat-docs="true">
        <ExternalLink size={13} aria-hidden="true" /> How to connect an agent
      </a>
    </Button>
  )
  if (onOpenSettings) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-6" data-sw-chat-empty="unconfigured">
        <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-3">
          <Bot size={22} className="text-faint" aria-hidden="true" />
          <p className="text-sm font-medium text-fg">Connect an agent to chat</p>
          {agent?.problem ? (
            <p className="text-center text-xs text-bad" data-sw-chat-problem="true">
              {agent.problem}.
            </p>
          ) : null}
          <QuickConnect agent={agent} touch={touch} onOpenSettings={onOpenSettings} onConnected={onConnected} />
          <McpSetup title="Or drive this board from Claude Code / Codex (MCP)" className="w-full" touch={touch} />
        </div>
      </div>
    )
  }
  if (settingsHint) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto" data-sw-chat-empty="unconfigured">
        <EmptyState icon={Bot} title="Connect an agent to chat">
          <p data-sw-settings-hint="connect">
            <SettingsHint />
          </p>
          <Disclosure title="Set it up in files instead" touch={touch} className="mt-4 text-left" data-sw-chat-files-setup="true">
            <FilesSetup agent={agent} />
          </Disclosure>
          {docs}
        </EmptyState>
      </div>
    )
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto" data-sw-chat-empty="unconfigured">
      <EmptyState icon={Bot} title="Connect an agent to chat">
        <FilesSetup agent={agent} />
        {docs}
      </EmptyState>
    </div>
  )
}
// ---- Settings: read-aloud voice, clear the thread ---------------------------------

// Where messages go: the endpoint's host, and whether the server's key goes with them.
export function AgentDestination({ agent, className }) {
  if (agent?.demo) {
    return (
      <p className={cn('text-xs text-muted', className)} data-sw-chat-host="demo">
        <span className="font-medium text-fg">{agent.label}</span>: canned answers that run in this browser. Nothing is sent anywhere and
        nothing is changed.
      </p>
    )
  }
  if (agent?.local) {
    return (
      <p className={cn('text-xs text-muted', className)} data-sw-chat-host="local">
        <span className="text-fg">{agent.label}</span> works in this project with your login. It asks before changing files or running
        commands.
      </p>
    )
  }
  if (!agent?.host) return null
  return (
    <p className={cn('text-xs text-muted', className)} data-sw-chat-host={agent.host}>
      {agent.label ? `${agent.label} at ` : 'Messages go to '}
      <span className="font-mono text-fg">{agent.host}</span>
      {agent.sendsKey ? ", with the server's API key." : ', without an API key.'}
    </p>
  )
}

export function ChatSettings({
  agent,
  voiceUri,
  onVoice,
  readAloud,
  onReadAloud,
  onClear,
  canClear,
  onOpenSettings,
  settingsHint,
  onExport = null,
  touch,
  children = null,
}) {
  const [open, setOpen] = useState(false)
  const unavailable = dictationUnavailable()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Chat settings">
        <PopoverTrigger asChild>
          <Button variant="ghost" size={touch ? 'icon' : 'icon-sm'} aria-label="Chat settings" data-sw-chat-settings="true">
            <Settings2 size={15} aria-hidden="true" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="max-h-[80vh] w-80 space-y-3 overflow-y-auto p-3">
        <AgentDestination agent={agent} />
        {onOpenSettings ? (
          <Button
            size={touch ? 'touch' : 'sm'}
            className="w-full justify-start"
            onClick={() => {
              setOpen(false)
              onOpenSettings()
            }}
            data-sw-settings-open="chat"
          >
            <Settings2 size={13} aria-hidden="true" /> Change the agent
          </Button>
        ) : settingsHint ? (
          <p className="text-xs text-muted" data-sw-settings-hint="chat">
            <SettingsHint />
          </p>
        ) : null}
        <div className="space-y-1 text-xs text-muted" data-sw-chat-voice-privacy="true">
          <p className="font-medium text-fg">Voice input</p>
          <p>
            Dictation uses your browser’s speech service, which may send audio to its provider. Review the transcript before sending. Only
            text you send goes to the agent.
          </p>
          {unavailable ? <p>{unavailable}</p> : null}
          <p>System read-aloud voices may use their provider. Downloaded natural voices run on this device.</p>
        </div>
        <ReadAloudSettings settings={readAloud} onChange={onReadAloud} voiceUri={voiceUri} onVoice={onVoice} touch={touch} />
        {children}
        {agent?.demo ? null : (
          <div className="border-t border-line pt-3">
            <McpSetup open touch={touch} />
          </div>
        )}
        {onExport ? (
          <div className="grid grid-cols-2 gap-2 border-t border-line pt-3" data-sw-chat-export="true">
            <Button
              variant="secondary"
              size={touch ? 'touch' : 'sm'}
              disabled={!canClear}
              onClick={() => {
                setOpen(false)
                onExport('copy')
              }}
              data-sw-chat-export-copy="true"
            >
              <Copy size={13} aria-hidden="true" /> Copy as Markdown
            </Button>
            <Button
              variant="secondary"
              size={touch ? 'touch' : 'sm'}
              disabled={!canClear}
              onClick={() => {
                setOpen(false)
                onExport('download')
              }}
              data-sw-chat-export-download="true"
            >
              <Download size={13} aria-hidden="true" /> Download .md
            </Button>
          </div>
        ) : null}
        <Button
          variant="danger"
          size={touch ? 'touch' : 'sm'}
          className="w-full justify-start"
          disabled={!canClear}
          onClick={() => {
            setOpen(false)
            onClear()
          }}
          data-sw-chat-clear="true"
        >
          <Trash2 size={13} aria-hidden="true" /> Clear this chat
        </Button>
      </PopoverContent>
    </Popover>
  )
}

// Who answers, as a compact chip with a status dot: ready, answering, or
// waiting for the person's permission. Where messages go is in its tooltip
// (and in Chat settings).
const AGENT_STATES = {
  ready: { dot: 'bg-ok', text: 'Ready' },
  working: { dot: 'bg-accent motion-safe:animate-pulse', text: 'Answering' },
  waiting: { dot: 'bg-warn', text: 'Waiting for you' },
}
function agentTip(agent) {
  if (agent?.demo) return 'Scripted answers that run in this browser. Nothing is sent anywhere and nothing is changed.'
  if (agent?.local) return 'Runs on the server’s computer, with its own login.'
  if (agent?.host) return `Messages go to ${agent.host}${agent.sendsKey ? ", with the server's API key" : ''}.`
  return null
}
// The agent's icon in the chip, when it has one (an avatar its owner chose
// or a known agent's mark): a chip without one stays as it was.
function ChipFace({ agent, label }) {
  const face = faceOf(agent)
  if (!face.icon && !face.logo && !face.tint) return null
  return <AgentFace label={label} {...face} size="xs" />
}
// The chip, and with `picker` ({ options, value, onChoose, onConnect,
// settingsHref, disabledReason }) the agent picker it opens. Its dot: the
// turn (answering, waiting for you), else how the agent is doing.
export function AgentSwitch({ agent, state, picker, touch, className }) {
  if (!picker) return <AgentChip agent={agent} state={state} className={className} />
  const label = agent?.label || 'Agent'
  const current = picker.options.find((option) => option.id === picker.value)
  const health = current?.state || agent?.state || 'ready'
  const turn = state === 'working' || state === 'waiting' ? AGENT_STATES[state] : null
  const dot = turn ? turn.dot : STATE_DOT[health] || STATE_DOT.ready
  const text = turn ? turn.text : STATE_TEXT[health] || STATE_TEXT.ready
  return (
    <AgentPicker
      options={picker.options}
      value={picker.value}
      onChoose={picker.onChoose}
      onConnect={picker.onConnect}
      settingsHref={picker.settingsHref}
      disabledReason={picker.disabledReason}
      heading="Agent for this chat"
      touch={touch}
    >
      <button
        type="button"
        className={cn(
          'inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/70 pr-1.5 pl-1.5 text-xs text-fg outline-none hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-disabled:cursor-default aria-disabled:hover:bg-surface-2/70 data-[state=open]:bg-surface-2',
          touch ? 'h-9' : 'h-6',
          className,
        )}
        aria-label={`Agent: ${label}, ${text}. Choose the agent for this chat`}
        data-sw-agent-profile="true"
        data-sw-chat-label={label}
        data-sw-chat-agent-state={state}
        data-sw-agent-health={health}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden="true" />
        <ChipFace agent={current || agent} label={label} />
        <span className="min-w-0 truncate font-medium">{label}</span>
        {agent?.demo ? (
          <span className="shrink-0 text-faint" aria-hidden="true">
            {' '}
            demo
          </span>
        ) : null}
        <ChevronDown size={12} className="shrink-0 text-faint" aria-hidden="true" />
      </button>
    </AgentPicker>
  )
}

export function AgentChip({ agent, state, className }) {
  // Its connection test runs: said in words, like the picker's chip.
  const testing = agent?.state === 'testing' && (!state || state === 'ready')
  const info = testing ? { dot: STATE_DOT.testing, text: STATE_TEXT.testing } : AGENT_STATES[state] || AGENT_STATES.ready
  const label = agent?.label || 'Agent'
  return (
    <Tooltip content={agentTip(agent)}>
      <span
        className={cn(
          'inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/70 pr-2 pl-1.5 text-xs text-fg',
          className,
        )}
        data-sw-chat-label={label}
        data-sw-chat-agent-state={state}
        tabIndex={0}
        role="status"
        aria-label={`${label}: ${info.text}`}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', info.dot)} aria-hidden="true" />
        <ChipFace agent={agent} label={label} />
        <span className="min-w-0 truncate font-medium">{label}</span>
        {agent?.demo ? <span className="shrink-0 text-faint">demo</span> : null}
      </span>
    </Tooltip>
  )
}
// ---- The header: title, agent chip, settings, close, chat history and New chat ----

// The top row: the shared side panel header beside the canvas; on a phone the
// sheet has the title and close, so only the chip and settings.
function Row({ heading, onClose, touch, children }) {
  if (heading) {
    return (
      <PanelHeader icon={Bot} title="Agent" onClose={onClose} closeLabel="Close chat" closeProps={{ 'data-sw-chat-close': 'true' }}>
        {children}
      </PanelHeader>
    )
  }
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2">
      {children}
      {onClose ? (
        <IconButton size={touch ? 'icon' : 'icon-sm'} label="Close chat" onClick={onClose} data-sw-chat-close="true">
          <X size={15} aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  )
}

export function ChatHeader({
  heading,
  configured,
  agent,
  agentState,
  picker = null,
  voiceUri,
  onVoice,
  readAloud,
  onReadAloud,
  onClear,
  canClear,
  onOpenSettings,
  settingsHint,
  onClose,
  threadId,
  threadTitle,
  threadBadge = null,
  onOpenHistory,
  onNewChat,
  onExport = null,
  touch,
  // More Chat settings from the panel (the composer's "Allow for this chat" list).
  settingsExtra = null,
}) {
  return (
    <header className="relative z-10 shrink-0 border-b border-line bg-surface" data-sw-chat-header="true">
      <Row heading={heading} onClose={onClose} touch={touch}>
        {configured ? (
          <AgentSwitch agent={agent} state={agentState} picker={picker} touch={touch} className={heading ? 'ml-1' : ''} />
        ) : null}
        <span className="min-w-0 flex-1" />
        {configured ? (
          <ChatSettings
            agent={agent}
            voiceUri={voiceUri}
            onVoice={onVoice}
            readAloud={readAloud}
            onReadAloud={onReadAloud}
            onClear={onClear}
            canClear={canClear}
            onOpenSettings={onOpenSettings}
            settingsHint={settingsHint}
            onExport={onExport}
            touch={touch}
          >
            {settingsExtra}
          </ChatSettings>
        ) : null}
      </Row>
      {configured ? (
        <div className="flex items-center gap-1.5 px-3 pt-1 pb-2">
          {/* The thread on screen; opens chat history (history.jsx). */}
          <Button
            variant="secondary"
            size={touch ? 'touch' : 'sm'}
            className="min-w-0 flex-1 justify-start"
            onClick={onOpenHistory}
            aria-label={`Chat history. Current: ${threadTitle}`}
            aria-haspopup="dialog"
            data-sw-chat-thread={threadId}
            data-sw-chat-history-open="true"
          >
            <History size={14} className="shrink-0 text-muted" aria-hidden="true" />
            {threadBadge ? (
              <Badge tone="accent" className="shrink-0 tabular-nums">
                {threadBadge}
              </Badge>
            ) : null}
            <span className="min-w-0 truncate" data-sw-chat-title="true">
              {threadTitle}
            </span>
            <ChevronDown size={13} className="ml-auto shrink-0 text-faint" aria-hidden="true" />
          </Button>
          <IconButton
            size={touch ? 'icon' : 'icon-sm'}
            variant="secondary"
            label="New chat"
            tooltip="New chat: starts fresh, without this chat's context"
            onClick={onNewChat}
            disabled={!onNewChat}
            data-sw-chat-new="header"
          >
            <SquarePen size={14} aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
    </header>
  )
}
