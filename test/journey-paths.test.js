// Branching journeys: validation, the graph, paths, choices and pruning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JOURNEY_PATHS_MAX,
  checkSteps,
  chooseBranch,
  isBranching,
  journeyGraph,
  journeyPages,
  journeyPaths,
  pruneSteps,
  resolvePath,
} from '../src/journey-paths.js'

const PAGES = new Set(['home', 'signup', 'verify', 'expired', 'welcome', 'billing', 'declined', 'done', 'login'])

// Sign up, then the email link works or has expired (sent again, then
// verified); both rejoin at welcome. Then pay: ok, or declined (ends).
const SIGNUP = [
  'home',
  'signup',
  {
    branches: [
      { id: 'link-ok', label: 'Link works', steps: ['verify'] },
      { id: 'link-expired', label: 'Link expired', steps: ['expired', 'verify'] },
    ],
  },
  'welcome',
  'billing',
  {
    branches: [
      { label: 'Payment ok', steps: ['done'] },
      { label: 'Card declined', steps: ['declined'], end: true },
    ],
  },
]

function check(steps) {
  const problems = []
  const clean = checkSteps(steps, PAGES, 'steps', problems)
  return { clean, problems: problems.join('\n') }
}

test('linear steps stay exactly as they were', () => {
  const { clean, problems } = check(['home', 'signup', 'home'])
  assert.equal(problems, '')
  assert.deepEqual(clean, ['home', 'signup', 'home'])
  assert.equal(isBranching(clean), false)
  assert.deepEqual(journeyPaths(clean), [{ choices: [], labels: [], steps: ['home', 'signup', 'home'], ended: false }])
})

test('forks are validated and normalized: ids from labels, end only when true', () => {
  const { clean, problems } = check(SIGNUP)
  assert.equal(problems, '')
  assert.equal(isBranching(clean), true)
  assert.deepEqual(clean[5].branches, [
    { id: 'payment-ok', label: 'Payment ok', steps: ['done'] },
    { id: 'card-declined', label: 'Card declined', steps: ['declined'], end: true },
  ])
  assert.deepEqual(journeyPages(clean), ['home', 'signup', 'verify', 'expired', 'welcome', 'billing', 'done', 'declined'])
  // A skip branch: signed in goes straight to the step after the fork.
  const skip = check([
    'home',
    {
      branches: [
        { label: 'Signed out', steps: ['login'] },
        { label: 'Signed in', steps: [] },
      ],
    },
    'welcome',
  ])
  assert.equal(skip.problems, '')
  // Nested forks.
  const nested = check([
    'home',
    {
      branches: [
        {
          label: 'A',
          steps: [
            'signup',
            {
              branches: [
                { label: 'A1', steps: ['verify'] },
                { label: 'A2', steps: ['expired'] },
              ],
            },
          ],
        },
        { label: 'B', steps: ['login'] },
      ],
    },
    'welcome',
  ])
  assert.equal(nested.problems, '')
  assert.equal(journeyPaths(nested.clean).length, 3)
})

test('invalid forks are refused with the JSON path of each problem', () => {
  const { clean, problems } = check([
    {
      branches: [
        { label: 'x', steps: ['home'] },
        { label: 'y', steps: ['home'] },
      ],
    },
    'home',
    { branches: [{ label: 'Only one', steps: ['signup'] }] },
    'signup',
    {
      branches: [
        { label: '', steps: ['home'] },
        { id: 'Bad Id', label: 'Bad', steps: ['home'] },
        { id: 'same', label: 'One', steps: ['nope'] },
        { id: 'same', label: 'Two', steps: [], end: true },
        { label: 'Not a list', steps: 'home' },
        { label: 'Odd end', steps: ['home'], end: 'yes' },
        'not a branch',
      ],
    },
    'welcome',
    {
      branches: [
        { label: 'a', steps: ['home'], end: true },
        { label: 'b', steps: ['home'], end: true },
      ],
    },
    'done',
  ])
  assert.equal(clean, null)
  for (const fragment of [
    'steps[0]: a fork follows a page',
    'steps[2].branches: 2 to 6 branches',
    'steps[4].branches[0].label: 1 to 60',
    'steps[4].branches[1].id: lowercase',
    'steps[4].branches[2].steps[0]: no page "nope"',
    'steps[4].branches[3].id: "same" is used by another branch',
    'steps[4].branches[3].steps: an empty branch needs a step after the fork',
    'steps[4].branches[4].steps: a list of page ids',
    'steps[4].branches[5].end: true or false',
    'steps[4].branches[6]: a branch is an object',
    'steps[4].branches: 2 to 6 branches',
    'steps[6]: every branch ends, so nothing can follow this fork',
  ]) {
    assert.ok(problems.includes(fragment), `missing "${fragment}" in:\n${problems}`)
  }
  // Two forks in a row, too deep, too many pages, an empty branch at the very end.
  const fork = (steps) => ({
    branches: [
      { label: 'a', steps },
      { label: 'b', steps: ['home'] },
    ],
  })
  assert.match(check(['home', fork(['signup']), fork(['login'])]).problems, /steps\[2\]: a fork follows a page/)
  assert.match(check(['home', fork(['home', fork(['home', fork(['home', fork(['home'])])])])]).problems, /nest at most 3 deep/)
  assert.match(check(['home', fork([])]).problems, /an empty branch needs a step after the fork/)
  assert.match(check(Array(51).fill('home')).problems, /2 to 50 page ids/)
  assert.match(check(['home', fork(Array(50).fill('home'))]).problems, /2 to 50 page ids, in order \(counting every branch\)/)
  assert.match(check(['home']).problems, /2 to 50 page ids/)
  assert.match(check('home').problems, /2 to 50 page ids/)
  // More paths than the cap.
  const six = { branches: ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => ({ label, steps: ['home'] })) }
  assert.match(check(['home', six, 'home', six, 'home', six]).problems, new RegExp(`at most ${JOURNEY_PATHS_MAX} different paths`))
})

