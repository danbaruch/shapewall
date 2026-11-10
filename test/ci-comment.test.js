// `shapewall ci comment` against a local stub of the GitHub REST API (no
// network): one comment created and then updated in place, the fork and
// read-only fallbacks to the job summary, the token-host rule, artifact links
// and the optional images branch.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { PNG } from 'pngjs'
import { commentFromResult, prContext, apiTarget, checkArtifactUrl } from '../src/ci/github.js'
import { COMMENT_MARKER } from '../src/ci/summary.js'
import { SUMMARY_SCHEMA } from '../src/ci/compare.js'
import { main } from '../src/cli.js'
import { tempDir } from './helpers.js'

const TOKEN = 'ghs_test_token_0123456789'
let server
let api
const state = { comments: [], requests: [], readOnly: false, private: false, refs: {}, nextId: 100 }

function reset(options = {}) {
  Object.assign(state, { comments: [], requests: [], readOnly: false, private: false, refs: {}, nextId: 100, ...options })
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      state.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
      const url = new URL(req.url, 'http://stub')
      const write = req.method !== 'GET'
      if (write && state.readOnly) return send(403, { message: 'Resource not accessible by integration' })
      if (req.method === 'GET' && url.pathname === '/repos/acme/site') return send(200, { full_name: 'acme/site', private: state.private })
      if (req.method === 'GET' && url.pathname === '/repos/acme/site/issues/7/comments') {
        const page = Number(url.searchParams.get('page'))
        return send(200, page === 1 ? state.comments : [])
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/site/issues/7/comments') {
        const comment = {
          id: (state.nextId += 1),
          body: body.body,
          user: { login: 'github-actions[bot]', type: 'Bot' },
          html_url: `https://github.com/acme/site/pull/7#issuecomment-${state.nextId}`,
        }
        state.comments.push(comment)
        return send(201, comment)
      }
      const patch = url.pathname.match(/^\/repos\/acme\/site\/issues\/comments\/(\d+)$/)
      if (req.method === 'PATCH' && patch) {
        const comment = state.comments.find((item) => String(item.id) === patch[1])
        if (!comment || comment.user.type !== 'Bot') return send(403, { message: 'not yours' })
        comment.body = body.body
        return send(200, comment)
      }
      if (req.method === 'POST' && url.pathname === '/repos/acme/site/git/blobs') return send(201, { sha: `blob${state.requests.length}` })
      if (req.method === 'POST' && url.pathname === '/repos/acme/site/git/trees') return send(201, { sha: 'tree1' })
      if (req.method === 'POST' && url.pathname === '/repos/acme/site/git/commits') return send(201, { sha: 'c0ffee'.padEnd(40, '0') })
      if (req.method === 'GET' && url.pathname === '/repos/acme/site/git/ref/heads/shapewall-ci')
        return state.refs.tip ? send(200, { object: { sha: state.refs.tip } }) : send(404, { message: 'Not Found' })
      if (req.method === 'GET' && url.pathname.startsWith('/repos/acme/site/git/commits/')) return send(200, { tree: { sha: 'oldtree' } })
      if (req.method === 'POST' && url.pathname === '/repos/acme/site/git/refs') return send(201, { ref: body.ref })
      return send(404, { message: 'Not Found' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  api = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

function pixel(width = 40, height = 30) {
  return PNG.sync.write(new PNG({ width, height }))
}

// A result folder with one changed shot (or none).
function result({ changed = true } = {}) {
  const dir = tempDir('ci-comment')
  const images = {}
  if (changed) {
    fs.mkdirSync(path.join(dir, 'images', 'home.desktop'), { recursive: true })
    for (const name of ['before', 'after', 'diff']) {
      for (const suffix of ['', '.thumb']) {
        const rel = `images/home.desktop/${name}${suffix}.png`
        fs.writeFileSync(path.join(dir, rel), pixel())
        images[`${name}${suffix ? 'Thumb' : ''}`] = rel
      }
    }
  }
  const summary = {
    schema: SUMMARY_SCHEMA,
    version: 1,
    threshold: 0.001,
    totals: {
      pages: 2,
      changedPages: changed ? 1 : 0,
      shots: 2,
      changedShots: changed ? 1 : 0,
      unchangedShots: changed ? 1 : 2,
      failedShots: 0,
      newPages: 0,
      removedPages: 0,
      pagesNotCompared: 0,
    },
    failures: [],
    warnings: [],
    shots: [
      {
        page: 'home',
        title: 'Home',
        path: '/',
        viewport: 'desktop',
        viewportSize: { width: 1440, height: 900 },
        status: changed ? 'changed' : 'unchanged',
        changed,
        ratio: changed ? 0.02 : 0,
        images: changed ? images : null,
      },
      { page: 'about', title: 'About', path: '/about', viewport: 'desktop', status: 'unchanged', changed: false, ratio: 0 },
    ],
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary))
  return dir
}

function jobEnv({ fork = false, title = 'Make pricing clearer', extra = {} } = {}) {
  const dir = tempDir('ci-job')
  const event = path.join(dir, 'event.json')
  fs.writeFileSync(
    event,
    JSON.stringify({
      pull_request: {
        number: 7,
        title,
        head: { sha: 'a'.repeat(40), repo: { full_name: fork ? 'someone/site' : 'acme/site' } },
        base: { repo: { full_name: 'acme/site' } },
      },
    }),
  )
  const summaryFile = path.join(dir, 'step-summary.md')
  return {
    env: {
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: 'acme/site',
      GITHUB_RUN_ID: '7001',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_TOKEN: TOKEN,
      SHAPEWALL_GITHUB_API_URL: api,
      ...extra,
    },
    summaryFile,
  }
}

const lines = []
const log = (line) => lines.push(line)

test('the pull request comes from the event; a fork is detected', () => {
  const { env } = jobEnv({ fork: true })
  assert.deepEqual(prContext(env), { repo: 'acme/site', pull: 7, title: 'Make pricing clearer', headSha: 'a'.repeat(40), fork: true })
  assert.equal(prContext({}, { repo: 'acme/site', pull: '12' }).pull, 12)
  assert.equal(prContext({ GITHUB_REPOSITORY: 'not a repo' }).repo, null)
})

test('one comment: created on the first run, updated in place on the next, with the token sent only to the API', async () => {
  reset()
  const { env, summaryFile } = jobEnv()
  const dir = result()
  const first = await commentFromResult({ dir, env, artifactUrl: 'https://github.com/acme/site/actions/runs/7001/artifacts/55', log })
  assert.equal(first.posted, true)
  assert.equal(first.action, 'created')
  assert.equal(state.comments.length, 1)
  const body = state.comments[0].body
  assert.ok(body.startsWith(COMMENT_MARKER))
  assert.match(body, /### Shapewall: 1 of 2 pages changed/)
  assert.match(body, /\| Home \(\/\) \| desktop 1440x900 \| 2\.00% \|/)
  assert.match(body, /\[Before, after and diff images\]\(https:\/\/github\.com\/acme\/site\/actions\/runs\/7001\/artifacts\/55\)/)
  assert.match(body, /\[the workflow run\]\(https:\/\/github\.com\/acme\/site\/actions\/runs\/7001\)/)
  assert.ok(state.requests.every((item) => item.auth === `Bearer ${TOKEN}`))
  assert.ok(fs.readFileSync(summaryFile, 'utf8').includes('1 of 2 pages changed'), 'also in the job summary')

  const second = await commentFromResult({ dir: result({ changed: false }), env, log })
  assert.equal(second.action, 'updated')
  assert.equal(state.comments.length, 1, 'still one comment')
  assert.match(state.comments[0].body, /<details>\n<summary>Shapewall: no visual changes on 2 pages<\/summary>/)
})

test('a marker comment someone else wrote is not edited: Shapewall writes its own', async () => {
  reset({ comments: [{ id: 5, body: `${COMMENT_MARKER}\nfake`, user: { login: 'mallory', type: 'User' } }] })
  const { env } = jobEnv()
  const outcome = await commentFromResult({ dir: result(), env, log })
  assert.equal(outcome.action, 'created')
  assert.equal(state.comments[0].body, `${COMMENT_MARKER}\nfake`)
  assert.equal(state.comments.length, 2)
})

test('fork pull requests: no API call, the summary goes to the job summary, nothing fails', async () => {
  reset()
  const { env, summaryFile } = jobEnv({ fork: true })
  const outcome = await commentFromResult({ dir: result(), env, log })
  assert.equal(outcome.posted, false)
  assert.equal(outcome.fallback, 'step-summary')
  assert.equal(state.requests.length, 0)
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /Shapewall: 1 of 2 pages changed/)
})

test('a read-only token (403 on write) falls back to the job summary', async () => {
  reset({ readOnly: true })
  const { env, summaryFile } = jobEnv()
  const outcome = await commentFromResult({ dir: result(), env, log })
  assert.equal(outcome.posted, false)
  assert.match(outcome.reason, /read-only/)
  assert.ok(fs.existsSync(summaryFile))
})

test('token-host rule: an API URL only the config names gets no token, and no token means no request', async () => {
  reset()
  const { env } = jobEnv({ extra: { SHAPEWALL_GITHUB_API_URL: '' } })
  const config = { github: { apiUrl: api }, ci: { images: 'links' } }
  const outcome = await commentFromResult({ dir: result(), config, env, log })
  assert.equal(outcome.posted, false)
  assert.match(outcome.reason, /SHAPEWALL_GITHUB_API_URL/)
  assert.equal(state.requests.length, 0, 'nothing reached the host the config named')
  assert.deepEqual(apiTarget(config, {}), { apiUrl: api, confirmed: false, error: null })
  assert.equal(apiTarget(null, { GITHUB_API_URL: 'https://ghe.example.com/api/v3' }).confirmed, true)
  assert.match(apiTarget(null, { SHAPEWALL_GITHUB_API_URL: 'http://ghe.example.com/api/v3' }).error, /https/)

  const { env: noToken } = jobEnv({ extra: { GITHUB_TOKEN: '' } })
  const none = await commentFromResult({ dir: result(), env: noToken, log })
  assert.match(none.reason, /No GitHub token/)
  assert.equal(state.requests.length, 0)
})

test('artifact links are kept only on the GitHub web host', () => {
  const env = { GITHUB_SERVER_URL: 'https://github.com' }
  assert.equal(
    checkArtifactUrl('https://github.com/acme/site/actions/runs/1/artifacts/2', env),
    'https://github.com/acme/site/actions/runs/1/artifacts/2',
  )
  assert.equal(checkArtifactUrl('https://evil.example/x', env), null)
  assert.equal(checkArtifactUrl('http://github.com/x', env), null)
  assert.equal(checkArtifactUrl('', env), null)
  // ( and ) are percent-encoded: they would end the markdown link.
  assert.equal(
    checkArtifactUrl('https://github.com/acme/site/actions/runs/1/artifacts/2)![x](https://evil.example/a.png', env),
    'https://github.com/acme/site/actions/runs/1/artifacts/2%29!%5Bx%5D%28https://evil.example/a.png',
  )
})

// A summary.json the pull request's code wrote: whatever it holds, nothing
// in it reaches the comment as markup, a mention or a link.
test('a hostile summary.json: no markup, mention or link from it reaches the comment', async () => {
  const hostile = (edit) => {
    const dir = result()
    const file = path.join(dir, 'summary.json')
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
    edit(summary)
    fs.writeFileSync(file, JSON.stringify(summary))
    return dir
  }
  const payloads = [
    (s) => (s.shots[0].viewportSize = { width: '1 @octocat', height: 900 }),
    (s) => (s.shots[0].viewportSize = { width: 1440, height: '![x](https://evil.example/a.png)' }),
    (s) => Object.assign(s.shots[0], { dimensionsChanged: true, base: { width: '<img src=x>', height: 1 }, head: { width: 1, height: 1 } }),
    (s) => (s.totals.pages = '2 @everyone'),
    (s) => (s.totals.changedPages = '<b>1</b>'),
    (s) => (s.totals.shots = -1),
    (s) => (s.totals.unchangedShots = 1.5),
    (s) => (s.totals.newPages = '![x](https://evil.example/a.png)'),
    (s) => (s.shots[0].ratio = '0.02 @octocat'),
    (s) => (s.shots[0].ratio = 7),
    (s) => (s.threshold = Infinity),
    (s) => (s.shots[0].status = '<script>'),
    (s) => (s.failures = [{ side: '@octocat', page: 'home', viewport: 'desktop', error: 'x' }]),
    (s) => (s.shots[0].images.beforeThumb = 'https://evil.example/a.png'),
    (s) => (s.shots[0].title = { toString: '@octocat' }),
  ]
  for (const edit of payloads) {
    reset()
    const { env } = jobEnv()
    await commentFromResult({ dir: hostile(edit), config: { ci: { images: 'branch' } }, env, log })
    const body = state.comments[0].body
    assert.match(body, /### Shapewall: the result could not be read/, String(edit))
    assert.doesNotMatch(body, /@octocat|@everyone|<img|<b>|<script|evil\.example|!\[/, String(edit))
    assert.ok(!state.requests.some((item) => item.url.includes('/git/')), 'no images pushed from it')
  }
  // Strings stay plain text: a hostile title and error are shown, neutralised.
  reset()
  const { env } = jobEnv()
  await commentFromResult({
    dir: hostile((s) => {
      s.shots[0].title = '![x](https://evil.example/a.png) <img src=x> @octocat www.evil.example'
      s.failures = [{ side: 'head', page: 'home', viewport: 'desktop', error: '@everyone <b>x</b> [y](https://evil.example)' }]
    }),
    env,
    log,
  })
  const body = state.comments[0].body
  assert.match(body, /### Shapewall: 1 of 2 pages changed/)
  // Shown, but escaped (a backslash before each markup character) and broken up.
  assert.match(body, /\\<img src=x\\>/)
  assert.doesNotMatch(body, /@octocat|@everyone|(?<!\\)<(img|b)\b|https:\/\/evil|www\.evil|(?<!\\)!(?<!\\)\[/)
})

test('a missing summary.json says the capture failed', async () => {
  reset()
  const { env } = jobEnv()
  await commentFromResult({ dir: tempDir('ci-empty'), env, log })
  assert.match(state.comments[0].body, /### Shapewall: capture failed[\s\S]*workflow run/)
})

test('images "branch": public repository, committed to shapewall-ci and embedded by commit', async () => {
  reset()
  const { env } = jobEnv()
  await commentFromResult({ dir: result(), config: { ci: { images: 'branch' } }, env, log })
  const blobs = state.requests.filter((item) => item.url === '/repos/acme/site/git/blobs')
  assert.equal(blobs.length, 6)
  const tree = state.requests.find((item) => item.url === '/repos/acme/site/git/trees').body
  assert.ok(tree.tree.every((entry) => entry.path.startsWith(`pr-7/${'a'.repeat(12)}/home.desktop/`)))
  const commit = state.requests.find((item) => item.url === '/repos/acme/site/git/commits').body
  assert.deepEqual(commit.parents, [], 'an orphan branch to begin with')
  assert.ok(state.requests.some((item) => item.method === 'POST' && item.url === '/repos/acme/site/git/refs'))
  const sha = 'c0ffee'.padEnd(40, '0')
  assert.ok(
    state.comments[0].body.includes(
      `(https://raw.githubusercontent.com/acme/site/${sha}/pr-7/${'a'.repeat(12)}/home.desktop/before.thumb.png)`,
    ),
  )
})

test('images "branch" on a private repository: refused, links only, with a note', async () => {
  reset({ private: true })
  const { env } = jobEnv()
  await commentFromResult({ dir: result(), config: { ci: { images: 'branch' } }, env, log })
  assert.equal(state.requests.filter((item) => item.url.includes('/git/')).length, 0)
  assert.match(state.comments[0].body, /public repositories only/)
  assert.ok(!state.comments[0].body.includes('raw.githubusercontent.com'))
})

test('the CLI: ci comment is off with [skip shapewall] or ci.enabled false, and exits 0', async () => {
  reset()
  const { env } = jobEnv({ title: 'WIP [skip shapewall]' })
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    const out = []
    const code = await main(['ci', 'comment', '--dir', result()], { out: (line) => out.push(line) })
    assert.equal(code, 0)
    assert.match(out.join('\n'), /\[skip shapewall\]/)
    assert.equal(state.requests.length, 0)
  } finally {
    for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key]
    Object.assign(process.env, saved)
  }
})
