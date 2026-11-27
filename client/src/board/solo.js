// The solo engine (shapewall serve --engine hosted, 1.5.0, experimental): the
// hosted engine run for one project and one owner on this machine. Its board
// /info says `hosted: true, solo: true` and lists in `soloFeatures` the
// local-only surfaces the engine serves so far (src/hosted/solo/info.js). A
// team server never sends `solo`, so everything here is false there and every
// hosted behaviour stays as it is.
//
// The board keeps its hosted behaviour on the engine (account author,
// presence, connected agents, the console), except at the few places a local
// board offers more: each one asks hostedOrSolo(info, feature), which is true
// on a local board, false on a team server, and true on the engine only once
// the engine serves that feature. A control never shows before its route.

// Features the engine may list (one per local-only surface):
//   journeys    journey editing (the board's journeys.json in the engine folder)
//   checksRun   starting a checks run from the board
//   batchFixes  batch fixes with the agent
//   domFallback reading old captures' DOM (needs a separate usercontent origin)
//   appUpdates  About and updates can check for and apply an update
// (In-process capture, G3, turns on with the owner's /info allowCapture: true;
// the engine also lists it as soloFeatures.capture.)
export const SOLO_FEATURES = ['journeys', 'checksRun', 'batchFixes', 'domFallback', 'appUpdates']

// The signed-in owner of a solo engine. Never a guest or a public visitor
// (their /info is their own and never says solo).
export function soloOwner(info) {
  return Boolean(info?.hosted && info.solo === true && info.role === 'owner' && !info.guest && !info.public)
}

// The engine serves this local-only feature to its owner.
export function soloHas(info, feature) {
  return soloOwner(info) && info.soloFeatures?.[feature] === true
}

// A local-only feature: on a local board, or on the solo engine that serves it.
export function hostedOrSolo(info, feature) {
  return !info?.hosted || soloHas(info, feature)
}

// The empty state's hint: a solo engine that captures in place says to
// capture, like a local board; a team server (or an engine that cannot
// capture yet) says to push.
export function capturesByPush(info) {
  return Boolean(info?.hosted) && !(soloOwner(info) && info.allowCapture === true)
}