test('the graph joins every step, labels arrows into branches and rejoins after the fork', () => {
  const { clean } = check(SIGNUP)
  const graph = journeyGraph(clean)
  assert.deepEqual(
    graph.nodes.map((node) => `${node.key}=${node.pageId}`),
    ['0=home', '1=signup', '2:0:0=verify', '2:1:0=expired', '2:1:1=verify', '3=welcome', '4=billing', '5:0:0=done', '5:1:0=declined'],
  )
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}${edge.label ? ` [${edge.label}]` : ''}`),
    [
      '0>1',
      '1>2:0:0 [Link works]',
      '1>2:1:0 [Link expired]',
      '2:1:0>2:1:1',
      '2:0:0>3',
      '2:1:1>3',
      '3>4',
      '4>5:0:0 [Payment ok]',
      '4>5:1:0 [Card declined]',
    ],
  )
  // A skip branch draws one labelled arrow from the fork's page to the step after it.
  const skip = journeyGraph([
    'home',
    {
      branches: [
        { id: 'out', label: 'Signed out', steps: ['login'] },
        { id: 'in', label: 'Signed in', steps: [] },
      ],
    },
    'welcome',
  ])
  assert.deepEqual(
    skip.edges.map((edge) => `${edge.from}>${edge.to} ${edge.branch || ''}`.trim()),
    ['0>1:0:0 out', '1:0:0>2', '0>2 in'],
  )
})

test('resolvePath takes the chosen branch at each fork, the first one by default', () => {
  const { clean } = check(SIGNUP)
  const first = resolvePath(clean)
  assert.deepEqual(
    first.steps.map((item) => item.pageId),
    ['home', 'signup', 'verify', 'welcome', 'billing', 'done'],
  )
  assert.deepEqual(
    first.forks.map((fork) => [fork.afterStep, fork.chosen]),
    [
      [2, 'link-ok'],
      [5, 'payment-ok'],
    ],
  )
  assert.equal(first.ended, false)
  const declined = resolvePath(clean, ['link-expired', 'card-declined'])
  assert.deepEqual(
    declined.steps.map((item) => [item.pageId, item.branch]),
    [
      ['home', null],
      ['signup', null],
      ['expired', 'Link expired'],
      ['verify', 'Link expired'],
      ['welcome', null],
      ['billing', null],
      ['declined', 'Card declined'],
    ],
  )
  assert.equal(declined.ended, true)
  assert.deepEqual(declined.forks[1].options, [
    { id: 'payment-ok', label: 'Payment ok', end: false },
    { id: 'card-declined', label: 'Card declined', end: true },
  ])
  // Unknown choices fall back to the first branch.
  assert.deepEqual(resolvePath(clean, ['nope']).forks[0].chosen, 'link-ok')
  // A new pick keeps earlier choices and drops later ones.
  assert.deepEqual(chooseBranch(declined, 0, 'link-ok'), ['link-ok'])
  assert.deepEqual(chooseBranch(declined, 1, 'payment-ok'), ['link-expired', 'payment-ok'])
})

test('journeyPaths lists every way through the forks', () => {
  const { clean } = check(SIGNUP)
  assert.deepEqual(
    journeyPaths(clean).map((item) => [item.labels.join(' / '), item.steps.length, item.ended]),
    [
      ['Link works / Payment ok', 6, false],
      ['Link works / Card declined', 6, true],
      ['Link expired / Payment ok', 7, false],
      ['Link expired / Card declined', 7, true],
    ],
  )
})

test('pruneSteps drops pages that left the config and collapses forks', () => {
  const { clean } = check(SIGNUP)
  // Without "expired" the expired branch still has "verify"; without "declined" its ending branch disappears and the fork collapses.
  assert.deepEqual(pruneSteps(clean, new Set(['home', 'signup', 'verify', 'welcome', 'billing', 'done'])), [
    'home',
    'signup',
    {
      branches: [
        { id: 'link-ok', label: 'Link works', steps: ['verify'] },
        { id: 'link-expired', label: 'Link expired', steps: ['verify'] },
      ],
    },
    'welcome',
    'billing',
    'done',
  ])
  // A lone ending branch ends the journey there.
  assert.deepEqual(
    pruneSteps(
      [
        'home',
        {
          branches: [
            { id: 'a', label: 'A', steps: ['gone'] },
            { id: 'b', label: 'B', steps: ['login'], end: true },
          ],
        },
        'x',
      ],
      new Set(['home', 'login', 'x']),
    ),
    [
      'home',
      {
        branches: [
          { id: 'a', label: 'A', steps: [] },
          { id: 'b', label: 'B', steps: ['login'], end: true },
        ],
      },
      'x',
    ],
  )
  assert.deepEqual(
    pruneSteps(
      [
        'home',
        {
          branches: [
            { id: 'a', label: 'A', steps: ['gone'], end: true },
            { id: 'b', label: 'B', steps: ['login'], end: true },
          ],
        },
      ],
      new Set(['home', 'login']),
    ),
    ['home', 'login'],
  )
})
