// The release text gate (scripts/check-release-text.mjs): en and em dashes,
// banned phrases and competitor or employer names on the lines a change adds.
// The dashes are spelled by code point so this file holds neither.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { addedLines, check, loadRules, DASHES } from '../scripts/check-release-text.mjs'
import { tempDir } from './helpers.js'

const CONFIG = {
  phrases: [{ pattern: '(feedback|review)[ -]tools?\\b', why: 'positioning' }],
  names: [
    { name: 'Acme Corp', kind: 'employer' },
    { name: 'Marker.io', kind: 'competitor' },
  ],
  exclude: ['lists.json'],
  dashesAllowed: { paths: ['tts/'] },
  phrasesAllowed: { paths: ['test/rules.test.js'] },
  binaryExtensions: ['.png'],
}

test('each rule fires on its own line, and the allow lists hold', () => {
  const rules = loadRules(CONFIG)
  const hits = check(
    {
      'docs/a.md': [
        [1, `Plain text -- fine.`],
        [2, `An en dash ${DASHES[0]} here`],
        [3, `An em dash ${DASHES[1]} here`],
        [4, 'The best review tool around'],
        [5, 'We used to work at ACME CORP.'],
        [6, 'Unlike marker.io, ...'],
        [7, 'A markerXio lookalike and Acme Corporation do not count'],
      ],
      'tts/split.js': [[1, `/[${DASHES[0]}${DASHES[1]}]/`]],
      'test/rules.test.js': [[1, 'never a feedback tool']],
      'lists.json': [[1, 'Acme Corp']],
      'shot.png': [[1, DASHES[1]]],
    },
    rules,
  )
  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line} ${hit.why}`),
    [
      'docs/a.md:2 en dash (U+2013)',
      'docs/a.md:3 em dash (U+2014)',
      'docs/a.md:4 positioning',
      'docs/a.md:5 employer name Acme Corp',
      'docs/a.md:6 competitor name Marker.io',
    ],
  )
})

test('addedLines reads only the lines HEAD adds against the base, with their line numbers', () => {
  const dir = tempDir('release-text-git')
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  fs.writeFileSync(path.join(dir, 'a.md'), `old ${DASHES[1]} line\nkeep\n`)
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').trim()
  fs.writeFileSync(path.join(dir, 'a.md'), `old ${DASHES[1]} line\nkeep\nnew line\n`)
  fs.writeFileSync(path.join(dir, 'b.md'), 'first\n')
  git('add', '.')
  git('commit', '-qm', 'change')
  assert.deepEqual(addedLines(base, dir), { 'a.md': [[3, 'new line']], 'b.md': [[1, 'first']] })
})

test('the repository config parses and bans the dashes everywhere but its allow list', () => {
  const rules = loadRules()
  assert.equal(rules.excluded('scripts/release-text.config.json'), true)
  assert.deepEqual(check({ 'README.md': [[1, `a ${DASHES[1]} b`]] }, rules).length, 1)
  assert.ok(rules.names.length > 0 && rules.phrases.length > 0)
})
