import { useState } from 'react'
import { Check, Copy, Terminal } from 'lucide-react'
import { Button } from '../components/ui'
import { cn } from '../lib/utils'
import Disclosure from './Disclosure'

const CLIENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
]

// The MCP setup commands for an external coding session, with Copy.
function McpCommands({ touch }) {
  const [copied, setCopied] = useState(null)
  return (
    <div className="space-y-2 text-xs text-muted">
      <p>Run in your project folder, next to shapewall.config.json.</p>
      {CLIENTS.map((client) => {
        const command = `${client.id} mcp add shapewall -- npx shapewall mcp`
        return (
          <div key={client.id} className="space-y-1">
            <p className="text-[11px] font-medium text-fg">{client.label}</p>
            <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-sunken py-1 pr-1 pl-2">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap text-fg">{command}</code>
              <Button
                size={touch ? 'touch' : 'xs'}
                variant="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(command)
                    setCopied(client.id)
                  } catch {
                    setCopied(null)
                  }
                }}
                aria-label={`Copy ${client.id} MCP setup`}
              >
                {copied === client.id ? <Check size={12} className="text-ok" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                {copied === client.id ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        )
      })}
      <p>
        If your client starts elsewhere, add <code className="font-mono text-[11px]">--config /path/to/shapewall.config.json</code>. Over
        MCP it can reply, set status, resolve and recapture; review its changes before shipping.
      </p>
    </div>
  )
}

// `open`: shown as a section (the chat settings), not folded.
export default function McpSetup({ title = 'Use with Claude Code / Codex', className, touch = false, open = false }) {
  if (open) {
    return (
      <section className={cn('space-y-1.5', className)} data-sw-mcp-setup="true">
        <p className="flex items-center gap-1.5 text-xs font-medium text-fg">
          <Terminal size={13} aria-hidden="true" /> {title}
        </p>
        <McpCommands touch={touch} />
      </section>
    )
  }
  return (
    <Disclosure title={title} icon={Terminal} touch={touch} className={cn('mt-3', className)} data-sw-mcp-setup="true">
      <McpCommands touch={touch} />
    </Disclosure>
  )
}
