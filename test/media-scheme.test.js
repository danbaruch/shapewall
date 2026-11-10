// Live HTML is frozen to the preferences it was captured with: media queries
// on prefers-color-scheme (and forced reduced motion) are resolved at capture
// time, so a viewer whose browser prefers dark still sees the light capture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinnedColorScheme, resolveMediaInCss, resolveMediaList } from '../src/capture/media-scheme.js'
import { buildLiveHtml, snapshotScheme } from '../src/capture/live.js'

const light = { colorScheme: 'light' }
const dark = { colorScheme: 'dark' }
const lightReduced = { colorScheme: 'light', reducedMotion: 'reduce' }

test('a lone scheme query becomes always or never', () => {
  assert.equal(resolveMediaList('(prefers-color-scheme: dark)', light), 'not all')
  assert.equal(resolveMediaList('(prefers-color-scheme: light)', light), 'all')
  assert.equal(resolveMediaList('(prefers-color-scheme: dark)', dark), 'all')
  assert.equal(resolveMediaList('(prefers-color-scheme: light)', dark), 'not all')
})

test('not, uppercase and whitespace', () => {
  assert.equal(resolveMediaList('not (prefers-color-scheme: dark)', light), 'all')
  assert.equal(resolveMediaList('NOT (PREFERS-COLOR-SCHEME:DARK)', light), 'all')
  assert.equal(resolveMediaList('  (  prefers-color-scheme  :  dark  )  ', light), 'not all')
  assert.equal(resolveMediaList('(Prefers-Color-Scheme: Light)', light), 'all')
  assert.equal(resolveMediaList('not all and (prefers-color-scheme: dark)', light), 'all')
  assert.equal(resolveMediaList('not screen and (prefers-color-scheme: dark)', light), 'all')
  assert.equal(resolveMediaList('not screen and (prefers-color-scheme: dark)', dark), 'not screen')
})

test('combined conditions keep what is not resolved', () => {
  assert.equal(resolveMediaList('screen and (prefers-color-scheme: dark)', light), 'not all')
  assert.equal(resolveMediaList('screen and (prefers-color-scheme: dark)', dark), 'screen')
  assert.equal(
    resolveMediaList('only screen and (min-width: 600px) and (prefers-color-scheme: dark)', dark),
    'only screen and (min-width: 600px)',
  )
  assert.equal(resolveMediaList('(min-width: 600px) and (prefers-color-scheme: light)', light), '(min-width: 600px)')
  assert.equal(resolveMediaList('(min-width: 600px) and (prefers-color-scheme: dark)', light), 'not all')
  assert.equal(resolveMediaList('(min-width: 600px) or (prefers-color-scheme: dark)', light), '(min-width: 600px)')
  assert.equal(resolveMediaList('(min-width: 600px) or (prefers-color-scheme: light)', light), 'all')
  assert.equal(resolveMediaList('((prefers-color-scheme: dark) or (hover)) and (min-width: 1px)', light), '((hover)) and (min-width: 1px)')
  assert.equal(resolveMediaList('(not (prefers-color-scheme: dark)) and (hover)', light), '(hover)')
  assert.equal(resolveMediaList('print and (prefers-color-scheme: light)', light), 'print')
})

test('comma lists: any true is all, false ones go', () => {
  assert.equal(resolveMediaList('print, (prefers-color-scheme: dark)', light), 'print')
  assert.equal(resolveMediaList('(prefers-color-scheme: dark), (prefers-color-scheme: light)', light), 'all')
  assert.equal(resolveMediaList('(prefers-color-scheme: dark), screen and (prefers-color-scheme: dark)', light), 'not all')
  assert.equal(resolveMediaList('(max-width: 600px), (prefers-color-scheme: dark)', dark), 'all')
})

test('other features, range syntax and unparsable queries stay exactly as written', () => {
  for (const query of [
    '(max-width: 640px)',
    'screen and (min-width: 40em)',
    '(400px <= width <= 700px)',
    '(width >= 600px) and (orientation: landscape)',
    '(prefers-contrast: more)',
    '(prefers-color-scheme)',
    '(prefers-color-scheme: no-preference)',
    '(prefers-reduced-motion: reduce)',
  ])
    assert.equal(resolveMediaList(query, light), query, query)
  // Mixed and/or without parens is invalid CSS: left alone.
  const mixed = '(prefers-color-scheme: dark) and (hover) or (pointer: fine)'
  assert.equal(resolveMediaList(mixed, light), mixed)
  const unclosed = '(prefers-color-scheme: dark'
  assert.equal(resolveMediaList(unclosed, light), unclosed)
  const junk = 'screen & (prefers-color-scheme: dark)'
  assert.equal(resolveMediaList(junk, light), junk)
  // A bad query in a list stays; the good one is resolved.
  assert.equal(resolveMediaList('screen & x, (prefers-color-scheme: dark)', light), 'screen & x')
})

