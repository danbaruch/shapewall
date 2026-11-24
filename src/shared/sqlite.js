import fs from 'node:fs'
import path from 'node:path'

// The Node.js Shapewall needs (package.json engines); node:sqlite itself is in 22.13+.
export const MIN_NODE = [22, 19]

export function nodeSupportsSqlite(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

export async function openSqlite(file, initialize) {
  const { DatabaseSync } = await import('node:sqlite')
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
    initialize(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

// Runs fn() inside BEGIN IMMEDIATE ... COMMIT (nested calls join the outer
// transaction). fn must be synchronous.
const inTransaction = new WeakSet()
export function transaction(db, fn) {
  if (inTransaction.has(db)) return fn()
  db.exec('BEGIN IMMEDIATE')
  inTransaction.add(db)
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw error
  } finally {
    inTransaction.delete(db)
  }
}

const statements = new WeakMap()
// node:sqlite binds a missing named parameter as NULL without a word; a
// typo must fail instead. Every :name in the SQL needs a key (null is fine).
export function prepareSql(db, sql, ErrorType = Error) {
  let cache = statements.get(db)
  if (!cache) statements.set(db, (cache = new Map()))
  let entry = cache.get(sql)
  if (!entry) {
    entry = { statement: db.prepare(sql), names: [...new Set([...sql.matchAll(/:([a-z_][a-z0-9_]*)/gi)].map((match) => match[1]))] }
    cache.set(sql, entry)
  }
  const check = (params = {}) => {
    for (const name of entry.names) if (params[name] === undefined) throw new ErrorType(`missing SQL parameter :${name}`)
    return params
  }
  return {
    get: (params) => entry.statement.get(check(params)),
    all: (params) => entry.statement.all(check(params)),
    run: (params) => entry.statement.run(check(params)),
  }
}
