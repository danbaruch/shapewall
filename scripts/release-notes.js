// Used before package publication and again when creating the GitHub release.
import fs from 'node:fs'

const version = process.argv[2]
const lines = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/)
const start = lines.findIndex((line) => line.startsWith('## ') && line.trim().split(/\s+/)[1] === version)
const body = []
if (start >= 0) {
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    body.push(line)
  }
}
const notes = body.join('\n').trim()
if (!notes) throw new Error(`Missing changelog entry for ${version}`)
console.log(notes)
