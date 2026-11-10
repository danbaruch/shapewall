// Board references in agent answers (client/src/chat/refs.js) and the code
// block highlighter (client/src/chat/highlight.js): only things the board
// has become links, nothing is guessed, and highlighting never builds markup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRefIndex,
  previewText,
  readableText,
  refLabel,
  resolveName,
  resolvePath,
  resolveToken,
  usedRefs,
  plainToken,
} from '../client/src/chat/refs.js'
import { markdownToPlain, tokensToText } from '../src/agent/plain-text.js'
import { highlight, langName } from '../client/src/chat/highlight.js'

const pages = [
  { id: 'home', title: 'Home', path: '/' },
  { id: 'pricing', title: 'Pricing', path: '/pricing' },
  { id: 'signup', title: 'Sign up', path: '/signup/' },
  { id: 'blog-a', title: 'Post', path: '/blog/a' },
  { id: 'blog-b', title: 'Post', path: '/blog/b' },
]
const comments = [
  { id: 12, body: 'Make the button bolder', pageId: 'pricing', status: 'open' },
  { id: 3, body: 'Typo', pageId: 'home', status: 'resolved' },
]
const journeys = [{ id: 'checkout', name: 'Checkout', steps: [] }]
const index = buildRefIndex({ comments, pages, journeys, checks: new Map([['pricing', 2]]) })

test('tokens resolve only to things the board has', () => {
  assert.equal(resolveToken(index, 'comment', '12').target.body, 'Make the button bolder')
  assert.equal(resolveToken(index, 'comment', '99'), null)
  assert.equal(resolveToken(index, 'page', 'pricing').id, 'pricing')
  assert.equal(resolveToken(index, 'page', '/signup').id, 'signup', 'a trailing slash does not matter')
  assert.equal(resolveToken(index, 'page', 'nope'), null)
  assert.equal(resolveToken(index, 'journey', 'checkout').target.name, 'Checkout')
  assert.equal(resolveToken(index, 'check', 'pricing').count, 2)
  assert.equal(resolveToken(buildRefIndex({ pages }), 'check', 'pricing'), null, 'no checks on the board: no check links')
  assert.equal(resolveToken(null, 'page', 'pricing'), null)
  assert.equal(plainToken('comment', '99'), '#99')
})

test('names in code or bold, and paths in text, are exact matches only', () => {
  assert.equal(resolveName(index, '#12').id, 12)
  assert.equal(resolveName(index, '/pricing').id, 'pricing')
  assert.equal(resolveName(index, 'Pricing').id, 'pricing')
  assert.equal(resolveName(index, 'pricing').id, 'pricing', 'a page id')
  assert.equal(resolveName(index, 'Checkout').kind, 'journey')
  assert.equal(resolveName(index, 'Post'), null, 'two pages share the title: not a link')
  assert.equal(resolveName(index, 'font-weight: 600'), null)
  assert.equal(resolveName(index, '[[comment:12]]').id, 12)
  assert.equal(resolvePath(index, '/pricing').id, 'pricing')
  assert.equal(resolvePath(index, '/'), null, 'the bare root is never linked from running text')
  assert.equal(resolvePath(index, '/missing'), null)
  // "or **/** for commands": a bare slash in bold or code is never Home.
  assert.equal(resolveName(index, '/'), null)
  assert.equal(resolveName(index, ' / '), null)
})

test('copy and export read tokens as words; previews drop the Markdown', () => {
  const text = 'See [[comment:12]] on [[page:home]], the [[journey:checkout]] flow, [[check:pricing]] and [[page:gone]] or [[comment:99]].'
  assert.equal(
    readableText(text, index),
    'See comment #12 on Home page, the Checkout journey flow, checks for Pricing and gone page or comment #99.',
  )
  assert.equal(
    readableText(text),
    'See comment #12 on home page, the checkout journey flow, checks for pricing and gone page or comment #99.',
  )
  assert.equal(readableText('Keep **bold** and `code`.', index), 'Keep **bold** and `code`.', 'Copy keeps the Markdown')
  assert.equal(tokensToText('A [[widget:x1]] token'), 'A x1 token', 'an unknown kind reads as its id')
  assert.equal(
    previewText('## Done\n\n**Fixed** the `h1` on [[page:pricing]]:\n\n- one [link](https://example.com)\n> quoted', index),
    'Done\n\nFixed the h1 on Pricing page:\n\none link\nquoted',
  )
  assert.equal(markdownToPlain('...the end of [[comment:1'), '...the end of', 'half a token at a snippet edge goes')
  assert.equal(markdownToPlain('2]] and more'), 'and more')
  assert.equal(markdownToPlain('a_b_c and snake_case stay'), 'a_b_c and snake_case stay')
})

test('used refs come from structured data, without doubles', () => {
  const reply = {
    refs: { comments: [12, 404], pages: ['pricing', 'gone'] },
    cards: [
      { kind: 'tool', label: 'Read comment #3' },
      { kind: 'permission', label: 'Edit #12' },
    ],
  }
  const request = {
    attachments: [{ source: { kind: 'element', pageId: 'pricing', commentId: 12 } }, { source: { kind: 'page', pageId: 'home' } }],
  }
  const used = usedRefs(index, { reply, request, commentId: 12 })
  assert.deepEqual(
    used.map((ref) => `${ref.kind}:${ref.id}:${ref.via}`),
    ['comment:12:thread', 'page:home:attached', 'page:pricing:read', 'comment:3:read'],
  )
  assert.equal(refLabel(used[1]), 'Home')
  assert.equal(refLabel(resolveToken(index, 'check', 'pricing')), 'Checks: Pricing')
})

test('the highlighter splits code into typed pieces and keeps every character', () => {
  const code = 'const n = 42 // the answer\nconst s = "a // not a comment"\n'
  const pieces = highlight(code, 'js')
  assert.equal(pieces.map((piece) => piece.text).join(''), code)
  const typed = (type) => pieces.filter((piece) => piece.type === type).map((piece) => piece.text)
  assert.deepEqual(typed('keyword'), ['const', 'const'])
  assert.deepEqual(typed('number'), ['42'])
  assert.deepEqual(typed('comment'), ['// the answer'])
  assert.deepEqual(typed('string'), ['"a // not a comment"'])
  const shell = highlight('npm test # run it\necho "https://x.dev/#a"', 'sh')
  assert.deepEqual(
    shell.filter((piece) => piece.type === 'comment').map((piece) => piece.text),
    ['# run it'],
  )
  const html = highlight('<a href="/x">Hi</a><!-- note -->', 'html')
  assert.deepEqual(
    html.filter((piece) => piece.type === 'tag').map((piece) => piece.text),
    ['<a', '>', '</a>'], // adjacent pieces of one type merge,
  )
  const diff = highlight('@@ -1 +1 @@\n-old\n+new\n same', 'diff')
  assert.deepEqual(
    diff.map((piece) => piece.type),
    ['meta', 'del', 'add', 'plain'],
  )
  assert.deepEqual(highlight('<script>alert(1)</script>', 'text'), [{ type: 'plain', text: '<script>alert(1)</script>' }])
  assert.equal(langName('js'), 'JavaScript')
  assert.equal(langName(''), 'Code')
  assert.equal(langName('weird-lang'), 'weird-lang')
})
