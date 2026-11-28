// prepareOrigins at server start: --previous-origin is checked before
// anything is written, and replacing a recorded move says so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { openDatabase } from '../src/hosted/db.js'
import { getState, prepareOrigins, readMove, recordMove } from '../src/hosted/rebind.js'
import { tempDir } from './helpers.js'

const NEW = 'https://new.example.test'
const OLD = 'https://old.example.test'

test('a bad --previous-origin changes nothing: the origin stays, and the next start still warns', async () => {
  const db = await openDatabase(path.join(tempDir('rebind-validate'), 'shapewall.db'))
  try {
    prepareOrigins({ db, origin: OLD, rpId: 'old.example.test' })
    for (const previous of ['http://old.example.test', NEW, 'not a url'])
      assert.throws(() => prepareOrigins({ db, origin: NEW, rpId: 'new.example.test', previousOrigin: previous }))
    assert.equal(getState(db, 'origin').origin, OLD, 'not recorded before the check')
    assert.equal(readMove(db), null)
    const lines = []
    prepareOrigins({ db, origin: NEW, rpId: 'new.example.test', log: (line) => lines.push(line) })
    assert.match(lines.join('\n'), /ran at https:\/\/old\.example\.test and now runs at https:\/\/new\.example\.test without a move/)
  } finally {
    db.close()
  }
})

test('a restart with the recorded move keeps its window; a different one replaces it loudly', async () => {
  const db = await openDatabase(path.join(tempDir('rebind-replace'), 'shapewall.db'))
  try {
    prepareOrigins({ db, origin: OLD, rpId: 'old.example.test' })
    const started = new Date(Date.now() - 10 * 86_400_000)
    const recorded = recordMove(db, { from: OLD, to: NEW, now: started })
    const lines = []
    const log = (line) => lines.push(line)
    const same = prepareOrigins({ db, origin: NEW, rpId: 'new.example.test', previousOrigin: OLD, log })
    assert.equal(same.move.endsAt, recorded.endsAt, 'the 30-day window is not reset')
    assert.equal(lines.length, 0)
    const other = 'https://older.example.test'
    const replaced = prepareOrigins({ db, origin: NEW, rpId: 'new.example.test', previousOrigin: other, log })
    assert.equal(replaced.move.from, other)
    assert.match(lines.join('\n'), /Warning: replacing the recorded move from https:\/\/old\.example\.test/)
  } finally {
    db.close()
  }
})

test('the solo engine starts on a new --port without the passkeys and move-origin warning (IC4 B8)', async () => {
  const db = await openDatabase(path.join(tempDir('rebind-solo'), 'shapewall.db'))
  try {
    const first = 'http://notes-abc.shapewall.localhost:25698'
    const second = 'http://notes-abc.shapewall.localhost:22814'
    prepareOrigins({ db, origin: first, rpId: 'notes-abc.shapewall.localhost', solo: true })
    const lines = []
    prepareOrigins({ db, origin: second, rpId: 'notes-abc.shapewall.localhost', solo: true, log: (line) => lines.push(line) })
    assert.deepEqual(lines, [])
    assert.equal(getState(db, 'origin').origin, second, 'the new origin is still recorded')
    // A team server keeps the warning.
    prepareOrigins({ db, origin: first, rpId: 'notes-abc.shapewall.localhost', log: (line) => lines.push(line) })
    assert.match(lines.join('\n'), /without a move/)
  } finally {
    db.close()
  }
})
