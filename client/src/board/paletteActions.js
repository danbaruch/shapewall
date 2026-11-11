import { Bot, Flag, GitCompare, Map as MapIcon, Maximize, MessageSquarePlus, Waypoints } from 'lucide-react'

// The board's own actions in the command palette (Ctrl/Cmd+K), after pages,
// journeys and comments: what this person can do on this board right now.
export function boardPaletteActions({
  canComment,
  comparePair,
  commentMode,
  markPicked,
  setDraft,
  keepDraft,
  setCommentMode,
  showLinks,
  toggleLinks,
  canCompare,
  toggleCompare,
  wide,
  fitBoard,
  minimapOn,
  toggleMinimap,
  chatAvailable,
  reopenChat,
  canChecks,
  openChecks,
}) {
  return [
    canComment && !comparePair
      ? {
          id: 'comment',
          label: commentMode ? 'Stop commenting' : 'Comment on a page',
          icon: MessageSquarePlus,
          keys: 'C',
          run: () => {
            markPicked()
            if (keepDraft()) return
            setDraft(null)
            setCommentMode((value) => !value)
          },
        }
      : null,
    { id: 'links', label: showLinks ? 'Hide links between pages' : 'Show links between pages', icon: Waypoints, run: toggleLinks },
    canCompare
      ? { id: 'compare', label: comparePair ? 'Leave compare mode' : 'Compare environments', icon: GitCompare, run: toggleCompare }
      : null,
    wide ? { id: 'fit', label: 'Fit the whole board', icon: Maximize, keys: 'Shift 1', run: fitBoard } : null,
    wide ? { id: 'minimap', label: minimapOn ? 'Hide the minimap' : 'Show the minimap', icon: MapIcon, run: toggleMinimap } : null,
    chatAvailable ? { id: 'agent', label: 'Chat with your agent', icon: Bot, run: reopenChat } : null,
    canChecks ? { id: 'checks', label: 'Open page checks', icon: Flag, run: () => openChecks() } : null,
  ].filter(Boolean)
}
