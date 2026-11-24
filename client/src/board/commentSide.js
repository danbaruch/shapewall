// Which capture a comment is on when a page has more than one: compare mode
// draws a page once per environment, side by side, and a comment belongs on
// the side it was left on.
//
// A comment stores the environment it was left on (`environment`, an id
// from the board's environments) only when it was placed while comparing;
// every comment before that, and every one placed outside compare mode, is
// on the default environment, which is the one the board shows outside
// compare. So:
//
//   - in compare mode a comment's pin is drawn on the frame of its own
//     environment, when that environment is one of the two compared;
//   - when it is not (a comment on Production while Staging is compared with
//     Preview), the pin goes on the first environment's frame, as every pin
//     did before comments had sides, so no comment ever loses its pin;
//   - a variant is a single capture with no environment: its comments have
//     no side.
//
// Kept pure so the rules can be read and tested without a browser
// (test/comment-side.test.js).

// The board's default environment: the one marked default, else the first.
export function defaultEnvironment(environments) {
  const list = Array.isArray(environments) ? environments : []
  return (list.find((env) => env?.default) || list[0])?.id || null
}

const onVariant = (comment) => String(comment?.pageId || '').startsWith('variant:')

// The environment a comment was left on: its own when the board still has
// it, else the default. null on a variant, or on a board with none.
export function environmentOf(comment, environments) {
  if (onVariant(comment)) return null
  const own = comment?.environment
  const list = Array.isArray(environments) ? environments : []
  if (own && list.some((env) => env?.id === own)) return own
  return defaultEnvironment(list)
}

// The environment whose frame draws the comment while `pair` ([a, b]) is
// compared: its own when it is one of the two, else a. null on a variant
// and outside compare mode.
export function compareSide(comment, pair, environments) {
  if (!Array.isArray(pair) || pair.length !== 2 || onVariant(comment)) return null
  const own = environmentOf(comment, environments)
  return own && pair.includes(own) ? own : pair[0]
}

// Whether the comment is drawn on the frame of `env` in compare mode.
export function onSide(comment, env, pair, environments) {
  return compareSide(comment, pair, environments) === env
}

// The key of one frame of a card: page (or variant:<id>) and viewport, and in
// compare mode the environment, since a compare card shows the same page and
// viewport twice: `home|desktop@staging`. Viewport names and environment ids
// never hold "|" or "@", so viewports.js splitFrameKey reads all three. A
// drawing being made is tied to one of these.
export function frameKey(pageId, viewport, env = null) {
  return env ? `${pageId}|${viewport}@${env}` : `${pageId}|${viewport}`
}

// What the thread says about where the comment is, when it is worth saying:
// while comparing, which side it is on; outside compare mode, only a comment
// left on another environment than the one the board is showing (its pin
// is drawn on the default capture, which is not the one it was left on).
// Returns { env, title, drawnOn } or null, where drawnOn names the capture
// its pin is drawn on when that is not the one it was left on.
export function sideLabel(comment, { environments, pair = null }) {
  if (onVariant(comment)) return null
  const list = Array.isArray(environments) ? environments : []
  if (list.length < 2) return null
  const own = environmentOf(comment, list)
  const title = (id) => list.find((env) => env.id === id)?.title || id
  if (Array.isArray(pair) && pair.length === 2) {
    // Not one of the two compared: drawn on a, and said so.
    return { env: own, title: title(own), drawnOn: pair.includes(own) ? null : title(pair[0]) }
  }
  const shown = defaultEnvironment(list)
  if (own === shown) return null
  return { env: own, title: title(own), drawnOn: title(shown) }
}
