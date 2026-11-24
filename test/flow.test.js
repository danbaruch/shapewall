// The board's pure helpers for arrows, journeys and before/after.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beforeAfter, clampStep, cropAround, flowEdges, stepMap } from '../client/src/board/flow.js'
import { journeyGraph, resolvePath } from '../src/journey-paths.js'

const present = new Set(['home', 'pricing', 'login', 'blog'])
const links = { home: ['pricing', 'blog'], pricing: ['home', 'login'], blog: ['gone'] }

test('link arrows: all quiet when nothing is active, only the active card when one is', () => {
  assert.deepEqual(flowEdges({ links, present }), [])
  const idle = flowEdges({ links, present, showLinks: true })
  assert.deepEqual(
    idle.map((edge) => [edge.id, edge.data.tone]),
    [
      ['link:home>pricing', 'idle'],
      ['link:home>blog', 'idle'],
      ['link:pricing>home', 'idle'],
      ['link:pricing>login', 'idle'],
    ],
  )
  const active = flowEdges({ links, present, showLinks: true, activePage: 'pricing' })
  assert.deepEqual(
    active.map((edge) => [edge.id, edge.data.tone]),
    [
      ['link:home>pricing', 'in'],
      ['link:pricing>home', 'out'],
      ['link:pricing>login', 'out'],
    ],
  )
  // A big board draws nothing until a card is active.
  assert.deepEqual(flowEdges({ links, present, showLinks: true, idleMax: 3 }), [])
})

test('journey arrows join consecutive steps and replace the same link arrow', () => {
  const edges = flowEdges({ links, present, showLinks: true, journeySteps: ['home', 'pricing', 'pricing', 'login'], currentStep: 2 })
  const journey = edges.filter((edge) => edge.id.startsWith('journey:'))
  assert.deepEqual(
    journey.map((edge) => [edge.source, edge.target, edge.data.label, edge.data.tone]),
    [
      ['home', 'pricing', '2', 'done'],
      ['pricing', 'login', '4', 'journey'],
    ],
  )
  assert.equal(
    edges.some((edge) => edge.id === 'link:home>pricing'),
    false,
  )
  assert.deepEqual(stepMap(['home', 'pricing', 'home']).get('home'), [1, 3])
  assert.equal(clampStep('9', 4), 4)
  assert.equal(clampStep('nope', 4), 1)
  assert.equal(clampStep(2, 0), 0)
})

test('branching journey arrows: the chosen path is numbered, other branches are dashed with their label', () => {
  const steps = [
    'home',
    {
      branches: [
        { id: 'out', label: 'Signed out', steps: ['login'] },
        { id: 'in', label: 'Signed in', steps: [] },
      ],
    },
    'pricing',
  ]
  const graph = journeyGraph(steps)
  const routeOf = (choices) => ({ graph, path: resolvePath(steps, choices).steps.map((item) => item.key) })
  const out = flowEdges({ links, present, showLinks: true, journeyRoute: routeOf([]), currentStep: 1 })
  assert.deepEqual(
    out
      .filter((edge) => edge.id.startsWith('journey'))
      .map((edge) => [edge.id, edge.source, edge.target, edge.data.tone, edge.data.label || null, edge.data.branch || null]),
    [
      ['journey-alt:0>2', 'home', 'pricing', 'alt', null, 'Signed in'],
      ['journey:1', 'home', 'login', 'journey', '2', 'Signed out'],
      ['journey:2', 'login', 'pricing', 'journey', '3', null],
    ],
  )
  // The link arrow home > pricing gives way to the journey's own arrow.
  assert.equal(
    out.some((edge) => edge.id === 'link:home>pricing'),
    false,
  )
  const signedIn = flowEdges({ links, present, journeyRoute: routeOf(['in']), currentStep: 2 })
  assert.deepEqual(
    signedIn.map((edge) => [edge.id, edge.data.tone, edge.data.label || null]),
    [
      ['journey-alt:0>1:0:0', 'alt', null],
      ['journey-alt:1:0:0>2', 'alt', null],
      ['journey:1', 'done', '2'],
    ],
  )
  // A linear journey gives the same arrows as a plain list of steps.
  const linear = ['home', 'pricing', 'login']
  assert.deepEqual(
    flowEdges({ links, present, journeyRoute: { graph: journeyGraph(linear), path: ['0', '1', '2'] }, currentStep: 2 }),
    flowEdges({ links, present, journeySteps: linear, currentStep: 2 }),
  )
})

test('before/after picks the version a comment was made on and the current capture', () => {
  const manifest = { capturedAt: '2026-11-04T10:00:00.000Z', pages: { home: { desktop: { status: 'ok', version: 'v-now' } } } }
  const captures = { home: { desktop: { file: 'home.desktop.png' } } }
  const versions = { home: { desktop: [{ version: 'v-old', file: 'home.desktop.v-old.png' }] } }
  const data = { manifest, captures, versions }
  const resolved = { pageId: 'home', viewport: 'desktop', status: 'resolved', captureVersion: 'v-old' }
  assert.deepEqual(beforeAfter(resolved, data), {
    before: { kind: 'versions', file: 'home.desktop.v-old.png', version: 'v-old' },
    after: { kind: 'captures', file: 'home.desktop.png', version: 'v-now' },
    reason: null,
  })
  assert.equal(beforeAfter({ ...resolved, captureVersion: 'v-now' }, data).reason, 'not-recaptured')
  assert.equal(beforeAfter({ ...resolved, captureVersion: 'v-pruned' }, data).reason, 'pruned')
  assert.equal(beforeAfter({ ...resolved, status: 'open' }, data), null)
  assert.equal(beforeAfter({ ...resolved, captureVersion: null }, data), null)
})

test('the crop around a pin stays inside the frame', () => {
  const native = { width: 1440, height: 2200 }
  assert.deepEqual(cropAround(native, 50, 5), { left: 396, top: 0, width: 648, height: 428 })
  const corner = cropAround(native, 100, 100)
  assert.equal(corner.left + corner.width, 1440)
  assert.equal(corner.top + corner.height, 2200)
  assert.equal(cropAround({ width: 390, height: 1800 }, 50, 50).width, 320)
})
