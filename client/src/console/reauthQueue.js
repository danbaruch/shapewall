// The re-auth dialog's waiting requests (console/state.jsx ReauthProvider),
// as pure steps, tested in test/reauth-queue.test.js. Two actions can both
// be told reauth_required before the dialog is up: each waits its turn, so
// neither caller's promise is left unsettled (and its spinner on forever).
// An entry is { resolve, reject, typed, addFirst, ... }; the head is shown.

// A confirmed passkey re-authenticates the session: every waiting passkey
// request goes on with it. A typed confirmation, or "add a passkey first",
// is its own question and waits for its own answer.
const passkeyRequest = (entry) => !entry.typed && !entry.addFirst

export function afterPasskey(queue) {
  const [head, ...rest] = queue
  if (!head) return { done: [], rest: [] }
  return { done: [head, ...rest.filter(passkeyRequest)], rest: rest.filter((entry) => !passkeyRequest(entry)) }
}

// The head is answered (typed, cancelled): the next one shows.
export const afterHead = (queue) => ({ done: queue.slice(0, 1), rest: queue.slice(1) })

// Leaving for another page (add a passkey): nothing waiting will be answered here.
export const afterAll = (queue) => ({ done: [...queue], rest: [] })
