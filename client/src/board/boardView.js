// The parts of the board's state that change with every click and camera
// rest, kept outside React context. A context value re-renders every card
// that reads it; here each card subscribes with a selector and re-renders
// only when its own answer changes ("am I the focused frame?", "do I need the
// full image at this zoom?"). So a card click, an opened thread or a zoom
// rest costs the one or two cards it is about, not all 200.
//
//   focusedKey       the selected frame, `${targetId}|${viewport}`
//   selectingKey     the live frame in "select text" mode
//   readingKey       that frame while its page has the mouse (it was
//                    clicked; until the pointer leaves it, or Esc)
//   settledZoom      the zoom once the camera stopped (hooks/useSettledZoom)
//   selectedComment  the open thread's comment (its pin stays on its frame)
//   draftSpot        where the comment being written goes
//   unread           Set of unread comment ids
//   liveKeys         Set of frames showing live HTML
//   hoveredId        the comment under the mouse (list row or pin)
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'

const NO_IDS = new Set()
const INITIAL = {
  focusedKey: null,
  selectingKey: null,
  readingKey: null,
  settledZoom: null,
  selectedComment: null,
  draftSpot: null,
  unread: NO_IDS,
  liveKeys: NO_IDS,
  hoveredId: null,
}

export function createBoardView(initial = null) {
  let state = { ...INITIAL, ...initial }
  const listeners = new Set()
  return {
    get: () => state,
    // Only what changed is written; listeners hear nothing when nothing did.
    set(patch) {
      let next = null
      for (const key of Object.keys(patch)) {
        if (Object.is(state[key], patch[key])) continue
        next = next || { ...state }
        next[key] = patch[key]
      }
      if (!next) return
      state = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// Outside a board (a panel rendered on its own) every selector sees the
// empty state.
const NONE = createBoardView()
export const BoardViewContext = createContext(NONE)
export const useBoardViewStore = () => useContext(BoardViewContext)

// `selector(state)` must return a primitive or an object already in the
// state (never a new object), so an unchanged answer is the same value.
export function useBoardView(selector) {
  const store = useContext(BoardViewContext)
  const snapshot = useCallback(() => selector(store.get()), [store, selector])
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}
