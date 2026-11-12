// The board's tools as state (client/src/board/tools.js): who gets which
// tools, which one is in use, and that V and H pick Select and Hand only when
// nobody is typing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POINTER_TOOLS, TOOL_ORDER, activeTool, hasDivider, toolForKey, toolList } from '../client/src/board/tools.js'

// A DOM element, as far as the key guard looks at one.
const element = (tagName, { type = null, editable = false } = {}) => ({
  nodeType: 1,
  tagName,
  isContentEditable: editable,
  getAttribute: (name) => (name === 'type' ? type : null),
})
const key = (value, extra = {}) => ({ key: value, target: element('DIV'), ...extra })

test('the order is Select, Hand, then Comment, Draw, Select text; Select and Hand are the pointer tools', () => {
  assert.deepEqual(TOOL_ORDER, ['select', 'hand', 'comment', 'draw', 'text'])
  assert.deepEqual([...POINTER_TOOLS], ['select', 'hand'])
})

test('a desktop commenter has every tool; Select text needs a board with live pages', () => {
  assert.deepEqual(toolList({ wide: true, commenting: true, draw: true, liveBoard: true }), ['select', 'hand', 'comment', 'draw', 'text'])
  assert.deepEqual(toolList({ wide: true, commenting: true, draw: true }), ['select', 'hand', 'comment', 'draw'])
  // A static export that keeps comments in the browser: comments, no drawings.
  assert.deepEqual(toolList({ wide: true, commenting: true, liveBoard: true }), ['select', 'hand', 'comment', 'text'])
  // Draw is never offered without Comment.
  assert.deepEqual(toolList({ wide: true, draw: true }), ['select', 'hand'])
})

test('someone who may not comment has Select and Hand on desktop, and Select text only while a page is live', () => {
  assert.deepEqual(toolList({ wide: true, liveBoard: true }), ['select', 'hand'])
  assert.deepEqual(toolList({ wide: true, liveBoard: true, livePage: true }), ['select', 'hand', 'text'])
  assert.deepEqual(toolList({ wide: true, livePage: true }), ['select', 'hand'], 'not without live pages on the board')
})

test('phones: no Hand (a finger pans already) and no Select text; a viewer is left with Select alone, so no toolbar', () => {
  assert.deepEqual(toolList({ commenting: true, draw: true, liveBoard: true, livePage: true }), ['select', 'comment', 'draw'])
  assert.deepEqual(toolList({ liveBoard: true, livePage: true }), ['select'])
  assert.deepEqual(toolList(), ['select'])
})

test('one tool is in use at a time: Draw over Comment over Select text over Hand; Select is the rest', () => {
  assert.equal(activeTool(), 'select')
  assert.equal(activeTool({ hand: true }), 'hand')
  assert.equal(activeTool({ hand: true, selecting: true }), 'text')
  assert.equal(activeTool({ hand: true, selecting: true, commentMode: true }), 'comment')
  assert.equal(activeTool({ commentMode: true, drawArmed: true }), 'draw')
  assert.equal(activeTool({ drawing: true }), 'draw', 'drawing on a reply, outside comment mode')
  // Draw armed means nothing once comment mode is off.
  assert.equal(activeTool({ drawArmed: true }), 'select')
})

test('the divider sits after Hand only when there are tools on both sides', () => {
  assert.equal(hasDivider(['select', 'hand', 'comment', 'draw']), true)
  assert.equal(hasDivider(['select', 'hand', 'text']), true)
  assert.equal(hasDivider(['select', 'hand']), false)
  assert.equal(hasDivider(['select', 'comment', 'draw']), false, 'phones have no Hand')
})

test('V is Select and H is Hand, in either case', () => {
  assert.equal(toolForKey(key('v')), 'select')
  assert.equal(toolForKey(key('V')), 'select')
  assert.equal(toolForKey(key('h')), 'hand')
  assert.equal(toolForKey(key('H', { shiftKey: true })), 'hand')
  assert.equal(toolForKey(key('c')), null, 'C is comment mode, with its own handler')
  assert.equal(toolForKey(key('Escape')), null)
  assert.equal(toolForKey(null), null)
})

test('V and H do nothing while typing, in a live page, with a modifier, on a held key, or with a dialog, menu or list open', () => {
  for (const target of [
    element('TEXTAREA'),
    element('INPUT', { type: 'text' }),
    element('INPUT', { type: 'search' }),
    element('INPUT'),
    element('INPUT', { type: 'checkbox' }),
    element('SELECT'),
    element('DIV', { editable: true }),
    element('IFRAME'),
  ]) {
    assert.equal(toolForKey({ key: 'h', target }), null, `H in ${target.tagName}`)
    assert.equal(toolForKey({ key: 'v', target }), null, `V in ${target.tagName}`)
  }
  assert.equal(toolForKey(key('h', { ctrlKey: true })), null)
  assert.equal(toolForKey(key('v', { metaKey: true })), null, 'Cmd+V pastes')
  assert.equal(toolForKey(key('h', { altKey: true })), null)
  assert.equal(toolForKey(key('h', { repeat: true })), null)
  assert.equal(toolForKey(key('h'), { busy: true }), null)
  assert.equal(toolForKey(key('h'), { handled: true }), null)
  // A button or the canvas itself is fine.
  assert.equal(toolForKey({ key: 'h', target: element('BUTTON') }), 'hand')
})

test('a key for a tool this person does not have does nothing', () => {
  assert.equal(toolForKey(key('h'), { tools: ['select', 'comment', 'draw'] }), null, 'no Hand on a phone layout')
  assert.equal(toolForKey(key('v'), { tools: ['select', 'comment', 'draw'] }), 'select')
})
