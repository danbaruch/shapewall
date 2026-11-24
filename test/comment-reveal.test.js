// "Jump to comment" when the view is hiding the comment's card: which view
// state the jump turns off, and what it says it did
// (client/src/board/commentReveal.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { revealNotice, revealPlan } from '../client/src/board/commentReveal.js'

// A comment on a page, on the board, in plain view: the common case.
const SHOWN = { hasTarget: true, known: true, changedOnly: false, pageChanged: false }
const plan = (over) => revealPlan({ ...SHOWN, ...over })

test('a card already on the board asks for no change at all', () => {
  assert.equal(plan({}), null)
  // Even on "Changed pages only": the pin is there, so fly.
  assert.equal(plan({ changedOnly: true }), null)
})

test('compare mode is no longer a reason: it lays variants out', () => {
  // 0.7.3 left compare mode to show a comment on a variant, because compare
  // laid out no variants. 0.8.0 lays them out as single-frame cards
  // (layout.js), so the card is there and the jump changes nothing. The only
  // thing that can hide one now is the changed-pages filter.
  assert.equal(plan({ changedOnly: false }), null)
  assert.deepEqual(plan({ hasTarget: false, changedOnly: false, pageChanged: true }), { gone: true })
})

test('a page "Changed pages only" drops is shown again, and nothing else is touched', () => {
  assert.deepEqual(plan({ hasTarget: false, changedOnly: true, pageChanged: false }), { showAllPages: true })
})

test('a variant beside a page the filter drops goes the same way as the page', () => {
  // The filter drops a page and the variants beside it together, so showing
  // every page brings both back; the comment is on the variant either way.
  assert.deepEqual(plan({ hasTarget: false, changedOnly: true, pageChanged: false }), { showAllPages: true })
})

test('a removed page or variant is gone, whatever the view is doing', () => {
  assert.deepEqual(plan({ hasTarget: false, known: false }), { gone: true })
  assert.deepEqual(plan({ hasTarget: false, known: false, changedOnly: true }), { gone: true })
})

test('a card hidden for a reason the view cannot name is gone, not a guess', () => {
  // The comment is on a page that did change, with "Changed pages only" off:
  // nothing here explains the missing card, so the board says so rather than
  // turning something off for no reason.
  assert.deepEqual(plan({ hasTarget: false, changedOnly: false, pageChanged: true }), { gone: true })
  // And on the filter, for a page that did change: the filter is keeping it,
  // so the filter is not what is hiding it.
  assert.deepEqual(plan({ hasTarget: false, changedOnly: true, pageChanged: true }), { gone: true })
})

// ---- what the notice says ----------------------------------------------------

const label = (name) => name[0].toUpperCase() + name.slice(1)
const notice = (changes, over = {}) => revealNotice({ id: 7, at: 1, changes, from: 'desktop', to: 'phone', ...over }, label)
const small = (changes, over = {}) =>
  revealNotice({ id: 7, at: 1, changes, from: 'desktop', to: 'phone', ...over }, label, { compact: true })

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

test('showing every page names the filter it turned off', () => {
  assert.deepEqual(notice(['changed']), {
    text: 'Showing all pages: comment #7 is on a page "Changed pages only" leaves out.',
    back: 'Back to changed pages only',
  })
})

test('two changes read as one sentence with one way back', () => {
  assert.deepEqual(notice(['viewport', 'changed']), {
    text: 'Showing Phone, showing all pages: comment #7 is on the phone capture, and on a page "Changed pages only" leaves out.',
    back: 'Back to Desktop and changed pages only',
  })
})

// ---- the compact wording a phone gets ----------------------------------------
// The full sentence ran to five lines at 390 px with the button under it. The
// compact one says what changed and which comment; the sheet it sits in names
// the page or variant, so the "why" is already on screen.

test('compact says what changed and for which comment, and nothing else', () => {
  assert.deepEqual(small(['viewport']), { text: 'Showing Phone for comment #7.', back: 'Back' })
  assert.deepEqual(small(['changed']), { text: 'Showing all pages for comment #7.', back: 'Back' })
})

test('compact keeps two changes on one short line', () => {
  const said = small(['viewport', 'changed'])
  assert.equal(said.text, 'Showing Phone, showing all pages for comment #7.')
  // Short enough to sit beside its button at 390 px rather than stack above it.
  assert.ok(said.text.length <= 48, `"${said.text}" is ${said.text.length} characters`)
})

test('compact still says nothing when nothing changed', () => {
  assert.equal(small([]), null)
})
