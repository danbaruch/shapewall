// Small chat cards kept out of ChatPanel.jsx: the diff on an edit approval
// card, and a note about the answer (images that were not sent).

import { useState } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { Button, Tooltip } from '../components/ui'
import { cn } from '../lib/utils'

const LINE_TONES = {
  '+': 'bg-ok/10 text-fg',
  '-': 'bg-bad/10 text-fg',
  '@': 'text-faint',
  '-file': 'font-medium text-fg',
}

// The server's marker on a line too long to show here (src/agent/text-diff.js clipLine).
const CUT_RE = /… \[line cut: \d+ characters in all\]$/

function DiffLine({ line }) {
  const cut = line.match(CUT_RE)
  if (!cut) return line || ' '
  return (
    <>
      {line.slice(0, cut.index)}
      <span className="text-warn italic" data-sw-chat-diff-cut="true">
        {cut[0]}
      </span>
    </>
  )
}

// What an agent's edit or write would change: the server's bounded diff
// (src/agent/text-diff.js). The preview first; "Show the whole diff" for the
// rest, itself bounded on the server.
export function DiffView({ diff }) {
  const [expanded, setExpanded] = useState(false)
  if (typeof diff?.preview !== 'string') return null
  const text = expanded && diff.full ? diff.full : diff.preview
  const lines = text ? text.split('\n') : []
  return (
    <div className="mt-1.5 space-y-1" data-sw-chat-diff={diff.path || 'diff'}>
      <p className="flex items-center gap-1.5 text-[11px] text-muted">
        <Tooltip content={diff.path || null}>
          <span className={cn('min-w-0 font-mono', diff.outside ? 'break-all' : 'truncate')}>{diff.path || 'Changes'}</span>
        </Tooltip>
        <span className="shrink-0 text-ok">+{diff.added}</span>
        <span className="shrink-0 text-bad">-{diff.removed}</span>
        {diff.created ? <span className="shrink-0">(new file)</span> : null}
      </p>
      {diff.outside ? (
        <p className="flex items-center gap-1.5 text-[11px] text-warn" data-sw-chat-diff-outside="true">
          <AlertTriangle size={12} className="shrink-0" aria-hidden="true" />
          Outside the project: check the whole path above.
        </p>
      ) : null}
      {lines.length ? (
        <pre
          className="max-h-72 overflow-auto rounded-md border border-line bg-sunken py-1 font-mono text-[11px] leading-4"
          data-sw-chat-diff-lines={lines.length}
        >
          {lines.map((line, index) => {
            const tone = line.startsWith('--- ') ? LINE_TONES['-file'] : LINE_TONES[line[0]]
            return (
              // Lines repeat and never move: the index is the key.
              <div key={index} className={cn('px-2 whitespace-pre-wrap break-all', tone || 'text-muted')}>
                <DiffLine line={line} />
              </div>
            )
          })}
        </pre>
      ) : (
        <p className="text-[11px] text-faint">No change to the text.</p>
      )}
      {diff.full ? (
        <Button
          variant="ghost"
          size="xs"
          className="-ml-2 font-normal text-muted"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-sw-chat-diff-expand="true"
        >
          {expanded ? 'Show less' : 'Show the whole diff'}
        </Button>
      ) : null}
      {expanded && diff.truncated ? <p className="text-[11px] text-faint">The diff is cut here: it is too long to show in full.</p> : null}
    </div>
  )
}

// A note about this answer, such as images the model does not take.
export function NoteCard({ card }) {
  return (
    <p
      className="flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-fg"
      data-sw-chat-card="note"
    >
      <Info size={13} className="mt-px shrink-0 text-warn" aria-hidden="true" />
      <span className="min-w-0 break-words">{card.label}</span>
    </p>
  )
}
