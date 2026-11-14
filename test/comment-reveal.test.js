// "Jump to comment" when the view is hiding the comment's card: which view
// state the jump turns off, and what it says it did
// (client/src/board/commentReveal.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revealNotice, revealPlan } from '../client/src/board/commentReveal.js'

// A comment on a page, on the board, in plain view: the common case.
const SHOWN = { hasTarget: true, known: true, onVariant: false, compare: false, changedOnly: false, pageChanged: false }
const plan = (over) => revealPlan({ ...SHOWN, ...over })

test('a card already on the board asks for no change at all', () => {
  assert.equal(plan({}), null)
  // Even in compare mode on "Changed pages only": the pin is there, so fly.
  assert.equal(plan({ compare: true, changedOnly: true, onVariant: true }), null)
})

test('compare mode hides a variant, so the jump leaves compare -- and only compare', () => {
  assert.deepEqual(plan({ hasTarget: false, onVariant: true, compare: true, pageChanged: true }), {
    leaveCompare: true,
    showAllPages: false,
  })
})

test('a page compare mode keeps but "Changed pages only" drops stays in compare', () => {
  // The narrowest escape: the page is on the board as soon as every page is.
  assert.deepEqual(plan({ hasTarget: false, compare: true, changedOnly: true, pageChanged: false }), {
    leaveCompare: false,
    showAllPages: true,
  })
})

test('a variant beside an unchanged page needs both', () => {
  assert.deepEqual(plan({ hasTarget: false, onVariant: true, compare: true, changedOnly: true, pageChanged: false }), {
    leaveCompare: true,
    showAllPages: true,
  })
})

test('a changed page whose variant is hidden leaves compare without showing every page', () => {
  assert.deepEqual(plan({ hasTarget: false, onVariant: true, compare: true, changedOnly: true, pageChanged: true }), {
    leaveCompare: true,
    showAllPages: false,
  })
})

test('"Changed pages only" outside compare mode is not a reason: compare carries it', () => {
  // changedOnly only applies while comparing (useCompare.js), so a hidden
  // card with compare off and the page unchanged is simply gone.
  assert.deepEqual(plan({ hasTarget: false, compare: false, changedOnly: false, pageChanged: false }), { gone: true })
})

test('a removed page or variant is gone, whatever the view is doing', () => {
  assert.deepEqual(plan({ hasTarget: false, known: false, onVariant: true, compare: true }), { gone: true })
  assert.deepEqual(plan({ hasTarget: false, known: false, changedOnly: true, compare: true }), { gone: true })
})

test('a card hidden for a reason the view cannot name is gone, not a guess', () => {
  // Compare mode is on and the comment is on a page that did change, with
  // "Changed pages only" off: nothing here explains the missing card, so the
  // board says so rather than turning compare off for no reason.
  assert.deepEqual(plan({ hasTarget: false, compare: true, changedOnly: false, pageChanged: true }), { gone: true })
})

// ---- what the notice says ----------------------------------------------------

const label = (name) => name[0].toUpperCase() + name.slice(1)
const notice = (changes, over = {}) => revealNotice({ id: 7, at: 1, changes, from: 'desktop', to: 'phone', ...over }, label)

test('no change means no notice', () => {
  assert.equal(revealNotice(null, label), null)
  assert.equal(revealNotice({ id: 7, changes: [] }, label), null)
})

test('a viewport switch keeps the sentence it has always had', () => {
  assert.deepEqual(notice(['viewport']), {
    text: 'Showing Phone: comment #7 is on the phone capture.',
    back: 'Back to Desktop',
  })
})

test('leaving compare says it was a variant', () => {
  assert.deepEqual(notice(['compare']), {
    text: 'Left compare: comment #7 is on a variant, which compare does not show.',
    back: 'Back to compare',
  })
})

test('showing every page names the filter it turned off', () => {
  assert.deepEqual(notice(['changed']), {
    text: 'Showing all pages: comment #7 is on a page "Changed pages only" leaves out.',
    back: 'Back to changed pages only',
  })
})

test('two changes read as one sentence with one way back', () => {
  assert.deepEqual(notice(['viewport', 'compare']), {
    text: 'Showing Phone, Left compare: comment #7 is on the phone capture, and on a variant, which compare does not show.',
    back: 'Back to Desktop and compare',
  })
})

test('three changes list properly rather than piling up "and"', () => {
  assert.equal(notice(['viewport', 'compare', 'changed']).back, 'Back to Desktop, compare and changed pages only')
})
