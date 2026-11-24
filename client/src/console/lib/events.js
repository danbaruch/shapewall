// Window events between console modules that cannot import each other
// (pages/account.jsx imports state.jsx).

// Opens the account page's add-passkey dialog (state.jsx re-auth asks for one).
export const ADD_PASSKEY_EVENT = 'shapewall:add-passkey'
