import { execFileSync } from 'node:child_process'
import test from 'node:test'

test('managed updater rejects untrusted files and preserves rollback on activation failure', () => {
  execFileSync('python3', ['test/managed-update.test.py'], { stdio: 'pipe' })
})
