import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BridgeError, privatePath } from './config.js'

// One foreground gateway owns this private journal. Persist the intent before
// any publish. Interrupted/ambiguous requests stay unknown and never resend.
export function openJournal(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 })
  privatePath(dir, 'dir')
  const lock = path.join(dir, 'gateway.lock')
  let lockFd
  const acquire = () => fs.openSync(lock, 'wx', 0o600)
  try {
    lockFd = acquire()
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    privatePath(lock)
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'))
    if (!Number.isInteger(owner.pid) || owner.pid < 1)
      throw new Error('Invalid gateway lock. Inspect it before starting another gateway.', { cause: error })
    try {
      process.kill(owner.pid, 0)
    } catch (probe) {
      if (probe.code === 'ESRCH') {
        fs.unlinkSync(lock)
        lockFd = acquire()
      } else throw probe
    }
    if (lockFd === undefined) throw new Error('A gateway already owns this journal.', { cause: error })
  }
  fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid }))
  fs.fsyncSync(lockFd)
  const file = path.join(dir, 'receipts.json')
  let receipts = []
  const save = () => {
    const tmp = path.join(dir, `.receipts-${randomUUID()}`)
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(receipts))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    const parent = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(parent)
    } finally {
      fs.closeSync(parent)
    }
  }
  try {
    if (fs.existsSync(file)) {
      privatePath(file)
      if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('The bridge journal is too large.')
      receipts = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(receipts) || receipts.length > 500) throw new Error('Invalid bridge journal.')
      for (const receipt of receipts) if (receipt.status === 'publishing') receipt.status = 'unknown'
      save()
    }
  } catch (error) {
    fs.closeSync(lockFd)
    fs.unlinkSync(lock)
    throw error
  }
  return {
    get: (id) => receipts.find((r) => r.requestId === id),
    list: (root, board) => receipts.filter((r) => r.root === root && r.board === board).slice(-50),
    add(receipt) {
      if (receipts.length >= 500)
        throw new BridgeError('journal_full', 'The private receipt journal is full. Archive it on the host before sending more.', 409)
      receipts.push(receipt)
      save()
      return receipt
    },
    update(id, patch) {
      Object.assign(
        receipts.find((r) => r.requestId === id),
        patch,
      )
      save()
    },
    close() {
      fs.closeSync(lockFd)
      fs.unlinkSync(lock)
    },
  }
}
