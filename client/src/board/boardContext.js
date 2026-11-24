import { createContext } from 'react'

// Board-wide state the nodes read: images, manifest, comments, comment mode.
// Nodes stay layout-only so React Flow can memoize them. What changes with
// every click and camera rest (the focused frame, the open thread, the
// settled zoom) is not in here: a node reads its own answer from the view
// store (boardView.js), so those re-render the cards they are about.
export const BoardContext = createContext(null)