test('reduced motion is resolved only when the capture forced it', () => {
  assert.equal(resolveMediaList('(prefers-reduced-motion: reduce)', lightReduced), 'all')
  assert.equal(resolveMediaList('(prefers-reduced-motion: no-preference)', lightReduced), 'not all')
  assert.equal(resolveMediaList('(prefers-reduced-motion: no-preference)', { colorScheme: 'light', reducedMotion: 'no-preference' }), 'all')
  assert.equal(resolveMediaList('(prefers-reduced-motion: reduce)', light), '(prefers-reduced-motion: reduce)')
  assert.equal(
    resolveMediaList('(prefers-reduced-motion: no-preference) and (prefers-color-scheme: light)', light),
    '(prefers-reduced-motion: no-preference)',
  )
})

test('stylesheets: nested @media, @supports around it, @import media, strings and comments', () => {
  const css = [
    'body { color: black }',
    '@media (prefers-color-scheme: dark) { body { color: white } }',
    '@supports (display: grid) { @media screen and (prefers-color-scheme: dark) { .a { color: red } } }',
    '@media (min-width: 600px) { @MEDIA (PREFERS-COLOR-SCHEME: LIGHT) { .b { color: blue } } }',
    '@media (max-width: 640px) { .c { color: green } }',
    '@import url("x.css") screen and (prefers-color-scheme: dark);',
    "@import 'y.css' layer(base) supports(display: grid) (prefers-color-scheme: light);",
    '.d::after { content: "@media (prefers-color-scheme: dark) {" }',
    '/* @media (prefers-color-scheme: dark) { } */',
    '@media (400px <= width <= 700px) { .e { color: gray } }',
  ].join('\n')
  const out = resolveMediaInCss(css, light)
  assert.match(out, /@media not all \{ body \{ color: white \} \}/)
  assert.match(out, /@supports \(display: grid\) \{ @media not all \{ \.a/)
  assert.match(out, /@media \(min-width: 600px\) \{ @MEDIA all \{ \.b/)
  assert.match(out, /@media \(max-width: 640px\) \{ \.c/)
  assert.match(out, /@import url\("x\.css"\) not all;/)
  assert.match(out, /@import 'y\.css' layer\(base\) supports\(display: grid\) all;/)
  assert.match(out, /content: "@media \(prefers-color-scheme: dark\) \{"/, 'strings are not rewritten')
  assert.match(out, /\/\* @media \(prefers-color-scheme: dark\) \{ \} \*\//, 'comments are not rewritten')
  assert.match(out, /@media \(400px <= width <= 700px\) \{/)
  // Only the scheme rules changed.
  assert.equal(resolveMediaInCss('@media (max-width: 1px){a{b:c}}', light), '@media (max-width: 1px){a{b:c}}')
  assert.equal(resolveMediaInCss(css, dark).includes('@media all { body { color: white } }'), true)
})

test('the root color-scheme pin follows the capture when the page supports it', () => {
  assert.equal(pinnedColorScheme('normal', 'light'), 'light')
  assert.equal(pinnedColorScheme('light dark', 'light'), 'light')
  assert.equal(pinnedColorScheme('light dark', 'dark'), 'dark')
  assert.equal(pinnedColorScheme('dark', 'light'), 'dark', 'a dark-only page stays dark')
  assert.equal(pinnedColorScheme('only light', 'dark'), 'light')
  assert.equal(pinnedColorScheme(undefined), 'light')
})

test('old and synthetic snapshots (no recorded scheme) are treated as light', () => {
  assert.deepEqual(snapshotScheme({}), { colorScheme: 'light', root: 'normal' })
  assert.deepEqual(snapshotScheme({ scheme: { colorScheme: 'dark', reducedMotion: 'reduce', root: 'light dark' } }), {
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    root: 'light dark',
  })
})

test('buildLiveHtml freezes a light capture: dark rules and dark-only sheets never match', async () => {
  const base = 'http://127.0.0.1:3000/'
  const snapshot = {
    base,
    html: '<!DOCTYPE html><html><head><title>t</title></head><body><p>Hi</p></body></html>',
    chunks: [
      {
        href: null,
        base,
        text: 'body { background: white }\n@media (prefers-color-scheme: dark) {\nbody { background: black }\n}',
        media: '',
      },
      // A <link media="(prefers-color-scheme: dark)"> sheet.
      { href: null, base, text: 'p { color: white }', media: '(prefers-color-scheme: dark)' },
      { href: null, base, text: 'p { font-size: 20px }', media: 'screen and (prefers-color-scheme: light)' },
      { href: null, base, text: 'p { margin: 0 }', media: '(max-width: 640px)' },
    ],
    cssImages: {},
    scheme: { colorScheme: 'light', reducedMotion: 'reduce', root: 'light dark' },
  }
  const { html, colorScheme } = await buildLiveHtml(snapshot, { getBody: async () => null })
  assert.equal(colorScheme, 'light')
  assert.doesNotMatch(html, /prefers-color-scheme/)
  assert.match(html, /@media not all \{\s*body \{ background: black \}/)
  assert.match(html, /@media not all \{\s*p \{ color: white \}/)
  assert.match(html, /@media screen \{\s*p \{ font-size: 20px \}/)
  assert.match(html, /@media \(max-width: 640px\) \{\s*p \{ margin: 0 \}/)
  assert.match(html, /:root\{color-scheme:only light!important\}/)
})
