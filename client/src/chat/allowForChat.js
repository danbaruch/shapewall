// "Allow for this chat" on a permission card (cards.jsx), provided by the
// panel (ChatPanel.jsx). The rules themselves live in the panel's state:
// per thread, in this tab only, gone on reload or Clear (composerModel.js
// canAutoAllow decides which cards may get one).

import { createContext, useContext } from 'react'

export const AllowForChat = createContext({
  // (card) => true when the card may get "Allow for this chat".
  can: () => false,
  // (card) => adds the rule; the card itself is answered by its own button.
  add: () => {},
  // Ids of cards a rule answered without asking.
  auto: new Set(),
})

export const useAllowForChat = () => useContext(AllowForChat)
