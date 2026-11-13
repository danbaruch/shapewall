// "Jump to comment" when the current view is hiding the comment's card.
//
// A pin only exists where its card is laid out, so a view that leaves the
// card out (compare mode, which lays out no variants; "Changed pages only",
// which drops the pages that did not change) gave the click nothing to fly
// to: the board sat still. The board already knows how to get out of the way
// for one kind of hiding -- a comment on another screen size switches the
// viewport, says so, and flies (Board.jsx focusComment) -- so the same answer
// is given to the rest: turn off the least view state that reveals the card,
// say what changed, fly to the pin.
//
// Kept pure so the rules can be read and tested without a browser
// (test/comment-reveal.test.js).

// What a view must stop doing before a comment's card is on the board.
//
//   hasTarget    the card is laid out right now (then there is nothing to do)
//   known        the page, or the variant and its page, still exist on the board
//   onVariant    the comment is on a variant, not on a page
//   compare      compare mode is on
//   changedOnly  "Changed pages only" is on (and the comparison has loaded)
//   pageChanged  the comment's page changed between the two environments
//
// Returns null when the card is already there, `{ gone: true }` when it is
// not there and no view state explains it (a removed page or variant, an
// unknown screen size), else the changes to make.
//
// Narrowest first: compare mode is only left when compare mode itself is
// what hides the card, which is a variant. A page that compare mode keeps but
// "Changed pages only" drops stays in compare mode and shows all pages.
export function revealPlan({ hasTarget, known, onVariant, compare, changedOnly, pageChanged }) {
  if (hasTarget) return null
  if (!known) return { gone: true }
  // Compare mode lays out no variants at all (Board.jsx passes it none), so a
  // comment on one needs compare off. A page is never hidden by compare mode.
  const leaveCompare = Boolean(compare && onVariant)
  // "Changed pages only" drops a page that did not change, and with it the
  // variants beside that page.
  const showAllPages = Boolean(changedOnly && !pageChanged)
  if (!leaveCompare && !showAllPages) return { gone: true }
  return { leaveCompare, showAllPages }
}

// "a, b and c".
function sentenceList(items) {
  if (items.length < 2) return items[0] || ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// The notice over the canvas after a jump moved the view out of the way, and
// the label of its one way back. `changes` names what the jump changed, in
// the order it reads best; `label` turns a viewport name into its button
// label ("phone" -> "Phone"), so the wording has no opinion about the modes.
//
// A viewport switch on its own keeps the sentence it has always had.
export function revealNotice(notice, label = (name) => name) {
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
    if (change === 'compare') {
      heads.push('Left compare')
      spots.push('a variant, which compare does not show')
      backs.push('compare')
    }
    if (change === 'changed') {
      heads.push('Showing all pages')
      spots.push('a page "Changed pages only" leaves out')
      backs.push('changed pages only')
    }
  }
  return {
    text: `${heads.join(', ')}: comment #${notice.id} is on ${spots.join(', and on ')}.`,
    back: `Back to ${sentenceList(backs)}`,
  }
}
