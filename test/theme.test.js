// Appearance: every theme defines every token in light and dark, text keeps
// WCAG AA contrast (7:1 in the high-contrast theme), and the boot script that
// runs before the first paint agrees with client/src/lib/theme.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { APPEARANCE_KEY, MODES, THEMES, normalizeAppearance, resolveMode } from '../client/src/lib/theme.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = fs.readFileSync(path.join(ROOT, 'client', 'src', 'styles.css'), 'utf8')
const TOKENS = [
  'surface',
  'surface-2',
  'sunken',
  'line',
  'line-strong',
  'fg',
  'muted',
  'faint',
  'accent',
  'accent-fg',
  'ok',
  'warn',
  'bad',
  'ok-fg',
  'warn-fg',
  'bad-fg',
]

function block(selector) {
  const start = CSS.indexOf(`${selector} {`)
  if (start < 0) return null
  const body = CSS.slice(start + selector.length + 2, CSS.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2].toLowerCase()]))
}

// The tokens in effect for a theme and mode, in cascade order.
function tokensFor(theme, mode) {
  const layers = [block(':root')]
  if (mode === 'dark') layers.push(block(":root[data-mode='dark']"))
  if (theme !== 'default') {
    layers.push(block(`:root[data-theme='${theme}']`))
    if (mode === 'dark') layers.push(block(`:root[data-theme='${theme}'][data-mode='dark']`))
  }
  return Object.assign({}, ...layers)
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

test('every theme defines every token in both modes', () => {
  for (const theme of THEMES) {
    if (theme.id === 'default') continue
    for (const selector of [`:root[data-theme='${theme.id}']`, `:root[data-theme='${theme.id}'][data-mode='dark']`]) {
      const tokens = block(selector)
      assert.ok(tokens, `${selector} is in styles.css`)
      assert.deepEqual(Object.keys(tokens).sort(), [...TOKENS].sort(), `${selector} defines every token`)
    }
  }
  assert.deepEqual(Object.keys(block(':root')).sort(), [...TOKENS].sort())
  assert.deepEqual(Object.keys(block(":root[data-mode='dark']")).sort(), [...TOKENS].sort())
  for (const theme of THEMES) assert.ok(CSS.includes(`.sw-swatch-${theme.id} {`), `swatch for ${theme.id}`)
})

test('text and controls keep AA contrast in every theme, 7:1 in high contrast', () => {
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark']) {
      const tokens = tokensFor(theme.id, mode)
      const where = `${theme.id}/${mode}`
      const text = theme.id === 'contrast' ? 7 : 4.5
      for (const background of ['surface', 'surface-2']) {
        for (const name of ['fg', 'muted', 'faint', 'accent', 'ok', 'warn', 'bad']) {
          const ratio = contrast(tokens[name], tokens[background])
          assert.ok(ratio >= text, `${where}: ${name} on ${background} is ${ratio.toFixed(2)}:1`)
        }
      }
      assert.ok(contrast(tokens.fg, tokens.sunken) >= text, `${where}: fg on sunken`)
      assert.ok(contrast(tokens['accent-fg'], tokens.accent) >= text, `${where}: accent-fg on accent`)
      // Text on a filled status chip (a resolved check, a count of broken links).
      for (const name of ['ok', 'warn', 'bad'])
        assert.ok(contrast(tokens[`${name}-fg`], tokens[name]) >= text, `${where}: ${name}-fg on ${name}`)
      // Focus rings and selection (non-text): 3:1 against the surface.
      assert.ok(contrast(tokens.accent, tokens.surface) >= 3, `${where}: accent ring on surface`)
      // A strong border (group frames, dividers that must show on the canvas) stands out more than a plain one.
      for (const background of ['surface', 'sunken']) {
        const strong = contrast(tokens['line-strong'], tokens[background])
        assert.ok(strong > contrast(tokens.line, tokens[background]) || strong >= 7, `${where}: line-strong beats line on ${background}`)
        assert.ok(strong >= 1.5, `${where}: line-strong shows on ${background} (${strong.toFixed(2)}:1)`)
      }
    }
  }
})

test('comment avatar and pin colours keep AA contrast for their white initials', () => {
  const source = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'ui', 'avatar.jsx'), 'utf8')
  const people = JSON.parse(/PERSON_COLORS = (\[[^\]]+\])/.exec(source)[1].replaceAll("'", '"'))
  const agent = /AGENT_COLOR = '(#[0-9a-f]{6})'/.exec(source)[1]
  assert.ok(people.length >= 6)
  for (const color of [...people, agent]) {
    const ratio = contrast('#ffffff', color)
    assert.ok(ratio >= 4.5, `white on ${color} is ${ratio.toFixed(2)}:1`)
  }
})

test('the boot script applies the same appearance as theme.js, before any module runs', () => {
  const source = fs.readFileSync(path.join(ROOT, 'client', 'public', 'theme-boot.js'), 'utf8')
  assert.ok(source.includes(APPEARANCE_KEY), 'same storage key')
  for (const theme of THEMES) assert.ok(source.includes(`'${theme.id}'`), `boot knows ${theme.id}`)
  const cases = [
    [null, false],
    ['{"mode":"dark","theme":"ocean"}', false],
    ['{"mode":"system","theme":"contrast"}', true],
    ['{"mode":"light","theme":"forest"}', true],
    ['{"mode":"sepia","theme":"neon"}', true],
    ['not json', false],
  ]
  for (const [stored, systemDark] of cases) {
    const attributes = {}
    const context = {
      window: { matchMedia: () => ({ matches: systemDark }) },
      localStorage: { getItem: () => stored },
      document: { documentElement: { setAttribute: (name, value) => (attributes[name] = value) } },
    }
    context.window.localStorage = context.localStorage
    vm.runInNewContext(source, context)
    let parsed = null
    try {
      parsed = JSON.parse(stored)
    } catch {
      parsed = null
    }
    const expected = normalizeAppearance(parsed)
    assert.equal(attributes['data-theme'], expected.theme, `theme for ${stored}`)
    assert.equal(attributes['data-mode'], resolveMode(expected.mode, systemDark), `mode for ${stored}`)
  }
  assert.deepEqual(
    MODES.map((mode) => mode.id),
    ['light', 'dark', 'system'],
  )
})

test('both app shells load the boot script before their bundle, as a plain script', () => {
  for (const file of ['index.html', 'console.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'client', file), 'utf8')
    const boot = html.search(/<script src="[^"]*theme-boot\.js"><\/script>/)
    assert.ok(boot > 0, `${file} loads theme-boot.js`)
    assert.ok(boot < html.indexOf('type="module"'), `${file}: boot runs before the bundle`)
    assert.ok(boot < html.indexOf('</head>'), `${file}: boot is in the head`)
  }
})
