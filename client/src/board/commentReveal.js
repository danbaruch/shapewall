// "Jump to comment" when the current view is hiding the comment's card.
//
// A pin only exists where its card is laid out, so a view that leaves the
// card out ("Changed pages only", which drops the pages that did not change)
// gives the click nothing to fly to: the board sits still. The board already
// knows how to get out of the way for one kind of hiding -- a comment on
// another screen size switches the viewport, says so, and flies (Board.jsx
// focusComment) -- so the same answer is given to the rest: turn off the least
// view state that reveals the card, say what changed, fly to the pin.
//
// Compare mode was the other reason: it laid out no variants, so a comment on
// one had no pin and the jump left compare mode altogether to show it (0.7.3).
// 0.8.0 lays a variant out inside compare mode instead, as the single-frame
// card it is (layout.js), so compare mode hides nothing, and the jump has one
// fewer view change to make, to say and to put back.
//
// Kept pure so the rules can be read and tested without a browser
// (test/comment-reveal.test.js).

// What a view must stop doing before a comment's card is on the board.
//
//   hasTarget    the card is laid out right now (then there is nothing to do)
//   known        the page, or the variant and its page, still exist on the board
//   changedOnly  "Changed pages only" is on (and the comparison has loaded)
//   pageChanged  the comment's page changed between the two environments
//
// Returns null when the card is already there, `{ gone: true }` when it is
// not there and no view state explains it (a removed page or variant, an
// unknown screen size, a variant with no capture for this screen size), else
// the changes to make.
export function revealPlan({ hasTarget, known, changedOnly, pageChanged }) {
  if (hasTarget) return null
  if (!known) return { gone: true }
  // "Changed pages only" drops a page that did not change, and with it the
  // variants beside that page. It is the only view state left that hides a
  // card, so it is the whole plan.
  const showAllPages = Boolean(changedOnly && !pageChanged)
  if (!showAllPages) return { gone: true }
  return { showAllPages }
}

// "a, b and c".
function sentenceList(items) {
  if (items.length < 2) return items[0] || ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1)

// The notice after a jump moved the view out of the way, and the label of its
// one way back. `changes` names what the jump changed, in the order it reads
// best; `label` turns a viewport name into its button label ("phone" ->
// "Phone"), so the wording has no opinion about the modes.
//
// `compact` is for a phone, where the full sentence ran to five lines and the
// button went under it. It says what changed and which comment, and leaves
// out why: on a phone the notice sits in the thread sheet, whose own header
// already names the page or variant the comment is on.
//
// A viewport switch on its own keeps the sentence it has always had.
export function revealNotice(notice, label = (name) => name, { compact = false } = {}) {
  if (!notice?.changes?.length) return null
  const heads = []
  const spots = []
  const backs = []
  for (const change of notice.changes) {
    if (change === 'viewport') {
      heads.push(`Showing ${label(notice.to)}`)
      spots.push(`the ${notice.to} capture`)
      backs.push(label(notice.from))
    }
    if (change === 'changed') {
      heads.push('Showing all pages')
      spots.push('a page "Changed pages only" leaves out')
      backs.push('changed pages only')
    }
  }
  const said = heads.map((head, index) => (index === 0 ? head : lower(head))).join(', ')
  if (compact) return { text: `${said} for comment #${notice.id}.`, back: 'Back' }
  return {
    text: `${said}: comment #${notice.id} is on ${spots.join(', and on ')}.`,
    back: `Back to ${sentenceList(backs)}`,
  }
}
