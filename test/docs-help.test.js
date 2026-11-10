// The help text printed in the README and on the website's CLI page is the real `shapewall --help`, so a flag
// added to src/cli/help.js cannot be forgotten in the docs. To refresh both after a change:
//   node bin/shapewall.js --help    (paste everything from "Usage:" on into the two ```text blocks)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HELP, SECTIONS } from '../src/cli/help.js'
import { COMMAND_FLAGS } from '../src/cli/args.js'

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
// Without the first line: it carries the version, which changes every release.
const body = HELP.trim().split('\n').slice(2).join('\n')

test('README and the website CLI page carry the current --help text', () => {
  for (const file of ['README.md', 'website/src/docs/cli.md']) {
    assert.ok(read(file).includes(body), `${file}: the help block is out of date (see the top of this test)`)
  }
})

test('every command and every option it takes is in its help section', () => {
  for (const [command, flags] of Object.entries(COMMAND_FLAGS)) {
    assert.ok(SECTIONS[command], `${command}: no help section`)
    // Operator subcommand flags of `hosted admin` are listed by `shapewall hosted admin` itself.
    if (command === 'hosted') continue
    for (const flag of flags) {
      assert.ok(HELP.includes(`--${flag}`), `${command} --${flag} is not in the help text`)
    }
  }
})
