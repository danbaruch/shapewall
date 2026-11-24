// The /changelog page drops what is only about building and deploying shapewall.com itself (scripts/changelog-public.mjs),
// without editing CHANGELOG.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicChangelogEntry } from '../scripts/changelog-public.mjs'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('site-only bullets go, user-facing ones stay, and an emptied heading goes with them', () => {
  const entry = [
    '### Changed',
    '',
    '- Website: one film on the site, the narrated tour, on the home page.',
    '  It replaces the launch film.',
    '',
    '### Fixed',
    '',
    '- Hosted restore closes incomplete uploads.',
    '- **Website privacy page names no vendors.** It now describes the analytics.',
  ].join('\n')
  const out = publicChangelogEntry(entry)
  assert.equal(out, '### Fixed\n\n- Hosted restore closes incomplete uploads.')
})

test('deploy and telemetry sentences, project stages and migration numbers are reworded or dropped', () => {
  assert.equal(
    publicChangelogEntry(
      '- Website deployments read the SSH destination and telemetry endpoint from the operator environment. Release automation publishes the archive that passed package checks.',
    ),
    '- Release automation publishes the archive that passed package checks.',
  )
  assert.equal(publicChangelogEntry('Connected agents, stage E: the Usage dashboard.'), 'The Usage dashboard.')
  assert.equal(
    publicChangelogEntry('- **Upgrade notes.** Migration 15 is additive; see [Migration 15 and rollback](docs/hosted.md#x).'),
    '- **Upgrade notes.** The upgrade is additive; see [upgrade and rollback notes](docs/hosted.md#x).',
  )
  assert.equal(publicChangelogEntry('Fixes from a full code review: Undo never erases your edit.'), 'Fixes: Undo never erases your edit.')
  assert.equal(
    publicChangelogEntry('- Managed updates and website deployment preserve the rollback release.'),
    '- Managed updates preserve the rollback release.',
  )
})

test('the real CHANGELOG.md has none of it left once filtered', () => {
  const source = fs.readFileSync(path.join(SITE, '..', 'CHANGELOG.md'), 'utf8')
  const entries = source.split(/^## /m).slice(1)
  for (const entry of entries) {
    const out = publicChangelogEntry(entry.split('\n').slice(1).join('\n'))
    for (const re of [
      /^[-*] (\*\*Website|Website( contact page)?:)/m,
      /SSH destination/,
      /telemetry endpoint/i,
      /stage [A-Z]\b/,
      /[Mm]igration \d/,
      /code review/,
    ]) {
      assert.doesNotMatch(out, re, `${entry.split('\n')[0]}: ${re}`)
    }
  }
})
