// The address bar's board parameters (lib/hooks.js useParams) that belong to
// one board: ids and open panels that only mean something on the board they
// were set on (comment #12 on one board is an unrelated comment on another).
// Picking another board clears them; what stays is how the visitor likes to
// look at a board (screen size, filter, links, the side panel, search).
// Pure, tested in test/board-params.test.js.

export const BOARD_SCOPED_PARAMS = Object.freeze([
  // the open comment and the camera
  'c',
  'v',
  // the agent chat (c<commentId> or chat-<id>) and the hosted Agent panel
  'chat',
  'ha',
  // page checks: open, page, viewport, tab, environment
  'checks',
  'cv',
  'ct',
  'ce',
  // journeys: open, step, branch, comments on the route
  'j',
  'step',
  'jb',
  'jc',
  // page history
  'hist',
  'hv',
  // compare: the pair, changed pages only, the diff overlay
  'cmp',
  'changed',
  'diff',
  // a page a check asked to show
  'page',
])

// The URL changes that open board `id`: every board-scoped parameter goes.
export function boardSwitchChanges(id) {
  const changes = { board: id }
  for (const key of BOARD_SCOPED_PARAMS) changes[key] = null
  return changes
}

// Whether a write from the board opened as `mountedBoard` (the board
// parameter when it mounted, null for "the first board") may still land on
// the address bar, which now names `currentBoard`.
export const sameBoard = (mountedBoard, currentBoard) => (mountedBoard || null) === (currentBoard || null)

// The board parameters a switch keeps: which board, and how it is looked at.
export const BOARD_VIEW_PARAMS = Object.freeze(['board', 'vp', 'filter', 'links', 'la', 'panel', 'q', 'st', 'm', 'settings', 'share'])
