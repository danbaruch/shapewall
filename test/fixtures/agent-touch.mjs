// A stand-in for a coding agent behind `shapewall watch --remote --exec`:
// reads the comment's JSON on stdin and appends one line to the file named
// by SW_TOUCH_FILE ("<label> <board>#<comment>"), so a test can see which
// watcher was handed which comment. SW_TOUCH_MS keeps it "working" a while.
import fs from 'node:fs'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const { board, comment } = JSON.parse(input)
const wait = Number(process.env.SW_TOUCH_MS || 0)
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
fs.appendFileSync(process.env.SW_TOUCH_FILE, `${process.env.SW_TOUCH_LABEL || 'agent'} ${board}#${comment.id}\n`)
